// Visual + integration check: serves the built app, answers its Neon Data API (PostgREST) calls from PGlite
// (the real migrations + demo data), then screenshots key screens with Playwright.
// and imitates the Neon Auth endpoints (session + anonymous token) the browser SDK uses.
// Usage: node tests/preview.mjs   (expects web/dist-preview built with the AUTH/DATA URLs below)
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'screenshots');
mkdirSync(out, { recursive: true });

const db = new PGlite();
const AUTH = 'https://ep-demo.neonauth.c-2.eu-central-1.aws.neon.tech/neondb/auth';
const DATA = 'https://ep-demo.apirest.c-2.eu-central-1.aws.neon.tech/neondb/rest/v1';
await db.exec(`create schema auth; create function auth.user_id() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '') $$;
grant usage on schema auth to public; create schema neon_auth; create table neon_auth."user" (id uuid primary key default gen_random_uuid(), email text unique, name text);`);
for (const f of readdirSync(join(root, 'web/db/migrations')).sort()) await db.exec(readFileSync(join(root, 'web/db/migrations', f), 'utf8'));
await db.exec(readFileSync(join(root, 'web/db/demo_seed.sql'), 'utf8'));
const [admin] = (await db.query(`insert into neon_auth."user"(email, name) values ('owner@example.com', 'Owner') returning id`)).rows;
await db.query(`insert into user_roles values ($1, 'super_admin')`, [admin.id]);
await db.exec(`update system_settings set value = '"0302 000 000"' where key = 'contact_business_phone';
update system_settings set value = '"sarahpetermore"' where key = 'contact_snapchat';
update system_settings set value = '"0550 000 000"' where key = 'contact_whatsapp';`);

async function as(uid, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    await tx.exec(`set local role ${uid ? 'authenticated' : 'anonymous'}`);
    return (await tx.query(sql, params)).rows;
  });
}
// Seed some orders so admin screens have content
const ids = Object.fromEntries((await db.query(`select slug, id from products`)).rows.map((r) => [r.slug, r.id]));
const legon = (await db.query(`select id from institutions where short_name='Legon'`)).rows[0].id;
const hostel = async (n) => (await db.query(`select id from hostels where name=$1`, [n])).rows[0].id;
const place = (p) => as(null, `select public.place_order($1) as r`, [JSON.stringify(p)]).then((r) => r[0].r);
const o1 = await place({ items: [{ product_id: ids['classic-condoms-3'], quantity: 2 }, { product_id: ids['pregnancy-test'], quantity: 1 }], customer: { name: 'Abena K.', phone: '0245551234' }, location: { type: 'on_campus', institution_id: legon, hostel_id: await hostel('Akuafo Hall'), room_number: 'B214' } });
await place({ items: [{ product_id: ids['personal-massager'], quantity: 1 }], customer: { name: 'Kofi A.', phone: '0201112222' }, location: { type: 'off_campus', address_line: 'East Legon, near the mall' } });
const o3 = await place({ items: [{ product_id: ids['emergency-pill'], quantity: 1 }], customer: { name: 'Esi M.', phone: '0277000111' }, location: { type: 'on_campus', institution_id: legon, hostel_id: await hostel('Commonwealth Hall') } });
await place({ items: [{ product_id: ids['lube-100'], quantity: 1 }, { product_id: ids['classic-condoms-3'], quantity: 1 }], customer: { name: 'Yaw D.', phone: '0551234567' }, location: { type: 'on_campus', institution_id: legon, hostel_id: await hostel('Volta Hall') } });
const oid = async (ref) => (await db.query(`select id from orders where reference=$1`, [ref])).rows[0].id;
await as(admin.id, `select public.update_order_status($1, 'delivered', 'Handed over')`, [await oid(o3.reference)]);
await as(admin.id, `select public.record_order_payment($1, 30, 'momo')`, [await oid(o3.reference)]);
await as(admin.id, `select public.update_order_status($1, 'out_for_delivery', null)`, [await oid(o1.reference)]);
await as(admin.id, `insert into expenses(name, category, amount) values ('Rider fuel', 'Delivery', 40)`);

