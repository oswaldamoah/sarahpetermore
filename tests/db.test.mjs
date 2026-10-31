// Runs the real migrations (db/migrations) inside PGlite (Postgres compiled to WASM) with a
// minimal stand-in for what Neon provides (auth.user_id(), neon_auth.user), then exercises the acceptance scenarios.
// Usage: node tests/db.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const db = new PGlite();

// Minimal stand-in for what Neon provides: the pg_session_jwt `auth` schema (auth.user_id())
// and the Neon Auth user table. The Data API roles are created by the migrations if missing.
const NEON_STUB = `
create schema auth;
create function auth.user_id() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '') $$;
create schema neon_auth;
create table neon_auth."user" (id uuid primary key default gen_random_uuid(), email text unique, name text);
`;

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { results.push(`  ✗ ${name}\n      ${e.message}`); }
}

// Run SQL as a given user (null = anonymous visitor) inside a transaction, like PostgREST does.
async function as(uid, sql, params = []) {
  const role = uid ? 'authenticated' : 'anonymous';
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    await tx.exec(`set local role ${role}`);
    const r = await tx.query(sql, params);
    return r.rows;
  });
}
const one = async (uid, sql, params) => (await as(uid, sql, params))[0];
const rpc = async (uid, fn, args) => {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
  return (await one(uid, sql, vals)).r;
};
const sys = async (sql, params) => (await db.query(sql, params)).rows;
async function expectError(promise, pattern) {
  try { await promise; } catch (e) { assert.match(e.message, pattern); return; }
  assert.fail(`expected error matching ${pattern}`);
}

// ---------- setup ----------
await db.exec(NEON_STUB);
await db.exec(`grant usage on schema auth to public; grant execute on all functions in schema auth to public;`);
async function runFile(path) {
  try { await db.exec(readFileSync(path, 'utf8')); }
  catch (e) { console.error(`\n✗ ${path}\n  ${e.message}\n  position: ${e.position} ${e.where ?? ''}`); process.exit(1); }
}
for (const f of readdirSync(join(root, 'migrations')).sort()) await runFile(join(root, 'migrations', f));
await runFile(join(root, 'demo_seed.sql'));
console.log('Migrations applied.');

const [admin] = await sys(`insert into neon_auth."user"(email) values ('owner@example.com') returning id`);
const [clerk] = await sys(`insert into neon_auth."user"(email) values ('clerk@example.com') returning id`);
const [shopper] = await sys(`insert into neon_auth."user"(email) values ('shopper@example.com') returning id`);
await sys(`insert into user_roles(user_id, role) values ($1, 'super_admin'), ($2, 'order_manager')`, [admin.id, clerk.id]);
const A = admin.id, CLERK = clerk.id, SHOPPER = shopper.id;

const id = async (table, col, val) => (await sys(`select id from ${table} where ${col} = $1`, [val]))[0].id;
const stock = async (slug, dist) =>
  (await sys(`select i.on_hand, i.reserved, i.available from inventory i join products p on p.id = i.product_id
              join distributors d on d.id = i.distributor_id where p.slug = $1 and d.name = $2`, [slug, dist]))[0] ?? { on_hand: 0, reserved: 0, available: 0 };

const condom = await id('products', 'slug', 'classic-condoms-3');
const pill = await id('products', 'slug', 'emergency-pill');
const lube = await id('products', 'slug', 'lube-100');
const toy = await id('products', 'slug', 'personal-massager');
const legon = await id('institutions', 'short_name', 'Legon');
const upsa = await id('institutions', 'short_name', 'UPSA');
const akuafo = await id('hostels', 'name', 'Akuafo Hall');
const commonwealth = await id('hostels', 'name', 'Commonwealth Hall');
const bani = await id('hostels', 'name', 'Bani Hostel'); // no distributor serves it
const hq = await id('distributors', 'name', 'HQ Stock');
const north = await id('distributors', 'name', 'Legon North');
const south = await id('distributors', 'name', 'Legon South');
const customer = { name: 'Abena Test', phone: '024 555 1234' };

