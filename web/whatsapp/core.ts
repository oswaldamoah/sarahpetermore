// What the WhatsApp link does, independent of the WhatsApp connection itself (so it can be tested).
//  • Alerts: every new order goes to your own "Message yourself" chat, plus anyone in Admin → Order alerts
//    with a WhatsApp number (distributors only get the orders they deliver).
//  • Customers: replies with the same AI as the website chat. A customer confirms an order by replying YES.
//  • You stay in charge: type in a chat yourself and the AI goes quiet there for 2 hours.
//    Type "/ai off" or "/ai on" in any chat to switch it for that chat (the command is deleted right away).
//  • Type "/alerts here" in any group or chat to also post every new order there; "/alerts off" to stop.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { q, qSafe, cleanError } from '../api/_lib/db.js';
import { ALERT_TYPES, type Note, noteText, orderIdOf, orderText, recipients } from '../api/_lib/alerts.js';
import { POST as assistant } from '../api/customer-assistant.js';
import { POST as notify } from '../api/notify.js';

export type AiMode = 'off' | 'customers' | 'everyone';
export type Io = {
  send: (jid: string, text: string) => Promise<string | undefined>;      // returns the sent message id
  resolve: (phone: string) => Promise<string | null>;                    // phone → WhatsApp chat id (null if not on WhatsApp)
  typing?: (jid: string, on: boolean) => Promise<void>;
  read?: (key: unknown) => Promise<void>;
  remove?: (jid: string, key: unknown) => Promise<void>;
};
export type Incoming = { jid: string; id: string; fromMe: boolean; text: string; phone: string | null; isSelf: boolean; isGroup?: boolean; key?: unknown };

const HUMAN_PAUSE_MS = 2 * 60 * 60 * 1000;
const DRAFT_TTL_MS = 30 * 60 * 1000;
const SHOP = /(condom|pregnan|test ?kit|postpil|postinor|lydia|\blube|lubric|vibrat|dildo|\btoys?\b|delay spray|enhanc|how much|price|deliver|sarah ?petermore|\bsp-[a-z0-9]{6}\b|my order|in stock|do you (have|sell))/i;
const YES = /^(yes|yeah|yh|yep|yup|ok|okay|confirm|sure|go ahead|place it|do it)\b/i;
const money = (n: unknown) => `GH₵ ${Number(n ?? 0).toFixed(2)}`;
export const toJidNumber = (p: string) => p.replace(/\D/g, '').replace(/^0(?=\d{9}$)/, '233');
const sessionFor = (jid: string) => `wa-${createHash('sha256').update(jid).digest('hex').slice(0, 24)}`;