// ---------------- minimal PostgREST emulation ----------------
const cols = new Map();
for (const r of (await db.query(`select table_name, column_name from information_schema.columns where table_schema='public'`)).rows) {
  if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
  cols.get(r.table_name).add(r.column_name);
}
const singular = (t) => (t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.endsWith('ses') ? t.slice(0, -2) : t.replace(/s$/, ''));
function splitTop(s) {
  const parts = []; let depth = 0, cur = '';
  for (const c of s) { if (c === '(') depth++; if (c === ')') depth--; if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c; }
  if (cur) parts.push(cur); return parts.map((p) => p.trim()).filter(Boolean);
}
async function project(uid, table, rows, select) {
  const items = splitTop(select || '*');
  const plain = items.filter((i) => !i.includes('('));
  const embeds = items.filter((i) => i.includes('('));
  return Promise.all(rows.map(async (row) => {
    const o = plain.includes('*') ? { ...row } : Object.fromEntries(plain.map((c) => [c.split(':').pop(), row[c.split(':').pop()]]));
    for (const e of embeds) {
      const m = e.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s);
      if (!m) continue;
      const [, alias, rel, hint, inner] = m;
      const key = alias ?? rel;
      const fk = hint && hint !== 'inner' ? hint.replace(`${table}_`, '').replace(/_fkey$/, '') : `${singular(rel)}_id`;
      if (cols.get(table)?.has(fk)) {
        const r = row[fk] ? await as(uid, `select * from ${rel} where id = $1`, [row[fk]]) : [];
        o[key] = r[0] ? (await project(uid, rel, r, inner))[0] : null;
      } else {
        const back = `${singular(table)}_id`;
        const r = cols.get(rel)?.has(back) ? await as(uid, `select * from ${rel} where ${back} = $1`, [row.id]) : [];
        o[key] = inner.trim() === 'count' ? [{ count: r.length }] : await project(uid, rel, r, inner);
      }
    }
    return o;
  }));
}
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
async function handleRest(req, body, uid) {
  const url = new URL(req.url());
  const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
  if (name.startsWith('rpc/')) {
    const fn = name.slice(4); const args = body ? JSON.parse(body) : {};
    const keys = Object.keys(args);
    const r = await as(uid, `select to_jsonb(t) as r from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) t`,
      keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
    const vals = r.map((x) => x.r);
    const single = vals.length === 1 && !(vals[0] && typeof vals[0] === 'object' && Object.keys(vals[0]).length > 1 && r.length > 1);
    const isSetof = (await db.query(`select proretset from pg_proc where proname=$1`, [fn])).rows[0]?.proretset;
    if (isSetof) return { body: vals };
    let v = vals[0]; if (v && typeof v === 'object' && fn in v && Object.keys(v).length === 1) v = v[fn];
    return { body: single ? v : vals };
  }
  if (req.method() !== 'GET') return { body: [] };
  const where = []; const params = [];
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(k) || k.includes('.')) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    if (op === 'in') { params.push(val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, ''))); where.push(`${k}::text = any($${params.length})`); }
    else if (op === 'is') where.push(`${k} is ${val}`);
    else if (OPS[op]) { params.push(val.replace(/\*/g, '%')); where.push(`${k}::text ${OPS[op]} $${params.length}`); }
  }
  let sql = `select * from ${name}${where.length ? ` where ${where.join(' and ')}` : ''}`;
  const order = url.searchParams.get('order');
  if (order) sql += ` order by ${order.split(',').map((o) => { const [c, d] = o.split('.'); return `${c} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}`;
  const all = await as(uid, sql, params);
  const range = req.headers()['range'];
  let rows = all;
  if (range) { const [a, b] = range.split('-').map(Number); rows = all.slice(a, b + 1); }
  else if (url.searchParams.get('limit')) rows = all.slice(Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('offset') ?? 0) + Number(url.searchParams.get('limit')));
  const data = await project(uid, name, rows, url.searchParams.get('select'));
  const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
  return { body: wantsObject ? data[0] ?? null : data, total: all.length };
}

for (const f of ['real_products.sql', 'pleasuretoysgh_products.sql', 'fiesta_products.sql']) await db.exec(readFileSync(join(root, 'web/db', f), 'utf8'));
await db.exec(`update products set is_featured = slug in ('fiesta-strawberry-condoms-3-pack','kiss-condoms-3-pack','lydia-postpil','cupisure-pregnancy-test-kit');
update system_settings set value = '"No long talk. Just get it."' where key = 'tagline';
update system_settings set value = '"Condoms, tests, postpills and toys. Packed plain, brought to you, paid for when it arrives."' where key = 'hero_subtitle';
insert into inventory(product_id, distributor_id, on_hand) select p.id, d.id, 20 from products p, distributors d where d.name = 'HQ Stock' and p.is_active and p.images[1] like '/img/%' on conflict (product_id, distributor_id) do update set on_hand = 20;`);

// ---------------- static server for the built app ----------------
const dist = join(root, 'web/dist-preview');
if (!existsSync(dist)) { console.error('Build web/dist-preview first'); process.exit(1); }
const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = join(dist, decodeURIComponent(req.url.split('?')[0]));
  const file = existsSync(p) && extname(p) ? p : join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'text/html' }); res.end(readFileSync(file));
}).listen(4173);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 86400;
const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: admin.id, role: 'authenticated', exp, email: 'owner@example.com' })}.sig`;
const anonToken = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anonymous', exp })}.anon`;
const cors = { 'access-control-allow-origin': 'http://localhost:4173', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const stats = { auth: {}, data: { admin: 0, 'anonymous-token': 0, other: 0, 'no-token': 0 }, errors: [] };

const browser = await chromium.launch();
async function shoot(name, path, { mobile = false, adminSession = false, before, wait = 1200 } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true } : { viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  const handler = async (route) => {
    const req = route.request();
    const auth = req.headers()['authorization'] ?? '';
    const uid = auth.includes(token) ? admin.id : null;
    try {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (req.url().startsWith(AUTH)) {
        const path = new URL(req.url()).pathname.replace(/^.*\/auth/, '');
        stats.auth[path] = (stats.auth[path] ?? 0) + 1;
        if (path.startsWith('/token/anonymous')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ token: anonToken, expires_at: exp }) });
        if (path.startsWith('/get-session')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
          body: JSON.stringify(adminSession ? { session: { id: 's1', token, userId: admin.id, expiresAt: new Date(exp * 1000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            user: { id: admin.id, email: 'owner@example.com', name: 'Owner', emailVerified: true, image: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } : null) });
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{}' });
      }
      if (req.url().includes('/rest/v1/')) {
        stats.data[auth.includes(token) ? 'admin' : auth.includes(anonToken) ? 'anonymous-token' : auth ? 'other' : 'no-token']++;
        const r = await handleRest(req, req.postData(), uid);
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { ...cors, ...(r.total != null ? { 'content-range': `0-0/${r.total}` } : {}) }, body: JSON.stringify(r.body ?? null) });
      }
      if (req.url().includes('/api/customer-assistant')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: 'We have Classic Condoms (3-pack) at GH₵ 12.00. How many would you like, and are you on campus or off campus?', products: [] }) });
      }
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{}' });
    } catch (e) {
      stats.errors.push(`${req.url().slice(0, 120)}: ${e.message}`);
      return route.fulfill({ status: 400, headers: cors, contentType: 'application/json', body: JSON.stringify({ message: e.message }) });
    }
  };
  await page.route(`${AUTH}/**`, handler);
  await page.route(`${DATA}/**`, handler);
  await page.route('http://localhost:4173/api/**', handler);
  if (before) await page.addInitScript(before);
  await page.goto(`http://localhost:4173${path}`);
  await page.waitForTimeout(wait);
  if (process.env.DEBUG_JS) console.log(name, await page.evaluate(process.env.DEBUG_JS));
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: !mobile || name.includes('full') });
  await ctx.close();
  console.log(`  ✓ ${name}`);
}

