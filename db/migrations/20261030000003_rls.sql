-- =====================================================================
-- Row Level Security. Every table has RLS on. Mutations that touch stock,
-- orders or money only happen through the functions in 0002.
-- =====================================================================

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Role groups (super_admin always passes has_any_role)
-- catalog:   manager
-- inventory: manager, inventory_manager
-- orders:    manager, order_manager
-- finance:   finance_manager  (manager can read)

-- profiles
create policy profiles_self_select on profiles for select using (id = public.current_user_id() or public.is_staff());
create policy profiles_self_update on profiles for update using (id = public.current_user_id()) with check (id = public.current_user_id());
create policy profiles_self_insert on profiles for insert with check (id = public.current_user_id());

-- user_roles
create policy user_roles_self on user_roles for select using (user_id = public.current_user_id() or public.has_role('super_admin'));

-- customers
create policy customers_select on customers for select
  using (user_id = public.current_user_id() or public.has_any_role('{manager,order_manager,finance_manager}'));
create policy customers_staff_update on customers for update
  using (public.has_any_role('{manager,order_manager}')) with check (public.has_any_role('{manager,order_manager}'));

-- catalogue (public reads go through storefront_* views)
create policy stakeholders_staff_select on stakeholders for select using (public.is_staff());
create policy stakeholders_write on stakeholders for all
  using (public.has_any_role('{manager}')) with check (public.has_any_role('{manager}'));

create policy categories_staff_select on categories for select using (public.is_staff());
create policy categories_write on categories for all
  using (public.has_any_role('{manager}')) with check (public.has_any_role('{manager}'));

create policy products_staff_select on products for select using (public.is_staff());
create policy products_write on products for all
  using (public.has_any_role('{manager}')) with check (public.has_any_role('{manager}'));

-- locations (public can read active ones for checkout)
create policy institutions_public_select on institutions for select using (is_active or public.is_staff());
create policy institutions_write on institutions for all
  using (public.has_any_role('{manager,inventory_manager}')) with check (public.has_any_role('{manager,inventory_manager}'));
create policy hostels_public_select on hostels for select using (is_active or public.is_staff());
create policy hostels_write on hostels for all
  using (public.has_any_role('{manager,inventory_manager}')) with check (public.has_any_role('{manager,inventory_manager}'));

create policy distributors_staff_select on distributors for select using (public.is_staff());
create policy distributors_write on distributors for all
  using (public.has_any_role('{manager,inventory_manager}')) with check (public.has_any_role('{manager,inventory_manager}'));
create policy dsa_staff_select on distributor_service_areas for select using (public.is_staff());
create policy dsa_write on distributor_service_areas for all
  using (public.has_any_role('{manager,inventory_manager}')) with check (public.has_any_role('{manager,inventory_manager}'));

-- inventory & ledgers: read-only for staff; writes only via functions
create policy inventory_staff_select on inventory for select using (public.is_staff());
create policy inventory_threshold_update on inventory for update
  using (public.has_any_role('{manager,inventory_manager}')) with check (public.has_any_role('{manager,inventory_manager}'));
revoke update on inventory from anonymous, authenticated;
grant update (low_stock_threshold) on inventory to authenticated;

create policy stock_movements_staff_select on stock_movements for select using (public.is_staff());
create policy stock_transfers_staff_select on stock_transfers for select using (public.is_staff());
create policy stock_transfer_items_staff_select on stock_transfer_items for select using (public.is_staff());
create policy restocks_staff_select on restocks for select using (public.is_staff());
create policy restock_items_staff_select on restock_items for select using (public.is_staff());

-- customer addresses: owner only
create policy addresses_owner on customer_addresses for all using (user_id = public.current_user_id()) with check (user_id = public.current_user_id());

-- orders: staff only (customers use my_orders / track_order / get_order_by_token)
create policy orders_staff_select on orders for select using (public.has_any_role('{manager,order_manager,finance_manager,inventory_manager}'));
create policy orders_staff_update on orders for update
  using (public.has_any_role('{manager,order_manager}')) with check (public.has_any_role('{manager,order_manager}'));
create policy order_items_staff_select on order_items for select using (public.has_any_role('{manager,order_manager,finance_manager,inventory_manager}'));
create policy osh_staff_select on order_status_history for select using (public.has_any_role('{manager,order_manager,finance_manager,inventory_manager}'));
create policy ofa_staff_select on order_fulfilment_assignments for select using (public.has_any_role('{manager,order_manager,inventory_manager}'));
create policy ofa_staff_update on order_fulfilment_assignments for update
  using (public.has_any_role('{manager,order_manager}')) with check (public.has_any_role('{manager,order_manager}'));
create policy refunds_staff_select on refunds for select using (public.has_any_role('{manager,order_manager,finance_manager}'));

-- enquiries
create policy enquiries_select on enquiries for select using (user_id = public.current_user_id() or public.has_any_role('{manager,order_manager}'));
create policy enquiries_staff_update on enquiries for update
  using (public.has_any_role('{manager,order_manager}')) with check (public.has_any_role('{manager,order_manager}'));

-- finance
create policy expenses_select on expenses for select using (public.has_any_role('{finance_manager,manager}'));
create policy expenses_insert on expenses for insert with check (public.has_any_role('{finance_manager}'));
create policy expenses_update on expenses for update
  using (public.has_any_role('{finance_manager}')) with check (public.has_any_role('{finance_manager}'));
create policy settlements_select on stakeholder_settlements for select using (public.has_any_role('{finance_manager,manager}'));
create policy ft_select on financial_transactions for select using (public.has_any_role('{finance_manager,manager}'));

-- system
create policy notifications_staff on notifications for select using (public.is_staff());
create policy notifications_staff_update on notifications for update using (public.is_staff()) with check (public.is_staff());
create policy audit_select on audit_logs for select using (public.has_any_role('{manager}'));
create policy settings_public_select on system_settings for select using (is_public or public.is_staff());
create policy settings_write on system_settings for all
  using (public.has_role('super_admin')) with check (public.has_role('super_admin'));

-- AI
create policy ai_settings_staff_select on ai_provider_settings for select using (public.is_staff());
create policy ai_settings_delete on ai_provider_settings for delete using (public.has_role('super_admin'));
-- ai_provider_secrets: RLS enabled, NO policies => unreachable from the browser. Edge functions use the service role.
create policy ai_usage_select on ai_usage for select using (public.has_role('super_admin'));
create policy ai_action_logs_select on ai_action_logs for select using (user_id = public.current_user_id() or public.has_role('super_admin'));
-- ai_conversations: service role only.
