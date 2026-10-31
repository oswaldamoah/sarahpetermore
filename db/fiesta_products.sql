-- Fiesta condoms (own stock). Prices are a starting point: change them in Admin → Products. Safe to re-run.
insert into products(name, slug, description, category_id, stakeholder_id, cost_price, base_price, unit, images, is_active, is_available)
select v.name, v.slug, v.descr, c.id, s.id, 0, v.price, 'pack', array[v.img], true, true
from (values
  ('Fiesta Strawberry Condoms (3-pack)', 'fiesta-strawberry-condoms-3-pack', 'Strawberry-scented, flavoured latex condoms. 3 per pack.', 25, '/img/products/fiesta-strawberry-condoms-3-pack.webp'),
  ('Fiesta Dotted Condoms (3-pack)',     'fiesta-dotted-condoms-3-pack',     'Dotted latex condoms for extra sensation. 3 per pack.', 25, '/img/products/fiesta-dotted-condoms-3-pack.webp'),
  ('Fiesta All Night Condoms (3-pack)',  'fiesta-all-night-condoms-3-pack',  'Latex condoms with delay gel for longer-lasting pleasure. 3 per pack.', 25, '/img/products/fiesta-all-night-condoms-3-pack.webp'),
  ('Fiesta Extra-Thin Condoms (3-pack)', 'fiesta-extra-thin-condoms-3-pack', 'Extra-thin latex condoms for a closer feel. 3 per pack.', 25, '/img/products/fiesta-extra-thin-condoms-3-pack.webp'),
  ('Fiesta Dumsor Condoms (3-pack)',     'fiesta-dumsor-condoms-3-pack',     'Glow-in-the-dark latex condoms for a fun night. 3 per pack.', 25, '/img/products/fiesta-dumsor-condoms-3-pack.webp')
) v(name, slug, descr, price, img)
join categories c on c.slug = 'condoms' join stakeholders s on s.slug = 'sarahpetermore'
on conflict (slug) do update set name = excluded.name, description = excluded.description, images = excluded.images,
  is_active = true, is_available = true, updated_at = now();
