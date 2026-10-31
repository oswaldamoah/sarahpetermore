// End-to-end test of the 24/7 Customer Service function without internet:
// real migrations in PGlite + a scripted fake OpenAI-compatible model on localhost.
// Usage: npx tsx tests/assistant.test.ts
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { __setQueryRunner } from '../web/api/_lib/db.ts';
import { POST as customerAssistant } from '../web/api/customer-assistant.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'db');
const db = new PGlite();
await db.exec(`create schema auth; create function auth.user_id() returns text language sql stable as $$ select null::text $$;
  create schema neon_auth; create table neon_auth."user"(id uuid primary key default gen_random_uuid(), email text, name text);`);
for (const f of readdirSync(join(root, 'migrations')).sort()) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
await db.exec(readFileSync(join(root, 'demo_seed.sql'), 'utf8'));
await db.exec(`update system_settings set value = '"0302 000 000"' where key = 'contact_business_phone'; update system_settings set value = '"sarahpetermore"' where key = 'contact_snapchat'`);
// The functions run as the database owner (like on Neon with DATABASE_URL)
__setQueryRunner(async (text, params) => (await db.query(text, params as any[])).rows as any[]);

// ---- fake model: decides the next step from the conversation so far ----
const seen: string[] = [];
const llm = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const { messages } = JSON.parse(raw);
  const tr = (name: string) => {
    const m = [...messages].reverse().find((x: any) => x.content.startsWith(`TOOL_RESULT ${name}:`));
    return m ? JSON.parse(m.content.slice(`TOOL_RESULT ${name}: `.length)) : null;
  };
  const lastUser = [...messages].reverse().find((x: any) => x.role === 'user' && !x.content.startsWith('TOOL_RESULT'));
  let out: unknown;
  if (lastUser.content.includes('person')) out = { reply: "I'm SarahPetermore's automated customer service. To reach a person, call 0302 000 000." };
  else if (!tr('search_products')) out = { tool: 'search_products', args: { query: 'condoms' } };
  else if (!tr('get_locations')) out = { tool: 'get_locations', args: {} };
  else if (!tr('prepare_order')) {
    const product = tr('search_products')[0];
    const legon = tr('get_locations').find((i: any) => i.short === 'Legon');
    const hostel = legon.hostels.find((h: any) => h.name === 'Akuafo Hall');
    out = { tool: 'prepare_order', args: { items: [{ product_id: product.product_id, quantity: 2 }], customer: { name: 'Ama', phone: '0244111222' },
      location: { type: 'on_campus', institution_id: legon.institution_id, hostel_id: hostel.hostel_id, room_number: 'B12' } } };
  } else out = { reply: 'Check the summary and tap "Confirm order".' };
  seen.push(JSON.stringify(out).slice(0, 60));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(out) + '\n```' } }] }));
}).listen(5055);
await db.exec(`update ai_provider_settings set is_enabled = false;
  insert into ai_provider_settings(name, provider, base_url, model, priority, requires_key) values ('Fake', 'openai_compatible', 'http://127.0.0.1:5055/v1', 'fake', 1, false);`);

const call = async (body: unknown) => (await customerAssistant(new Request('http://x/api/customer-assistant', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(body) }))).json() as Promise<any>;
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

const session = 'test-session-0001';
const r1 = await call({ session_id: session, message: 'I need 2 condoms at Akuafo Hall room B12. Ama, 0244111222' });
assert.equal(r1.fallback, false);
assert.ok(r1.draft, 'a draft order card is returned');
assert.equal(r1.draft.payload.items[0].quantity, 2);
assert.equal(r1.draft.hostel_name, 'Akuafo Hall');
assert.equal(Number(r1.draft.quote.total), 24);
assert.equal(r1.draft.quote.delivery_method, 'distributor');
assert.match(r1.reply, /Confirm order/);
ok('Chat order: searches the real catalogue, maps the hostel, returns a priced draft for the customer to confirm');
assert.equal((await db.query(`select count(*)::int n from orders`)).rows[0].n, 0);
ok('No order exists until the customer confirms');

