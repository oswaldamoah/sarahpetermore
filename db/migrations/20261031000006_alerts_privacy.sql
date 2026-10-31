-- =====================================================================
-- Order alerts by WhatsApp and email, and keeping phone numbers private.
-- Safe to re-run.
-- =====================================================================

-- Who gets told about new orders.
--   distributor_id null  -> receives every order (you, the owner, a manager)
--   distributor_id set   -> receives only orders that use that distributor's stock
create table if not exists alert_recipients (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  distributor_id uuid references distributors(id) on delete cascade,
  whatsapp text,                 -- number with country code, e.g. +233505690386
  whatsapp_key text,             -- free CallMeBot key for that number
  email text,
  is_active boolean not null default true,
  last_result text,              -- what happened the last time we tried to send
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists alert_recipients_distributor_idx on alert_recipients(distributor_id);

alter table alert_recipients enable row level security;
drop policy if exists alert_recipients_manage on alert_recipients;
create policy alert_recipients_manage on alert_recipients for all
  using (public.has_any_role('{manager}')) with check (public.has_any_role('{manager}'));
grant select, insert, update, delete on alert_recipients to authenticated;

-- Phone numbers are no longer published on the website. They are still used
-- (server-side) on the order confirmation, once an order has been placed.
update system_settings set is_public = false
where key in ('contact_business_phone', 'contact_customer_service_phone', 'contact_whatsapp');