// ---------- storefront ----------
await test('Anonymous visitors see products but never cost prices', async () => {
  const rows = await as(null, `select * from storefront_products order by name`);
  assert.ok(rows.length >= 6);
  assert.ok(!('cost_price' in rows[0]) && !('base_price' in rows[0]));
  await expectError(as(null, `select cost_price from products`), /permission|denied|0 rows/i).catch(async () => {
    const r = await as(null, `select cost_price from products`); assert.equal(r.length, 0);
  });
});

await test("Goldy's 15% markup is applied to the customer price", async () => {
  const r = await one(null, `select price from storefront_products where slug = 'personal-massager'`);
  assert.equal(Number(r.price), 230.0);
});

await test('Goldy contact details are never exposed publicly', async () => {
  const r = await as(null, `select * from stakeholders`);
  assert.equal(r.length, 0);
});

// ---------- Scenario A ----------
let orderA;
await test('A: hostel order is created, stock reserved, distributor contact returned', async () => {
  const before = await stock('classic-condoms-3', 'Legon North');
  orderA = await rpc(null, 'place_order', { p: {
    items: [{ product_id: condom, quantity: 2 }],
    customer,
    location: { type: 'on_campus', institution_id: legon, hostel_id: akuafo, room_number: 'B-214' } } });
  assert.match(orderA.reference, /^SP-[A-Z0-9]{6}$/);
  assert.equal(orderA.delivery_method, 'distributor');
  assert.equal(orderA.room_number, 'B-214');
  assert.equal(Number(orderA.total), 24);
  const after = await stock('classic-condoms-3', 'Legon North');
  assert.equal(after.reserved, before.reserved + 2);
  assert.equal(after.on_hand, before.on_hand);
  assert.ok(orderA.contacts.primary.some((c) => c.phone === '0240000001'));
});

await test('A: frontend prices are ignored — server reprices', async () => {
  const o = await rpc(null, 'place_order', { p: {
    items: [{ product_id: condom, quantity: 1, price: 0.01 }], customer: { name: 'Kofi', phone: '0201112222' },
    location: { type: 'on_campus', institution_id: legon, hostel_id: akuafo } } });
  assert.equal(Number(o.total), 12);
});

await test('A: guest can track only with reference + matching phone', async () => {
  const t = await rpc(null, 'track_order', { p_reference: orderA.reference, p_phone: '+233245551234' });
  assert.equal(t.status, 'received');
  await expectError(rpc(null, 'track_order', { p_reference: orderA.reference, p_phone: '0209999999' }), /NOT_FOUND/);
});

// ---------- Scenario B ----------
await test('B: unsupported location → courier, no distributor falsely assigned for delivery', async () => {
  const o = await rpc(null, 'place_order', { p: {
    items: [{ product_id: pill, quantity: 1 }], customer: { name: 'Esi', phone: '0277000111' },
    location: { type: 'off_campus', address_line: 'East Legon, near A&C Mall', digital_address: 'GA-123-4567' } } });
  assert.equal(o.delivery_method, 'courier');
  const [ord] = await sys(`select id, fulfilment_mode, is_supported_location from orders where reference = $1`, [o.reference]);
  assert.equal(ord.fulfilment_mode, 'courier');
  assert.equal(ord.is_supported_location, false);
  const deliv = await sys(`select * from order_fulfilment_assignments where order_id = $1 and role = 'delivery'`, [ord.id]);
  assert.equal(deliv.length, 0);
  assert.ok(o.contacts.primary.every((c) => c.label.includes('SarahPetermore')));
});

await test('B: hostel with no distributor → courier', async () => {
  const q = await rpc(null, 'quote_order', { p_items: [{ product_id: condom, quantity: 1 }], p_hostel_id: bani });
  assert.equal(q.delivery_method, 'courier');
  assert.equal(q.supported_location, false);
});

