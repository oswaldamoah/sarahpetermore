-- =====================================================================
-- SarahPetermore — business logic (transactional functions, triggers, views)
-- Errors are raised as 'CODE: human readable message' so the UI can show them.
-- Internal helpers live in schema "private", which is NOT exposed through the API.
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------
-- The signed-in user's id (Neon Auth), or null for visitors.
-- The Data API runs requests as role "authenticated" (valid user JWT) or "anonymous".
-- auth.user_id() comes from the pg_session_jwt extension that the Data API configures.
create or replace function public.current_user_id() returns uuid
language plpgsql stable as $$
declare v text;
begin
  if coalesce(current_setting('role', true), '') <> 'authenticated' and session_user::text <> 'authenticated' then
    return null;
  end if;
  begin
    v := auth.user_id();
  exception when others then
    return null;
  end;
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return v::uuid; end if;
  return null;
end $$;

create or replace function public.normalize_phone(p text) returns text
language sql immutable as $$
  select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 9)
$$;

create or replace function public.has_any_role(roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles ur
    where ur.user_id = public.current_user_id() and (ur.role = any(roles) or ur.role = 'super_admin'))
$$;

create or replace function public.has_role(r app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_any_role(array[r])
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = public.current_user_id() and role <> 'distributor')
$$;

create or replace function public.my_roles() returns app_role[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(role), '{}') from user_roles where user_id = public.current_user_id()
$$;

create or replace function private.require_roles(roles app_role[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_user_id() is null or not public.has_any_role(roles) then
    raise exception 'FORBIDDEN: You do not have permission for this action' using errcode = '42501';
  end if;
end $$;

create or replace function private.setting(k text, fallback jsonb default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from system_settings where key = k), fallback)
$$;

create or replace function private.setting_text(k text, fallback text default null) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select value #>> '{}' from system_settings where key = k), ''), fallback)
$$;

create or replace function private.gen_code(n int default 6) returns text
language plpgsql volatile as $$
declare a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; r text := '';
begin
  for i in 1..n loop r := r || substr(a, 1 + floor(random() * 32)::int, 1); end loop;
  return r;
end $$;

create or replace function private.audit(p_action text, p_entity text, p_id text, p_details jsonb) returns void
language sql security definer set search_path = public as $$
  insert into audit_logs(actor_id, action, entity_type, entity_id, details) values (public.current_user_id(), p_action, p_entity, p_id, p_details)
$$;

-- ---------------------------------------------------------------------
-- Triggers: timestamps, pricing, audit, immutability, guards
-- ---------------------------------------------------------------------
create or replace function private.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

create trigger t_profiles_touch before update on profiles for each row execute function private.touch_updated_at();
create trigger t_customers_touch before update on customers for each row execute function private.touch_updated_at();
create trigger t_stakeholders_touch before update on stakeholders for each row execute function private.touch_updated_at();
create trigger t_categories_touch before update on categories for each row execute function private.touch_updated_at();
create trigger t_distributors_touch before update on distributors for each row execute function private.touch_updated_at();
create trigger t_orders_touch before update on orders for each row execute function private.touch_updated_at();
create trigger t_enquiries_touch before update on enquiries for each row execute function private.touch_updated_at();
create trigger t_expenses_touch before update on expenses for each row execute function private.touch_updated_at();
create trigger t_ai_settings_touch before update on ai_provider_settings for each row execute function private.touch_updated_at();

-- Final price = base × (1 + markup%). Product markup overrides the stakeholder default.
create or replace function private.products_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_markup numeric;
begin
  select markup_percent into v_markup from stakeholders where id = new.stakeholder_id;
  new.final_price := round(new.base_price * (1 + coalesce(new.markup_percent, v_markup, 0) / 100.0), 2);
  new.updated_at := now();
  return new;
end $$;
create trigger t_products_price before insert or update on products for each row execute function private.products_price();

create or replace function private.stakeholder_markup_cascade() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.markup_percent is distinct from old.markup_percent then
    update products set updated_at = now() where stakeholder_id = new.id and markup_percent is null;
  end if;
  return new;
end $$;
create trigger t_stakeholder_markup after update on stakeholders for each row execute function private.stakeholder_markup_cascade();

create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
        v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
        v_diff jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)) into v_diff
    from jsonb_each(v_new) n join jsonb_each(v_old) o using (key)
    where n.value is distinct from o.value and n.key not in ('updated_at');
    if v_diff is null then return new; end if;
  end if;
  insert into audit_logs(actor_id, action, entity_type, entity_id, details)
  values (public.current_user_id(), lower(tg_op), tg_table_name,
          coalesce(coalesce(v_new, v_old) ->> 'id', coalesce(v_new, v_old) ->> 'key', coalesce(v_new, v_old) ->> 'user_id'),
          case tg_op when 'UPDATE' then v_diff when 'INSERT' then v_new else v_old end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['stakeholders','categories','products','distributors','distributor_service_areas','institutions',
                           'hostels','expenses','system_settings','user_roles','ai_provider_settings','stakeholder_settlements','refunds']
  loop
    execute format('create trigger t_%s_audit after insert or update or delete on %I for each row execute function private.audit_row()', t, t);
  end loop;
end $$;

create or replace function private.block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE: % records cannot be changed or deleted; record a correction instead', tg_table_name;
end $$;
create trigger t_stock_movements_immutable before update or delete on stock_movements for each row execute function private.block_mutation();
create trigger t_status_history_immutable before update or delete on order_status_history for each row execute function private.block_mutation();

create or replace function private.ft_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: financial transactions cannot be deleted; reverse them instead';
  end if;
  if (to_jsonb(new) - 'is_reversed') <> (to_jsonb(old) - 'is_reversed') then
    raise exception 'IMMUTABLE: financial transactions cannot be edited; reverse them instead';
  end if;
  return new;
end $$;
create trigger t_ft_guard before update or delete on financial_transactions for each row execute function private.ft_guard();

-- Orders: status / money / items fields only change through the order functions.
create or replace function private.orders_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.bypass', true), '') <> 'on' and (
       new.status is distinct from old.status or new.payment_status is distinct from old.payment_status
    or new.amount_paid is distinct from old.amount_paid or new.total is distinct from old.total
    or new.subtotal is distinct from old.subtotal or new.delivery_fee is distinct from old.delivery_fee
    or new.discount is distinct from old.discount or new.reference is distinct from old.reference
    or new.access_token is distinct from old.access_token or new.delivery_method is distinct from old.delivery_method
    or new.phone_normalized is distinct from old.phone_normalized or new.customer_id is distinct from old.customer_id) then
    raise exception 'FORBIDDEN: Use the order actions to change status, payment, totals or delivery method';
  end if;
  return new;
end $$;
create trigger t_orders_guard before update on orders for each row execute function private.orders_guard();

create or replace function private.orders_block_delete() returns trigger
language plpgsql as $$ begin raise exception 'FORBIDDEN: Orders cannot be deleted; cancel them instead'; end $$;
create trigger t_orders_no_delete before delete on orders for each row execute function private.orders_block_delete();

-- Enquiry notifications
create or replace function private.enquiry_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications(type, title, body, link)
  values ('new_enquiry', 'New enquiry ' || new.reference, 'A customer is asking about a product', '/admin/enquiries');
  return new;
end $$;
create trigger t_enquiry_notify after insert on enquiries for each row execute function private.enquiry_notify();

-- Expenses -> cash ledger (with reversal on change)
create or replace function private.expense_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_txn financial_transactions;
begin
  if tg_op = 'UPDATE' then
    if new.amount is not distinct from old.amount and new.expense_date is not distinct from old.expense_date
       and new.is_void is not distinct from old.is_void and new.category is not distinct from old.category then
      return new;
    end if;
    for v_txn in select * from financial_transactions
                 where source_type = 'expense' and source_id = old.id and reverses_id is null and not is_reversed loop
      insert into financial_transactions(txn_date, type, direction, amount, description, source_type, source_id, reverses_id, created_by)
      values (current_date, v_txn.type, 'in', v_txn.amount, 'Reversal: ' || coalesce(v_txn.description, ''), 'expense', old.id, v_txn.id, public.current_user_id());
      update financial_transactions set is_reversed = true where id = v_txn.id;
    end loop;
  end if;
  if not new.is_void then
    insert into financial_transactions(txn_date, type, direction, amount, description, payment_method, source_type, source_id, created_by)
    values (new.expense_date, 'expenditure', 'out', new.amount, new.category || ': ' || new.name, new.payment_method, 'expense', new.id, public.current_user_id());
  end if;
  return new;
end $$;
create trigger t_expense_ledger after insert or update on expenses for each row execute function private.expense_ledger();

create or replace function private.expense_no_delete() returns trigger
language plpgsql as $$ begin raise exception 'FORBIDDEN: Void the expense instead of deleting it'; end $$;
create trigger t_expense_no_delete before delete on expenses for each row execute function private.expense_no_delete();

-- ---------------------------------------------------------------------
-- Public storefront views (no cost, supplier or stakeholder data)
-- ---------------------------------------------------------------------
create or replace view public.storefront_products as
select p.id, p.name, p.slug, p.description, p.images, p.unit, p.final_price as price, p.is_featured, p.created_at,
       c.id as category_id, c.name as category_name, c.slug as category_slug,
       coalesce((select sum(greatest(i.available, 0)) from inventory i
                 join distributors d on d.id = i.distributor_id and d.is_active
                 where i.product_id = p.id), 0)::int as available_qty,
       coalesce((select sum(oi.quantity) from order_items oi join orders o on o.id = oi.order_id
                 where oi.product_id = p.id and o.status not in ('cancelled')
                   and o.created_at > now() - interval '90 days'), 0)::int as sold_90d
from products p
join categories c on c.id = p.category_id
join stakeholders s on s.id = p.stakeholder_id
where p.is_active and p.is_available and c.status = 'active' and s.status = 'active' and p.final_price > 0;

create or replace view public.storefront_categories as
select c.id, c.name, c.slug, c.description, c.sort_order,
       (select count(*) from public.storefront_products sp where sp.category_id = c.id)::int as product_count
from categories c
where c.status = 'active';

grant select on public.storefront_products, public.storefront_categories to anonymous, authenticated;

-- ---------------------------------------------------------------------
-- Inventory core
-- ---------------------------------------------------------------------
create or replace function private.apply_stock(
  p_product uuid, p_distributor uuid, p_delta int, p_reserved_delta int, p_type movement_type,
  p_reason text default null, p_ref_type text default null, p_ref_id uuid default null,
  p_batch uuid default null, p_allow_negative boolean default false)
