// Provider-independent AI gateway. Every provider is called through the OpenAI-compatible
// /chat/completions shape (OpenRouter, Groq, Gemini's OpenAI endpoint, Pollinations, OpenAI,
// or a custom endpoint). Keys are read on the server only.
import { q, qSafe } from './db.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type Provider = { id: string; name: string; provider: string; base_url: string; model: string; requires_key: boolean; daily_limit: number | null };

async function keyFor(p: Provider): Promise<string | null> {
  const [row] = await q<{ api_key: string }>(`select api_key from ai_provider_secrets where provider_id = $1`, [p.id]);
  return row?.api_key ?? process.env[`AI_KEY_${p.provider.toUpperCase()}`] ?? null;
}

async function underDailyLimit(p: Provider) {
  if (!p.daily_limit) return true;
  const [r] = await q<{ n: number }>(`select count(*)::int n from ai_usage where provider_id = $1 and created_at > now() - interval '24 hours'`, [p.id]);
  return (r?.n ?? 0) < p.daily_limit;
}

/** Free models get retired often. Preferred replacements, best first, per provider. */
const MODEL_PREFERENCES: Record<string, (string | RegExp)[]> = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', /llama-?4/i, /llama.*70b/i, /qwen/i, /kimi/i],
  gemini: [/^(models\/)?gemini-\d+(\.\d+)?-flash$/, /^(models\/)?gemini-\d+(\.\d+)?-flash-preview$/, /^(models\/)?gemini-\d+(\.\d+)?-flash-lite$/],
  openrouter: ['openrouter/free', /:free$/],
  pollinations: ['openai', 'openai-fast', /mistral|llama|qwen/i],
};
const NOT_CHAT = /embed|tts|audio|image|vision-only|whisper|guard|moderation|live|transcri|speech/i;

function versionOf(id: string) { const m = /(\d+(?:\.\d+)?)/.exec(id); return m ? Number(m[1]) : 0; }

/** Ask the provider which models exist now and pick the best replacement. */
export async function discoverModel(p: Provider, key: string | null): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${p.base_url.replace(/\/$/, '')}/models`, { headers }).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null) as any;
  const ids: string[] = (body?.data ?? body?.models ?? (Array.isArray(body) ? body : []))
    .map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter((x: unknown): x is string => typeof x === 'string')
    .filter((id: string) => !NOT_CHAT.test(id));
  if (!ids.length) return null;
  for (const pref of MODEL_PREFERENCES[p.provider] ?? []) {
    const hits = ids.filter((id) => (typeof pref === 'string' ? id === pref : pref.test(id)));
    if (hits.length) return hits.sort((a, b) => versionOf(b) - versionOf(a))[0].replace(/^models\//, '');
  }
  return ids[0].replace(/^models\//, '');
}

const MODEL_GONE = /model.*(not.?found|does not exist|no longer available|decommission|deprecat|not supported|invalid)|not.?found.*model|404/i;

export async function callProvider(p: Provider, key: string | null, messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}) {
  try {
    return await callModel(p, key, messages, opts);
  } catch (e) {
    const msg = String((e as Error).message);
    if (!MODEL_GONE.test(msg)) throw e;
    const replacement = await discoverModel(p, key);
    if (!replacement || replacement === p.model) throw e;
    const old = p.model;
    p.model = replacement;
    const out = await callModel(p, key, messages, opts);
    // Remember the working model so the next request goes straight to it.
    await qSafe(`update ai_provider_settings set model = $1 where id = $2 and model = $3`, [replacement, p.id, old]);
    console.warn(`[ai] ${p.name}: model "${old}" is retired, switched to "${replacement}"`);
    return out;
  }
}

async function callModel(p: Provider, key: string | null, messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (p.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.SITE_URL ?? 'https://sarahpetermore.com';
    headers['X-Title'] = 'SarahPetermore';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${p.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model: p.model, messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 1500,
        // reasoning models: keep thinking short so the answer arrives fast and isn't cut off
        ...(/gpt-oss/i.test(p.model) ? { reasoning_effort: 'low' } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    const content = JSON.parse(text)?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') throw new Error('Empty response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** Try providers in priority order until one answers. Returns null if every provider failed. */
export async function chat(scope: 'customer' | 'admin', messages: ChatMessage[],
  opts: { preferredProviderId?: string; sessionKey?: string; temperature?: number } = {}) {
  const providers = await q<Provider>(
    `select id, name, provider, base_url, model, requires_key, daily_limit from ai_provider_settings
     where is_enabled and scope in ($1, 'both') order by (id::text = $2) desc, priority`, [scope, opts.preferredProviderId ?? '']);
  for (const p of providers) {
    let key: string | null;
    try {
      key = await keyFor(p);
      if (p.requires_key && !key) continue;
      if (!(await underDailyLimit(p))) continue;
    } catch { continue; }
    const started = Date.now();
    try {
      let content: string;
      try {
        content = await callProvider(p, key, messages, { temperature: opts.temperature });
      } catch (e) {
        // Reasoning models occasionally return an empty answer; one quick retry on the same provider is far faster than moving on.
        if (!/Empty response/.test(String((e as Error).message))) throw e;
        content = await callProvider(p, key, messages, { temperature: opts.temperature });
      }
      await qSafe(`insert into ai_usage(provider_id, scope, session_key, success, latency_ms) values ($1, $2, $3, true, $4)`, [p.id, scope, opts.sessionKey ?? null, Date.now() - started]);
      return { content, providerId: p.id, providerName: p.name, model: p.model };
    } catch (e) {
      await qSafe(`insert into ai_usage(provider_id, scope, session_key, success, latency_ms, error) values ($1, $2, $3, false, $4, $5)`,
        [p.id, scope, opts.sessionKey ?? null, Date.now() - started, String((e as Error).message).slice(0, 300)]);
    }
  }
  return null;
}

export async function testProvider(providerId: string) {
  const [p] = await q<Provider>(`select * from ai_provider_settings where id = $1`, [providerId]);
  if (!p) return { ok: false, error: 'Provider not found' };
  const key = await keyFor(p);
  if (p.requires_key && !key) return { ok: false, error: 'No API key saved for this provider' };
  const started = Date.now();
  try {
    const out = await callProvider(p, key, [{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 10 });
    return { ok: true, latency_ms: Date.now() - started, sample: out.slice(0, 40) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Pull the first JSON object out of a model reply (models sometimes wrap it in prose or code fences). */
export function parseAction(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return normalizeAction(JSON.parse(cleaned.slice(start, i + 1))); } catch { return null; } } }
  }
  return null;
}

/** Models don't always use our exact shape. Accept the common variants instead of leaking JSON to the customer. */
function normalizeAction(a: any): Record<string, unknown> | null {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (typeof a.tool === 'string' || typeof a.reply === 'string' || a.propose) return a;
  if (typeof a.tool === 'object' && a.tool?.name) return { tool: a.tool.name, args: a.tool.args ?? a.tool.arguments ?? {} };
  for (const k of ['name', 'action', 'function', 'tool_name']) {
    if (typeof a[k] === 'string') {
      let args = a.args ?? a.arguments ?? a.parameters ?? a.input ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      return { tool: a[k], args };
    }
  }
  for (const k of ['message', 'response', 'answer', 'text', 'content']) if (typeof a[k] === 'string') return { reply: a[k] };
  const keys = Object.keys(a);
  if (keys.length === 1 && a[keys[0]] && typeof a[keys[0]] === 'object' && !Array.isArray(a[keys[0]])) return { tool: keys[0], args: a[keys[0]] };
  return a;
}