// ---------- Scenario C ----------
await test('C: two distributors at one hostel — picks the one that can fill the whole order', async () => {
  // Commonwealth is served by North (has lube + pill) and South (has neither)
  const q = await rpc(null, 'quote_order', { p_items: [{ product_id: lube, quantity: 2 }, { product_id: pill, quantity: 1 }], p_hostel_id: commonwealth });
  assert.equal(q.delivery_method, 'distributor');
  assert.equal(q.split, false);
  const o = await rpc(null, 'place_order', { p: { items: [{ product_id: lube, quantity: 2 }, { product_id: pill, quantity: 1 }],
    customer: { name: 'Yaw', phone: '0551234567' }, location: { type: 'on_campus', institution_id: legon, hostel_id: commonwealth } } });
  const items = await sys(`select distinct distributor_id from order_items oi join orders o on o.id = oi.order_id where o.reference = $1`, [o.reference]);
  assert.deepEqual(items.map((i) => i.distributor_id), [north]);
});

await test('C: when no single distributor can fill it, the order is split across hostel distributors', async () => {
  // Commonwealth: North has 28 condoms available, South has 20 -> 40 needs both
  const q = await rpc(null, 'quote_order', { p_items: [{ product_id: condom, quantity: 40 }], p_hostel_id: commonwealth });
  assert.equal(q.delivery_method, 'distributor');
  assert.equal(q.split, true);
});

await test('C: if hostel distributors cannot cover it, fall back to courier from central stock', async () => {
  const q = await rpc(null, 'quote_order', { p_items: [{ product_id: condom, quantity: 60 }], p_hostel_id: commonwealth });
  assert.equal(q.delivery_method, 'courier');
  assert.equal(q.courier_fallback, true);
});

await test('C: impossible quantities are refused with a clear shortfall', async () => {
  await expectError(rpc(null, 'place_order', { p: { items: [{ product_id: toy, quantity: 50 }], customer: { name: 'Ben', phone: '0501111111' },
    location: { type: 'off_campus', address_line: 'Madina' } } }), /OUT_OF_STOCK: Personal Massager \(only 6 left\)/);
});

// ---------- Scenario D ----------
await test('D: disabling Goldy hides products and blocks purchase; history intact; reactivation restores', async () => {
  const toyOrder = await rpc(null, 'place_order', { p: { items: [{ product_id: toy, quantity: 1 }], customer: { name: 'Ama', phone: '0244000999' },
    location: { type: 'off_campus', address_line: 'Spintex' } } });
  assert.ok(toyOrder.contacts.primary[0].label.includes('SarahPetermore'));
  await as(A, `update stakeholders set status = 'inactive' where slug = 'goldy'`);
  assert.equal((await as(null, `select * from storefront_products where slug = 'personal-massager'`)).length, 0);
  await expectError(rpc(null, 'place_order', { p: { items: [{ product_id: toy, quantity: 1 }], customer: { name: 'Ama', phone: '0244000998' },
    location: { type: 'off_campus', address_line: 'Spintex' } } }), /no longer available/);
  const hist = await sys(`select count(*)::int n from order_items where product_id = $1`, [toy]);
  assert.equal(hist[0].n, 1);
  await as(A, `update stakeholders set status = 'active' where slug = 'goldy'`);
  assert.equal((await as(null, `select * from storefront_products where slug = 'personal-massager'`)).length, 1);
});

// ---------- Scenario E ----------
await test('E: disabling Lubricants hides its products and category; reactivation restores', async () => {
  await as(A, `update categories set status = 'inactive' where slug = 'lubricants'`);
  assert.equal((await as(null, `select * from storefront_products where category_slug = 'lubricants'`)).length, 0);
  assert.equal((await as(null, `select * from storefront_categories where slug = 'lubricants'`)).length, 0);
  assert.ok((await sys(`select count(*)::int n from order_items where product_id = $1`, [lube]))[0].n >= 1);
  await as(A, `update categories set status = 'active' where slug = 'lubricants'`);
  assert.equal((await as(null, `select * from storefront_products where category_slug = 'lubricants'`)).length, 1);
});

