// WhatsApp link behaviour, without WhatsApp: real migrations in PGlite, a scripted AI, and a fake phone.
// Usage: npx tsx tests/whatsapp.test.ts
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { __setQueryRunner } from '../web/api/_lib/db.ts';
import { createCore } from '../web/whatsapp/core.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'db');
const db = new PGlite();
await db.exec(`create schema auth; create function auth.user_id() returns text language sql stable as $$ select null::text $$;
  create schema neon_auth; create table neon_auth."user"(id uuid primary key default gen_random_uuid(), email text, name text);`);
for (const f of readdirSync(join(root, 'migrations')).sort()) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
await db.exec(readFileSync(join(root, 'demo_seed.sql'), 'utf8'));
__setQueryRunner(async (text, params) => (await db.query(text, params as any[])).rows as any[]);

// Scripted AI (same protocol as the real providers)
const llm = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const { messages } = JSON.parse(raw);
  const tr = (name: string) => { const m = [...messages].reverse().find((x: any) => x.content.startsWith(`TOOL_RESULT ${name}:`)); return m ? JSON.parse(m.content.slice(`TOOL_RESULT ${name}: `.length)) : null; };
  const system = messages[0].content as string;
  let out: unknown;
  if (!tr('search_products')) out = { tool: 'search_products', args: { query: 'condoms' } };
  else if (!tr('get_locations')) out = { tool: 'get_locations', args: {} };
  else if (!tr('prepare_order')) {
    const legon = tr('get_locations').find((i: any) => i.short === 'Legon');
    const phone = system.match(/WhatsApp number is (\+?\d+)/)?.[1] ?? 'missing';
    out = { tool: 'prepare_order', args: { items: [{ product_id: tr('search_products')[0].product_id, quantity: 2 }], customer: { name: 'Kofi', phone },
      location: { type: 'on_campus', institution_id: legon.institution_id, hostel_id: legon.hostels.find((h: any) => h.name === 'Akuafo Hall').hostel_id, room_number: 'C3' } } };
  } else out = { reply: system.includes('CHANNEL: WhatsApp') ? 'Here you go.' : 'Tap Confirm.' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
}).listen(5056);
await db.exec(`update ai_provider_settings set is_enabled = false;
  insert into ai_provider_settings(name, provider, base_url, model, priority, requires_key) values ('Fake', 'openai_compatible', 'http://127.0.0.1:5056/v1', 'fake', 1, false);`);

// Fake phone
const ME = '233505690386@s.whatsapp.net';
const sent: { jid: string; text: string }[] = [];
const removed: string[] = [];
let n = 0;
const core = createCore({
  send: async (jid, text) => { sent.push({ jid, text }); return `bot-${++n}`; },
  resolve: async (num) => (num === '233999999999' ? null : `${num}@s.whatsapp.net`),
  remove: async (_jid, key: any) => { removed.push(key.id); },
}, { me: () => ME, aiMode: 'customers', notifySelf: true });

let passed = 0;
const ok = (s: string) => { passed++; console.log(`  ✓ ${s}`); };
const KOFI = '233244000111@s.whatsapp.net';
const msg = (jid: string, text: string, fromMe = false, id = `m-${Math.random()}`) => core.onMessage({ jid, id, fromMe, text, phone: `+${jid.split('@')[0]}`, isSelf: jid === ME, key: { id } });
const lastTo = (jid: string) => [...sent].reverse().find((s) => s.jid === jid)?.text ?? '';

await db.query(`insert into alert_recipients(label, distributor_id, whatsapp) select 'Kwame', id, '0240000001' from distributors where name = 'Legon North'`);
await db.query(`insert into alert_recipients(label, distributor_id, whatsapp) select 'Ama', id, '0240000002' from distributors where name = 'Legon South'`);

// 1. A friend saying hi is left alone
await msg('233200000000@s.whatsapp.net', 'Hey, how far? Are we still meeting later?');
assert.equal(sent.length, 0);
ok('Personal chats are left alone (no shop words, never ordered)');

// 2. A customer asks → AI replies with a summary and "reply YES"
await msg(KOFI, 'Do you have condoms? 2 to Akuafo Hall room C3');
const s1 = lastTo(KOFI);
assert.match(s1, /Here you go\./);
assert.match(s1, /2 × Classic Condoms \(3-pack\)/);
assert.match(s1, /Reply \*YES\*/);
assert.match(s1, /Akuafo Hall · Room C3/);
ok('Customer gets the same AI as the website, with an order summary to confirm');

// 3. YES places the order, with their WhatsApp number as the phone
await msg(KOFI, 'yes');
const done = lastTo(KOFI);
assert.match(done, /Order \*SP-[A-Z0-9]{6}\*/);
assert.match(done, /Delivery contact: .*0240000001/);
const [order] = (await db.query<any>(`select reference, phone, source from orders order by created_at desc limit 1`)).rows;
assert.equal(order.phone, '+233244000111');
assert.equal(order.source, 'assistant');
ok('Replying YES places the order and gives the delivery contact');

