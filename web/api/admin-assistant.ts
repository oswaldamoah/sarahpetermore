// Sarah Assistant — admin AI (Vercel Function: POST /api/admin-assistant). Requires a signed-in staff member.
// Reads run with the caller's own permissions (RLS). Changes are proposed, previewed,
// and only executed after the admin confirms — through the same database functions the UI uses.
import { chat, parseAction, testProvider, type ChatMessage } from './_lib/ai.js';
import { bearer, cleanError, json, money, q, userDb, whoami } from './_lib/db.js';

type DataClient = ReturnType<typeof userDb>;

type Body = {
  mode?: 'chat' | 'execute' | 'reject' | 'test';
  messages?: ChatMessage[]; provider_id?: string; action_id?: string;
};

const ACTIONS = ['create_products', 'update_product', 'create_category', 'set_category_status', 'create_stakeholder',
  'set_stakeholder_status', 'adjust_stock', 'set_stock', 'restock', 'transfer_stock', 'record_expense',
  'update_order_status', 'record_payment', 'create_distributor', 'add_hostels'] as const;

export async function POST(req: Request): Promise<Response> {
  try {
    return await handle(req);
  } catch (e) {
    console.error('[admin-assistant]', e);
    return json({ reply: `I couldn't finish that because the connection to the database dropped (${(e as Error).message}). Please try again.`, fallback: true });
  }
}