// The browser's Confirm button calls place_order as a visitor
const placed = await db.transaction(async (tx) => {
  await tx.exec('set local role anonymous');
  return (await tx.query(`select public.place_order($1::jsonb) as r`, [JSON.stringify(r1.draft.payload)])).rows[0].r as any;
});
assert.match(placed.reference, /^SP-/);
assert.equal(placed.contacts.primary[0].phone, '0240000001');
ok('Confirming places the order and returns the distributor contact');
const r2 = await call({ session_id: session, event: { type: 'order_placed', reference: placed.reference } });
assert.equal(r2.ok, true);
const mem = (await db.query(`select messages from ai_conversations where session_key = $1`, [session])).rows[0] as any;
assert.ok(JSON.stringify(mem.messages).includes(placed.reference));
ok('Conversation memory is stored server-side and records the order');

const r3 = await call({ session_id: session, message: 'Am I talking to a person?' });
assert.match(r3.reply, /automated/);
ok('Answers honestly when asked if it is a person');

llm.close();
await db.exec(`update ai_provider_settings set base_url = 'http://127.0.0.1:5999/v1' where name = 'Fake'`);
const r4 = await call({ session_id: 'test-session-0002', message: 'do you have lubricant' });
assert.equal(r4.fallback, true);
assert.match(r4.reply, /Water-based Lubricant 100ml — GH₵ 45.00/);
assert.doesNotMatch(r4.reply, /0302 000 000/);
assert.match(r4.reply, /Snapchat|this chat/);
ok('If every AI provider is down, customers still get real products and prices, and no private phone number');
const fails = (await db.query(`select count(*)::int n from ai_usage where not success`)).rows[0] as any;
assert.ok(fails.n >= 1);
ok('Provider failures are logged for the admin');
// ---- flaky network: every 3rd database call drops once → retries keep the chat working
const realRunner = async (text: string, params: unknown[]) => (await db.query(text, params as any[])).rows as any[];
let calls = 0;
__setQueryRunner(async (text, params) => { calls++; if (calls % 3 === 0) throw new Error('Error connecting to database: TypeError: fetch failed'); return realRunner(text, params); });
const r5 = await call({ session_id: 'test-session-0003', message: 'pregnancy test' });
assert.equal(typeof r5.reply, 'string'); assert.ok(!r5.error);
ok('A dropped connection mid-chat is retried; the customer still gets a reply');

// ---- database completely unreachable → still a friendly reply, never an error
__setQueryRunner(async () => { throw new Error('Error connecting to database: TypeError: fetch failed'); });
const res = await customerAssistant(new Request('http://x/api/customer-assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'test-session-0004', message: 'hello' }) }));
assert.equal(res.status, 200);
const r6 = await res.json() as any;
assert.equal(r6.fallback, true); assert.match(r6.reply, /shop|reach/);
ok('If the database is unreachable the chat answers politely instead of erroring');
__setQueryRunner(realRunner);

// ---- a provider retired its model → the gateway discovers a replacement, uses it and saves it
const groqLike = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    return res.end(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }, { id: 'openai/gpt-oss-120b' }] }));
  }
  const { model } = JSON.parse(raw);
  if (model !== 'openai/gpt-oss-120b') { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: `The model \`${model}\` does not exist or you do not have access to it.` } })); }
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'Yes, we have pregnancy tests.' }) } }] }));
}).listen(5056);
await db.exec(`update ai_provider_settings set is_enabled = false;
  insert into ai_provider_settings(name, provider, base_url, model, priority, requires_key) values ('GroqLike', 'groq', 'http://127.0.0.1:5056/openai/v1', 'llama-3.3-70b-versatile', 1, false);`);
const r7 = await call({ session_id: 'test-session-0005', message: 'pregnancy test?' });
assert.equal(r7.fallback, false); assert.match(r7.reply, /pregnancy tests/);
const [saved] = (await db.query(`select model from ai_provider_settings where name = 'GroqLike'`)).rows as any[];
assert.equal(saved.model, 'openai/gpt-oss-120b');
ok('A retired model name is replaced automatically with the provider\'s current model, and remembered');
groqLike.close();

console.log(`\n${passed} passed`);
process.exit(0);