returns stock_movements
language plpgsql security definer set search_path = public as $$
declare inv inventory; v_on int; v_res int; v_mv stock_movements; v_threshold int; v_pname text; v_dname text;
begin
  insert into inventory(product_id, distributor_id) values (p_product, p_distributor)
  on conflict (product_id, distributor_id) do nothing;
  select * into inv from inventory where product_id = p_product and distributor_id = p_distributor for update;
  select name, low_stock_threshold into v_pname, v_threshold from products where id = p_product;
  select name into v_dname from distributors where id = p_distributor;
  v_on := inv.on_hand + p_delta;
  v_res := inv.reserved + p_reserved_delta;
  if v_res < 0 then
    raise exception 'STOCK_ERROR: Reserved quantity for % at % would go below zero', v_pname, v_dname;
  end if;
  if not p_allow_negative and (v_on < 0 or v_on - v_res < 0) then
    raise exception 'INSUFFICIENT_STOCK: % has only % available at %', v_pname, greatest(inv.on_hand - inv.reserved, 0), v_dname;
  end if;
  update inventory set on_hand = v_on, reserved = v_res, updated_at = now() where id = inv.id;
  insert into stock_movements(product_id, distributor_id, movement_type, quantity, reserved_delta, on_hand_after, reserved_after,
                              reason, reference_type, reference_id, batch_id, created_by)
  values (p_product, p_distributor, p_type, p_delta, p_reserved_delta, v_on, v_res, p_reason, p_ref_type, p_ref_id, p_batch, public.current_user_id())
  returning * into v_mv;

  v_threshold := coalesce(inv.low_stock_threshold, v_threshold, 5);
  if (v_on - v_res) <= v_threshold and (inv.on_hand - inv.reserved) > v_threshold then
    insert into notifications(type, title, body, link)
    values (case when v_on - v_res <= 0 then 'out_of_stock' else 'low_stock' end,
            case when v_on - v_res <= 0 then 'Out of stock: ' else 'Low stock: ' end || v_pname,
            format('%s now has %s available', v_dname, v_on - v_res), '/admin/inventory');
  end if;
  return v_mv;
end $$;

-- Allocate items to distributors. Prefers one distributor for the whole order, otherwise splits.
create or replace function private.try_allocate(p_items jsonb, p_candidates uuid[], p_allow_split boolean)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_dist uuid; v_alloc jsonb := '[]'; it record; r record; v_rem int; v_take int;
begin
  if p_candidates is null or cardinality(p_candidates) = 0 then
    return jsonb_build_object('ok', false, 'allocations', '[]'::jsonb);
  end if;

  select d.id into v_dist
  from distributors d
  where d.id = any(p_candidates) and d.is_active
    and not exists (
      select 1 from jsonb_to_recordset(p_items) x(product_id uuid, quantity int)
      left join inventory i on i.product_id = x.product_id and i.distributor_id = d.id
      where coalesce(i.available, 0) < x.quantity)
  order by d.is_hub desc,
           (select coalesce(sum(i2.available), 0) from inventory i2 where i2.distributor_id = d.id) desc,
           d.created_at
  limit 1;

  if v_dist is not null then
    select jsonb_agg(jsonb_build_object('product_id', x.product_id, 'distributor_id', v_dist, 'quantity', x.quantity))
    into v_alloc from jsonb_to_recordset(p_items) x(product_id uuid, quantity int);
    return jsonb_build_object('ok', true, 'mode', 'single', 'allocations', v_alloc);
  end if;

  if not p_allow_split then
    return jsonb_build_object('ok', false, 'allocations', '[]'::jsonb);
  end if;

  for it in select * from jsonb_to_recordset(p_items) x(product_id uuid, quantity int) loop
    v_rem := it.quantity;
    for r in
      select i.distributor_id, i.available
      from inventory i join distributors d on d.id = i.distributor_id
      where i.product_id = it.product_id and d.id = any(p_candidates) and d.is_active and i.available > 0
      order by (i.available >= it.quantity) desc, d.is_hub desc, i.available desc
    loop
      v_take := least(v_rem, r.available);
      v_alloc := v_alloc || jsonb_build_object('product_id', it.product_id, 'distributor_id', r.distributor_id, 'quantity', v_take);
      v_rem := v_rem - v_take;
      exit when v_rem = 0;
    end loop;
    if v_rem > 0 then
      return jsonb_build_object('ok', false, 'allocations', '[]'::jsonb);
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'mode', 'split', 'allocations', v_alloc);
end $$;

-- Decide how an order will be fulfilled for a given hostel (null hostel = off-campus / unlisted).
create or replace function private.plan_fulfilment(p_items jsonb, p_hostel uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_hostel_d uuid[]; v_all_d uuid[]; v_res jsonb; v_supported boolean;
        v_split boolean := coalesce(private.setting_text('allow_split_fulfilment', 'true')::boolean, true);
begin
  if p_hostel is not null then
    select array_agg(d.id) into v_hostel_d
    from distributors d
    join distributor_service_areas a on a.distributor_id = d.id
    join hostels h on h.id = a.hostel_id
    where a.hostel_id = p_hostel and d.is_active and h.is_active;
  end if;
  v_supported := coalesce(cardinality(v_hostel_d), 0) > 0;

  if v_supported then
    v_res := private.try_allocate(p_items, v_hostel_d, v_split);
    if (v_res ->> 'ok')::boolean then
      return v_res || jsonb_build_object('supported', true, 'delivery_method', 'distributor', 'fallback', false);
    end if;
  end if;

  select array_agg(id) into v_all_d from distributors where is_active;
  v_res := private.try_allocate(p_items, v_all_d, true);
  if (v_res ->> 'ok')::boolean then
    return v_res || jsonb_build_object('supported', v_supported, 'delivery_method', 'courier', 'fallback', v_supported,
                                       'stock_mode', v_res ->> 'mode', 'mode', 'courier');
  end if;

  return jsonb_build_object(
    'ok', false, 'supported', v_supported, 'mode', 'unavailable',
    'delivery_method', case when v_supported then 'distributor' else 'courier' end,
    'allocations', '[]'::jsonb,
    'shortfall', (
      select coalesce(jsonb_agg(jsonb_build_object('product_id', x.product_id, 'name', p.name,
                                                   'requested', x.quantity, 'available', coalesce(s.avail, 0))), '[]'::jsonb)
      from jsonb_to_recordset(p_items) x(product_id uuid, quantity int)
      join products p on p.id = x.product_id
      left join lateral (
        select sum(greatest(i.available, 0))::int as avail
        from inventory i join distributors d on d.id = i.distributor_id and d.is_active
        where i.product_id = x.product_id) s on true
      where coalesce(s.avail, 0) < x.quantity));
end $$;

-- Validate and price a cart against live data. Never trusts client prices.
create or replace function private.price_cart(p_items jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r record; v_lines jsonb := '[]'; v_req jsonb := '[]'; v_errors jsonb := '[]'; v_subtotal numeric := 0; v_markup numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('lines', '[]'::jsonb, 'request', '[]'::jsonb, 'subtotal', 0, 'errors', jsonb_build_array('Your cart is empty'));
  end if;

  for r in
    select x.product_id, sum(x.quantity)::int as quantity,
           p.id as pid, p.name, p.unit, p.final_price, p.base_price, p.cost_price, p.markup_percent as p_markup,
           p.is_active, p.is_available, c.name as category_name, c.status as category_status,
           s.id as stakeholder_id, s.name as stakeholder_name, s.status as stakeholder_status,
           s.markup_percent as s_markup, s.commission_percent, s.is_platform_owner
    from jsonb_to_recordset(p_items) x(product_id uuid, quantity int)
    left join products p on p.id = x.product_id
    left join categories c on c.id = p.category_id
    left join stakeholders s on s.id = p.stakeholder_id
    group by x.product_id, p.id, c.id, s.id
  loop
    if r.pid is null then
      v_errors := v_errors || to_jsonb('A product in your cart no longer exists'::text);
      continue;
    end if;
    if not (r.is_active and r.is_available and r.category_status = 'active' and r.stakeholder_status = 'active' and r.final_price > 0) then
      v_errors := v_errors || to_jsonb(r.name || ' is no longer available');
      continue;
    end if;
    if r.quantity is null or r.quantity < 1 or r.quantity > 100 then
      v_errors := v_errors || to_jsonb('Invalid quantity for ' || r.name);
      continue;
    end if;
    v_markup := coalesce(r.p_markup, r.s_markup, 0);
    v_lines := v_lines || jsonb_build_object(
      'product_id', r.pid, 'name', r.name, 'unit', r.unit, 'quantity', r.quantity,
      'unit_price', r.final_price, 'line_total', round(r.final_price * r.quantity, 2),
      'base_price', r.base_price, 'cost_price', r.cost_price, 'markup_percent', v_markup,
      'commission_percent', r.commission_percent, 'is_platform_owned', r.is_platform_owner,
      'category_name', r.category_name, 'stakeholder_id', r.stakeholder_id, 'stakeholder_name', r.stakeholder_name);
    v_req := v_req || jsonb_build_object('product_id', r.pid, 'quantity', r.quantity);
    v_subtotal := v_subtotal + round(r.final_price * r.quantity, 2);
  end loop;

  return jsonb_build_object('lines', v_lines, 'request', v_req, 'subtotal', v_subtotal, 'errors', v_errors);
end $$;

-- ---------------------------------------------------------------------
-- Customer-facing order functions
-- ---------------------------------------------------------------------
create or replace function public.quote_order(p_items jsonb, p_hostel_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_cart jsonb; v_plan jsonb; v_fee numeric; v_without_stock boolean;
begin
  v_cart := private.price_cart(p_items);
  if jsonb_array_length(v_cart -> 'errors') > 0 then
    return jsonb_build_object('ok', false, 'errors', v_cart -> 'errors');
  end if;
  v_plan := private.plan_fulfilment(v_cart -> 'request', p_hostel_id);
  v_without_stock := coalesce(private.setting_text('allow_orders_without_stock', 'false')::boolean, false);
  v_fee := case when v_plan ->> 'delivery_method' = 'courier'
                then coalesce(private.setting_text('delivery_fee_courier', '0')::numeric, 0)
                else coalesce(private.setting_text('delivery_fee_distributor', '0')::numeric, 0) end;
  return jsonb_build_object(
    'ok', (v_plan ->> 'ok')::boolean or v_without_stock,
    'errors', '[]'::jsonb,
    'items', (select jsonb_agg(jsonb_build_object('product_id', l ->> 'product_id', 'name', l ->> 'name', 'unit', l ->> 'unit',
                                                  'quantity', (l ->> 'quantity')::int, 'unit_price', (l ->> 'unit_price')::numeric,
                                                  'line_total', (l ->> 'line_total')::numeric))
              from jsonb_array_elements(v_cart -> 'lines') l),
    'subtotal', (v_cart ->> 'subtotal')::numeric,
    'delivery_fee', v_fee,
    'total', (v_cart ->> 'subtotal')::numeric + v_fee,
    'delivery_method', v_plan ->> 'delivery_method',
    'supported_location', coalesce((v_plan ->> 'supported')::boolean, false),
    'courier_fallback', coalesce((v_plan ->> 'fallback')::boolean, false),
    'split', coalesce(v_plan ->> 'mode', '') = 'split' or coalesce(v_plan ->> 'stock_mode', '') = 'split',
    'unavailable', case when (v_plan ->> 'ok')::boolean then '[]'::jsonb else coalesce(v_plan -> 'shortfall', '[]'::jsonb) end,
    'manual_fulfilment', not (v_plan ->> 'ok')::boolean and v_without_stock,
    'courier_note', private.setting_text('courier_note', 'Delivered by courier. We will call you to confirm timing.'));
end $$;

create or replace function private.insert_order_item(p_order uuid, l jsonb, p_distributor uuid, p_qty int, p_state item_stock_state)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_lt numeric; v_sp numeric; v_owned boolean := (l ->> 'is_platform_owned')::boolean;
begin
  v_lt := round((l ->> 'unit_price')::numeric * p_qty, 2);
  v_sp := case when v_owned then 0
               else round((l ->> 'base_price')::numeric * p_qty * (1 - (l ->> 'commission_percent')::numeric / 100.0), 2) end;
  insert into order_items(order_id, product_id, distributor_id, product_name, category_name, stakeholder_id, stakeholder_name, unit,
                          quantity, unit_price, base_price, cost_price, markup_percent, commission_percent, is_platform_owned,
                          line_total, platform_revenue, stakeholder_proceeds, stock_state)
  values (p_order, (l ->> 'product_id')::uuid, p_distributor, l ->> 'name', l ->> 'category_name', (l ->> 'stakeholder_id')::uuid,
          l ->> 'stakeholder_name', l ->> 'unit', p_qty, (l ->> 'unit_price')::numeric, (l ->> 'base_price')::numeric,
          (l ->> 'cost_price')::numeric, (l ->> 'markup_percent')::numeric, (l ->> 'commission_percent')::numeric, v_owned,
          v_lt, v_lt - v_sp, v_sp, p_state)
  returning id into v_id;
  return v_id;
end $$;

-- The customer-safe view of an order (never exposes stakeholder contacts, costs or internal notes).
create or replace function private.order_public_view(p_order uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o orders; v_owned boolean; v_primary jsonb := '[]'; v_backup jsonb := '[]';
        v_business text := private.setting_text('contact_business_phone');
        v_cs text := private.setting_text('contact_customer_service_phone');
        v_snap text := private.setting_text('contact_snapchat');
        v_wa text := private.setting_text('contact_whatsapp');
begin
  select * into o from orders where id = p_order;
  if not found then return null; end if;
  v_owned := not exists (select 1 from order_items where order_id = o.id and not is_platform_owned);

  if not v_owned then
    v_primary := v_primary || jsonb_build_object('label', 'SarahPetermore order line', 'name', 'SarahPetermore', 'phone', v_business);
  end if;
  if o.delivery_method = 'distributor' and o.status not in ('cancelled', 'refunded') then
    select v_primary || coalesce(jsonb_agg(jsonb_build_object('label', 'Your delivery contact',
                                         'name', coalesce(d.contact_person, d.name), 'phone', d.phone)), '[]'::jsonb)
    into v_primary
    from (select distinct d.* from order_fulfilment_assignments a join distributors d on d.id = a.distributor_id
          where a.order_id = o.id and a.role = 'delivery' and a.status <> 'cancelled') d;
  end if;
  if jsonb_array_length(v_primary) = 0 then
    v_primary := jsonb_build_array(jsonb_build_object('label', 'SarahPetermore order line', 'name', 'SarahPetermore', 'phone', v_business));
  end if;
  if v_business is not null then v_backup := v_backup || jsonb_build_object('label', 'Business line', 'phone', v_business); end if;
  if v_cs is not null then v_backup := v_backup || jsonb_build_object('label', '24/7 Customer service', 'phone', v_cs); end if;
  if v_wa is not null then v_backup := v_backup || jsonb_build_object('label', 'WhatsApp', 'phone', v_wa); end if;
  if v_snap is not null then v_backup := v_backup || jsonb_build_object('label', 'Snapchat', 'handle', v_snap); end if;

  return jsonb_build_object(
    'reference', o.reference, 'status', o.status, 'payment_status', o.payment_status, 'created_at', o.created_at,
    'delivered_at', o.delivered_at, 'customer_name', o.customer_name,
    'phone_masked', '•••• ' || right(o.phone_normalized, 3),
    'delivery_method', o.delivery_method, 'location_type', o.location_type,
    'institution_name', o.institution_name, 'hostel_name', o.hostel_name, 'room_number', o.room_number,
    'address_line', o.address_line, 'delivery_instructions', o.delivery_instructions,
    'subtotal', o.subtotal, 'delivery_fee', o.delivery_fee, 'discount', o.discount, 'total', o.total, 'amount_paid', o.amount_paid,
    'courier', case when o.courier_name is not null or o.courier_tracking is not null
                    then jsonb_build_object('name', o.courier_name, 'phone', o.courier_phone, 'tracking', o.courier_tracking) end,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'name', product_name, 'unit', unit,
                                   'quantity', qty, 'unit_price', unit_price, 'line_total', lt) order by product_name), '[]'::jsonb)
              from (select product_id, product_name, unit, unit_price, sum(quantity)::int qty, sum(line_total) lt
                    from order_items where order_id = o.id group by product_id, product_name, unit, unit_price) x),
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object('status', to_status, 'at', created_at) order by created_at), '[]'::jsonb)
                 from order_status_history where order_id = o.id),
    'contacts', jsonb_build_object('primary', v_primary, 'backup', v_backup));
