-- =====================================================================
-- SarahPetermore — core schema (Neon Postgres)
-- User ids come from Neon Auth (Managed Better Auth, table neon_auth."user").
-- They are stored as plain uuids (no foreign key into the managed auth schema).
-- All money is numeric(12,2) in GHS. All timestamps are timestamptz (UTC).
-- =====================================================================


-- ---------- Data API roles (created by Neon when the Data API is enabled) ----------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anonymous') then create role anonymous nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

-- ---------- Enums ----------
create type app_role as enum ('super_admin','manager','inventory_manager','finance_manager','order_manager','distributor');
create type stakeholder_status as enum ('active','inactive','suspended');
create type category_status as enum ('active','inactive','archived');
create type order_status as enum ('received','confirmed','processing','ready_for_delivery','out_for_delivery','delivered','cancelled','refund_pending','refunded','failed_delivery','returned');
create type payment_status as enum ('unpaid','pending','partially_paid','paid','refunded','failed');
create type delivery_method as enum ('distributor','courier');
create type location_type as enum ('on_campus','off_campus');
create type movement_type as enum ('adjustment_in','adjustment_out','restock','transfer_out','transfer_in','transfer_cancel','order_reserve','order_release','order_fulfil','damaged','expired','return','internal_use','correction','import');
create type transfer_status as enum ('draft','in_transit','received','cancelled');
create type txn_type as enum ('income','expenditure','refund','restock','settlement','capital','adjustment');
create type txn_direction as enum ('in','out');
create type enquiry_status as enum ('open','in_progress','resolved','closed');
create type item_stock_state as enum ('reserved','fulfilled','released','returned','unallocated');