// ---------- Scenario F ----------
await test('F: transfer 15 units A→B — source drops at dispatch, destination rises only on receipt', async () => {
  await rpc(A, 'adjust_stock_batch', { p_adjustments: JSON.stringify([
    { product_id: pill, distributor_id: south, delta: 10 },
    { product_id: pill, distributor_id: hq, delta: 50 - (await stock('emergency-pill', 'HQ Stock')).on_hand }]), p_reason: 'Set up scenario F' });
  assert.equal((await stock('emergency-pill', 'HQ Stock')).on_hand, 50);
  const t = await rpc(A, 'create_transfer', { p: { source_distributor_id: hq, destination_distributor_id: south,
    items: [{ product_id: pill, quantity: 15 }], dispatch: true } });
  assert.equal(t.status, 'in_transit');
  assert.equal((await stock('emergency-pill', 'HQ Stock')).on_hand, 35);
  assert.equal((await stock('emergency-pill', 'Legon South')).on_hand, 10);
  await rpc(A, 'receive_transfer', { p_id: t.id });
  assert.equal((await stock('emergency-pill', 'Legon South')).on_hand, 25);
  const mv = await sys(`select movement_type from stock_movements where reference_id = $1 order by created_at`, [t.id]);
  assert.deepEqual(mv.map((m) => m.movement_type), ['transfer_out', 'transfer_in']);
});

await test('F: cancelling an in-transit transfer returns stock to the source', async () => {
  const t = await rpc(A, 'create_transfer', { p: { source_distributor_id: hq, destination_distributor_id: north,
    items: [{ product_id: pill, quantity: 5 }], dispatch: true } });
  assert.equal((await stock('emergency-pill', 'HQ Stock')).on_hand, 30);
  await rpc(A, 'cancel_transfer', { p_id: t.id, p_reason: 'test' });
  assert.equal((await stock('emergency-pill', 'HQ Stock')).on_hand, 35);
});

// ---------- Scenario G ----------
await test('G: restock adds 20 units, logs a movement, and records the expense exactly once', async () => {
  const before = (await stock('pregnancy-test', 'Legon South')).on_hand;
  const r = await rpc(A, 'record_restock', { p: { distributor_id: south, supplier: 'MedSupply', payment_status: 'paid',
    items: [{ product_id: await id('products', 'slug', 'pregnancy-test'), quantity: 20, unit_cost: 4.5 }] } });
  assert.equal(Number(r.total_cost), 90);
  assert.equal((await stock('pregnancy-test', 'Legon South')).on_hand, before + 20);
  const tx = await sys(`select * from financial_transactions where source_type = 'restock' and source_id = $1`, [r.id]);
  assert.equal(tx.length, 1);
  await expectError(rpc(A, 'mark_restock_paid', { p_id: r.id }), /already paid/);
  await expectError(sys(`insert into financial_transactions(type, direction, amount, source_type, source_id) values ('restock','out',90,'restock',$1)`, [r.id]), /duplicate|unique/i);
});

await test('G: unpaid restock adds stock but no cash until marked paid', async () => {
  const r = await rpc(A, 'record_restock', { p: { distributor_id: hq, payment_status: 'unpaid', items: [{ product_id: lube, quantity: 4, unit_cost: 10 }] } });
  assert.equal((await sys(`select * from financial_transactions where source_id = $1`, [r.id])).length, 0);
  await rpc(A, 'mark_restock_paid', { p_id: r.id, p_method: 'momo' });
  assert.equal((await sys(`select * from financial_transactions where source_id = $1`, [r.id])).length, 1);
});

