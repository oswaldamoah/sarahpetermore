// Order alerts: a real order placed in PGlite, WhatsApp/email calls captured instead of sent.
// Usage: npx tsx tests/notify.test.ts
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { __setQueryRunner } from '../web/api/_lib/db.ts';
import { POST as notify } from '../web/api/notify.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'db');
const db = new PGlite();
await db.exec(`create schema auth; create function auth.user_id() returns text language sql stable as $$ select null::text $$;
  create schema neon_auth; create table neon_auth."user"(id uuid primary key default gen_random_uuid(), email text, name text);`);
for (const f of readdirSync(join(root, 'migrations')).sort()) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
await db.exec(readFileSync(join(root, 'demo_seed.sql'), 'utf8'));
__setQueryRunner(async (text, params) => (await db.query(text, params as any[])).rows as any[]);

let passed = 0;
const ok = (n: string) => { passed++; console.log(`  ✓ ${n}`); };

// Capture outgoing calls
const calls: { url: string; body?: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  if (url.includes('resend')) return new Response('{"id":"x"}', { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = 'test'; process.env.SITE_URL = 'https://sarahpetermore.vercel.app';

const id = async (sql: string) => (await db.query<any>(sql)).rows[0].id;
const north = await id(`select id from distributors where name = 'Legon North'`);
const south = await id(`select id from distributors where name = 'Legon South'`);
await db.query(`insert into alert_recipients(label, email) values ('Owner', 'owner@example.com')`);
await db.query(`insert into alert_recipients(label, distributor_id, email) values ('Kwame', $1, 'kwame@example.com')`, [north]);
await db.query(`insert into alert_recipients(label, distributor_id, email) values ('Ama', $1, 'ama@example.com')`, [south]);

const legon = await id(`select id from institutions where short_name = 'Legon'`);
const akuafo = await id(`select id from hostels where name = 'Akuafo Hall'`);
const condom = await id(`select id from products where slug = 'classic-condoms-3'`);
const order = await db.transaction(async (tx) => {
  await tx.exec('set local role anonymous');
  return (await tx.query<any>(`select public.place_order($1::jsonb) as r`, [JSON.stringify({ items: [{ product_id: condom, quantity: 2 }],
    customer: { name: 'Abena K.', phone: '0245551234' }, location: { type: 'on_campus', institution_id: legon, hostel_id: akuafo, room_number: 'B214' } })])).rows[0].r;
});

const res = await (await notify(new Request('http://x/api/notify', { method: 'POST' }))).json() as any;
assert.equal(res.sent, 1);
const emails = calls.filter((c) => c.url.includes('resend')).map((c) => c.body);
const owner = emails.find((e) => e.to[0] === 'owner@example.com');
assert.ok(owner, 'owner gets an email');
assert.equal(owner.from, 'SarahPetermore <onboarding@resend.dev>');
assert.match(owner.subject, new RegExp(order.reference));
assert.match(owner.text, /2 × Classic Condoms \(3-pack\)/);
assert.match(owner.text, /Akuafo Hall · Room B214/);
assert.match(owner.text, /Abena K\. · 0245551234/);
assert.match(owner.text, /https:\/\/sarahpetermore\.vercel\.app\/admin\/orders\//);
ok('Owner gets the full order by email through Resend (items, hostel, room, customer, link)');

assert.ok(emails.some((e) => e.to[0] === 'kwame@example.com'), 'the distributor holding the stock is emailed');
assert.ok(!emails.some((e) => e.to[0] === 'ama@example.com'), 'other distributors are not');
ok('Only the distributor delivering the order gets it');

const [r] = (await db.query<any>(`select last_result from alert_recipients where label = 'Owner'`)).rows;
assert.equal(r.last_result, 'Email sent');
ok('Delivery result is recorded for the admin');

calls.length = 0;
const again = await (await notify(new Request('http://x/api/notify', { method: 'POST' }))).json() as any;
assert.equal(again.sent, 0); assert.equal(calls.length, 0);
ok('Nothing is sent twice');

console.log(`\n${passed} passed`);
process.exit(0);
