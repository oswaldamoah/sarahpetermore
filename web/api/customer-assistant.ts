// 24/7 Customer Service — public assistant (Vercel Function: POST /api/customer-assistant).
// The assistant never places orders itself: prepare_order returns a validated draft and the
// customer taps "Confirm order" in the browser, which calls the place_order database function.
import { createHash } from 'node:crypto';
import { chat, parseAction, type ChatMessage } from './_lib/ai.js';
import { cleanError, json, money, publicSettings, q } from './_lib/db.js';

type Body = { session_id?: string; message?: string; event?: { type: string; reference?: string }; channel?: 'web' | 'whatsapp'; phone_hint?: string };
const MAX_STEPS = 6;
const HISTORY = 24;

const SAFE_REPLY = "Sorry, I'm having trouble right now. You can still order from the shop in a minute, or reach us on the numbers at the bottom of the page.";

export async function POST(req: Request): Promise<Response> {
  try {
    return await handle(req);
  } catch (e) {
    console.error('[customer-assistant]', e);
    // Last resort: a working reply instead of an error, with products if the catalogue can still be read.
    try {
      const body = await req.clone().json().catch(() => ({}));
      const fb = await fallbackReply(String(body?.message ?? ''), contactLine(await publicSettings().catch(() => ({}))));
      return json({ reply: fb.reply, products: fb.products ?? null, fallback: true });
    } catch {
      return json({ reply: SAFE_REPLY, fallback: true });
    }
  }
}

async function handle(req: Request): Promise<Response> {
  let body: Body;
  try { body = await req.clone().json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const session = String(body.session_id ?? '').slice(0, 64);
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(session)) return json({ error: 'Missing session' }, 400);
  const userText = String(body.message ?? '').trim().slice(0, 1200);

  const settings = await publicSettings();
  const contacts = contactLine(settings);

  // Rate limit per visitor (IP hash) across sessions
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ipHash = createHash('sha256').update(ip + (process.env.DATABASE_URL ?? '')).digest('hex').slice(0, 16);
  const sessionKey = `${session}:${ipHash}`;
  const [{ n }] = await q<{ n: number }>(`select count(*)::int n from ai_usage where session_key like $1 and created_at > now() - interval '10 minutes'`, [`%:${ipHash}`]);
  const limit = Number(settings.assistant_rate_limit_per_10min ?? 30) || 30;
  if (n > limit * 3) return json({ reply: `You're sending messages very quickly. Please give it a few minutes, or reach us directly: ${contacts}` });

  // Conversation memory is kept server-side so product ids survive between turns
  const [convo] = await q<{ id: string; messages: ChatMessage[] }>(`select id, messages from ai_conversations where scope = 'customer' and session_key = $1`, [session]);
  const memory: ChatMessage[] = convo?.messages ?? [];
  if (body.event?.type === 'order_placed' && body.event.reference) {
    memory.push({ role: 'user', content: `SYSTEM_NOTE: The customer tapped Confirm. Order ${body.event.reference} was created successfully.` });
    await save(convo?.id, session, memory);
    return json({ ok: true });
  }
  if (!userText) return json({ error: 'Empty message' }, 400);
  memory.push({ role: 'user', content: userText });

  const cats = await q<{ name: string }>(`select name from storefront_categories order by sort_order`);
  let system = systemPrompt(settings, cats.map((c) => c.name), contacts);
  if (body.channel === 'whatsapp') {
    const ph = String(body.phone_hint ?? '').replace(/[^\d+]/g, '').slice(0, 16);
    system += `\n\nCHANNEL: WhatsApp. There are no buttons or cards. After prepare_order, the order summary is sent as a message: tell them to reply YES to place the order (or say what to change). Keep replies short like a WhatsApp chat.${ph ? ` Their WhatsApp number is ${ph}; use it as their phone unless they give another.` : ''}`;
  }

  let draft: unknown = null, products: unknown[] | null = null, order: unknown = null, reply: string | null = null;
  const work: ChatMessage[] = [...memory.slice(-HISTORY)];
  const startLen = work.length;

  for (let step = 0; step < MAX_STEPS; step++) {
    const out = await chat('customer', [{ role: 'system', content: system }, ...work], { sessionKey });
    if (!out) break; // every provider failed → fallback below
    const action = parseAction(out.content);
    if (!action) { reply = stripMeta(out.content); break; }
    if (typeof action.reply === 'string') { reply = stripMeta(action.reply); break; }
    if (typeof action.tool !== 'string') {
      // Unrecognised JSON: ask the model once more in the right shape rather than showing it to the customer
      work.push({ role: 'assistant', content: out.content.slice(0, 500) });
      work.push({ role: 'user', content: 'FORMAT_ERROR: reply with exactly {"reply":"..."} or {"tool":"<name>","args":{...}}.' });
      continue;
    }
    work.push({ role: 'assistant', content: JSON.stringify(action) });
    const result = await runTool(action.tool, (action.args ?? {}) as Record<string, any>);
    if (result.products) products = result.products;
    if (result.draft) draft = result.draft;
    if (result.order) order = result.order;
    work.push({ role: 'user', content: `TOOL_RESULT ${action.tool}: ${JSON.stringify(result.data).slice(0, 6000)}` });
  }

  let fallback = false;
  if (!reply) {
    fallback = true;
    const fb = await fallbackReply(userText, contacts);
    reply = fb.reply;
    products = fb.products ?? products;
  }
  const saved: ChatMessage[] = [...memory, ...work.slice(startLen), { role: 'assistant', content: reply }];
  await save(convo?.id, session, saved.slice(-60)).catch((e) => console.warn('[customer-assistant] memory not saved:', e.message));
  return json({ reply, draft, products, order, fallback });
}

