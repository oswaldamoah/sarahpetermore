-- =====================================================================
-- OPTIONAL demo data for trying the platform. Do NOT run this in production
-- unless you want these sample hostels, distributors and products.
-- Run with `npm run demo-seed` in db/, or paste into the Neon SQL Editor after the migrations.
-- =====================================================================

-- Hostels (edit/add your real ones in Admin → Locations)
insert into hostels(institution_id, name, sort_order)
select i.id, h.name, h.ord from institutions i
cross join (values ('Akuafo Hall', 1), ('Commonwealth Hall', 2), ('Legon Hall', 3), ('Mensah Sarbah Hall', 4), ('Volta Hall', 5),
                   ('Jean Nelson Aka Hall', 6), ('Alexander Kwapong Hall', 7), ('Elizabeth Sutherland Hall', 8),
                   ('Hilla Limann Hall', 9), ('Pent Hostel', 10), ('Evandy Hostel', 11), ('Bani Hostel', 12)) h(name, ord)
where i.short_name = 'Legon'
on conflict do nothing;

insert into hostels(institution_id, name, sort_order)
select i.id, h.name, h.ord from institutions i
cross join (values ('UPSA Main Hostel', 1), ('UPSA Annex', 2)) h(name, ord)
where i.short_name = 'UPSA'
on conflict do nothing;

insert into distributors(name, contact_person, phone, is_hub, notes) values
  ('HQ Stock', 'SarahPetermore', '0200000000', true, 'Central stock — used for courier orders'),
  ('Legon North', 'Kwame', '0240000001', false, 'Akuafo, Commonwealth, Legon Hall'),
  ('Legon South', 'Ama', '0240000002', false, 'Volta, Sarbah, Pent'),
  ('UPSA Team', 'Efua', '0240000003', false, 'All UPSA hostels');

insert into distributor_service_areas(distributor_id, hostel_id)
select d.id, h.id from distributors d join hostels h on
  (d.name = 'Legon North' and h.name in ('Akuafo Hall','Commonwealth Hall','Legon Hall','Jean Nelson Aka Hall'))
  or (d.name = 'Legon South' and h.name in ('Volta Hall','Mensah Sarbah Hall','Pent Hostel','Commonwealth Hall'))
  or (d.name = 'UPSA Team' and h.name like 'UPSA%')
on conflict do nothing;

insert into products(name, slug, description, category_id, stakeholder_id, cost_price, base_price, unit, is_featured)
select p.name, p.slug, p.descr, c.id, s.id, p.cost, p.price, p.unit, p.featured
from (values
  ('Classic Condoms (3-pack)', 'classic-condoms-3', 'Ultra-thin latex condoms.', 'condoms', 'sarahpetermore', 6.00, 12.00, 'pack', true),
  ('Classic Condoms (12-pack)', 'classic-condoms-12', 'Value pack.', 'condoms', 'sarahpetermore', 20.00, 40.00, 'pack', false),
  ('Emergency Contraceptive Pill', 'emergency-pill', 'Single-dose emergency contraceptive. Read the leaflet before use.', 'postpills', 'sarahpetermore', 15.00, 30.00, 'pc', true),
  ('Pregnancy Test Strip', 'pregnancy-test', 'Early-result test.', 'pregnancy-kits', 'sarahpetermore', 5.00, 15.00, 'pc', true),
  ('Water-based Lubricant 100ml', 'lube-100', 'Gentle, water-based.', 'lubricants', 'sarahpetermore', 18.00, 45.00, 'bottle', false),
  ('Personal Massager', 'personal-massager', 'Rechargeable, quiet.', 'adult-toys', 'goldy', 120.00, 200.00, 'pc', true)
) p(name, slug, descr, cat, sh, cost, price, unit, featured)
join categories c on c.slug = p.cat join stakeholders s on s.slug = p.sh
on conflict (slug) do nothing;

-- Opening stock
insert into inventory(product_id, distributor_id, on_hand)
select p.id, d.id, q.qty from (values
  ('classic-condoms-3', 'HQ Stock', 100), ('classic-condoms-3', 'Legon North', 30), ('classic-condoms-3', 'Legon South', 20), ('classic-condoms-3', 'UPSA Team', 25),
  ('classic-condoms-12', 'HQ Stock', 40), ('emergency-pill', 'HQ Stock', 30), ('emergency-pill', 'Legon North', 8),
  ('pregnancy-test', 'HQ Stock', 50), ('pregnancy-test', 'Legon South', 10), ('pregnancy-test', 'UPSA Team', 10),
  ('lube-100', 'HQ Stock', 20), ('lube-100', 'Legon North', 5), ('personal-massager', 'HQ Stock', 6)
) q(slug, dist, qty)
join products p on p.slug = q.slug join distributors d on d.name = q.dist
on conflict (product_id, distributor_id) do nothing;

-- Record the opening balances in the stock ledger
insert into stock_movements(product_id, distributor_id, movement_type, quantity, on_hand_after, reserved_after, reason, reference_type)
select i.product_id, i.distributor_id, 'correction', i.on_hand, i.on_hand, i.reserved, 'Opening stock (demo)', 'opening'
from inventory i where i.on_hand > 0
  and not exists (select 1 from stock_movements m where m.product_id = i.product_id and m.distributor_id = i.distributor_id);
