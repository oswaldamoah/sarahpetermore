// Server-side database access for the Vercel functions.
//  - sql:    owner connection (like a service role) for AI settings, logs and public look-ups.
//  - userDb: the Neon Data API acting AS the signed-in person, so Row Level Security and
//            role checks apply exactly as in the browser.
import { neon } from '@neondatabase/serverless';
import { createClient } from '@neondatabase/neon-js';

const url = process.env.DATABASE_URL;
export const sql = neon(url ?? 'postgresql://missing:missing@localhost/missing');

type Runner = (text: string, params: unknown[]) => Promise<any[]>;
let runner: Runner = async (text, params) => (await sql.query(text, params)) as any[];
/** Tests swap in a local database; production always uses Neon. */
export function __setQueryRunner(fn: Runner) { runner = fn; }

const TRANSIENT = /fetch failed|Error connecting to database|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|terminated/i;

/** Run a query; retries twice when the network drops (common on mobile/campus connections). */
export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await runner(text, params)) as T[];
    } catch (e) {
      if (attempt >= 2 || !TRANSIENT.test(String((e as Error)?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

/** Fire-and-forget bookkeeping (usage stats, logs) must never break a reply. */
export async function qSafe(text: string, params: unknown[] = []) {
  try { await q(text, params); } catch (e) { console.warn('[db] ignored:', (e as Error).message); }
}

export function userDb(token: string) {
  const dataApi = process.env.NEON_DATA_API_URL ?? process.env.VITE_NEON_DATA_API_URL;
  if (!dataApi) throw new Error('NEON_DATA_API_URL is not set');
  return createClient({ dataApi: { url: dataApi, getToken: async () => token } });
}

/** Validate a bearer token by asking the database who it belongs to. */
export async function whoami(token: string | null | undefined): Promise<{ user_id: string | null; roles: string[] }> {
  if (!token) return { user_id: null, roles: [] };
  try {
    const { data, error } = await userDb(token).rpc('whoami');
    if (error || !data) return { user_id: null, roles: [] };
    return data as { user_id: string | null; roles: string[] };
  } catch {
    return { user_id: null, roles: [] };
  }
}

export const bearer = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function publicSettings(): Promise<Record<string, any>> {
  const rows = await q<{ key: string; value: unknown }>(`select key, value from system_settings where is_public or key like 'assistant_%'`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export const money = (n: number | string) => `GH₵ ${Number(n).toFixed(2)}`;
export const cleanError = (m: string) => m.replace(/^[A-Z_]+:\s*/, '');