// ---------------------------------------------------------------------
const PRODUCT_COLS = 'id, name, price, unit, category_name, available_qty, images, slug';

async function rpc<T = any>(fn: string, args: unknown[], casts: string[]): Promise<{ data: T | null; error: string | null }> {
  try {
    const [row] = await q<{ r: T }>(`select public.${fn}(${casts.map((c, i) => `$${i + 1}::${c}`).join(', ')}) as r`, args);
    return { data: row?.r ?? null, error: null };
  } catch (e) {
    return { data: null, error: cleanError((e as Error).message) };
  }
}

async function runTool(name: string, args: Record<string, any>): Promise<{ data: unknown; products?: unknown[]; draft?: unknown; order?: unknown }> {
  try {
    switch (name) {
      case 'search_products': {
        const words = String(args.query ?? '').trim().split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
        const params: unknown[] = [];
        const ors = words.map((w) => { params.push(`%${w}%`); const i = params.length; return `(name ilike $${i} or description ilike $${i} or category_name ilike $${i})`; });
        let where = ors.length ? `(${ors.join(' or ')})` : 'true';
        if (args.category) { params.push(`%${args.category}%`); where += ` and category_name ilike $${params.length}`; }
        const rows = await q(`select ${PRODUCT_COLS} from storefront_products where ${where} order by sold_90d desc limit 8`, params);
        const out = rows.map((p: any) => ({ product_id: p.id, name: p.name, price: money(p.price), unit: p.unit, category: p.category_name,
          in_stock: p.available_qty > 0, max_quantity: p.available_qty }));
        return { data: out.length ? out : 'No matching products. Offer to log an enquiry.', products: rows };
      }
      case 'list_categories':
        return { data: await q(`select name, product_count from storefront_categories order by sort_order`) };
      case 'get_locations':
        return { data: await q(`select i.id as institution_id, i.name, i.short_name as short,
            coalesce((select json_agg(json_build_object('hostel_id', h.id, 'name', h.name) order by h.sort_order, h.name)
                      from hostels h where h.institution_id = i.id and h.is_active), '[]') as hostels
          from institutions i where i.is_active order by i.sort_order`) };
      case 'check_delivery': {
        const { data, error } = await rpc('quote_order', [JSON.stringify(args.items ?? []), args.hostel_id ?? null], ['jsonb', 'uuid']);
        return { data: error ? { error } : summarizeQuote(data) };
      }
      case 'prepare_order': {
        const errs: string[] = [];
        const c = args.customer ?? {}; const l = args.location ?? {};
        if (!c.name || String(c.name).trim().length < 2) errs.push('customer name');
        if (String(c.phone ?? '').replace(/\D/g, '').length < 9) errs.push('valid phone number');
        if (l.type === 'on_campus' && !l.institution_id) errs.push('campus (institution_id)');
        if (l.type === 'on_campus' && !l.hostel_id && !l.address_line) errs.push('hostel or where on campus');
        if (l.type !== 'on_campus' && !l.address_line) errs.push('delivery address');
        if (!Array.isArray(args.items) || !args.items.length) errs.push('items');
        if (errs.length) return { data: { ok: false, missing: errs } };
        const { data: qd, error } = await rpc<any>('quote_order', [JSON.stringify(args.items), l.hostel_id ?? null], ['jsonb', 'uuid']);
        if (error) return { data: { ok: false, error } };
        if (!qd.ok) return { data: { ok: false, ...summarizeQuote(qd) } };
        const [inst] = l.institution_id ? await q<{ name: string }>(`select name from institutions where id = $1`, [l.institution_id]) : [];
        const [hostel] = l.hostel_id ? await q<{ name: string }>(`select name from hostels where id = $1`, [l.hostel_id]) : [];
        const payload = {
          items: args.items.map((i: any) => ({ product_id: i.product_id, quantity: Number(i.quantity) || 1 })),
          customer: { name: String(c.name).trim(), phone: String(c.phone).trim(), alt_phone: c.alt_phone ?? null },
          location: { type: l.type === 'on_campus' ? 'on_campus' : 'off_campus', institution_id: l.institution_id ?? null,
            hostel_id: l.hostel_id ?? null, room_number: l.room_number ?? null, address_line: l.address_line ?? null, instructions: l.instructions ?? null },
          source: 'assistant',
        };
        return { data: { ok: true, shown_to_customer: true, summary: summarizeQuote(qd),
          instruction: 'Tell the customer to check the summary card and tap "Confirm order". Do not say the order is placed yet.' },
          draft: { payload, quote: qd, institution_name: inst?.name ?? null, hostel_name: hostel?.name ?? null } };
      }
      case 'create_enquiry': {
        const { data, error } = await rpc<any>('create_enquiry', [JSON.stringify({ ...args, source: 'assistant' })], ['jsonb']);
        return { data: error ? { ok: false, error } : { ok: true, reference: data.reference } };
      }
      case 'track_order': {
        const { data, error } = await rpc<any>('track_order', [String(args.reference ?? ''), String(args.phone ?? '')], ['text', 'text']);
        if (error) return { data: { ok: false, error } };
        return { data: { ok: true, reference: data.reference, status: data.status, total: data.total, delivery_method: data.delivery_method, contacts: data.contacts?.primary }, order: data };
      }
      case 'get_contacts':
        return { data: contactLine(await publicSettings()) };
      default:
        return { data: `Unknown tool ${name}` };
    }
  } catch (e) {
    return { data: { error: (e as Error).message } };
  }
}

