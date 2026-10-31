-- =====================================================================
-- Data API privileges. Neon's Data API runs browser requests as:
--   anonymous      — visitors (no sign-in)
--   authenticated  — signed-in users (customers and staff)
-- Table privileges are broad; Row Level Security (0003) decides which rows each
-- person can see or change, and the functions in 0002 check staff roles.
-- =====================================================================
grant usage on schema public to anonymous, authenticated;
grant select, insert, update, delete on all tables in schema public to anonymous, authenticated;
grant usage, select on all sequences in schema public to anonymous, authenticated;
grant execute on all functions in schema public to anonymous, authenticated;

-- inventory counts only change through stock functions (thresholds may be edited)
revoke insert, update, delete on inventory from anonymous, authenticated;
grant update (low_stock_threshold) on inventory to authenticated;

-- never reachable from the browser, only from the server functions (database owner)
revoke all on ai_provider_secrets, ai_conversations from anonymous, authenticated;
revoke insert, update, delete on ai_usage, ai_action_logs, audit_logs, stock_movements, financial_transactions,
  order_status_history, order_items from anonymous, authenticated;

-- internal helpers
revoke all on schema private from anonymous, authenticated;
revoke execute on all functions in schema private from public, anonymous, authenticated;

-- future objects
alter default privileges in schema public grant select, insert, update, delete on tables to anonymous, authenticated;
alter default privileges in schema public grant execute on functions to anonymous, authenticated;