// ---------- Inventory rules ----------
await test('Stock cannot go negative without an authorised override', async () => {
  const s = await stock('lube-100', 'Legon North');
  await expectError(rpc(A, 'adjust_stock_batch', { p_adjustments: JSON.stringify([{ product_id: lube, distributor_id: north, delta: -(s.on_hand + 5) }]) }), /negative|reserved/);
  await expectError(rpc(CLERK, 'adjust_stock_batch', { p_adjustments: JSON.stringify([{ product_id: lube, distributor_id: north, delta: 1 }]) }), /FORBIDDEN/);
});

await test('Preview shows before / change / after without committing', async () => {
  const s = await stock('classic-condoms-3', 'UPSA Team');
  const p = await rpc(A, 'preview_stock_adjustments', { p_adjustments: JSON.stringify([{ product_id: condom, distributor_id: await id('distributors', 'name', 'UPSA Team'), delta: 5 }]) });
  assert.equal(p[0].before, s.on_hand); assert.equal(p[0].after, s.on_hand + 5);
  assert.equal((await stock('classic-condoms-3', 'UPSA Team')).on_hand, s.on_hand);
});

await test('Stock movements are immutable', async () => {
  await expectError(sys(`update stock_movements set quantity = 999`), /IMMUTABLE/);
});

// ---------- Scenario H ----------
await test('H: unpaid order adds no cash; payment on delivery updates cash; partner proceeds separated', async () => {
  const cash = async () => Number((await sys(`select coalesce(sum(case when direction='in' then amount else -amount end),0) c from financial_transactions where not is_reversed and reverses_id is null`))[0].c);
  const c0 = await cash();
  const o = await rpc(null, 'place_order', { p: { items: [{ product_id: toy, quantity: 1 }, { product_id: condom, quantity: 1 }],
    customer: { name: 'Kwesi', phone: '0266000111' }, location: { type: 'on_campus', institution_id: legon, hostel_id: akuafo } } });
  assert.equal(await cash(), c0);
  const [ord] = await sys(`select id from orders where reference = $1`, [o.reference]);
  await rpc(CLERK, 'update_order_status', { p_order: ord.id, p_status: 'delivered', p_note: 'Handed over' });
  assert.equal(await cash(), c0);
  await rpc(CLERK, 'record_order_payment', { p_order: ord.id, p_amount: 242, p_method: 'momo' });
  assert.equal(await cash(), c0 + 242);
  const items = await sys(`select product_name, line_total, platform_revenue, stakeholder_proceeds from order_items where order_id = $1 order by product_name`, [ord.id]);
  const t = items.find((i) => i.product_name === 'Personal Massager');
  assert.equal(Number(t.line_total), 230); assert.equal(Number(t.stakeholder_proceeds), 200); assert.equal(Number(t.platform_revenue), 30);
  const c = items.find((i) => i.product_name.startsWith('Classic'));
  assert.equal(Number(c.platform_revenue), 12); assert.equal(Number(c.stakeholder_proceeds), 0);
  const [bal] = await as(A, `select * from stakeholder_balances() where name = 'Goldy'`);
  assert.equal(Number(bal.outstanding), 200);
  const rep = await rpc(A, 'finance_report', { p_from: '2020-01-01', p_to: '2099-01-01' });
  assert.equal(Number(rep.stakeholder_proceeds), 200);
  assert.equal(Number(rep.net_sales) - Number(rep.stakeholder_proceeds), Number(rep.platform_sales));
});

await test('Delivered order converts reservation into a stock deduction', async () => {
  const before = await stock('classic-condoms-3', 'Legon North');
  const [ord] = await sys(`select id from orders where reference = $1`, [orderA.reference]);
  await rpc(CLERK, 'update_order_status', { p_order: ord.id, p_status: 'delivered' });
  const after = await stock('classic-condoms-3', 'Legon North');
  assert.equal(after.on_hand, before.on_hand - 2); assert.equal(after.reserved, before.reserved - 2);
  const hist = await sys(`select from_status, to_status, changed_by from order_status_history where order_id = $1 order by created_at`, [ord.id]);
  assert.equal(hist.at(-1).to_status, 'delivered'); assert.equal(hist.at(-1).changed_by, CLERK);
});