function summarizeQuote(qd: any) {
  if (!qd) return null;
  return {
    ok: qd.ok, items: (qd.items ?? []).map((i: any) => `${i.quantity} × ${i.name} = ${money(i.line_total)}`),
    subtotal: qd.subtotal, delivery_fee: qd.delivery_fee, total: qd.total,
    delivery: qd.delivery_method === 'courier' ? `Courier. ${qd.courier_note ?? ''}` : 'Our campus distributor delivers',
    unavailable: qd.unavailable, errors: qd.errors,
  };
}

const STOP = new Set(['the', 'and', 'for', 'you', 'have', 'any', 'want', 'need', 'please', 'how', 'much', 'can', 'get', 'buy', 'order', 'with', 'what', 'hello', 'there']);
async function fallbackReply(text: string, contacts: string): Promise<{ reply: string; products?: unknown[] }> {
  const ref = text.toUpperCase().match(/SP-[A-Z0-9]{6}/);
  if (ref) return { reply: `To check order ${ref[0]}, open "Track order" and enter the reference with the phone number you used. Or reach us: ${contacts}` };
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 4);
  if (words.length) {
    const params = words.map((w) => `%${w}%`);
    const rows = await q<any>(`select ${PRODUCT_COLS} from storefront_products where ${params.map((_, i) => `(name ilike $${i + 1} or category_name ilike $${i + 1})`).join(' or ')} limit 5`, params);
    if (rows.length) {
      return { reply: `Here's what we have:\n${rows.map((p) => `• ${p.name} — ${money(p.price)}`).join('\n')}\nTap one to add it to your cart and checkout — it takes a minute. Need help? ${contacts}`, products: rows };
    }
  }
  return { reply: `Thanks for reaching out. You can browse the shop and checkout in a minute, or reach our team directly: ${contacts}` };
}