-- ---------- People ----------
create table profiles (
  id uuid primary key,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_roles (
  user_id uuid not null,
  role app_role not null,
  distributor_id uuid,               -- for future distributor accounts
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique,
  full_name text not null,
  phone text not null,
  phone_normalized text not null,
  alt_phone text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_phone_idx on customers(phone_normalized);

-- ---------- Catalogue ----------
create table stakeholders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  contact_name text,
  phone text,
  email text,
  description text,
  pricing_arrangement text,
  markup_percent numeric(6,2) not null default 0 check (markup_percent >= 0),
  commission_percent numeric(6,2) not null default 0 check (commission_percent between 0 and 100),
  settlement_arrangement text,
  is_platform_owner boolean not null default false,  -- true for SarahPetermore itself
  status stakeholder_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  status category_status not null default 'active',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  sku text unique,
  images text[] not null default '{}',
  category_id uuid not null references categories(id),
  stakeholder_id uuid not null references stakeholders(id),
  cost_price numeric(12,2) not null default 0 check (cost_price >= 0),
  base_price numeric(12,2) not null default 0 check (base_price >= 0),
  markup_percent numeric(6,2) check (markup_percent >= 0),     -- null = inherit stakeholder markup
  final_price numeric(12,2) not null default 0,                -- maintained by trigger
  unit text not null default 'pc',
  is_available boolean not null default true,
  is_active boolean not null default true,
  is_featured boolean not null default false,
  low_stock_threshold int not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on products(category_id);
create index products_stakeholder_idx on products(stakeholder_id);
create index products_name_trgm_idx on products(lower(name));

-- ---------- Locations & distributors ----------
create table institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  short_name text,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table hostels (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references institutions(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (institution_id, name)
);

create table distributors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_person text,
  phone text,
  alt_phone text,
  notes text,
  is_hub boolean not null default false,   -- central stock used for courier orders
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table distributor_service_areas (
  distributor_id uuid not null references distributors(id) on delete cascade,
  hostel_id uuid not null references hostels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (distributor_id, hostel_id)
);
create index dsa_hostel_idx on distributor_service_areas(hostel_id);

alter table user_roles add constraint user_roles_distributor_fk foreign key (distributor_id) references distributors(id) on delete set null;

-- ---------- Inventory ----------
create table inventory (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete restrict,
  distributor_id uuid not null references distributors(id) on delete restrict,
  on_hand int not null default 0,
  reserved int not null default 0 check (reserved >= 0),
  available int generated always as (on_hand - reserved) stored,
  low_stock_threshold int,
  updated_at timestamptz not null default now(),
  unique (product_id, distributor_id)
);
create index inventory_distributor_idx on inventory(distributor_id);

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  distributor_id uuid not null references distributors(id),
  movement_type movement_type not null,
  quantity int not null,              -- signed change to on_hand
  reserved_delta int not null default 0,
  on_hand_after int not null,
  reserved_after int not null,
  reason text,
  reference_type text,
  reference_id uuid,
  batch_id uuid,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index stock_movements_product_idx on stock_movements(product_id, created_at desc);
create index stock_movements_distributor_idx on stock_movements(distributor_id, created_at desc);
create index stock_movements_ref_idx on stock_movements(reference_type, reference_id);

create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  source_distributor_id uuid not null references distributors(id),
  destination_distributor_id uuid not null references distributors(id),
  status transfer_status not null default 'draft',
  notes text,
  initiated_by uuid,
  received_by uuid,
  dispatched_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (source_distributor_id <> destination_distributor_id)
);

create table stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references stock_transfers(id) on delete cascade,
  product_id uuid not null references products(id),
  quantity int not null check (quantity > 0),
  unique (transfer_id, product_id)
);

create table restocks (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  supplier text,
  distributor_id uuid not null references distributors(id),
  restock_date date not null default current_date,
  payment_status payment_status not null default 'paid',
  payment_method text,
  total_cost numeric(12,2) not null default 0,
  receipt_url text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table restock_items (
  id uuid primary key default gen_random_uuid(),
  restock_id uuid not null references restocks(id) on delete cascade,
  product_id uuid not null references products(id),
  quantity int not null check (quantity > 0),
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  total_cost numeric(12,2) generated always as (quantity * unit_cost) stored
);

-- ---------- Customers' saved addresses ----------
create table customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  label text not null default 'Home',
  recipient_name text not null,
  phone text not null,
  alt_phone text,
  location_type location_type not null,
  institution_id uuid references institutions(id) on delete set null,
  hostel_id uuid references hostels(id) on delete set null,
  room_number text,
  address_line text,
  digital_address text,
  instructions text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index customer_addresses_user_idx on customer_addresses(user_id);

-- ---------- Orders ----------
create table orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  access_token uuid not null default gen_random_uuid(),
  customer_id uuid references customers(id),
  user_id uuid,
  customer_name text not null,
  phone text not null,
  phone_normalized text not null,
  alt_phone text,
  email text,
  location_type location_type not null,
  institution_id uuid references institutions(id),
  hostel_id uuid references hostels(id),
  institution_name text,
  hostel_name text,
  room_number text,
  address_line text,
  digital_address text,
  delivery_instructions text,
  delivery_method delivery_method not null,
  is_supported_location boolean not null default false,
  fulfilment_mode text not null default 'single' check (fulfilment_mode in ('single','split','courier','manual')),
  status order_status not null default 'received',
  payment_status payment_status not null default 'unpaid',
  payment_method text not null default 'pay_on_delivery',
  subtotal numeric(12,2) not null default 0,
  delivery_fee numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  courier_name text,
  courier_phone text,
  courier_tracking text,
  internal_notes text,
  source text not null default 'web' check (source in ('web','assistant','admin','import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  cancelled_at timestamptz
);
create index orders_status_idx on orders(status, created_at desc);
create index orders_phone_idx on orders(phone_normalized);
create index orders_user_idx on orders(user_id);
create index orders_created_idx on orders(created_at desc);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id),
  distributor_id uuid references distributors(id),     -- stock source
  product_name text not null,
  category_name text,
  stakeholder_id uuid references stakeholders(id),
  stakeholder_name text,
  unit text,
  quantity int not null check (quantity > 0),
  unit_price numeric(12,2) not null,      -- customer-facing price snapshot
  base_price numeric(12,2) not null,
  cost_price numeric(12,2) not null,
  markup_percent numeric(6,2) not null default 0,
  commission_percent numeric(6,2) not null default 0,
  is_platform_owned boolean not null default true,
  line_total numeric(12,2) not null,
  platform_revenue numeric(12,2) not null,
  stakeholder_proceeds numeric(12,2) not null,
  stock_state item_stock_state not null default 'reserved',
  created_at timestamptz not null default now()
);
create index order_items_order_idx on order_items(order_id);
create index order_items_product_idx on order_items(product_id);

create table order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  from_status order_status,
  to_status order_status not null,
  note text,
  changed_by uuid,
  created_at timestamptz not null default now()
);
create index order_status_history_order_idx on order_status_history(order_id, created_at);