await test('Cancelling releases reserved stock; delivered orders cannot be cancelled', async () => {
  const o = await rpc(null, 'place_order', { p: { items: [{ product_id: condom, quantity: 3 }], customer: { name: 'Adjoa', phone: '0241231231' },
    location: { type: 'on_campus', institution_id: legon, hostel_id: akuafo } } });
  const [ord] = await sys(`select id from orders where reference = $1`, [o.reference]);
  const mid = await stock('classic-condoms-3', 'Legon North');
  await rpc(CLERK, 'update_order_status', { p_order: ord.id, p_status: 'cancelled', p_note: 'Customer changed mind' });
  assert.equal((await stock('classic-condoms-3', 'Legon North')).reserved, mid.reserved - 3);
  const [delivered] = await sys(`select id from orders where reference = $1`, [orderA.reference]);
  await expectError(rpc(CLERK, 'update_order_status', { p_order: delivered.id, p_status: 'cancelled' }), /INVALID_TRANSITION/);
});

await test('Order status cannot be changed by a direct table update', async () => {
  const [ord] = await sys(`select id from orders where reference = $1`, [orderA.reference]);
  await expectError(as(CLERK, `update orders set status = 'received' where id = $1`, [ord.id]), /FORBIDDEN/);
  await as(CLERK, `update orders set internal_notes = 'Gate 2' where id = $1`, [ord.id]);
});

await test('Refunds create their own ledger entries and cannot exceed what was collected', async () => {
  const [ord] = await sys(`select id, amount_paid from orders where customer_name = 'Kwesi'`);
  await expectError(rpc(CLERK, 'create_refund', { p_order: ord.id, p_amount: 9999, p_reason: 'x' }), /cannot exceed/);
  await rpc(CLERK, 'create_refund', { p_order: ord.id, p_amount: 12, p_reason: 'Damaged pack', p_method: 'momo', p_paid: true });
  const tx = await sys(`select * from financial_transactions where type = 'refund'`);
  assert.equal(tx.length, 1); assert.equal(tx[0].direction, 'out');
});

await test('Expenses post to the ledger and edits create reversals, not silent changes', async () => {
  const [e] = await as(A, `insert into expenses(name, category, amount) values ('Rider fuel', 'Delivery', 50) returning id`);
  await as(A, `update expenses set amount = 60 where id = $1`, [e.id]);
  const tx = await sys(`select direction, amount, is_reversed, reverses_id is not null as is_reversal from financial_transactions where source_id = $1 order by created_at`, [e.id]);
  assert.equal(tx.length, 3);
  await expectError(sys(`delete from financial_transactions where source_id = $1`, [e.id]), /IMMUTABLE/);
});

// ---------- Permissions ----------
await test('Anonymous users cannot call admin functions or read orders', async () => {
  await expectError(rpc(null, 'adjust_stock_batch', { p_adjustments: '[]' }), /FORBIDDEN/);
  await expectError(rpc(null, 'update_order_status', { p_order: condom, p_status: 'delivered' }), /FORBIDDEN/);
  assert.equal((await as(null, `select * from orders`)).length, 0);
  assert.equal((await as(SHOPPER, `select * from orders`)).length, 0);
  await expectError(as(null, `select private.apply_stock(null, null, 1, 0, 'adjustment_in')`), /permission denied/);
});

await test('AI provider keys are unreadable from the browser', async () => {
  await rpc(A, 'save_ai_provider', { p: { id: await id('ai_provider_settings', 'provider', 'groq'), api_key: 'gsk_secret_1234' } });
  await expectError(as(A, `select * from ai_provider_secrets`), /permission denied/);
  await expectError(as(null, `select * from ai_provider_secrets`), /permission denied/);
  const [s] = await as(A, `select has_key, key_last4 from ai_provider_settings where provider = 'groq'`);
  assert.equal(s.has_key, true); assert.equal(s.key_last4, '1234');
});