export function createCore(io: Io, opts: { me: () => string | null; aiMode: AiMode; notifySelf: boolean; stateFile?: string; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  const botSent = new Set<string>();
  const humanAt = new Map<string, number>();
  const pending = new Map<string, { payload: unknown; expires: number }>();
  let chatMode: Record<string, 'on' | 'off'> = {};
  let alertChats: string[] = [];   // extra chats/groups that get every alert ("/alerts here")
  try {
    if (opts.stateFile) {
      const saved = JSON.parse(readFileSync(opts.stateFile, 'utf8'));
      if (saved && typeof saved === 'object' && ('modes' in saved || 'alertChats' in saved)) { chatMode = saved.modes ?? {}; alertChats = saved.alertChats ?? []; }
      else chatMode = saved ?? {};
    }
  } catch { /* first run */ }
  const saveModes = () => { try { if (opts.stateFile) writeFileSync(opts.stateFile, JSON.stringify({ modes: chatMode, alertChats }, null, 1)); } catch { /* ignore */ } };

  async function send(jid: string, text: string) {
    const id = await io.send(jid, text);
    if (id) botSent.add(id);
    return id;
  }
  async function sendToNumber(phone: string, text: string) {
    const jid = await io.resolve(toJidNumber(phone));
    if (!jid) return `WhatsApp failed: ${phone} is not on WhatsApp`;
    if (jid === opts.me()) return 'WhatsApp sent (your own chat)';
    await send(jid, text);
    return 'WhatsApp sent';
  }

  // ------------------------------------------------------------ alerts
  async function alertsTick() {
    const me = opts.me();
    if (!me) return 0;
    const rows = await q<Note>(`update notifications set wa_sent_at = now()
      where id in (select id from notifications where wa_sent_at is null and created_at > now() - interval '2 days' order by created_at limit 10 for update skip locked)
      returning id, type, title, body, link`);
    if (!rows.length) return 0;
    const people = (await recipients()).filter((r) => r.whatsapp);
    const mark = (id: string, result: string) => qSafe(`update alert_recipients set last_result = $1, last_sent_at = now() where id = $2`, [result, id]);
    for (const n of rows) {
      try {
        if (n.type === 'test') {
          const r = people.find((p) => `wa:${p.id}` === n.body);
          if (r) await mark(r.id, await sendToNumber(r.whatsapp!, `*${n.title}*\nNew orders will arrive here like this.`));
          continue;
        }
        if (!ALERT_TYPES.includes(n.type)) continue;
        const orderId = orderIdOf(n);
        const full = orderId ? await orderText(orderId) : null;
        const text = full?.text ?? noteText(n);
        if (opts.notifySelf) await send(me, text);
        for (const jid of alertChats) await send(jid, text).catch((e) => log(`alert to ${jid} failed: ${(e as Error).message}`));
        for (const r of people.filter((p) => !p.distributor_id)) await mark(r.id, await sendToNumber(r.whatsapp!, text));
        if (orderId && full) {
          for (const r of people.filter((p) => p.distributor_id && full.distributors.includes(p.distributor_id))) {
            const theirs = await orderText(orderId, r.distributor_id!);
            if (theirs) await mark(r.id, await sendToNumber(r.whatsapp!, theirs.text));
          }
        }
        log(`alert sent: ${n.title}`);
      } catch (e) {
        log(`alert failed (${n.title}): ${(e as Error).message}`);
      }
    }
    return rows.length;
  }

  // ------------------------------------------------------------ chats
  async function knownCustomer(jid: string, phone: string | null) {
    const [s] = await q<{ n: number }>(`select count(*)::int n from ai_conversations where scope = 'customer' and session_key = $1`, [sessionFor(jid)]);
    if (s?.n) return true;
    if (!phone) return false;
    const [o] = await q<{ n: number }>(`select count(*)::int n from orders where phone_normalized = public.normalize_phone($1)`, [phone]);
    return (o?.n ?? 0) > 0;
  }

  async function shouldReply(m: Incoming) {
    if (opts.aiMode === 'off' || chatMode[m.jid] === 'off') return false;
    if (chatMode[m.jid] === 'on') return true;
    if (Date.now() - (humanAt.get(m.jid) ?? 0) < HUMAN_PAUSE_MS) return false;
    if (opts.aiMode === 'everyone') return true;
    return SHOP.test(m.text) || (await knownCustomer(m.jid, m.phone));
  }

  const ask = async (jid: string, body: Record<string, unknown>) => (await assistant(new Request('http://whatsapp.local/api/customer-assistant', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': sessionFor(jid) },
    body: JSON.stringify({ session_id: sessionFor(jid), ...body }),
  }))).json() as Promise<any>;

  function summary(d: any) {
    const qd = d.quote ?? {};
    const where = d.payload?.location?.type === 'on_campus'
      ? [d.institution_name, d.hostel_name, d.payload.location.room_number && `Room ${d.payload.location.room_number}`].filter(Boolean).join(' · ')
      : d.payload?.location?.address_line;
    return [
      '*Your order*',
      ...(qd.items ?? []).map((i: any) => `• ${i.quantity} × ${i.name} — ${money(i.line_total)}`),
      Number(qd.delivery_fee) > 0 ? `Delivery: ${money(qd.delivery_fee)}` : '',
      `*Total: ${money(qd.total)}* (pay on delivery)`,
      where ? `📍 ${where}` : '',
      qd.delivery_method === 'courier' ? 'Comes by courier. We will call to confirm.' : '',
      '',
      'Reply *YES* to place it, or tell me what to change.',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
  }

  async function placeDraft(m: Incoming, payload: unknown) {
    try {
      const [row] = await q<{ r: any }>(`select public.place_order($1::jsonb) as r`, [JSON.stringify(payload)]);
      const o = row.r;
      const who = (o.contacts?.primary ?? []).filter((c: any) => c.phone).map((c: any) => `${c.name && c.name !== 'SarahPetermore' ? `${c.name}: ` : ''}${c.phone}`);
      await send(m.jid, [`Done ✅ Order *${o.reference}*`, `Total ${money(o.total)}, pay when it arrives.`, who.length ? `Delivery contact: ${who.join(' / ')}` : '', 'Track it anytime with this reference.'].filter(Boolean).join('\n'));
      await ask(m.jid, { event: { type: 'order_placed', reference: o.reference } }).catch(() => null);
      void notify(new Request('http://whatsapp.local/api/notify', { method: 'POST' })).catch(() => null); // email alerts
      void alertsTick().catch(() => null);
      log(`order placed from WhatsApp: ${o.reference}`);
    } catch (e) {
      await send(m.jid, `Sorry, I couldn't place that: ${cleanError((e as Error).message)}. Want to change something and try again?`);
    }
  }

  async function onMessage(m: Incoming) {
    if (!m.text) return;
    if (m.fromMe) {
      if (botSent.has(m.id) || m.isSelf) return;
      const cmd = m.text.trim().toLowerCase();
      if (cmd === '/alerts here' || cmd === '/alerts off') {
        alertChats = alertChats.filter((j) => j !== m.jid);
        if (cmd === '/alerts here') alertChats.push(m.jid);
        saveModes();
        await io.remove?.(m.jid, m.key).catch(() => null);
        await send(m.jid, cmd === '/alerts here' ? '✅ New orders will be posted here too.' : 'Order alerts stopped for this chat.');
        log(`alerts ${cmd === '/alerts here' ? 'on' : 'off'} for ${m.jid}`);
        return;
      }
      if (m.isGroup) return;
      if (cmd === '/ai on' || cmd === '/ai off') {
        chatMode[m.jid] = cmd.endsWith('on') ? 'on' : 'off'; saveModes();
        if (cmd.endsWith('on')) humanAt.delete(m.jid);
        await io.remove?.(m.jid, m.key).catch(() => null);
        log(`AI ${chatMode[m.jid]} for ${m.jid}`);
        return;
      }
      humanAt.set(m.jid, Date.now()); // you replied yourself: AI stays quiet in this chat for a while
      return;
    }
    if (m.isSelf || m.isGroup || !(await shouldReply(m))) return;

    const draft = pending.get(m.jid);
    if (draft && draft.expires > Date.now() && YES.test(m.text.trim())) {
      pending.delete(m.jid);
      return placeDraft(m, draft.payload);
    }
    await io.read?.(m.key).catch(() => null);
    await io.typing?.(m.jid, true).catch(() => null);
    try {
      const data = await ask(m.jid, { message: m.text, channel: 'whatsapp', phone_hint: m.phone ?? '' });
      let out = String(data.reply ?? data.error ?? '').trim();
      if (data.draft) {
        pending.set(m.jid, { payload: data.draft.payload, expires: Date.now() + DRAFT_TTL_MS });
        out = `${out}\n\n${summary(data.draft)}`.trim();
      }
      if (out) await send(m.jid, out);
    } finally {
      await io.typing?.(m.jid, false).catch(() => null);
    }
  }

  return { onMessage, alertsTick, _state: { pending, humanAt, chatMode, get alertChats() { return alertChats; } } };
}