create table order_fulfilment_assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  distributor_id uuid not null references distributors(id),
  role text not null default 'delivery' check (role in ('delivery','stock_source')),
  status text not null default 'assigned' check (status in ('assigned','confirmed','completed','cancelled')),
  assigned_by uuid,
  notes text,
  created_at timestamptz not null default now()
);
create index ofa_order_idx on order_fulfilment_assignments(order_id);
create index ofa_distributor_idx on order_fulfilment_assignments(distributor_id);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  amount numeric(12,2) not null check (amount > 0),
  reason text,
  method text,
  status text not null default 'pending' check (status in ('pending','paid','cancelled')),
  paid_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- ---------- Enquiries ----------
create table enquiries (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  user_id uuid,
  customer_name text,
  phone text not null,
  product_name text,
  quantity int,
  message text not null,
  status enquiry_status not null default 'open',
  admin_response text,
  source text not null default 'web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Finance ----------
create table expenses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'General',
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  recipient text,
  payment_method text,
  description text,
  receipt_url text,
  is_recurring boolean not null default false,
  recurrence text,
  is_void boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table stakeholder_settlements (
  id uuid primary key default gen_random_uuid(),
  stakeholder_id uuid not null references stakeholders(id),
  period_start date,
  period_end date,
  sales_generated numeric(12,2) not null default 0,
  platform_commission numeric(12,2) not null default 0,
  amount_due numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  settlement_date date not null default current_date,
  reference text,
  method text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- Cash ledger: one row per actual movement of money. Immutable; corrected by reversal.
create table financial_transactions (
  id uuid primary key default gen_random_uuid(),
  txn_date date not null default current_date,
  type txn_type not null,
  direction txn_direction not null,
  amount numeric(12,2) not null check (amount > 0),
  description text,
  payment_method text,
  source_type text,           -- 'order','expense','restock','refund','settlement','manual'
  source_id uuid,
  reverses_id uuid references financial_transactions(id),
  is_reversed boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index ft_date_idx on financial_transactions(txn_date);
create index ft_source_idx on financial_transactions(source_type, source_id);
-- a restock / refund / settlement is paid out exactly once (reversals excluded)
create unique index ft_single_payout_idx on financial_transactions(source_type, source_id)
  where source_type in ('restock','refund','settlement') and reverses_id is null and is_reversed = false;

-- ---------- System ----------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  body text,
  link text,
  is_read boolean not null default false,
  notified_at timestamptz,          -- when the external alert (email/SMS/webhook) was sent
  created_at timestamptz not null default now()
);
create index notifications_pending_idx on notifications(created_at) where notified_at is null;
create index notifications_unread_idx on notifications(is_read, created_at desc);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs(created_at desc);
create index audit_logs_entity_idx on audit_logs(entity_type, entity_id);

create table system_settings (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------- AI ----------
create table ai_provider_settings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null check (provider in ('pollinations','openrouter','groq','gemini','openai','openai_compatible')),
  base_url text not null,
  model text not null,
  scope text not null default 'both' check (scope in ('customer','admin','both')),
  priority int not null default 100,          -- lower runs first
  is_enabled boolean not null default true,
  requires_key boolean not null default true,
  has_key boolean not null default false,
  key_last4 text,
  daily_limit int,                            -- max requests per day (null = no app limit)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Secrets live in their own table with RLS on and NO policies: only the service role (edge functions) can read.
create table ai_provider_secrets (
  provider_id uuid primary key references ai_provider_settings(id) on delete cascade,
  api_key text not null,
  updated_at timestamptz not null default now()
);

create table ai_usage (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references ai_provider_settings(id) on delete set null,
  scope text not null,
  session_key text,
  success boolean not null,
  latency_ms int,
  error text,
  created_at timestamptz not null default now()
);
create index ai_usage_created_idx on ai_usage(created_at desc);
create index ai_usage_session_idx on ai_usage(session_key, created_at desc);

create table ai_conversations (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('customer','admin')),
  session_key text not null,
  user_id uuid,
  messages jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope, session_key)
);

create table ai_action_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  instruction text,
  action jsonb not null,
  preview jsonb,
  status text not null default 'proposed' check (status in ('proposed','executed','rejected','failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);
