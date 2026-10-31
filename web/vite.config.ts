import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Runs the server functions in api/*.ts during `npm run dev`, exactly like Vercel does in production,
 * so the 24/7 Customer Service chat, Sarah Assistant and alerts work locally too.
 */
function localApi(): Plugin {
  return {
    name: 'local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        const match = /^\/api\/([a-z-]+)(\?.*)?$/.exec(url);
        if (!match) return next();
        try {
          const mod = await server.ssrLoadModule(`/api/${match[1]}.ts`);
          const handler = mod[req.method ?? 'GET'];
          if (typeof handler !== 'function') { res.statusCode = 405; res.end(); return; }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (v === undefined || ['connection', 'keep-alive', 'transfer-encoding', 'host', 'content-length'].includes(k)) continue;
            headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          }
          const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET') && chunks.length > 0;
          const request = new Request(`http://${req.headers.host ?? 'localhost'}${url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
          const response: Response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          server.config.logger.error(`[api/${match[1]}] ${(e as Error).stack ?? e}`);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Make server-only variables in .env (DATABASE_URL, NEON_DATA_API_URL, …) available to api/*.ts locally.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
  // Login goes through this site's own address (/neon-auth → Neon Auth), so the login cookie belongs to the site
  // and browsers that block cross-site cookies (Edge, Safari, Brave) still keep you signed in. Vercel does the same (vercel.json).
  const auth = env.VITE_NEON_AUTH_URL ? new URL(env.VITE_NEON_AUTH_URL) : null;
  return {
    plugins: [react(), localApi()],
    server: auth ? {
      proxy: {
        '/neon-auth': {
          target: auth.origin, changeOrigin: true, secure: true,
          rewrite: (p: string) => p.replace(/^\/neon-auth/, auth.pathname.replace(/\/$/, '')),
          configure: (proxy) => {
            proxy.on('proxyRes', (res) => {
              const sc = res.headers['set-cookie'];
              if (sc) {
                // Make Neon's login cookie belong to this site: whole-site path, no foreign domain, not partitioned
                res.headers['set-cookie'] = sc.map((c) => c.replace(/;\s*Path=[^;]*/i, '').replace(/;\s*Domain=[^;]*/i, '').replace(/;\s*Partitioned/i, '') + '; Path=/');
              }
            });
          },
        },
      },
    } : undefined,
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    build: {
      rollupOptions: {
        output: { manualChunks: { charts: ['recharts'], neon: ['@neondatabase/neon-js'], react: ['react', 'react-dom', 'react-router-dom'] } },
      },
    },
  };
});
