-- =====================================================================
-- WhatsApp link (your own WhatsApp, linked like WhatsApp Web).
-- The link sends each alert once and marks it here; email keeps using notified_at.
-- Safe to re-run.
-- =====================================================================
alter table notifications add column if not exists wa_sent_at timestamptz;
create index if not exists notifications_wa_pending_idx on notifications(created_at) where wa_sent_at is null;

-- Don't replay old alerts the first time the link starts.
update notifications set wa_sent_at = coalesce(notified_at, now()) where wa_sent_at is null and created_at < now() - interval '10 minutes';

-- The link reports its status here (shown in Admin → Settings → Order alerts).
insert into system_settings(key, value, is_public) values ('whatsapp_link', '{}'::jsonb, false)
on conflict (key) do nothing;

-- The CallMeBot key is no longer used.
comment on column alert_recipients.whatsapp_key is 'Unused (was CallMeBot). WhatsApp now goes through the WhatsApp link.';