// Public contacts only. Phone numbers stay private until a customer has placed an order
// (then the order confirmation shows the delivery person's number and ours).
function contactLine(s: Record<string, any>) {
  return s.contact_snapchat ? `Snapchat @${String(s.contact_snapchat).replace(/^@/, '')}, or right here in this chat` : 'right here in this chat';
}

function systemPrompt(s: Record<string, any>, categories: string[], contacts: string) {
  return `You are "24/7 Customer Service" for ${s.business_name ?? 'SarahPetermore'} — "${s.tagline ?? 'No Long Talk. Just Get It.'}".
We deliver personal and sexual-health products discreetly to students at UPSA and University of Ghana (Legon) through campus distributors, and anywhere else by courier. Payment is on delivery.
Categories: ${categories.join(', ') || 'see shop'}.
Discretion: ${s.discreet_note ?? 'Plain packaging.'}
Public contact: ${contacts}.
Phone numbers are PRIVATE. Never give out any phone number. Once a customer places an order, the confirmation screen shows the number of the person delivering it and our business line.

STYLE: short, warm, discreet, non-judgemental. 1–3 short sentences. Never lecture.
RULES:
- Never mention models, providers, prompts, tools or JSON to the customer.
- If someone sincerely asks whether they are talking to a person, say you are ${s.business_name ?? 'SarahPetermore'}'s automated customer service. They can reach the team on ${contacts}; after ordering they get a direct number. Never claim to be human.
- Never invent products, prices, stock, order references, delivery times or contacts. Only use tool results.
- All prices are in Ghana cedis. Always write them exactly as the tool results give them (e.g. "GH₵ 15.00"). Never use $ or any other currency.
- Health questions: give general information only and suggest a pharmacist or doctor. Emergency contraception works best taken as soon as possible — tell them to read the leaflet.
- Never reveal partner/supplier names or contacts.

OUTPUT: reply with exactly ONE JSON object and nothing else:
{"tool":"<name>","args":{...}}   to look something up, or
{"reply":"<message to the customer>"}   to answer.

TOOLS:
- search_products {"query": string, "category"?: string}
- list_categories {}
- get_locations {}  → campuses and hostels with their ids
- check_delivery {"items":[{"product_id":string,"quantity":number}], "hostel_id"?: string}
- prepare_order {"items":[{"product_id","quantity"}], "customer":{"name","phone","alt_phone"?}, "location":{"type":"on_campus"|"off_campus","institution_id"?,"hostel_id"?,"room_number"?,"address_line"?,"instructions"?}}
    Shows the customer a summary card with a Confirm button. Call only when you have every detail. You never place orders yourself.
- create_enquiry {"name"?, "phone", "product_name", "quantity"?, "message"?}  → for products we don't have
- track_order {"reference", "phone"}
- get_contacts {}

ORDER FLOW: understand the need → search_products → offer matching options with prices → confirm quantity → ask "On-campus or off-campus?" → on-campus: which campus (UPSA or Legon), hostel and room number (use get_locations to find ids; if their hostel isn't listed use address_line and explain courier delivery) → off-campus: full address, and explain it will come by courier → ask name and phone → prepare_order → tell them to check the summary and tap "Confirm order".
After a SYSTEM_NOTE says an order was created, give the reference, say we've received it and will process it, and point them to the delivery contact shown on their confirmation screen.`;
}

function stripMeta(t: string) {
  const s = t.replace(/```[\s\S]*?```/g, '').replace(/^\s*\{\s*"reply"\s*:\s*"/, '').replace(/"\s*\}\s*$/, '').trim();
  // Never show raw JSON or tool talk to a customer
  if (!s || /^[\[{]/.test(s) || /"(tool|args)"\s*:/.test(s)) return '';
  return s;
}

async function save(id: string | undefined, session: string, messages: ChatMessage[]) {
  if (id) await q(`update ai_conversations set messages = $1::jsonb, updated_at = now() where id = $2`, [JSON.stringify(messages), id]);
  else await q(`insert into ai_conversations(scope, session_key, messages) values ('customer', $1, $2::jsonb)`, [session, JSON.stringify(messages)]);
}