const cart = JSON.stringify([{ product_id: ids['classic-condoms-3'], name: 'Classic Condoms (3-pack)', price: 12, unit: 'pack', quantity: 2 }, { product_id: ids['pregnancy-test'], name: 'Pregnancy Test Strip', price: 15, unit: 'pc', quantity: 1 }]);
const checkoutState = JSON.stringify({ loc: { type: 'on_campus', institution_id: legon, hostel_id: await hostel('Akuafo Hall'), unlisted: false }, details: { name: 'Abena K.', phone: '0245551234', room_number: 'B214' } });
const setCart = new Function(`localStorage.setItem('sp_cart_v1', ${JSON.stringify(cart)}); sessionStorage.setItem('sp_checkout_v1', ${JSON.stringify(checkoutState)});`);

const only = process.argv[2];
const shots = [
  ['home', '/', {}], ['home-mobile', '/', { mobile: true }], ['shop', '/shop', {}], ['product', '/product/fiesta-all-night-condoms-3-pack', {}], ['shop-mobile', '/shop', { mobile: true }], ['product-mobile', '/product/fiesta-all-night-condoms-3-pack', { mobile: true }],
  ['checkout-location', '/checkout/location', { before: setCart, wait: 1800 }], ['checkout-location-mobile', '/checkout/location', { before: setCart, mobile: true, wait: 1800 }],
  ['checkout-review', '/checkout/review', { before: setCart, wait: 1800 }],
  ['confirmation', `/order-confirmation/${o1.reference}?t=${o1.access_token}`, {}],
  ['admin-dashboard', '/admin', { adminSession: true, wait: 2500 }], ['admin-orders', '/admin/orders?x=1', { adminSession: true, wait: 2500 }],
  ['admin-order', `/admin/orders/${await oid(o1.reference)}`, { adminSession: true, wait: 3000 }],
  ['admin-inventory', '/admin/inventory', { adminSession: true, wait: 3500 }], ['admin-products', '/admin/products', { adminSession: true, wait: 3500 }],
  ['admin-finance', '/admin/finance', { adminSession: true, wait: 2500 }], ['admin-analytics', '/admin/analytics', { adminSession: true, wait: 2500 }],
];
for (const [n, p, o] of shots) if (!only || n.includes(only)) await shoot(n, p, o);
console.log('\nAuth endpoints called:', JSON.stringify(stats.auth));
console.log('Data API requests by identity:', JSON.stringify(stats.data));
if (stats.errors.length) console.log('Errors:', stats.errors.slice(0, 10));
await browser.close(); server.close();