// 4. The order lands in your own chat and the distributor's
await new Promise((r) => setTimeout(r, 300)); await core.alertsTick();
assert.match(lastTo(ME), new RegExp(`New order ${order.reference}`));
assert.match(lastTo(ME), /Kofi · \+233244000111/);
assert.match(lastTo('233240000001@s.whatsapp.net'), new RegExp(order.reference));
assert.equal(lastTo('233240000002@s.whatsapp.net'), '');
ok('New order goes to your "Message yourself" chat and only to the distributor delivering it');

// 5. Nothing is sent twice
const before = sent.length;
await core.alertsTick();
assert.equal(sent.length, before);
ok('Each alert is sent once');

// 6. You reply yourself → AI stays quiet in that chat
await msg(KOFI, 'Thanks bro, I will call you', true, 'human-1');
const b2 = sent.length;
await msg(KOFI, 'how much is the lube?');
assert.equal(sent.length, b2);
ok('When you type in a chat yourself, the AI steps back');

// 7. /ai on and /ai off per chat (the command is deleted from the chat)
await msg(KOFI, '/ai on', true, 'cmd-1');
assert.deepEqual(removed, ['cmd-1']);
await msg(KOFI, 'Do you have condoms?');
assert.ok(sent.length > b2);
await msg(KOFI, '/ai off', true, 'cmd-2');
const b3 = sent.length;
await msg(KOFI, 'Do you have condoms?');
assert.equal(sent.length, b3);
ok('"/ai on" and "/ai off" switch the AI for one chat');

// 8. A returning customer (has ordered before) gets replies even without shop words
const legonId = (await db.query<any>(`select id from institutions where short_name = 'Legon'`)).rows[0].id;
const akuafo = (await db.query<any>(`select id from hostels where name = 'Akuafo Hall'`)).rows[0].id;
const condom = (await db.query<any>(`select id from products where slug = 'classic-condoms-3'`)).rows[0].id;
await db.query(`select public.place_order($1::jsonb)`, [JSON.stringify({ items: [{ product_id: condom, quantity: 1 }], customer: { name: 'Esi', phone: '0277000000' },
  location: { type: 'on_campus', institution_id: legonId, hostel_id: akuafo, room_number: 'A1' } })]);
await msg('233277000000@s.whatsapp.net', 'Hello?');
assert.ok(lastTo('233277000000@s.whatsapp.net').length > 0);
ok('People who have ordered before always get a reply');

// 9. Test button in the admin
const [r] = (await db.query<any>(`select id from alert_recipients where label = 'Kwame'`)).rows;
await db.query(`insert into notifications(type, title, body, notified_at) values ('test', 'Test from SarahPetermore ✅', $1, now())`, [`wa:${r.id}`]);
await core.alertsTick(); await new Promise((r) => setTimeout(r, 400));
assert.match(lastTo('233240000001@s.whatsapp.net'), /Test from SarahPetermore/);
const [res] = (await db.query<any>(`select last_result from alert_recipients where id = $1`, [r.id])).rows;
assert.equal(res.last_result, 'WhatsApp sent');
ok('"Test" in the admin sends a WhatsApp and records the result');

// 10. Group alerts: "/alerts here" in a group, then new orders are posted there too
const GROUP = '120363000000000000@g.us';
await core.onMessage({ jid: GROUP, id: 'g-cmd', fromMe: true, text: '/alerts here', phone: null, isSelf: false, isGroup: true, key: { id: 'g-cmd' } });
assert.ok(removed.includes('g-cmd'));
assert.match(lastTo(GROUP), /New orders will be posted here/);
await core.onMessage({ jid: GROUP, id: 'g-1', fromMe: false, text: 'do you have condoms?', phone: null, isSelf: false, isGroup: true, key: { id: 'g-1' } });
assert.match(lastTo(GROUP), /New orders will be posted here/); // no AI replies in groups
await db.query(`select public.place_order($1::jsonb)`, [JSON.stringify({ items: [{ product_id: condom, quantity: 1 }], customer: { name: 'Yaw', phone: '0201234567' },
  location: { type: 'on_campus', institution_id: legonId, hostel_id: akuafo, room_number: 'D4' } })]);
await core.alertsTick(); await new Promise((r) => setTimeout(r, 300));
assert.match(lastTo(GROUP), /New order SP-.*[\s\S]*Yaw/);
assert.match(lastTo(ME), /Yaw/);
ok('"/alerts here" posts every new order to a group as well as your own chat (no AI replies in groups)');
await core.onMessage({ jid: GROUP, id: 'g-off', fromMe: true, text: '/alerts off', phone: null, isSelf: false, isGroup: true, key: { id: 'g-off' } });
assert.equal(core._state.alertChats.length, 0);
ok('"/alerts off" stops it');

llm.close();
console.log(`\n${passed} passed`);
process.exit(0);