end $$;

create or replace function public.place_order(p jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_name text := btrim(p -> 'customer' ->> 'name');
  v_phone text := btrim(p -> 'customer' ->> 'phone');
  v_phone_n text;
  v_loc jsonb := coalesce(p -> 'location', '{}'::jsonb);
  v_loc_type location_type;
  v_inst uuid; v_hostel uuid; v_inst_name text; v_hostel_name text;
  v_cart jsonb; v_plan jsonb; v_order orders; v_customer uuid; v_fee numeric; v_ref text;
  v_alloc record; v_line jsonb; v_manual boolean := false; v_units int; v_source text;
begin
  perform set_config('app.bypass', 'on', true);

  if v_name is null or length(v_name) < 2 then raise exception 'VALIDATION: Please enter your name'; end if;
  v_phone_n := public.normalize_phone(v_phone);
  if length(v_phone_n) < 9 then raise exception 'VALIDATION: Please enter a valid phone number'; end if;
  if (select count(*) from orders where phone_normalized = v_phone_n and created_at > now() - interval '10 minutes')
     >= coalesce(private.setting_text('max_orders_per_phone_10min', '5')::int, 5) then
    raise exception 'RATE_LIMIT: Too many orders from this number in a short time. Please call us to complete your order.';
  end if;

  v_loc_type := coalesce(nullif(v_loc ->> 'type', ''), 'off_campus')::location_type;
  if v_loc_type = 'on_campus' then
    v_inst := nullif(v_loc ->> 'institution_id', '')::uuid;
    if v_inst is null then raise exception 'VALIDATION: Please choose your campus'; end if;
    select name into v_inst_name from institutions where id = v_inst and is_active;
    if v_inst_name is null then raise exception 'VALIDATION: We do not deliver to that campus yet'; end if;
    v_hostel := nullif(v_loc ->> 'hostel_id', '')::uuid;
    if v_hostel is not null then
      select name into v_hostel_name from hostels where id = v_hostel and institution_id = v_inst and is_active;
      if v_hostel_name is null then raise exception 'VALIDATION: Please choose a valid hostel'; end if;
    elsif coalesce(btrim(v_loc ->> 'address_line'), '') = '' then
      raise exception 'VALIDATION: Please tell us where on campus to deliver';
    end if;
  elsif coalesce(btrim(v_loc ->> 'address_line'), '') = '' then
    raise exception 'VALIDATION: Please enter your delivery address';
  end if;

  v_cart := private.price_cart(p -> 'items');
  if jsonb_array_length(v_cart -> 'errors') > 0 then
    raise exception 'VALIDATION: %', v_cart -> 'errors' ->> 0;
  end if;

  v_plan := private.plan_fulfilment(v_cart -> 'request', v_hostel);
  if not (v_plan ->> 'ok')::boolean then
    if coalesce(private.setting_text('allow_orders_without_stock', 'false')::boolean, false) then
      v_manual := true;
    else
      raise exception 'OUT_OF_STOCK: %', (select string_agg(format('%s (only %s left)', s ->> 'name', s ->> 'available'), ', ')
                                          from jsonb_array_elements(v_plan -> 'shortfall') s);
    end if;
  end if;

  v_fee := case when v_plan ->> 'delivery_method' = 'courier'
                then coalesce(private.setting_text('delivery_fee_courier', '0')::numeric, 0)
                else coalesce(private.setting_text('delivery_fee_distributor', '0')::numeric, 0) end;

  if public.current_user_id() is not null then
    select id into v_customer from customers where user_id = public.current_user_id();
    if v_customer is null then
      insert into customers(user_id, full_name, phone, phone_normalized, alt_phone, email)
      values (public.current_user_id(), v_name, v_phone, v_phone_n, nullif(btrim(p -> 'customer' ->> 'alt_phone'), ''), nullif(btrim(p -> 'customer' ->> 'email'), ''))
      returning id into v_customer;
    end if;
  else
    select id into v_customer from customers where phone_normalized = v_phone_n and user_id is null order by created_at limit 1;
    if v_customer is null then
      insert into customers(full_name, phone, phone_normalized, alt_phone, email)
      values (v_name, v_phone, v_phone_n, nullif(btrim(p -> 'customer' ->> 'alt_phone'), ''), nullif(btrim(p -> 'customer' ->> 'email'), ''))
      returning id into v_customer;
    end if;
  end if;

  loop
    v_ref := 'SP-' || private.gen_code(6);
    exit when not exists (select 1 from orders where reference = v_ref);
  end loop;
  v_source := case when p ->> 'source' = 'assistant' then 'assistant' else 'web' end;

  insert into orders(reference, customer_id, user_id, customer_name, phone, phone_normalized, alt_phone, email, location_type,
                     institution_id, hostel_id, institution_name, hostel_name, room_number, address_line, digital_address,
                     delivery_instructions, delivery_method, is_supported_location, fulfilment_mode, subtotal, delivery_fee, total, source)
  values (v_ref, v_customer, public.current_user_id(), v_name, v_phone, v_phone_n, nullif(btrim(p -> 'customer' ->> 'alt_phone'), ''),
          nullif(btrim(p -> 'customer' ->> 'email'), ''), v_loc_type, v_inst, v_hostel, v_inst_name, v_hostel_name,
          nullif(btrim(v_loc ->> 'room_number'), ''), nullif(btrim(v_loc ->> 'address_line'), ''),
          nullif(btrim(v_loc ->> 'digital_address'), ''), nullif(btrim(v_loc ->> 'instructions'), ''),
          (v_plan ->> 'delivery_method')::delivery_method, coalesce((v_plan ->> 'supported')::boolean, false),
          case when v_manual then 'manual' else v_plan ->> 'mode' end,
          (v_cart ->> 'subtotal')::numeric, v_fee, (v_cart ->> 'subtotal')::numeric + v_fee, v_source)
  returning * into v_order;

  if v_manual then
    for v_line in select * from jsonb_array_elements(v_cart -> 'lines') loop
      perform private.insert_order_item(v_order.id, v_line, null, (v_line ->> 'quantity')::int, 'unallocated');
    end loop;
  else
    for v_alloc in select * from jsonb_to_recordset(v_plan -> 'allocations') x(product_id uuid, distributor_id uuid, quantity int) loop
      select l into v_line from jsonb_array_elements(v_cart -> 'lines') l where (l ->> 'product_id')::uuid = v_alloc.product_id;
      perform private.insert_order_item(v_order.id, v_line, v_alloc.distributor_id, v_alloc.quantity, 'reserved');
      perform private.apply_stock(v_alloc.product_id, v_alloc.distributor_id, 0, v_alloc.quantity, 'order_reserve',
                                  'Order ' || v_ref, 'order', v_order.id);
    end loop;
    insert into order_fulfilment_assignments(order_id, distributor_id, role, assigned_by)
    select distinct v_order.id, x.distributor_id,
           case when v_plan ->> 'delivery_method' = 'distributor' then 'delivery' else 'stock_source' end, public.current_user_id()
    from jsonb_to_recordset(v_plan -> 'allocations') x(product_id uuid, distributor_id uuid, quantity int);
  end if;

  insert into order_status_history(order_id, from_status, to_status, note, changed_by)
  values (v_order.id, null, 'received', 'Order placed (' || v_source || ')', public.current_user_id());

  select sum((l ->> 'quantity')::int) into v_units from jsonb_array_elements(v_cart -> 'lines') l;
  insert into notifications(type, title, body, link)
  values ('new_order', 'New order ' || v_ref,
          format('%s item(s) · GH₵ %s · %s%s', v_units, to_char(v_order.total, 'FM999,990.00'),
                 case when v_order.delivery_method = 'courier' then 'Courier' else coalesce(v_hostel_name, 'Campus') end,
                 case when v_manual then ' · needs stock assignment' when (v_plan ->> 'mode') = 'split' then ' · split fulfilment' else '' end),
          '/admin/orders/' || v_order.id);

  return private.order_public_view(v_order.id)
         || jsonb_build_object('access_token', v_order.access_token, 'order_id', v_order.id);
end $$;

create or replace function public.get_order_by_token(p_reference text, p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from orders where reference = upper(btrim(p_reference)) and access_token = p_token;
  if v_id is null then raise exception 'NOT_FOUND: Order not found'; end if;
  return private.order_public_view(v_id);
end $$;

create or replace function public.track_order(p_reference text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from orders
  where reference = upper(btrim(p_reference)) and phone_normalized = public.normalize_phone(p_phone)
    and length(public.normalize_phone(p_phone)) = 9;
  if v_id is null then
    raise exception 'NOT_FOUND: We could not find an order with that reference and phone number';
  end if;
  return private.order_public_view(v_id);
end $$;

create or replace function public.my_orders()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'reference', o.reference, 'access_token', o.access_token, 'created_at', o.created_at, 'status', o.status,
           'total', o.total, 'item_count', (select sum(quantity) from order_items where order_id = o.id),
           'items', (select jsonb_agg(jsonb_build_object('product_id', product_id, 'name', product_name, 'quantity', quantity))
                     from order_items where order_id = o.id))
         order by o.created_at desc), '[]'::jsonb)
  from orders o where public.current_user_id() is not null and o.user_id = public.current_user_id()
