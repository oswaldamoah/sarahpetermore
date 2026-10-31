// Product photos (public) and restock receipts (private) go to Vercel Blob.
// The browser asks this function for a short-lived upload token; only staff get one.
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { json, whoami } from './_lib/db.js';

const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        const { token, kind } = JSON.parse(clientPayload ?? '{}') as { token?: string; kind?: string };
        const who = await whoami(token);
        const allowed = kind === 'product' ? ['super_admin', 'manager'] : ['super_admin', 'manager', 'inventory_manager', 'finance_manager'];
        if (!who.user_id || !who.roles.some((r) => allowed.includes(r))) throw new Error('Only staff can upload files');
        return {
          allowedContentTypes: kind === 'product' ? IMAGES : [...IMAGES, 'application/pdf'],
          maximumSizeInBytes: kind === 'product' ? 5 * 1024 * 1024 : 10 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ user_id: who.user_id, kind }),
        };
      },
    });
    return json(result);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