async function handle(req: Request): Promise<Response> {
  const token = bearer(req);
  const who = await whoami(token);
  if (!token || !who.user_id) return json({ error: 'Sign in required' }, 401);
  const roleList = who.roles ?? [];
  if (!roleList.some((r) => r !== 'distributor')) return json({ error: 'Staff only' }, 403);
  const db = userDb(token);
  const userId = who.user_id;

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (body.mode === 'test') {
    if (!roleList.includes('super_admin')) return json({ error: 'Super admin only' }, 403);
    return json(await testProvider(String(body.provider_id)));
  }

  if (body.mode === 'execute' || body.mode === 'reject') {
    const [log] = await q<any>(`select * from ai_action_logs where id::text = $1 and user_id = $2`, [String(body.action_id ?? ''), userId]);
    if (!log || log.status !== 'proposed') return json({ error: 'This action is no longer pending' }, 400);
    if (body.mode === 'reject') {
      await q(`update ai_action_logs set status = 'rejected' where id = $1`, [log.id]);
      return json({ ok: true });
    }
    try {
      const result = await execute(db, log.action.type, log.action.params);
      await q(`update ai_action_logs set status = 'executed', result = $1::jsonb, executed_at = now() where id = $2`, [JSON.stringify(result ?? null), log.id]);
      await q(`insert into audit_logs(actor_id, action, entity_type, entity_id, details) values ($1, 'ai_action', 'ai_action_logs', $2, $3::jsonb)`,
        [userId, log.id, JSON.stringify({ type: log.action.type, result })]);
      return json({ ok: true, result });
    } catch (e) {
      const msg = cleanError((e as Error).message);
      await q(`update ai_action_logs set status = 'failed', result = $1::jsonb where id = $2`, [JSON.stringify({ error: msg }), log.id]);
      return json({ ok: false, error: msg });
    }
  }

  // ---- chat ----
  const history = (body.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
  if (!history.length) return json({ error: 'Empty message' }, 400);
  const work: ChatMessage[] = [...history];
  const system = adminPrompt(roleList);

  for (let step = 0; step < 7; step++) {
    const out = await chat('admin', [{ role: 'system', content: system }, ...work],
      { preferredProviderId: body.provider_id, sessionKey: `admin:${userId}`, temperature: 0.1 });
    if (!out) return json({ reply: 'All AI providers are unavailable right now. Add or fix a provider key in Settings → AI, or try again shortly.', fallback: true });
    const action = parseAction(out.content);
    if (!action || typeof action.reply === 'string') {
      return json({ reply: (action?.reply as string) ?? out.content.trim(), model: `${out.providerName} · ${out.model}` });
    }
    if (action.propose && typeof action.propose === 'object') {
      const p = action.propose as { type: string; params: Record<string, any>; summary?: string };
      try {
        if (!ACTIONS.includes(p.type as any)) throw new Error(`Unsupported action "${p.type}"`);
        const { params, preview } = await prepare(db, p.type, p.params ?? {});
        const [log] = await q<{ id: string }>(`insert into ai_action_logs(user_id, instruction, action, preview, status)
          values ($1, $2, $3::jsonb, $4::jsonb, 'proposed') returning id`,
          [userId, history.at(-1)?.content ?? null, JSON.stringify({ type: p.type, params }), JSON.stringify(preview)]);
        return json({ reply: p.summary ?? 'Please review and confirm.', proposal: { id: log.id, type: p.type, summary: p.summary, preview },
          model: `${out.providerName} · ${out.model}` });
      } catch (e) {
        work.push({ role: 'assistant', content: JSON.stringify(action) });
        work.push({ role: 'user', content: `PROPOSAL_ERROR: ${cleanError((e as Error).message)}. Fix the parameters (use the read tools to find ids) or ask the admin.` });
        continue;
      }
    }
    if (typeof action.tool === 'string') {
      work.push({ role: 'assistant', content: JSON.stringify(action) });
      const data = await readTool(db, action.tool, (action.args ?? {}) as Record<string, any>);
      work.push({ role: 'user', content: `TOOL_RESULT ${action.tool}: ${JSON.stringify(data).slice(0, 12000)}` });
      continue;
    }
    return json({ reply: out.content.trim(), model: `${out.providerName} · ${out.model}` });
  }
  return json({ reply: 'That needed more steps than I can take at once. Could you break it into smaller instructions?' });
}

// ---------------------------------------------------------------------
async function readTool(db: DataClient, name: string, a: Record<string, any>) {
  const lim = Math.min(Number(a.limit) || 50, 200);
  const r = async (q: any) => { const { data, error } = await q; return error ? { error: error.message } : data; };
  switch (name) {
    case 'find_products': {
      let q = db.from('products').select('id,name,sku,unit,cost_price,base_price,markup_percent,final_price,is_active,is_available,low_stock_threshold,category:categories(name,status),stakeholder:stakeholders(name,status)').limit(lim).order('name');
      if (a.query) q = q.ilike('name', `%${a.query}%`);
      return r(q);
    }
    case 'list_categories': return r(db.from('categories').select('id,name,status,sort_order').order('sort_order'));
    case 'list_stakeholders': return r(db.from('stakeholders').select('id,name,status,markup_percent,commission_percent,is_platform_owner').order('name'));
    case 'list_distributors': return r(db.from('distributors').select('id,name,contact_person,phone,is_active,is_hub,distributor_service_areas(hostels(name))').order('name'));
    case 'list_locations': return r(db.from('institutions').select('id,name,short_name,is_active,hostels(id,name,is_active)').order('sort_order'));
    case 'get_stock': {
      let q = db.from('inventory').select('product_id,distributor_id,on_hand,reserved,available,product:products!inner(name),distributor:distributors!inner(name)').limit(lim);
      if (a.product_query) q = q.ilike('product.name', `%${a.product_query}%`);
      if (a.distributor_query) q = q.ilike('distributor.name', `%${a.distributor_query}%`);
      return r(q);
    }
    case 'find_orders': {
      let q = db.from('orders').select('id,reference,status,payment_status,total,amount_paid,customer_name,hostel_name,institution_name,delivery_method,created_at').order('created_at', { ascending: false }).limit(lim);
      if (a.status) q = q.eq('status', a.status);
      if (a.reference) q = q.ilike('reference', `%${a.reference}%`);
      return r(q);
    }
    case 'sales_report': return r(db.rpc('sales_breakdown', { p_from: a.from, p_to: a.to, p_dimension: a.dimension ?? 'product', p_scope: a.scope ?? 'delivered' }));
    case 'finance_summary': return r(db.rpc('finance_report', { p_from: a.from, p_to: a.to }));
    case 'stakeholder_balances': return r(db.rpc('stakeholder_balances'));
    case 'dashboard': return r(db.rpc('dashboard_stats', { p_from: a.from, p_to: a.to }));
    default: return { error: `Unknown tool ${name}` };
  }
}

// Resolve names → ids, validate, and build a human-readable preview.
async function prepare(db: DataClient, type: string, p: Record<string, any>) {
  const params = structuredClone(p);
  const one = async (table: string, val: unknown, label: string, col = 'name') => {
    if (!val) throw new Error(`${label} is required`);
    const v = String(val);
    if (/^[0-9a-f-]{36}$/i.test(v)) {
      const { data } = await db.from(table).select(`id,${col}`).eq('id', v).maybeSingle();
      if (!data) throw new Error(`${label} not found`);
      return data as Record<string, any>;
    }
    const { data } = await db.from(table).select(`id,${col}`).ilike(col, v);
    if (data?.length === 1) return data[0] as Record<string, any>;
    const { data: fuzzy } = await db.from(table).select(`id,${col}`).ilike(col, `%${v}%`).limit(5);
    if (fuzzy?.length === 1) return fuzzy[0] as Record<string, any>;
    throw new Error(fuzzy?.length ? `${label} "${v}" is ambiguous: ${fuzzy.map((f: any) => f[col]).join(', ')}` : `${label} "${v}" not found`);
  };

  switch (type) {
    case 'create_products': {
      const rows = [];
      for (const x of params.products ?? []) {
        const cat = await one('categories', x.category ?? x.category_id, 'Category');
        const sh = x.stakeholder || x.stakeholder_id
          ? await one('stakeholders', x.stakeholder ?? x.stakeholder_id, 'Stakeholder')
          : (await db.from('stakeholders').select('id,name').eq('is_platform_owner', true).limit(1).single()).data!;
        const { data: shFull } = await db.from('stakeholders').select('markup_percent').eq('id', sh.id).single();
        const base = Number(x.selling_price ?? x.base_price);
        if (!x.name || !(base > 0)) throw new Error('Each product needs a name and a selling price');
        Object.assign(x, { category_id: cat.id, stakeholder_id: sh.id, base_price: base, _category: cat.name, _stakeholder: sh.name,
          _final: +(base * (1 + Number(x.markup_percent ?? shFull?.markup_percent ?? 0) / 100)).toFixed(2) });
        rows.push({ Product: x.name, Category: cat.name, Stakeholder: sh.name, Cost: money(x.cost_price ?? 0), 'Base price': money(base), 'Customer price': money(x._final), Unit: x.unit ?? 'pc' });
      }
      if (!rows.length) throw new Error('No products given');
      return { params, preview: { title: `Create ${rows.length} product(s)`, rows } };
    }
    case 'update_product': {
      const prod = await one('products', params.product_id ?? params.product, 'Product');
      params.product_id = prod.id;
      const { data: before } = await db.from('products').select('*').eq('id', prod.id).single();
      const ch = params.changes ?? {};
      if (ch.category) { ch.category_id = (await one('categories', ch.category, 'Category')).id; delete ch.category; }
      const allowed = ['name', 'description', 'sku', 'cost_price', 'base_price', 'markup_percent', 'unit', 'is_active', 'is_available', 'is_featured', 'low_stock_threshold', 'category_id'];
      for (const k of Object.keys(ch)) if (!allowed.includes(k)) delete ch[k];
      if (!Object.keys(ch).length) throw new Error('Nothing to change');
      return { params, preview: { title: `Update ${prod.name}`, rows: Object.keys(ch).map((k) => ({ Field: k, Before: String(before?.[k] ?? '—'), After: String(ch[k]) })) } };
    }
    case 'create_category':
      if (!params.name) throw new Error('Category name is required');
      return { params, preview: { title: 'Create category', rows: [{ Name: params.name, Description: params.description ?? '' }] } };
    case 'set_category_status': {
      const c = await one('categories', params.category_id ?? params.category, 'Category');
      params.category_id = c.id;
      if (!['active', 'inactive', 'archived'].includes(params.status)) throw new Error('Status must be active, inactive or archived');
      return { params, preview: { title: `Set ${c.name} to ${params.status}`, rows: [{ Category: c.name, 'New status': params.status, Effect: params.status === 'active' ? 'Products reappear in the shop' : 'Products hidden from the shop' }] } };
    }
    case 'create_stakeholder':
      if (!params.name) throw new Error('Stakeholder name is required');
      return { params, preview: { title: 'Add stakeholder', rows: [{ Name: params.name, Markup: `${params.markup_percent ?? 0}%`, Commission: `${params.commission_percent ?? 0}%` }] } };
    case 'set_stakeholder_status': {
      const s = await one('stakeholders', params.stakeholder_id ?? params.stakeholder, 'Stakeholder');
      params.stakeholder_id = s.id;
      if (!['active', 'inactive', 'suspended'].includes(params.status)) throw new Error('Status must be active, inactive or suspended');
      return { params, preview: { title: `Set ${s.name} to ${params.status}`, rows: [{ Stakeholder: s.name, 'New status': params.status, Effect: params.status === 'active' ? 'Their products return to the shop' : 'All their products disappear from the shop' }] } };
    }
    case 'set_stock':
    case 'adjust_stock': {
      const list = type === 'set_stock' ? [params] : (params.adjustments ?? []);
      const adj = [];
      for (const x of list) {
        const prod = await one('products', x.product_id ?? x.product, 'Product');
        const dist = await one('distributors', x.distributor_id ?? x.distributor, 'Distributor');
        let delta = Number(x.delta);
        if (type === 'set_stock') {
          const { data: inv } = await db.from('inventory').select('on_hand').eq('product_id', prod.id).eq('distributor_id', dist.id).maybeSingle();
          delta = Number(x.quantity) - (inv?.on_hand ?? 0);
        }
        adj.push({ product_id: prod.id, distributor_id: dist.id, delta, movement_type: x.movement_type });
      }
      const { data: rows, error } = await db.rpc('preview_stock_adjustments', { p_adjustments: adj });
      if (error) throw error;
      const bad = (rows as any[]).filter((r) => r.error && r.error !== 'No change');
      if (bad.length) throw new Error(bad.map((b) => `${b.product_name} @ ${b.distributor_name}: ${b.error}`).join('; '));
      const out = { adjustments: adj, reason: params.reason ?? 'Sarah Assistant' };
      return { params: out, preview: { title: 'Stock adjustment', reason: out.reason,
        rows: (rows as any[]).map((r) => ({ Product: r.product_name, Distributor: r.distributor_name, Before: r.before, Change: r.delta > 0 ? `+${r.delta}` : r.delta, After: r.after })) } };
    }
    case 'restock': {
      const dist = await one('distributors', params.distributor_id ?? params.distributor, 'Distributor');
      params.distributor_id = dist.id;
      const rows = [];
      let total = 0;
      for (const it of params.items ?? []) {
        const prod = await one('products', it.product_id ?? it.product, 'Product');
        it.product_id = prod.id;
        const { data: inv } = await db.from('inventory').select('on_hand').eq('product_id', prod.id).eq('distributor_id', dist.id).maybeSingle();
        total += Number(it.quantity) * Number(it.unit_cost ?? 0);
        rows.push({ Product: prod.name, Before: inv?.on_hand ?? 0, Adding: `+${it.quantity}`, After: (inv?.on_hand ?? 0) + Number(it.quantity), 'Unit cost': money(it.unit_cost ?? 0) });
      }
      params.payment_status = params.payment_status ?? 'paid';
      return { params, preview: { title: `Restock ${dist.name}`, rows, footer: `Total cost ${money(total)} · ${params.payment_status}` } };
    }
    case 'transfer_stock': {
      const src = await one('distributors', params.source_distributor_id ?? params.from, 'Source distributor');
      const dst = await one('distributors', params.destination_distributor_id ?? params.to, 'Destination distributor');
      Object.assign(params, { source_distributor_id: src.id, destination_distributor_id: dst.id });
      const rows = [];
      for (const it of params.items ?? []) {
        const prod = await one('products', it.product_id ?? it.product, 'Product');
        it.product_id = prod.id;
        const { data: a } = await db.from('inventory').select('available').eq('product_id', prod.id).eq('distributor_id', src.id).maybeSingle();
        if ((a?.available ?? 0) < Number(it.quantity)) throw new Error(`${src.name} only has ${a?.available ?? 0} ${prod.name} available`);
        rows.push({ Product: prod.name, Quantity: it.quantity, From: src.name, To: dst.name });
      }
      return { params, preview: { title: 'Transfer stock', rows, footer: params.receive_now ? 'Will be marked received immediately' : 'Will be In Transit until received' } };
    }
    case 'record_expense':
      if (!params.name || !(Number(params.amount) > 0)) throw new Error('Expense needs a name and amount');
      return { params, preview: { title: 'Record expense', rows: [{ Name: params.name, Category: params.category ?? 'General', Amount: money(params.amount), Date: params.expense_date ?? 'today' }] } };
    case 'update_order_status':
    case 'record_payment': {
      const ref = params.order_id ?? params.reference;
      const { data: o } = /^[0-9a-f-]{36}$/i.test(String(ref))
        ? await db.from('orders').select('id,reference,status,total,amount_paid').eq('id', ref).maybeSingle()
        : await db.from('orders').select('id,reference,status,total,amount_paid').ilike('reference', String(ref).trim()).maybeSingle();
      if (!o) throw new Error(`Order ${ref} not found`);
      params.order_id = o.id;
      return { params, preview: type === 'update_order_status'
        ? { title: `Order ${o.reference}`, rows: [{ From: o.status, To: params.status, Note: params.note ?? '' }] }
        : { title: `Payment for ${o.reference}`, rows: [{ Total: money(o.total), 'Already paid': money(o.amount_paid), Recording: money(params.amount), Method: params.method ?? 'cash' }] } };
    }
    case 'create_distributor': {
      const hostels = [];
      for (const h of params.hostels ?? params.hostel_ids ?? []) hostels.push(await one('hostels', h, 'Hostel'));
      params.hostel_ids = hostels.map((h) => h.id);
      return { params, preview: { title: 'Add distributor', rows: [{ Name: params.name, Contact: params.contact_person ?? '', Phone: params.phone ?? '', Serves: hostels.map((h) => h.name).join(', ') || '—' }] } };
    }
    case 'add_hostels': {
      const inst = await one('institutions', params.institution_id ?? params.institution, 'Institution');
      params.institution_id = inst.id;
      return { params, preview: { title: `Add hostels to ${inst.name}`, rows: (params.names ?? []).map((n: string) => ({ Hostel: n })) } };
    }
  }
  throw new Error('Unsupported action');
}

async function execute(db: DataClient, type: string, p: Record<string, any>) {
  const ok = async (q: any) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  switch (type) {
    case 'create_products':
      return ok(db.from('products').insert(p.products.map((x: any) => ({
        name: x.name, slug: slug(x.name), description: x.description ?? null, sku: x.sku ?? null, unit: x.unit ?? 'pc',
        category_id: x.category_id, stakeholder_id: x.stakeholder_id, cost_price: Number(x.cost_price ?? 0), base_price: x.base_price,
        markup_percent: x.markup_percent ?? null }))).select('id,name,final_price'));
    case 'update_product': return ok(db.from('products').update(p.changes).eq('id', p.product_id).select('id,name,final_price'));
    case 'create_category': return ok(db.from('categories').insert({ name: p.name, slug: slug(p.name), description: p.description ?? null }).select('id,name'));
    case 'set_category_status': return ok(db.from('categories').update({ status: p.status }).eq('id', p.category_id).select('id,name,status'));
    case 'create_stakeholder': return ok(db.from('stakeholders').insert({ name: p.name, slug: slug(p.name), markup_percent: Number(p.markup_percent ?? 0),
      commission_percent: Number(p.commission_percent ?? 0), phone: p.phone ?? null, email: p.email ?? null, description: p.description ?? null }).select('id,name'));
    case 'set_stakeholder_status': return ok(db.from('stakeholders').update({ status: p.status }).eq('id', p.stakeholder_id).select('id,name,status'));
    case 'set_stock':
    case 'adjust_stock': return ok(db.rpc('adjust_stock_batch', { p_adjustments: p.adjustments, p_reason: p.reason }));
    case 'restock': return ok(db.rpc('record_restock', { p }));
    case 'transfer_stock': return ok(db.rpc('create_transfer', { p: { ...p, dispatch: true, receive: !!p.receive_now } }));
    case 'record_expense': return ok(db.from('expenses').insert({ name: p.name, category: p.category ?? 'General', amount: Number(p.amount),
      expense_date: p.expense_date ?? undefined, recipient: p.recipient ?? null, payment_method: p.payment_method ?? null, description: p.description ?? null }).select('id'));
    case 'update_order_status': return ok(db.rpc('update_order_status', { p_order: p.order_id, p_status: p.status, p_note: p.note ?? 'Via Sarah Assistant' }));
    case 'record_payment': return ok(db.rpc('record_order_payment', { p_order: p.order_id, p_amount: Number(p.amount), p_method: p.method ?? 'cash' }));
    case 'create_distributor': {
      const [d] = await ok(db.from('distributors').insert({ name: p.name, contact_person: p.contact_person ?? null, phone: p.phone ?? null,
        alt_phone: p.alt_phone ?? null, notes: p.notes ?? null }).select('id,name'));
      if (p.hostel_ids?.length) await ok(db.rpc('set_distributor_service_areas', { p_distributor: d.id, p_hostels: p.hostel_ids }));
      return d;
    }
    case 'add_hostels': return ok(db.from('hostels').insert(p.names.map((n: string) => ({ institution_id: p.institution_id, name: n }))).select('id,name'));
  }
  throw new Error('Unsupported action');
}

function adminPrompt(roles: string[]) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Sarah Assistant, the operations assistant inside the SarahPetermore admin panel. Today is ${today} (Africa/Accra). The admin's roles: ${roles.join(', ')}.
Currency is Ghana cedis (GH₵). Be brief and precise. Never invent data: look it up with tools.

Reply with exactly ONE JSON object and nothing else:
  {"tool":"<read tool>","args":{...}}                         to look something up
  {"propose":{"type":"<action>","params":{...},"summary":"<one line>"}}   to change something (the admin reviews and confirms; you never execute)
  {"reply":"<text>"}                                          to answer (markdown tables allowed)

READ TOOLS:
find_products {"query"?}, list_categories {}, list_stakeholders {}, list_distributors {}, list_locations {},
get_stock {"product_query"?, "distributor_query"?}, find_orders {"status"?, "reference"?, "limit"?},
sales_report {"from":"YYYY-MM-DD","to":"YYYY-MM-DD","dimension":"institution|hostel|distributor|product|category|stakeholder|day|delivery_method","scope":"delivered|placed"},
finance_summary {"from","to"}, stakeholder_balances {}, dashboard {"from","to"}

ACTIONS (names or ids are both accepted for products, categories, stakeholders, distributors, hostels, institutions; orders accept the SP- reference):
create_products {"products":[{"name","category","stakeholder"?,"cost_price","selling_price","unit"?,"description"?,"sku"?}]}  (selling_price = base price before the stakeholder's markup; Goldy adds 15% automatically)
update_product {"product","changes":{"name"?,"cost_price"?,"base_price"?,"markup_percent"?,"unit"?,"is_active"?,"is_available"?,"category"?,"low_stock_threshold"?,"description"?}}
create_category {"name","description"?}
set_category_status {"category","status":"active|inactive|archived"}
create_stakeholder {"name","markup_percent","commission_percent"?,"phone"?,"email"?,"description"?}
set_stakeholder_status {"stakeholder","status":"active|inactive|suspended"}
adjust_stock {"adjustments":[{"product","distributor","delta","movement_type"?}],"reason"}  (delta +/-; out reasons: adjustment_out, damaged, expired, internal_use)
set_stock {"product","distributor","quantity","reason"}  (sets the absolute count)
restock {"distributor","supplier"?,"payment_status":"paid|unpaid","payment_method"?,"items":[{"product","quantity","unit_cost"}]}
transfer_stock {"from","to","items":[{"product","quantity"}],"receive_now":true|false}
record_expense {"name","category","amount","expense_date"?,"recipient"?,"payment_method"?,"description"?}
update_order_status {"order","status":"received|confirmed|processing|ready_for_delivery|out_for_delivery|delivered|cancelled|failed_delivery|returned","note"?}
record_payment {"order","amount","method"}
create_distributor {"name","contact_person"?,"phone"?,"hostels"?:[names]}
add_hostels {"institution","names":[...]}

When the admin pastes a list (e.g. products with prices), turn it into ONE proposal. If something is ambiguous (which distributor? which price?), ask in a reply instead of guessing.
If you get PROPOSAL_ERROR, fix it with read tools or ask the admin.`;
}