$$;

create or replace function public.create_enquiry(p jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_ref text; v_phone_n text := public.normalize_phone(p ->> 'phone');
begin
  if length(v_phone_n) < 9 then raise exception 'VALIDATION: Please enter a valid phone number'; end if;
  if coalesce(btrim(p ->> 'message'), '') = '' and coalesce(btrim(p ->> 'product_name'), '') = '' then
    raise exception 'VALIDATION: Tell us what you are looking for';
  end if;
  if (select count(*) from enquiries where public.normalize_phone(phone) = v_phone_n and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'RATE_LIMIT: Please wait a few minutes before sending another enquiry';
  end if;
  loop
    v_ref := 'EQ-' || private.gen_code(5);
    exit when not exists (select 1 from enquiries where reference = v_ref);
  end loop;
  insert into enquiries(reference, user_id, customer_name, phone, product_name, quantity, message, source)
  values (v_ref, public.current_user_id(), nullif(btrim(p ->> 'name'), ''), btrim(p ->> 'phone'), nullif(btrim(p ->> 'product_name'), ''),
          nullif(p ->> 'quantity', '')::int, coalesce(nullif(btrim(p ->> 'message'), ''), 'Looking for: ' || (p ->> 'product_name')),
          case when p ->> 'source' = 'assistant' then 'assistant' else 'web' end);
  return jsonb_build_object('reference', v_ref);
end $$;

-- ---------------------------------------------------------------------
-- Admin: order lifecycle
-- ---------------------------------------------------------------------
create or replace function private.set_order_status(p_order uuid, p_status order_status, p_note text)
returns orders
language plpgsql security definer set search_path = public as $$
declare o orders; v_from order_status; it order_items; v_ok boolean;
begin
  perform set_config('app.bypass', 'on', true);
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND: Order not found'; end if;
  if o.status = p_status then return o; end if;
  v_from := o.status;

  v_ok := case
    when v_from in ('received','confirmed','processing','ready_for_delivery','out_for_delivery','failed_delivery')
      then p_status in ('received','confirmed','processing','ready_for_delivery','out_for_delivery','failed_delivery','delivered','cancelled')
    when v_from = 'delivered' then p_status in ('refund_pending','refunded','returned')
    when v_from = 'cancelled' then p_status in ('refund_pending','refunded')
    when v_from = 'refund_pending' then p_status in ('refunded','delivered','cancelled','returned')
    when v_from = 'returned' then p_status in ('refund_pending','refunded')
    when v_from = 'refunded' then p_status in ('returned')
    else false end;
  if not v_ok then
    raise exception 'INVALID_TRANSITION: An order cannot go from % to %', replace(v_from::text, '_', ' '), replace(p_status::text, '_', ' ');
  end if;

  if p_status = 'delivered' then
    if exists (select 1 from order_items where order_id = o.id and stock_state in ('unallocated', 'released')) then
      raise exception 'STOCK_ERROR: Assign stock to every item before marking this order delivered';
    end if;
    for it in select * from order_items where order_id = o.id and stock_state = 'reserved' for update loop
      perform private.apply_stock(it.product_id, it.distributor_id, -it.quantity, -it.quantity, 'order_fulfil',
                                  'Delivered ' || o.reference, 'order', o.id);
      update order_items set stock_state = 'fulfilled' where id = it.id;
    end loop;
  elsif p_status = 'cancelled' then
    if exists (select 1 from order_items where order_id = o.id and stock_state = 'fulfilled') then
      raise exception 'INVALID_TRANSITION: This order was delivered. Mark it Returned or Refunded instead';
    end if;
    for it in select * from order_items where order_id = o.id and stock_state = 'reserved' for update loop
      perform private.apply_stock(it.product_id, it.distributor_id, 0, -it.quantity, 'order_release',
                                  'Cancelled ' || o.reference, 'order', o.id);
      update order_items set stock_state = 'released' where id = it.id;
    end loop;
    update order_items set stock_state = 'released' where order_id = o.id and stock_state = 'unallocated';
  elsif p_status = 'returned' then
    for it in select * from order_items where order_id = o.id and stock_state = 'fulfilled' for update loop
      perform private.apply_stock(it.product_id, it.distributor_id, it.quantity, 0, 'return',
                                  'Returned ' || o.reference, 'order', o.id);
      update order_items set stock_state = 'returned' where id = it.id;
    end loop;
  end if;

  update orders set status = p_status,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
         cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end
  where id = o.id returning * into o;

  update order_fulfilment_assignments
     set status = case when p_status = 'delivered' then 'completed' when p_status = 'cancelled' then 'cancelled' else status end
   where order_id = o.id and status <> 'cancelled' and p_status in ('delivered', 'cancelled');

  insert into order_status_history(order_id, from_status, to_status, note, changed_by)
  values (o.id, v_from, p_status, nullif(btrim(p_note), ''), public.current_user_id());
  return o;
end $$;

create or replace function public.update_order_status(p_order uuid, p_status order_status, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  perform private.require_roles('{manager,order_manager}');
  o := private.set_order_status(p_order, p_status, p_note);
  return to_jsonb(o);
end $$;

create or replace function public.bulk_update_order_status(p_orders uuid[], p_status order_status, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ok int := 0; v_fail jsonb := '[]';
begin
  perform private.require_roles('{manager,order_manager}');
  foreach v_id in array p_orders loop
    begin
      perform private.set_order_status(v_id, p_status, p_note);
      v_ok := v_ok + 1;
    exception when others then
      v_fail := v_fail || jsonb_build_object('order_id', v_id, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('updated', v_ok, 'failed', v_fail);
end $$;

-- Move an order's stock (and delivery) to another distributor. Re-checks availability.
create or replace function public.assign_order_distributor(p_order uuid, p_distributor uuid, p_item uuid default null,
                                                            p_delivery_method delivery_method default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o orders; it order_items; v_role text;
begin
  perform private.require_roles('{manager,order_manager,inventory_manager}');
  perform set_config('app.bypass', 'on', true);
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND: Order not found'; end if;
  if o.status in ('delivered','cancelled','refunded','returned','refund_pending') then
    raise exception 'INVALID_TRANSITION: Stock can only be reassigned on open orders';
  end if;
  if not exists (select 1 from distributors where id = p_distributor and is_active) then
    raise exception 'VALIDATION: Choose an active distributor';
  end if;

  for it in select * from order_items where order_id = o.id and (p_item is null or id = p_item)
             and stock_state in ('reserved','unallocated') for update loop
    if it.stock_state = 'reserved' and it.distributor_id = p_distributor then continue; end if;
    if it.stock_state = 'reserved' then
      perform private.apply_stock(it.product_id, it.distributor_id, 0, -it.quantity, 'order_release',
                                  'Reassigned ' || o.reference, 'order', o.id);
    end if;
    perform private.apply_stock(it.product_id, p_distributor, 0, it.quantity, 'order_reserve',
                                'Reassigned ' || o.reference, 'order', o.id);
    update order_items set distributor_id = p_distributor, stock_state = 'reserved' where id = it.id;
  end loop;

  if p_delivery_method is not null and p_delivery_method <> o.delivery_method then
    update orders set delivery_method = p_delivery_method where id = o.id returning * into o;
  end if;
  v_role := case when o.delivery_method = 'distributor' then 'delivery' else 'stock_source' end;

  update order_fulfilment_assignments a set status = 'cancelled'
  where a.order_id = o.id and a.status <> 'cancelled'
    and (a.role <> v_role or not exists (select 1 from order_items oi where oi.order_id = o.id and oi.distributor_id = a.distributor_id));
  insert into order_fulfilment_assignments(order_id, distributor_id, role, assigned_by, notes)
  select distinct o.id, oi.distributor_id, v_role, public.current_user_id(), 'Manual assignment'
  from order_items oi where oi.order_id = o.id and oi.distributor_id is not null
    and not exists (select 1 from order_fulfilment_assignments a where a.order_id = o.id and a.distributor_id = oi.distributor_id
                    and a.role = v_role and a.status <> 'cancelled');
  update orders set fulfilment_mode = case
      when o.delivery_method = 'courier' then 'courier'
      when (select count(distinct distributor_id) from order_items where order_id = o.id) > 1 then 'split'
      else 'single' end
  where id = o.id;

  perform private.audit('assign_distributor', 'orders', o.id::text,
                        jsonb_build_object('distributor_id', p_distributor, 'item_id', p_item, 'delivery_method', o.delivery_method));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.record_order_payment(p_order uuid, p_amount numeric, p_method text default 'cash', p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  perform private.require_roles('{manager,order_manager,finance_manager}');
  perform set_config('app.bypass', 'on', true);
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND: Order not found'; end if;
  if o.status in ('cancelled', 'refunded') then raise exception 'VALIDATION: Cannot take payment on a % order', o.status; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'VALIDATION: Enter an amount above zero'; end if;
  if o.amount_paid + p_amount > o.total then
    raise exception 'VALIDATION: Payment exceeds the outstanding balance of GH₵ %', o.total - o.amount_paid;
  end if;
  insert into financial_transactions(type, direction, amount, description, payment_method, source_type, source_id, created_by)
  values ('income', 'in', p_amount, 'Payment for order ' || o.reference || coalesce(' — ' || nullif(p_note, ''), ''),
          coalesce(p_method, 'cash'), 'order', o.id, public.current_user_id());
  update orders set amount_paid = amount_paid + p_amount,
         payment_status = case when amount_paid + p_amount >= total then 'paid'::payment_status else 'partially_paid'::payment_status end
  where id = o.id returning * into o;
  return jsonb_build_object('amount_paid', o.amount_paid, 'payment_status', o.payment_status);
end $$;

create or replace function public.create_refund(p_order uuid, p_amount numeric, p_reason text, p_method text default null, p_paid boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o orders; v_refunded numeric; v_id uuid; v_full boolean;
begin
  perform private.require_roles('{manager,order_manager,finance_manager}');
  perform set_config('app.bypass', 'on', true);
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND: Order not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'VALIDATION: Enter a refund amount above zero'; end if;
  select coalesce(sum(amount), 0) into v_refunded from refunds where order_id = o.id and status <> 'cancelled';
  if v_refunded + p_amount > o.amount_paid then
    raise exception 'VALIDATION: Refunds cannot exceed the GH₵ % collected on this order', o.amount_paid - v_refunded;
  end if;
  insert into refunds(order_id, amount, reason, method, status, paid_at, created_by)
  values (o.id, p_amount, p_reason, p_method, case when p_paid then 'paid' else 'pending' end, case when p_paid then now() end, public.current_user_id())
  returning id into v_id;
  if p_paid then
    insert into financial_transactions(type, direction, amount, description, payment_method, source_type, source_id, created_by)
    values ('refund', 'out', p_amount, 'Refund for order ' || o.reference, p_method, 'refund', v_id, public.current_user_id());
  end if;
  v_full := v_refunded + p_amount >= o.amount_paid;
  if v_full and o.status in ('delivered','cancelled','returned','refund_pending') then
    if p_paid then
      perform private.set_order_status(o.id, 'refunded', 'Refund recorded: ' || coalesce(p_reason, ''));
      update orders set payment_status = 'refunded' where id = o.id;
    elsif o.status <> 'refund_pending' then
      perform private.set_order_status(o.id, 'refund_pending', 'Refund requested: ' || coalesce(p_reason, ''));
    end if;
  end if;
  insert into notifications(type, title, body, link)
  values ('refund', 'Refund ' || case when p_paid then 'paid' else 'requested' end || ' · ' || o.reference,
          'GH₵ ' || to_char(p_amount, 'FM999,990.00'), '/admin/orders/' || o.id);
  return jsonb_build_object('refund_id', v_id);
end $$;

create or replace function public.mark_refund_paid(p_refund uuid, p_method text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r refunds; o orders; v_paid numeric;
begin
  perform private.require_roles('{manager,order_manager,finance_manager}');
  perform set_config('app.bypass', 'on', true);
  select * into r from refunds where id = p_refund for update;
  if not found then raise exception 'NOT_FOUND: Refund not found'; end if;
  if r.status <> 'pending' then raise exception 'VALIDATION: This refund is already %', r.status; end if;
  update refunds set status = 'paid', paid_at = now(), method = coalesce(p_method, method) where id = r.id;
  select * into o from orders where id = r.order_id for update;
  insert into financial_transactions(type, direction, amount, description, payment_method, source_type, source_id, created_by)
  values ('refund', 'out', r.amount, 'Refund for order ' || o.reference, coalesce(p_method, r.method), 'refund', r.id, public.current_user_id());
  select coalesce(sum(amount), 0) into v_paid from refunds where order_id = o.id and status = 'paid';
  if v_paid >= o.amount_paid and o.status in ('delivered','cancelled','returned','refund_pending') then
    perform private.set_order_status(o.id, 'refunded', 'Refund paid');
    update orders set payment_status = 'refunded' where id = o.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Admin: inventory
-- ---------------------------------------------------------------------
create or replace function private.adjustment_rows(p jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a record; v_rows jsonb := '[]'; v_on int; v_res int; v_type text; v_err text;
begin
  for a in select * from jsonb_to_recordset(p) x(product_id uuid, distributor_id uuid, delta int, movement_type text, reason text) loop
    select coalesce(i.on_hand, 0), coalesce(i.reserved, 0) into v_on, v_res
    from (select 1) one left join inventory i on i.product_id = a.product_id and i.distributor_id = a.distributor_id;
    v_type := coalesce(nullif(a.movement_type, ''), case when a.delta >= 0 then 'adjustment_in' else 'adjustment_out' end);
    v_err := case
      when a.delta is null or a.delta = 0 then 'No change'
      when not exists (select 1 from products where id = a.product_id) then 'Unknown product'
      when not exists (select 1 from distributors where id = a.distributor_id) then 'Unknown distributor'
      when a.delta > 0 and v_type not in ('adjustment_in','correction','return','import') then 'Use an "in" reason for increases'
      when a.delta < 0 and v_type not in ('adjustment_out','damaged','expired','internal_use','correction') then 'Use an "out" reason for decreases'
      when v_on + a.delta < 0 then 'Would make stock negative'
      when v_on + a.delta - v_res < 0 then format('%s units are reserved for open orders', v_res)
      else null end;
    v_rows := v_rows || jsonb_build_object(
      'product_id', a.product_id, 'distributor_id', a.distributor_id,
      'product_name', (select name from products where id = a.product_id),
      'distributor_name', (select name from distributors where id = a.distributor_id),
      'before', v_on, 'reserved', v_res, 'delta', a.delta, 'after', v_on + coalesce(a.delta, 0),
      'movement_type', v_type, 'reason', a.reason, 'error', v_err);
  end loop;
  return v_rows;
end $$;

create or replace function public.preview_stock_adjustments(p_adjustments jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform private.require_roles('{manager,inventory_manager}');
  return private.adjustment_rows(p_adjustments);
end $$;

create or replace function public.adjust_stock_batch(p_adjustments jsonb, p_reason text default null, p_override boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb; r jsonb; v_batch uuid := gen_random_uuid();
begin
  perform private.require_roles('{manager,inventory_manager}');
  if p_override and not public.has_role('super_admin') then
    raise exception 'FORBIDDEN: Only a super admin can override negative stock';
  end if;
  if p_override and coalesce(btrim(p_reason), '') = '' then
    raise exception 'VALIDATION: An override needs a reason';
  end if;
  v_rows := private.adjustment_rows(p_adjustments);
  for r in select * from jsonb_array_elements(v_rows) loop
    if r ->> 'error' = 'No change' then continue; end if;
    if r ->> 'error' is not null and not (p_override and r ->> 'error' not in ('Unknown product','Unknown distributor')) then
      raise exception 'VALIDATION: % at %: %', r ->> 'product_name', r ->> 'distributor_name', r ->> 'error';
    end if;
    perform private.apply_stock((r ->> 'product_id')::uuid, (r ->> 'distributor_id')::uuid, (r ->> 'delta')::int, 0,
                                (r ->> 'movement_type')::movement_type,
                                coalesce(nullif(r ->> 'reason', ''), nullif(btrim(p_reason), ''), 'Manual adjustment'),
                                'adjustment', v_batch, v_batch, p_override);
  end loop;
  perform private.audit('stock_adjustment', 'inventory', v_batch::text, jsonb_build_object('rows', v_rows, 'reason', p_reason, 'override', p_override));
  return jsonb_build_object('batch_id', v_batch, 'rows', v_rows);
end $$;

create or replace function public.assign_products_to_distributor(p_distributor uuid, p_products uuid[])
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform private.require_roles('{manager,inventory_manager}');
  insert into inventory(product_id, distributor_id)
  select unnest(p_products), p_distributor
  on conflict (product_id, distributor_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.set_distributor_service_areas(p_distributor uuid, p_hostels uuid[])
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_roles('{manager,inventory_manager}');
  delete from distributor_service_areas where distributor_id = p_distributor and not (hostel_id = any(coalesce(p_hostels, '{}')));
  insert into distributor_service_areas(distributor_id, hostel_id)
  select p_distributor, h from unnest(coalesce(p_hostels, '{}')) h
  on conflict do nothing;
end $$;

-- Transfers: draft -> in_transit (source deducted) -> received (destination credited) | cancelled
create or replace function private.dispatch_transfer(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t stock_transfers; it stock_transfer_items;
begin
  select * into t from stock_transfers where id = p_id for update;
  if t.status <> 'draft' then raise exception 'INVALID_TRANSITION: Only draft transfers can be dispatched'; end if;
  for it in select * from stock_transfer_items where transfer_id = t.id loop
    perform private.apply_stock(it.product_id, t.source_distributor_id, -it.quantity, 0, 'transfer_out',
                                'Transfer ' || t.reference, 'transfer', t.id);
  end loop;
  update stock_transfers set status = 'in_transit', dispatched_at = now() where id = t.id;
  insert into notifications(type, title, body, link)
  values ('transfer', 'Transfer ' || t.reference || ' in transit', 'Confirm receipt when it arrives', '/admin/inventory/transfers');
end $$;

create or replace function private.receive_transfer(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t stock_transfers; it stock_transfer_items;
begin
  select * into t from stock_transfers where id = p_id for update;
  if t.status <> 'in_transit' then raise exception 'INVALID_TRANSITION: Only in-transit transfers can be received'; end if;
  for it in select * from stock_transfer_items where transfer_id = t.id loop
    perform private.apply_stock(it.product_id, t.destination_distributor_id, it.quantity, 0, 'transfer_in',
                                'Transfer ' || t.reference, 'transfer', t.id);
  end loop;
  update stock_transfers set status = 'received', received_at = now(), received_by = public.current_user_id() where id = t.id;
end $$;

create or replace function public.create_transfer(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ref text; it record;
begin
  perform private.require_roles('{manager,inventory_manager}');
  if (p ->> 'source_distributor_id') = (p ->> 'destination_distributor_id') then
    raise exception 'VALIDATION: Source and destination must be different';
  end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'VALIDATION: Add at least one product'; end if;
  loop
    v_ref := 'TR-' || private.gen_code(5);
    exit when not exists (select 1 from stock_transfers where reference = v_ref);
  end loop;
  insert into stock_transfers(reference, source_distributor_id, destination_distributor_id, notes, initiated_by)
  values (v_ref, (p ->> 'source_distributor_id')::uuid, (p ->> 'destination_distributor_id')::uuid, p ->> 'notes', public.current_user_id())
  returning id into v_id;
  for it in select product_id, sum(quantity)::int q from jsonb_to_recordset(p -> 'items') x(product_id uuid, quantity int) group by product_id loop
    if it.q is null or it.q <= 0 then raise exception 'VALIDATION: Quantities must be above zero'; end if;
    insert into stock_transfer_items(transfer_id, product_id, quantity) values (v_id, it.product_id, it.q);
  end loop;
  if coalesce((p ->> 'dispatch')::boolean, false) or coalesce((p ->> 'receive')::boolean, false) then
    perform private.dispatch_transfer(v_id);
  end if;
  if coalesce((p ->> 'receive')::boolean, false) then
    perform private.receive_transfer(v_id);
  end if;
  return jsonb_build_object('id', v_id, 'reference', v_ref, 'status', (select status from stock_transfers where id = v_id));
end $$;

create or replace function public.dispatch_transfer(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_roles('{manager,inventory_manager}');
  perform private.dispatch_transfer(p_id);
end $$;

create or replace function public.receive_transfer(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_roles('{manager,inventory_manager}');
  perform private.receive_transfer(p_id);
end $$;

create or replace function public.cancel_transfer(p_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare t stock_transfers; it stock_transfer_items;
begin
  perform private.require_roles('{manager,inventory_manager}');
  select * into t from stock_transfers where id = p_id for update;
  if t.status not in ('draft', 'in_transit') then raise exception 'INVALID_TRANSITION: This transfer is already %', t.status; end if;
  if t.status = 'in_transit' then
    for it in select * from stock_transfer_items where transfer_id = t.id loop
      perform private.apply_stock(it.product_id, t.source_distributor_id, it.quantity, 0, 'transfer_cancel',
                                  coalesce('Cancelled ' || t.reference || ': ' || p_reason, 'Cancelled ' || t.reference), 'transfer', t.id);
    end loop;
  end if;
  update stock_transfers set status = 'cancelled', cancelled_at = now(),
         notes = concat_ws(E'\n', notes, 'Cancelled: ' || p_reason) where id = t.id;
end $$;

-- Restocks increase stock and record the purchase exactly once.
create or replace function public.record_restock(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ref text; it record; v_total numeric := 0; v_status payment_status;
begin
  perform private.require_roles('{manager,inventory_manager}');
  if not exists (select 1 from distributors where id = (p ->> 'distributor_id')::uuid) then
    raise exception 'VALIDATION: Choose the receiving distributor';
  end if;
  if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'VALIDATION: Add at least one product'; end if;
  v_status := coalesce(nullif(p ->> 'payment_status', ''), 'paid')::payment_status;
  if v_status = 'paid' and not public.has_any_role('{manager,inventory_manager,finance_manager}') then
    raise exception 'FORBIDDEN';
  end if;
  loop
    v_ref := coalesce(nullif(btrim(p ->> 'reference'), ''), 'RS-' || private.gen_code(5));
    exit when not exists (select 1 from restocks where reference = v_ref);
    if nullif(btrim(p ->> 'reference'), '') is not null then raise exception 'VALIDATION: Reference % already used', v_ref; end if;
  end loop;
  insert into restocks(reference, supplier, distributor_id, restock_date, payment_status, payment_method, receipt_url, notes, created_by)
  values (v_ref, p ->> 'supplier', (p ->> 'distributor_id')::uuid, coalesce((p ->> 'restock_date')::date, current_date),
          v_status, p ->> 'payment_method', p ->> 'receipt_url', p ->> 'notes', public.current_user_id())
  returning id into v_id;
  for it in select * from jsonb_to_recordset(p -> 'items') x(product_id uuid, quantity int, unit_cost numeric) loop
    if it.quantity is null or it.quantity <= 0 then raise exception 'VALIDATION: Quantities must be above zero'; end if;
    insert into restock_items(restock_id, product_id, quantity, unit_cost) values (v_id, it.product_id, it.quantity, coalesce(it.unit_cost, 0));
    perform private.apply_stock(it.product_id, (p ->> 'distributor_id')::uuid, it.quantity, 0, 'restock',
                                'Restock ' || v_ref, 'restock', v_id);
    v_total := v_total + it.quantity * coalesce(it.unit_cost, 0);
    if coalesce((p ->> 'update_cost_price')::boolean, false) and coalesce(it.unit_cost, 0) > 0 then
      update products set cost_price = it.unit_cost where id = it.product_id;
    end if;
  end loop;
  update restocks set total_cost = v_total where id = v_id;
  if v_status = 'paid' and v_total > 0 then
    insert into financial_transactions(txn_date, type, direction, amount, description, payment_method, source_type, source_id, created_by)
    values (coalesce((p ->> 'restock_date')::date, current_date), 'restock', 'out', v_total,
            'Restock ' || v_ref || coalesce(' from ' || nullif(p ->> 'supplier', ''), ''), p ->> 'payment_method', 'restock', v_id, public.current_user_id());
  end if;
  insert into notifications(type, title, body, link)
  values ('restock', 'Restock ' || v_ref || ' received', (select name from distributors where id = (p ->> 'distributor_id')::uuid), '/admin/inventory/restocks');
  return jsonb_build_object('id', v_id, 'reference', v_ref, 'total_cost', v_total);
end $$;

create or replace function public.mark_restock_paid(p_id uuid, p_method text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare r restocks;
begin
  perform private.require_roles('{manager,inventory_manager,finance_manager}');
  select * into r from restocks where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Restock not found'; end if;
  if r.payment_status = 'paid' then raise exception 'VALIDATION: Restock already paid'; end if;
  update restocks set payment_status = 'paid', payment_method = coalesce(p_method, payment_method) where id = r.id;
  if r.total_cost > 0 then
    insert into financial_transactions(type, direction, amount, description, payment_method, source_type, source_id, created_by)
    values ('restock', 'out', r.total_cost, 'Restock ' || r.reference || ' paid', coalesce(p_method, r.payment_method), 'restock', r.id, public.current_user_id());
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Admin: finance
-- ---------------------------------------------------------------------
create or replace function public.create_manual_transaction(p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_type txn_type := (p ->> 'type')::txn_type; v_dir txn_direction := (p ->> 'direction')::txn_direction;
begin
  perform private.require_roles('{finance_manager}');
  if v_type not in ('capital','adjustment','income','expenditure') then
    raise exception 'VALIDATION: Orders, refunds, restocks and settlements are recorded from their own screens';
  end if;
  if v_type = 'capital' then v_dir := 'in'; end if;
  if coalesce((p ->> 'amount')::numeric, 0) <= 0 then raise exception 'VALIDATION: Enter an amount above zero'; end if;
  insert into financial_transactions(txn_date, type, direction, amount, description, payment_method, source_type, created_by)
  values (coalesce((p ->> 'txn_date')::date, current_date), v_type, v_dir, (p ->> 'amount')::numeric, p ->> 'description',
          p ->> 'payment_method', 'manual', public.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.reverse_transaction(p_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare t financial_transactions; v_id uuid;
begin
  perform private.require_roles('{finance_manager}');
  select * into t from financial_transactions where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Transaction not found'; end if;
  if t.is_reversed or t.reverses_id is not null then raise exception 'VALIDATION: This entry is already a reversal or reversed'; end if;
  if t.source_type in ('order','expense','restock','refund') then
    raise exception 'VALIDATION: Correct this from its source (order, expense, restock or refund)';
  end if;
  insert into financial_transactions(txn_date, type, direction, amount, description, source_type, source_id, reverses_id, created_by)
  values (current_date, t.type, case when t.direction = 'in' then 'out'::txn_direction else 'in'::txn_direction end, t.amount,
          'Reversal: ' || coalesce(p_reason, ''), t.source_type, t.source_id, t.id, public.current_user_id())
  returning id into v_id;
  update financial_transactions set is_reversed = true where id = t.id;
  perform private.audit('reverse_transaction', 'financial_transactions', t.id::text, jsonb_build_object('reason', p_reason));
  return v_id;
end $$;

-- A "recognised" sale: delivered, and not fully refunded / returned.
create or replace function public.stakeholder_balances()
returns table(stakeholder_id uuid, name text, status stakeholder_status, markup_percent numeric, sales_generated numeric,
              platform_commission numeric, proceeds_due numeric, settled numeric, outstanding numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform private.require_roles('{finance_manager,manager}');
  return query
  select s.id, s.name, s.status, s.markup_percent,
         coalesce(sum(oi.line_total), 0)::numeric, coalesce(sum(oi.platform_revenue), 0)::numeric,
         coalesce(sum(oi.stakeholder_proceeds), 0)::numeric,
         (select coalesce(sum(ss.amount_paid), 0) from stakeholder_settlements ss where ss.stakeholder_id = s.id)::numeric,
         (coalesce(sum(oi.stakeholder_proceeds), 0)
           - (select coalesce(sum(ss.amount_paid), 0) from stakeholder_settlements ss where ss.stakeholder_id = s.id))::numeric
  from stakeholders s
  left join (order_items oi join orders o on o.id = oi.order_id
             and o.delivered_at is not null and o.status not in ('refunded','returned'))
    on oi.stakeholder_id = s.id
  where not s.is_platform_owner
  group by s.id
  order by s.name;
end $$;

create or replace function public.create_settlement(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_sales numeric; v_comm numeric; v_due numeric; v_paid numeric := coalesce((p ->> 'amount_paid')::numeric, 0);
        v_from date := (p ->> 'period_start')::date; v_to date := (p ->> 'period_end')::date; v_name text;
begin
  perform private.require_roles('{finance_manager}');
  select name into v_name from stakeholders where id = (p ->> 'stakeholder_id')::uuid and not is_platform_owner;
  if v_name is null then raise exception 'VALIDATION: Choose a partner stakeholder'; end if;
  if v_paid < 0 then raise exception 'VALIDATION: Amount cannot be negative'; end if;
  select coalesce(sum(oi.line_total), 0), coalesce(sum(oi.platform_revenue), 0), coalesce(sum(oi.stakeholder_proceeds), 0)
  into v_sales, v_comm, v_due
  from order_items oi join orders o on o.id = oi.order_id
  where oi.stakeholder_id = (p ->> 'stakeholder_id')::uuid and o.delivered_at is not null and o.status not in ('refunded','returned')
    and (v_from is null or (o.delivered_at at time zone 'Africa/Accra')::date >= v_from)
    and (v_to is null or (o.delivered_at at time zone 'Africa/Accra')::date <= v_to);
  insert into stakeholder_settlements(stakeholder_id, period_start, period_end, sales_generated, platform_commission, amount_due,
                                      amount_paid, settlement_date, reference, method, notes, created_by)
  values ((p ->> 'stakeholder_id')::uuid, v_from, v_to, v_sales, v_comm, v_due, v_paid,
          coalesce((p ->> 'settlement_date')::date, current_date), p ->> 'reference', p ->> 'method', p ->> 'notes', public.current_user_id())
  returning id into v_id;
  if v_paid > 0 then
    insert into financial_transactions(txn_date, type, direction, amount, description, payment_method, source_type, source_id, created_by)
    values (coalesce((p ->> 'settlement_date')::date, current_date), 'settlement', 'out', v_paid, 'Settlement to ' || v_name,
            p ->> 'method', 'settlement', v_id, public.current_user_id());
  end if;
  return jsonb_build_object('id', v_id, 'sales_generated', v_sales, 'platform_commission', v_comm, 'amount_due', v_due, 'amount_paid', v_paid);
end $$;

create or replace function public.finance_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_gross numeric; v_disc numeric; v_ref numeric; v_proc numeric; v_cogs numeric; v_opex numeric; v_in numeric; v_out numeric;
        v_platform_items numeric; v_fees numeric;
begin
  perform private.require_roles('{finance_manager,manager}');
  with rec as (
    select * from orders o where o.delivered_at is not null and o.status not in ('refunded','returned')
      and (o.delivered_at at time zone 'Africa/Accra')::date between p_from and p_to)
  select coalesce(sum(subtotal + delivery_fee), 0), coalesce(sum(discount), 0), coalesce(sum(delivery_fee - discount), 0),
         (select coalesce(sum(r.amount), 0) from refunds r where r.order_id in (select id from rec) and r.status <> 'cancelled'),
         (select coalesce(sum(oi.stakeholder_proceeds), 0) from order_items oi where oi.order_id in (select id from rec)),
         (select coalesce(sum(oi.platform_revenue), 0) from order_items oi where oi.order_id in (select id from rec)),
         (select coalesce(sum(oi.cost_price * oi.quantity), 0) from order_items oi
           where oi.order_id in (select id from rec) and oi.is_platform_owned and oi.stock_state = 'fulfilled')
  into v_gross, v_disc, v_fees, v_ref, v_proc, v_platform_items, v_cogs
  from rec;

  select coalesce(sum(amount), 0) into v_opex from expenses where not is_void and expense_date between p_from and p_to;
  select coalesce(sum(amount) filter (where direction = 'in'), 0), coalesce(sum(amount) filter (where direction = 'out'), 0)
  into v_in, v_out from financial_transactions
  where txn_date between p_from and p_to and not is_reversed and reverses_id is null;

  v := jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'gross_sales', v_gross, 'discounts', v_disc, 'refunds', v_ref,
    'net_sales', v_gross - v_disc - v_ref,
    'stakeholder_proceeds', v_proc,
    'platform_sales', v_platform_items + v_fees - v_ref,
    'cogs', v_cogs,
    'platform_gross_margin', v_platform_items + v_fees - v_ref - v_cogs,
    'operating_expenses', v_opex,
    'net_profit', v_platform_items + v_fees - v_ref - v_cogs - v_opex,
    'cash_received', v_in, 'cash_paid', v_out, 'net_cash', v_in - v_out,
    'cash_balance_all_time', (select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)
                              from financial_transactions where not is_reversed and reverses_id is null),
    'stakeholder_liabilities', (select coalesce(sum(greatest(outstanding, 0)), 0) from public.stakeholder_balances()),
    'receivables', (select coalesce(sum(total - amount_paid), 0) from orders
                    where delivered_at is not null and status not in ('refunded','returned') and amount_paid < total),
    'refunds_paid_in_period', (select coalesce(sum(amount), 0) from financial_transactions
                               where type = 'refund' and direction = 'out' and not is_reversed and reverses_id is null
                                 and txn_date between p_from and p_to),
    'cashflow', (select coalesce(jsonb_agg(jsonb_build_object('date', d, 'in', cin, 'out', cout) order by d), '[]'::jsonb)
                 from (select txn_date d, sum(amount) filter (where direction = 'in') cin, sum(amount) filter (where direction = 'out') cout
                       from financial_transactions where txn_date between p_from and p_to and not is_reversed and reverses_id is null
                       group by txn_date) x),
    'cash_by_type', (select coalesce(jsonb_object_agg(type, total), '{}'::jsonb)
                     from (select type::text, sum(case when direction = 'in' then amount else -amount end) total
                           from financial_transactions where txn_date between p_from and p_to and not is_reversed and reverses_id is null
                           group by type) x),
    'expenses_by_category', (select coalesce(jsonb_object_agg(category, total), '{}'::jsonb)
                             from (select category, sum(amount) total from expenses where not is_void and expense_date between p_from and p_to
                                   group by category) x));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Admin: analytics
-- ---------------------------------------------------------------------
create or replace function public.sales_breakdown(p_from date, p_to date, p_dimension text, p_scope text default 'delivered')
returns table(label text, orders bigint, units bigint, revenue numeric, platform_revenue numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  select q.lbl, q.n_orders, q.n_units, q.rev, q.prev from (
    select (case p_dimension
              when 'institution' then coalesce(o.institution_name, 'Off-campus')
              when 'hostel' then coalesce(o.hostel_name, case when o.location_type = 'off_campus' then 'Off-campus' else coalesce(o.institution_name, '') || ' (unlisted)' end)
              when 'distributor' then coalesce(d.name, 'Unassigned')
              when 'product' then oi.product_name
              when 'category' then coalesce(oi.category_name, 'Uncategorised')
              when 'stakeholder' then coalesce(oi.stakeholder_name, '—')
              when 'delivery_method' then initcap(o.delivery_method::text)
              when 'day' then to_char(coalesce(case when p_scope = 'delivered' then o.delivered_at end, o.created_at) at time zone 'Africa/Accra', 'YYYY-MM-DD')
              else 'All' end)::text as lbl,
           count(distinct o.id)::bigint as n_orders, coalesce(sum(oi.quantity), 0)::bigint as n_units,
           coalesce(sum(oi.line_total), 0)::numeric as rev, coalesce(sum(oi.platform_revenue), 0)::numeric as prev
    from orders o
    join order_items oi on oi.order_id = o.id
    left join distributors d on d.id = oi.distributor_id
    where case when p_scope = 'delivered'
               then o.delivered_at is not null and o.status not in ('refunded','returned')
                    and (o.delivered_at at time zone 'Africa/Accra')::date between p_from and p_to
               else o.status not in ('cancelled') and (o.created_at at time zone 'Africa/Accra')::date between p_from and p_to end
    group by 1) q
  order by case when p_dimension = 'day' then q.lbl end, q.rev desc, q.lbl;
end $$;

create or replace function public.dashboard_stats(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select jsonb_build_object(
    'orders_total', count(*),
    'orders_delivered', count(*) filter (where status = 'delivered'),
    'orders_pending', count(*) filter (where status in ('received','confirmed','processing','ready_for_delivery','out_for_delivery','failed_delivery')),
    'orders_cancelled', count(*) filter (where status = 'cancelled'),
    'orders_new_today', count(*) filter (where (created_at at time zone 'Africa/Accra')::date = (now() at time zone 'Africa/Accra')::date),
    'pipeline_value', coalesce(sum(total) filter (where status in ('received','confirmed','processing','ready_for_delivery','out_for_delivery')), 0),
    'sales_delivered', coalesce(sum(total) filter (where delivered_at is not null and status not in ('refunded','returned')), 0))
  into v
  from orders where (created_at at time zone 'Africa/Accra')::date between p_from and p_to;

  v := v || jsonb_build_object(
    'open_orders_all_time', (select count(*) from orders where status in ('received','confirmed','processing','ready_for_delivery','out_for_delivery','failed_delivery')),
    'open_enquiries', (select count(*) from enquiries where status in ('open','in_progress')),
    'inventory_units', (select coalesce(sum(on_hand), 0) from inventory),
    'inventory_value', (select coalesce(sum(i.on_hand * p.cost_price), 0) from inventory i join products p on p.id = i.product_id),
    'low_stock', (select count(*) from (select p.id from products p left join inventory i on i.product_id = p.id
                                        where p.is_active group by p.id, p.low_stock_threshold
                                        having coalesce(sum(i.available), 0) > 0 and coalesce(sum(i.available), 0) <= p.low_stock_threshold) x),
    'out_of_stock', (select count(*) from (select p.id from products p left join inventory i on i.product_id = p.id
                                           where p.is_active group by p.id having coalesce(sum(i.available), 0) <= 0) x),
    'pending_transfers', (select count(*) from stock_transfers where status = 'in_transit'),
    'unread_notifications', (select count(*) from notifications where not is_read));

  if public.has_any_role('{finance_manager,manager}') then
    v := v || jsonb_build_object('finance', public.finance_report(p_from, p_to) - 'cashflow' - 'cash_by_type' - 'expenses_by_category');
  end if;
  return v;
end $$;

-- End-of-day check: what each distributor was given, delivered, collected and should still hold.
create or replace function public.reconciliation(p_day date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform private.require_roles('{manager,order_manager,finance_manager,inventory_manager}');
  return (
    select coalesce(jsonb_agg(row_to_json(x) order by x.distributor_name), '[]'::jsonb)
    from (
      select d.id as distributor_id, d.name as distributor_name, d.phone,
        (select count(distinct o.id) from orders o join order_items oi on oi.order_id = o.id
          where oi.distributor_id = d.id and (o.created_at at time zone 'Africa/Accra')::date = p_day) as orders_assigned,
        (select count(distinct o.id) from orders o join order_items oi on oi.order_id = o.id
          where oi.distributor_id = d.id and (o.created_at at time zone 'Africa/Accra')::date = p_day and o.status <> 'received') as orders_confirmed,
        (select count(distinct o.id) from orders o join order_items oi on oi.order_id = o.id
          where oi.distributor_id = d.id and (o.delivered_at at time zone 'Africa/Accra')::date = p_day) as orders_delivered,
        (select count(distinct o.id) from orders o join order_items oi on oi.order_id = o.id
          where oi.distributor_id = d.id and o.status in ('received','confirmed','processing','ready_for_delivery','out_for_delivery','failed_delivery')) as orders_outstanding,
        (select coalesce(sum(oi.line_total), 0) from orders o join order_items oi on oi.order_id = o.id
          where oi.distributor_id = d.id and (o.delivered_at at time zone 'Africa/Accra')::date = p_day) as money_expected,
        (select coalesce(sum(round(oi.line_total * case when o.total > 0 then o.amount_paid / o.total else 0 end, 2)), 0)
           from orders o join order_items oi on oi.order_id = o.id
          where oi.distributor_id = d.id and (o.delivered_at at time zone 'Africa/Accra')::date = p_day) as money_collected,
        (select coalesce(sum(oi.quantity), 0) from orders o join order_items oi on oi.order_id = o.id
          where oi.distributor_id = d.id and (o.delivered_at at time zone 'Africa/Accra')::date = p_day) as units_sold,
        (select coalesce(sum(on_hand), 0) from inventory where distributor_id = d.id) as stock_on_hand,
        (select coalesce(sum(reserved), 0) from inventory where distributor_id = d.id) as stock_reserved,
        (select coalesce(jsonb_agg(jsonb_build_object('product', p.name, 'on_hand', i.on_hand, 'reserved', i.reserved) order by p.name), '[]'::jsonb)
           from inventory i join products p on p.id = i.product_id where i.distributor_id = d.id and (i.on_hand <> 0 or i.reserved <> 0)) as stock_lines
      from distributors d where d.is_active
    ) x);
end $$;

-- ---------------------------------------------------------------------
-- Admin: import (validate first, then all-or-nothing unless skipping invalid rows)
-- Columns: Product Name, Category, Cost Price, Selling Price, Stock Quantity, Unit [, Stakeholder]
-- ---------------------------------------------------------------------
create or replace function public.import_stock(p_rows jsonb, p_distributor uuid default null, p_dry_run boolean default true,
                                               p_skip_invalid boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_out jsonb := '[]'; v_errs text[]; v_seen text[] := '{}'; v_key text; v_cat uuid; v_prod products; v_sh uuid;
        v_owner uuid; v_markup numeric; v_base numeric; v_action text; v_slug text; v_created int := 0; v_updated int := 0;
        v_skipped int := 0; v_on int; v_batch uuid := gen_random_uuid(); v_any_error boolean := false;
begin
  perform private.require_roles('{manager,inventory_manager}');
  if p_distributor is not null and not exists (select 1 from distributors where id = p_distributor) then
    raise exception 'VALIDATION: Unknown distributor';
  end if;
  select id into v_owner from stakeholders where is_platform_owner order by created_at limit 1;

  -- pass 1: validate
  for r in select ordinality as n, value as v from jsonb_array_elements(p_rows) with ordinality loop
    v_errs := '{}';
    v_key := lower(btrim(r.v ->> 'product_name'));
    if coalesce(v_key, '') = '' then v_errs := array_append(v_errs, ('Product Name is required')::text); end if;
    if coalesce(btrim(r.v ->> 'category'), '') = '' then v_errs := array_append(v_errs, ('Category is required')::text); end if;
    if coalesce(r.v ->> 'cost_price', '') !~ '^\s*\d+(\.\d+)?\s*$' then v_errs := array_append(v_errs, ('Cost Price must be a number')::text); end if;
    if coalesce(r.v ->> 'selling_price', '') !~ '^\s*\d+(\.\d+)?\s*$' then v_errs := array_append(v_errs, ('Selling Price must be a number')::text); end if;
    if coalesce(r.v ->> 'stock_quantity', '') <> '' and (r.v ->> 'stock_quantity') !~ '^\s*\d+\s*$' then
      v_errs := array_append(v_errs, ('Stock Quantity must be a whole number')::text); end if;
    if coalesce(r.v ->> 'stock_quantity', '') <> '' and p_distributor is null then
      v_errs := array_append(v_errs, ('Choose a distributor to import stock quantities')::text);
    end if;
    if v_key = any(v_seen) then v_errs := array_append(v_errs, ('Duplicate product in this file')::text); end if;
    v_seen := v_seen || v_key;
    v_sh := v_owner;
    if coalesce(btrim(r.v ->> 'stakeholder'), '') <> '' then
      select id into v_sh from stakeholders where lower(name) = lower(btrim(r.v ->> 'stakeholder')) or slug = lower(btrim(r.v ->> 'stakeholder'));
      if v_sh is null then v_errs := array_append(v_errs, (('Unknown stakeholder ' || (r.v ->> 'stakeholder')))::text); end if;
    end if;
    select * into v_prod from products where lower(name) = v_key limit 1;
    v_action := case when cardinality(v_errs) > 0 then 'error' when v_prod.id is null then 'create' else 'update' end;
    if v_action = 'error' then v_any_error := true; end if;
    v_out := v_out || jsonb_build_object('row', r.n, 'product_name', r.v ->> 'product_name', 'action', v_action,
                                         'errors', to_jsonb(v_errs),
                                         'current_stock', case when p_distributor is not null and v_prod.id is not null
                                           then (select on_hand from inventory where product_id = v_prod.id and distributor_id = p_distributor) end);
    v_prod := null;
  end loop;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'rows', v_out,
      'summary', jsonb_build_object('create', (select count(*) from jsonb_array_elements(v_out) e where e ->> 'action' = 'create'),
                                    'update', (select count(*) from jsonb_array_elements(v_out) e where e ->> 'action' = 'update'),
                                    'errors', (select count(*) from jsonb_array_elements(v_out) e where e ->> 'action' = 'error')));
  end if;
  if v_any_error and not p_skip_invalid then
    raise exception 'VALIDATION: Fix the highlighted rows or choose to skip invalid rows';
  end if;

  -- pass 2: write
  for r in select ordinality as n, value as v from jsonb_array_elements(p_rows) with ordinality loop
    if (v_out -> (r.n::int - 1)) ->> 'action' = 'error' then v_skipped := v_skipped + 1; continue; end if;
    select id into v_cat from categories where lower(name) = lower(btrim(r.v ->> 'category'));
    if v_cat is null then
      insert into categories(name, slug) values (btrim(r.v ->> 'category'),
        trim(both '-' from regexp_replace(lower(btrim(r.v ->> 'category')), '[^a-z0-9]+', '-', 'g')) || '-' || lower(private.gen_code(3)))
      returning id into v_cat;
    end if;
    v_sh := v_owner;
    if coalesce(btrim(r.v ->> 'stakeholder'), '') <> '' then
      select id into v_sh from stakeholders where lower(name) = lower(btrim(r.v ->> 'stakeholder')) or slug = lower(btrim(r.v ->> 'stakeholder'));
    end if;
    select * into v_prod from products where lower(name) = lower(btrim(r.v ->> 'product_name')) limit 1;
    select coalesce(v_prod.markup_percent, s.markup_percent, 0) into v_markup from stakeholders s where s.id = coalesce(v_prod.stakeholder_id, v_sh);
    -- Selling Price in the file is the customer price; store base so that base × (1 + markup) = selling price
    v_base := round(btrim(r.v ->> 'selling_price')::numeric / (1 + coalesce(v_markup, 0) / 100.0), 2);
    if v_prod.id is null then
      v_slug := trim(both '-' from regexp_replace(lower(btrim(r.v ->> 'product_name')), '[^a-z0-9]+', '-', 'g'));
      if exists (select 1 from products where slug = v_slug) then v_slug := v_slug || '-' || lower(private.gen_code(4)); end if;
      insert into products(name, slug, category_id, stakeholder_id, cost_price, base_price, unit)
      values (btrim(r.v ->> 'product_name'), v_slug, v_cat, v_sh, btrim(r.v ->> 'cost_price')::numeric, v_base,
              coalesce(nullif(btrim(r.v ->> 'unit'), ''), 'pc'))
      returning * into v_prod;
      v_created := v_created + 1;
    else
      update products set category_id = v_cat, cost_price = btrim(r.v ->> 'cost_price')::numeric, base_price = v_base,
             unit = coalesce(nullif(btrim(r.v ->> 'unit'), ''), unit),
             stakeholder_id = case when coalesce(btrim(r.v ->> 'stakeholder'), '') <> '' then v_sh else stakeholder_id end
      where id = v_prod.id returning * into v_prod;
      v_updated := v_updated + 1;
    end if;
    if p_distributor is not null and coalesce(btrim(r.v ->> 'stock_quantity'), '') <> '' then
      select coalesce(on_hand, 0) into v_on from (select 1) one
      left join inventory i on i.product_id = v_prod.id and i.distributor_id = p_distributor;
      if btrim(r.v ->> 'stock_quantity')::int <> v_on then
        perform private.apply_stock(v_prod.id, p_distributor, btrim(r.v ->> 'stock_quantity')::int - v_on, 0,
                                    case when btrim(r.v ->> 'stock_quantity')::int > v_on then 'import'::movement_type else 'correction'::movement_type end,
                                    'CSV import', 'import', v_batch, v_batch);
      else
        insert into inventory(product_id, distributor_id) values (v_prod.id, p_distributor) on conflict do nothing;
      end if;
    end if;
  end loop;
  perform private.audit('import', 'products', v_batch::text,
                        jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped, 'distributor_id', p_distributor));
  return jsonb_build_object('dry_run', false, 'rows', v_out,
                            'summary', jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped', v_skipped));
end $$;

-- ---------------------------------------------------------------------
-- Admin: staff & AI provider configuration (super admin)
-- ---------------------------------------------------------------------
-- Called by the app after sign-up / sign-in so every user has a profile row.
create or replace function public.ensure_profile(p_full_name text default null, p_phone text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_user_id() is null then return; end if;
  insert into profiles(id, full_name, phone) values (public.current_user_id(), nullif(btrim(p_full_name), ''), nullif(btrim(p_phone), ''))
  on conflict (id) do update set full_name = coalesce(profiles.full_name, excluded.full_name), phone = coalesce(profiles.phone, excluded.phone);
end $$;

-- Who is calling (used by the server functions to check a token)
create or replace function public.whoami()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('user_id', public.current_user_id(), 'roles', public.my_roles())
$$;

create or replace function public.list_staff()
returns table(user_id uuid, email text, full_name text, roles app_role[])
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform private.require_roles('{super_admin}');
  return query
  select u.id, u.email::text, p.full_name, array_agg(ur.role order by ur.role)
  from user_roles ur join neon_auth."user" u on u.id = ur.user_id left join profiles p on p.id = u.id
  group by u.id, u.email, p.full_name order by u.email;
end $$;

create or replace function public.grant_role(p_email text, p_role app_role)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  perform private.require_roles('{super_admin}');
  select id into v_uid from neon_auth."user" where lower(email) = lower(btrim(p_email));
  if v_uid is null then raise exception 'NOT_FOUND: That person must create an account first (Account → Sign up)'; end if;
  insert into user_roles(user_id, role) values (v_uid, p_role) on conflict do nothing;
end $$;

create or replace function public.revoke_role(p_user uuid, p_role app_role)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.require_roles('{super_admin}');
  if p_user = public.current_user_id() and p_role = 'super_admin' then raise exception 'VALIDATION: You cannot remove your own super admin role'; end if;
  delete from user_roles where user_id = p_user and role = p_role;
end $$;

create or replace function public.save_ai_provider(p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; v_key text := nullif(btrim(p ->> 'api_key'), '');
begin
  perform private.require_roles('{super_admin}');
  if v_id is null then
    insert into ai_provider_settings(name, provider, base_url, model, scope, priority, is_enabled, requires_key, daily_limit)
    values (p ->> 'name', p ->> 'provider', rtrim(p ->> 'base_url', '/'), p ->> 'model', coalesce(p ->> 'scope', 'both'),
            coalesce((p ->> 'priority')::int, 100), coalesce((p ->> 'is_enabled')::boolean, true),
            coalesce((p ->> 'requires_key')::boolean, true), nullif(p ->> 'daily_limit', '')::int)
    returning id into v_id;
  else
    update ai_provider_settings set
      name = coalesce(p ->> 'name', name), provider = coalesce(p ->> 'provider', provider),
      base_url = coalesce(rtrim(p ->> 'base_url', '/'), base_url), model = coalesce(p ->> 'model', model),
      scope = coalesce(p ->> 'scope', scope), priority = coalesce((p ->> 'priority')::int, priority),
      is_enabled = coalesce((p ->> 'is_enabled')::boolean, is_enabled),
      requires_key = coalesce((p ->> 'requires_key')::boolean, requires_key),
      daily_limit = case when p ? 'daily_limit' then nullif(p ->> 'daily_limit', '')::int else daily_limit end
    where id = v_id;
  end if;
  if v_key is not null then
    insert into ai_provider_secrets(provider_id, api_key) values (v_id, v_key)
    on conflict (provider_id) do update set api_key = excluded.api_key, updated_at = now();
    update ai_provider_settings set has_key = true, key_last4 = right(v_key, 4) where id = v_id;
  elsif coalesce((p ->> 'remove_key')::boolean, false) then
    delete from ai_provider_secrets where provider_id = v_id;
    update ai_provider_settings set has_key = false, key_last4 = null where id = v_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Lock down: internal helpers are not callable from the API.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public;
do $$ begin
  execute 'revoke execute on all functions in schema private from anonymous, authenticated';
end $$;
