// Applies db/migrations/*.sql to your Neon database in order, once each.
// Usage (PowerShell):  $env:DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require"; npm run migrate
//                      npm run demo-seed  → also loads demo_seed.sql
// Everything goes over HTTPS (port 443), so it works on networks that block Postgres port 5432:
//   1st choice: secure WebSocket session;  fallback: Neon's HTTPS SQL endpoint (one transaction per file).
// Use the OWNER connection string from Neon → Connect.
import { Pool, neon, neonConfig } from '@neondatabase/serverless';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSql } from './sql-split.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL to your Neon owner connection string.'); process.exit(1); }

const describe = (e) => [e?.message, e?.error?.message, e?.cause?.message, e?.code, e?.type, e?.reason]
  .filter(Boolean).join(' | ') || String(e);

const files = readdirSync(join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ name: f, path: join(here, 'migrations', f) }));
if (process.argv.includes('--demo')) files.push({ name: 'demo_seed.sql', path: join(here, 'demo_seed.sql') });
const BOOKKEEPING = `create schema if not exists ops; create table if not exists ops.schema_migrations (name text primary key, applied_at timestamptz not null default now())`;

function hint(msg) {
  if (/role "(anonymous|authenticated)" does not exist/.test(msg)) return 'Enable Neon Auth and the Data API in the Neon Console first, then run this again.';
  if (/password authentication failed/i.test(msg)) return 'Wrong password: copy the connection string again from Neon → Connect (owner role).';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'Database address not found: copy the connection string again, or switch DNS to 1.1.1.1 / 8.8.8.8.';
  return null;
}

async function viaWebSocket() {
  if (typeof WebSocket === 'undefined') throw new Error('Node 22+ needed for WebSocket');
  neonConfig.webSocketConstructor = WebSocket;
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15000 });
  const client = await pool.connect();
  try {
    await client.query(BOOKKEEPING);
    const done = new Set((await client.query('select name from ops.schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f.name)) { console.log(`  · ${f.name} (already applied)`); continue; }
      try {
        await client.query('begin');
        await client.query(readFileSync(f.path, 'utf8'));
        await client.query('insert into ops.schema_migrations(name) values ($1)', [f.name]);
        await client.query('commit');
        console.log(`  ✓ ${f.name}`);
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw Object.assign(new Error(`${f.name}: ${describe(e)}`), { migration: true });
      }
    }
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

async function viaHttp() {
  const sql = neon(url);
  for (const s of splitSql(BOOKKEEPING)) await sql.query(s);
  const done = new Set((await sql.query('select name from ops.schema_migrations')).map((r) => r.name));
  for (const f of files) {
    if (done.has(f.name)) { console.log(`  · ${f.name} (already applied)`); continue; }
    const statements = splitSql(readFileSync(f.path, 'utf8'));
    try {
      await sql.transaction((tx) => [...statements.map((s) => tx.query(s)), tx.query('insert into ops.schema_migrations(name) values ($1)', [f.name])]);
      console.log(`  ✓ ${f.name} (${statements.length} statements)`);
    } catch (e) {
      throw Object.assign(new Error(`${f.name}: ${describe(e)}`), { migration: true });
    }
  }
}

try {
  try {
    await viaWebSocket();
  } catch (e) {
    if (e.migration) throw e;
    console.log(`WebSocket connection failed (${describe(e)}). Trying Neon's HTTPS endpoint instead…`);
    await viaHttp();
  }
  console.log('\nDatabase is up to date. Now press "Refresh schema cache" on Neon\'s Data API page.');
} catch (e) {
  const msg = describe(e);
  console.error(`\n  ✗ ${msg}`);
  const h = hint(msg);
  if (h) console.error(`    → ${h}`);
  process.exit(1);
}
