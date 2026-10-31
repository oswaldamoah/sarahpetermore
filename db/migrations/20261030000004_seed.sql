-- =====================================================================
-- Base configuration. Everything here is editable from the admin panel.
-- Contact numbers are placeholders: set them in Admin → Settings before launch.
-- =====================================================================

insert into system_settings(key, value, is_public) values
  ('business_name',                  '"SarahPetermore"', true),
  ('tagline',                        '"No long talk. Just get it."', true),
  ('hero_title',                     '"No Long Talk."', true),
  ('hero_subtitle',                  '"Condoms, tests, postpills and toys. Packed plain, brought to you, paid for when it arrives."', true),
  ('contact_business_phone',         '""', true),
  ('contact_customer_service_phone', '""', true),
  ('contact_whatsapp',               '""', true),
  ('contact_snapchat',               '""', true),
  ('contact_email',                  '""', true),
  ('discreet_note',                  '"Every order is packed in a plain box. No product names on the outside."', true),
  ('courier_note',                   '"We don''t have a distributor at your location yet, so your order will be delivered by courier. We''ll call to confirm timing and any courier fee."', true),
  ('delivery_fee_distributor',       '0', true),
  ('delivery_fee_courier',           '0', true),
  ('currency',                       '"GHS"', true),
  ('timezone',                       '"Africa/Accra"', true),
  ('policies',                       '"Payment on delivery. Unopened items can be returned within 24 hours of delivery. We never share your details."', true),
  ('allow_split_fulfilment',         'true', false),
  ('allow_orders_without_stock',     'false', true),
  ('max_orders_per_phone_10min',     '5', false),
  ('assistant_rate_limit_per_10min', '30', false)
on conflict (key) do nothing;

insert into stakeholders(name, slug, description, pricing_arrangement, markup_percent, commission_percent, settlement_arrangement, is_platform_owner)
values
  ('SarahPetermore', 'sarahpetermore', 'Our own Classic range', 'Own stock — full selling price is platform revenue', 0, 0, null, true),
  ('Goldy', 'goldy', 'Partner: adult toys', 'Partner sets base price; we add 15% on top as our margin',
   15, 0, 'Partner is paid their base price for delivered orders. Customers only ever contact SarahPetermore.', false)
on conflict (slug) do nothing;

insert into categories(name, slug, description, sort_order) values
  ('Condoms',            'condoms',            'Classic', 1),
  ('Postpills',          'postpills',          'Classic', 2),
  ('Pregnancy Kits',     'pregnancy-kits',     'Classic', 3),
  ('Sexual Enhancement', 'sexual-enhancement', 'Classic', 4),
  ('Lubricants',         'lubricants',         'Classic', 5),
  ('Adult Toys',         'adult-toys',         'Goldy''s collection', 6)
on conflict (slug) do nothing;

insert into institutions(name, short_name, sort_order) values
  ('University of Professional Studies, Accra', 'UPSA', 1),
  ('University of Ghana, Legon', 'Legon', 2)
on conflict (name) do nothing;

-- Free AI providers. Keys (where needed) are added in Admin → Settings → AI and stay server-side.
insert into ai_provider_settings(name, provider, base_url, model, scope, priority, requires_key, is_enabled) values
  ('OpenRouter free router', 'openrouter', 'https://openrouter.ai/api/v1', 'openrouter/free', 'both', 10, true, true),
  ('Groq (free tier)',       'groq',       'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', 'both', 5, true, true),
  ('Gemini (free tier)',     'gemini',     'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.1-flash-lite', 'both', 25, true, true),
  ('Pollinations (no key)',  'pollinations','https://text.pollinations.ai/openai', 'openai', 'both', 30, false, true);