await test('Logged-in customers see only their own orders via my_orders', async () => {
  await rpc(SHOPPER, 'place_order', { p: { items: [{ product_id: condom, quantity: 1 }], customer: { name: 'Shopper', phone: '0249998888' },
    location: { type: 'off_campus', address_line: 'Osu' } } });
  const mine = await rpc(SHOPPER, 'my_orders', {});
  assert.equal(mine.length, 1);
});

// ---------- Scenario K: import ----------
await test('K: CSV import validates, previews, detects duplicates, then writes', async () => {
  const rows = [
    { product_name: 'Strawberry Lube 50ml', category: 'Lubricants', cost_price: '8', selling_price: '20', stock_quantity: '12', unit: 'bottle' },
    { product_name: 'Strawberry Lube 50ml', category: 'Lubricants', cost_price: '8', selling_price: '20', stock_quantity: '1', unit: 'bottle' },
    { product_name: '', category: 'X', cost_price: 'abc', selling_price: '1', stock_quantity: '1', unit: 'pc' }];
  const dry = await rpc(A, 'import_stock', { p_rows: JSON.stringify(rows), p_distributor: north, p_dry_run: true });
  assert.equal(dry.summary.create, 1); assert.equal(dry.summary.errors, 2);
  await expectError(rpc(A, 'import_stock', { p_rows: JSON.stringify(rows), p_distributor: north, p_dry_run: false }), /Fix the highlighted rows/);
  const res = await rpc(A, 'import_stock', { p_rows: JSON.stringify(rows), p_distributor: north, p_dry_run: false, p_skip_invalid: true });
  assert.equal(res.summary.created, 1); assert.equal(res.summary.skipped, 2);
  assert.equal((await stock('strawberry-lube-50ml', 'Legon North')).on_hand, 12);
});

await test('Analytics: sales breakdown by hostel and reconciliation run', async () => {
  const rows = await as(A, `select * from sales_breakdown('2020-01-01', '2099-01-01', 'hostel', 'placed')`);
  assert.ok(rows.some((r) => r.label === 'Akuafo Hall'));
  const rec = await rpc(A, 'reconciliation', { p_day: new Date().toISOString().slice(0, 10) });
  assert.ok(Array.isArray(rec) && rec.length >= 3);
  const d = await rpc(A, 'dashboard_stats', { p_from: '2020-01-01', p_to: '2099-01-01' });
  assert.ok(d.orders_total > 0 && d.finance);
});

await test('Audit log records admin changes', async () => {
  const n = (await sys(`select count(*)::int n from audit_logs where entity_type = 'stakeholders' and actor_id = $1`, [A]))[0].n;
  assert.ok(n >= 2);
});

await test('Neon: anonymous tokens never count as a signed-in user', async () => {
  // An anonymous Data API token may still carry a subject claim; it must not identify a customer.
  const r = await db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [SHOPPER]);
    await tx.exec('set local role anonymous');
    return (await tx.query(`select public.current_user_id() as uid, public.my_orders() as mine`)).rows[0];
  });
  assert.equal(r.uid, null);
  assert.deepEqual(r.mine, []);
});

await test('Neon: whoami and ensure_profile work for signed-in users', async () => {
  const w = await rpc(A, 'whoami', {});
  assert.equal(w.user_id, A); assert.deepEqual(w.roles, ['super_admin']);
  await rpc(SHOPPER, 'ensure_profile', { p_full_name: 'Shopper', p_phone: '0249998888' });
  const [p] = await sys(`select full_name from profiles where id = $1`, [SHOPPER]);
  assert.equal(p.full_name, 'Shopper');
  const staff = await as(A, `select * from list_staff()`);
  assert.ok(staff.some((s) => s.email === 'owner@example.com' && s.roles.includes('super_admin')));
});

console.log(results.join('\n'));
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
