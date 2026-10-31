// Emails alerts for new orders (and enquiries, low stock, refunds) through Resend.
// WhatsApp alerts are sent by the WhatsApp link (whatsapp/bridge.ts), which uses your own WhatsApp.
//
// Who gets emails is set in Admin → Settings → Order alerts (table alert_recipients):
//   • recipients without a distributor get every order in full
//   • recipients linked to a distributor get only orders that use that distributor's stock
// Server env: RESEND_API_KEY (required), ALERT_EMAIL_FROM (optional, needs a domain verified in Resend).
//
// Triggered by the site right after an order/enquiry (POST), and by the daily Vercel cron (GET) as a safety net.
import { bearer, json, q, qSafe, whoami } from './_lib/db.js';
import { ALERT_TYPES, type Note, type Recipient, noteText, orderIdOf, orderText, recipients, sendEmail } from './_lib/alerts.js';

export { sendEmail };

async function email(r: Recipient, subject: string, text: string) {
  if (!r.email) return '';
  const result = await sendEmail(r.email, subject, text);
  if (r.id !== 'env') await qSafe(`update alert_recipients set last_result = $1, last_sent_at = now() where id = $2`, [result, r.id]);
  return result;
}

async function run() {
  const pending = await q<Note>(`update notifications set notified_at = now()
    where id in (select id from notifications where notified_at is null order by created_at limit 20 for update skip locked)
    returning id, type, title, body, link`);
  if (!pending.length) return { sent: 0 };
  const people = (await recipients()).filter((r) => r.email);
  if (process.env.NOTIFY_EMAIL_TO) people.push({ id: 'env', label: 'Server settings', distributor_id: null, whatsapp: null, email: process.env.NOTIFY_EMAIL_TO.split(',')[0].trim() });
  const owners = people.filter((r) => !r.distributor_id);
  const log: string[] = [];
  for (const n of pending) {
    if (!ALERT_TYPES.includes(n.type)) continue;
    const orderId = orderIdOf(n);
    if (orderId) {
      const full = await orderText(orderId);
      if (!full) continue;
      for (const r of owners) log.push(await email(r, full.subject, full.text));
      for (const r of people.filter((p) => p.distributor_id && full.distributors.includes(p.distributor_id))) {
        const theirs = await orderText(orderId, r.distributor_id!);
        if (theirs) log.push(await email(r, theirs.subject, theirs.text));
      }
    } else {
      for (const r of owners) log.push(await email(r, n.title, noteText(n)));
    }
  }
  return { sent: pending.length, results: log.filter(Boolean) };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.clone().json().catch(() => ({}));
    if (body?.test_recipient_id) {
      // "Send test" from the admin: managers only
      const me = await whoami(bearer(req));
      if (!me.roles.some((r) => ['super_admin', 'manager'].includes(r))) return json({ error: 'Only managers can send tests' }, 403);
      const [r] = await q<Recipient>(`select id, label, distributor_id, whatsapp, email from alert_recipients where id = $1`, [body.test_recipient_id]);
      if (!r) return json({ error: 'Recipient not found' }, 404);
      const out: string[] = [];
      if (r.email) out.push(await email(r, 'SarahPetermore test alert', 'Test from SarahPetermore ✅\nNew orders will arrive here like this.'));
      if (r.whatsapp) {
        // WhatsApp tests go through the WhatsApp link, which watches this queue
        await q(`insert into notifications(type, title, body, link, notified_at) values ('test', 'Test from SarahPetermore ✅', $1, null, now())`, [`wa:${r.id}`]);
        out.push('WhatsApp test queued (arrives if the WhatsApp link is running)');
      }
      const result = out.join(' · ') || 'Add an email or WhatsApp number first';
      return json({ ok: !/failed|not set up|first/i.test(result), result });
    }
    return json(await run());
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) return json({ error: 'unauthorised' }, 401);
  try { return json(await run()); } catch (e) { return json({ error: (e as Error).message }, 500); }
}
