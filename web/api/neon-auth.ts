// Login on the live site goes through here: /neon-auth/* → this function → Neon Auth.
// Why: the login cookie must belong to this site (browsers like Edge/Safari block cross-site login cookies),
// and Neon rejects requests forwarded by a plain Vercel rewrite ("Invalid hostname header").
// During `npm run dev` the same job is done by the proxy in vite.config.ts.
const PASS_REQUEST = ['content-type', 'cookie', 'origin', 'referer', 'user-agent', 'accept', 'authorization', 'x-force-fetch'];
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']);

async function forward(req: Request): Promise<Response> {
  const base = (process.env.NEON_AUTH_URL ?? process.env.VITE_NEON_AUTH_URL ?? '').replace(/\/$/, '');
  if (!base) return Response.json({ error: 'NEON_AUTH_URL is not set' }, { status: 500 });

  const url = new URL(req.url);
  const path = (url.searchParams.get('path') ?? url.pathname.replace(/^\/(api\/)?neon-auth\/?/, '')).replace(/^\/+/, '');
  if (path.includes('..')) return Response.json({ error: 'Bad path' }, { status: 400 });
  url.searchParams.delete('path');
  const target = `${base}/${path}${url.search}`;

  const headers = new Headers();
  for (const h of PASS_REQUEST) { const v = req.headers.get(h); if (v) headers.set(h, v); }
  const fwdFor = req.headers.get('x-forwarded-for');
  if (fwdFor) headers.set('x-forwarded-for', fwdFor);

  const upstream = await fetch(target, {
    method: req.method, headers, redirect: 'manual',
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
  });

  const out = new Headers();
  upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k.toLowerCase())) out.set(k, v); });
  // Make Neon's login cookie belong to this site: whole-site path, no foreign domain, not partitioned
  for (const c of upstream.headers.getSetCookie?.() ?? []) {
    out.append('set-cookie', c.replace(/;\s*Path=[^;]*/i, '').replace(/;\s*Domain=[^;]*/i, '').replace(/;\s*Partitioned/i, '') + '; Path=/');
  }
  return new Response(req.method === 'HEAD' ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: out });
}

const handle = (req: Request) => forward(req).catch((e) => Response.json({ error: `Login service unreachable: ${(e as Error).message}` }, { status: 502 }));
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
