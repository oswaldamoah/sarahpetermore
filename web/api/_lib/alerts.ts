// Shared by api/notify.ts (email) and whatsapp/bridge.ts (WhatsApp).
import { q } from './db.js';

const money = (n: unknown) => `GH₵ ${Number(n ?? 0).toFixed(2)}`;
export const siteUrl = () => (process.env.SITE_URL ?? '').replace(/\/$/, '');

export type Recipient = { id: string; label: string; distributor_id: string | null; whatsapp: string | null; email: string | null };
export type Note = { id: string; type: string; title: string; body: string | null; link: string | null };

/** Active alert recipients (Admin → Settings → Order alerts). */
export async function recipients(): Promise<Recipient[]> {
  try { return await q<Recipient>(`select id, label, distributor_id, whatsapp, email from alert_recipients where is_active`); }
  catch { return []; }
}

/** The order as a short message. With a distributor id, only that distributor's items are listed. */
export async function orderText(orderId: string, onlyDistributor?: string): Promise<{ subject: string; text: string; distributors: string[]; reference: string } | null> {
  const [o] = await q<any>(`select id, reference, customer_name, phone, alt_phone, location_type, delivery_method, institution_name, hostel_name,
      room_number, address_line, digital_address, delivery_instructions, total, payment_method from orders where id = $1`, [orderId]);
  if (!o) return null;
  const items = await q<any>(`select product_name, quantity, distributor_id from order_items where order_id = $1 order by product_name`, [orderId]);
  const mine = onlyDistributor ? items.filter((i) => i.distributor_id === onlyDistributor) : items;
  const where = o.location_type === 'on_campus'
    ? [o.institution_name, o.hostel_name, o.room_number && `Room ${o.room_number}`].filter(Boolean).join(' · ')
    : [o.address_line, o.digital_address].filter(Boolean).join(' · ');
  const lines = [
    `*New order ${o.reference}*`,
    `${money(o.total)} · ${o.payment_method === 'pay_on_delivery' ? 'pay on delivery' : o.payment_method}${o.delivery_method === 'courier' ? ' · courier' : ''}`,
    '',
    ...mine.map((i) => `• ${i.quantity} × ${i.product_name}`),
    onlyDistributor && mine.length < items.length ? `(+${items.length - mine.length} more item(s) from another distributor)` : '',
    '',
    `📍 ${where || 'Address to confirm'}`,
    `👤 ${o.customer_name} · ${o.phone}${o.alt_phone ? ` / ${o.alt_phone}` : ''}`,
    o.delivery_instructions ? `📝 ${o.delivery_instructions}` : '',
    siteUrl() ? `\n${siteUrl()}/admin/orders/${o.id}` : '',
  ];
  return {
    subject: `New order ${o.reference} · ${money(o.total)}`,
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    distributors: [...new Set(items.map((i) => i.distributor_id).filter(Boolean))] as string[],
    reference: o.reference,
  };
}

/** Plain alert text for non-order events (enquiries, stock, refunds). */
export const noteText = (n: Note) => `*${n.title}*${n.body ? `\n${n.body}` : ''}${n.link && siteUrl() ? `\n${siteUrl()}${n.link}` : ''}`;
export const ALERT_TYPES = ['new_order', 'new_enquiry', 'low_stock', 'out_of_stock', 'refund'];
export const orderIdOf = (n: Note) => (n.type === 'new_order' ? n.link?.match(/[0-9a-f-]{36}/i)?.[0] : undefined);

/**
 * Email through Resend. Free plan: 100 emails/day. Until you verify a domain in Resend,
 * it only delivers to the email address your Resend account uses — fine for your own alerts.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<string> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return 'Email not set up yet (add RESEND_API_KEY)';
  const from = process.env.ALERT_EMAIL_FROM ? `SarahPetermore <${process.env.ALERT_EMAIL_FROM}>` : 'SarahPetermore <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (res.ok) return 'Email sent';
    const body = await res.text();
    if (/only send testing emails to your own email/i.test(body)) return `Email failed: without a verified domain, Resend only delivers to your Resend login email`;
    return `Email failed: ${body.slice(0, 140)}`;
  } catch (e) {
    return `Email failed: ${(e as Error).message}`;
  }
}
