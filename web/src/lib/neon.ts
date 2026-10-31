import { createClient, SupabaseAuthAdapter } from '@neondatabase/neon-js';
import { upload } from '@vercel/blob/client';

// Neon Console → your project → Data API (URL) and Auth → Configuration (Auth URL)
const neonAuthUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
// In the browser, sign-in goes through this site's own /neon-auth address (see vite.config.ts and vercel.json),
// so the login cookie is first-party and isn't blocked by Edge/Safari/Brave.
const authUrl = neonAuthUrl && typeof window !== 'undefined' && import.meta.env.VITE_NEON_AUTH_DIRECT !== 'true'
  ? `${window.location.origin}/neon-auth` : neonAuthUrl;
const dataApiUrl = import.meta.env.VITE_NEON_DATA_API_URL as string | undefined;

export const isConfigured = Boolean(authUrl && dataApiUrl);

/**
 * One client for sign-in and database queries.
 * - SupabaseAuthAdapter keeps the familiar auth API (signInWithPassword, getSession, onAuthStateChange…).
 * - allowAnonymous lets visitors browse and order without an account (Data API role "anonymous").
 * Row Level Security in the database decides what each request can see or change.
 */
export const db = createClient({
  auth: { url: authUrl ?? 'https://example.neonauth.invalid/neondb/auth', adapter: SupabaseAuthAdapter(), allowAnonymous: true },
  dataApi: { url: dataApiUrl ?? 'https://example.apirest.invalid/neondb/rest/v1' },
});

export async function accessToken(): Promise<string | null> {
  try {
    const { data } = await db.auth.getSession();
    return data.session?.access_token ?? null;
  } catch { return null; }
}

/** Call one of our server functions in web/api (assistants, alerts). */
export async function callApi<T = any>(name: string, body: unknown): Promise<{ data: T | null; error: Error | null }> {
  try {
    const token = await accessToken();
    const res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { data: json, error: new Error(json?.error ?? `Request failed (${res.status})`) };
    return { data: json as T, error: null };
  } catch (e) {
    return { data: null, error: e as Error };
  }
}

/** Fire-and-forget: send any pending email/SMS/webhook alerts (new order, enquiry…). */
export function flushAlerts() {
  void fetch('/api/notify', { method: 'POST' }).catch(() => undefined);
}

/** Upload a file to Vercel Blob. Images are public; receipts are private. Staff only (checked on the server). */
export async function uploadFile(file: File, kind: 'product' | 'receipt'): Promise<string> {
  const token = await accessToken();
  if (!token) throw new Error('Sign in again to upload files');
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin';
  const blob = await upload(`${kind === 'product' ? 'products' : 'receipts'}/${crypto.randomUUID()}.${ext}`, file, {
    access: kind === 'product' ? 'public' : 'private',
    handleUploadUrl: '/api/upload',
    clientPayload: JSON.stringify({ token, kind }),
    contentType: file.type,
  });
  return blob.url;
}
