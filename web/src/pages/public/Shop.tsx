import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Minus, Plus, Package, ChevronLeft, Wallet } from 'lucide-react';
import { db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import type { StoreCategory, StoreProduct } from '@/lib/types';
import { PlainBox, ProductGrid, ProductSkeletons, large, stockText, thumb, tintFor } from '@/components/public/Product';
import { Button, Empty, ErrorBox, Select, useToast } from '@/components/ui';
import { haptic } from '@/lib/haptics';
import { cn, money } from '@/lib/format';
import { useCart } from '@/hooks/cart';
import { useSettings } from '@/hooks/settings';

export default function Shop() {
  const { slug } = useParams();
  const [params, setParams] = useSearchParams();
  const term = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'popular';
  const cats = useAsync(() => q<StoreCategory[]>(db.from('storefront_categories').select('*').order('sort_order')));
  const prods = useAsync(() => {
    let query = db.from('storefront_products').select('*').limit(500);
    if (slug) query = query.eq('category_slug', slug);
    if (term) query = query.or(`name.ilike.%${term}%,description.ilike.%${term}%,category_name.ilike.%${term}%`);
    return q<StoreProduct[]>(query);
  }, [slug, term]);

  const sorted = useMemo(() => {
    const list = [...(prods.data ?? [])];
    if (sort === 'price_asc') list.sort((a, b) => a.price - b.price);
    else if (sort === 'price_desc') list.sort((a, b) => b.price - a.price);
    else if (sort === 'new') list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    else list.sort((a, b) => b.sold_90d - a.sold_90d || Number(b.is_featured) - Number(a.is_featured));
    return list;
  }, [prods.data, sort]);

  const current = cats.data?.find((c) => c.slug === slug);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  return (
    <div className="mx-auto max-w-6xl py-6 sm:py-10">
      <div className="flex items-end justify-between gap-3 px-4">
        <h1 className="text-[2.2rem] leading-none sm:text-5xl">{term ? `“${term}”` : current?.name ?? 'Shop'}</h1>
        <div className="w-40 shrink-0 sm:w-48">
          <Select aria-label="Sort" value={sort} onChange={(e) => set('sort', e.target.value)}>
            <option value="popular">Popular</option><option value="new">Newest</option>
            <option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option>
          </Select>
        </div>
      </div>
      <div className="no-scrollbar mt-5 flex gap-2 overflow-x-auto px-4 pb-1">
        <Link to="/shop" onClick={() => haptic()} className={chip(!slug)}>All</Link>
        {(cats.data ?? []).map((c) => <Link key={c.id} to={`/category/${c.slug}${term ? `?q=${term}` : ''}`} onClick={() => haptic()} className={chip(slug === c.slug)}>{c.name}</Link>)}
      </div>
      <div className="px-4">
        {slug && cats.data && !current && <div className="mt-8"><Empty title="This category isn't available">Browse everything else in the shop.</Empty></div>}
        {prods.error && <div className="mt-6"><ErrorBox message={prods.error} onRetry={prods.reload} /></div>}
        {!prods.loading && !prods.error && <p className="mt-4 text-sm font-medium text-charcoal-400">{sorted.length} product{sorted.length === 1 ? '' : 's'}</p>}
        <div className="mt-4">
          {prods.loading ? <ProductSkeletons /> : sorted.length === 0 && !prods.error ? (
            <Empty title="We don't have that yet" action={<Link className="btn-pop btn-pink h-11 px-5 text-sm" to={`/enquiries${term ? `?product=${encodeURIComponent(term)}` : ''}`}>Ask us to get it</Link>}>
              Tell us what you need and we'll let you know when it's in.</Empty>
          ) : <ProductGrid items={sorted} eager={4} />}
        </div>
      </div>
    </div>
  );
}

const chip = (on: boolean) => cn('press shrink-0 rounded-full px-4 py-2 text-sm font-semibold', on ? 'bg-navy text-white' : 'bg-white text-navy shadow-[0_1px_0_rgba(45,18,51,.08)] hover:bg-ember-50');

export function ProductPage() {
  const { slug } = useParams();
  const nav = useNavigate();
  const { add } = useCart();
  const toast = useToast();
  const { s } = useSettings();
  const [qty, setQty] = useState(1);
  const [img, setImg] = useState(0);
  const p = useAsync(() => q<StoreProduct | null>(db.from('storefront_products').select('*').eq('slug', slug!).maybeSingle()), [slug]);
  if (p.loading) return <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 md:grid-cols-2"><div className="skeleton aspect-square rounded-[32px]" /><div><div className="skeleton h-10 w-3/4 rounded-full" /><div className="skeleton mt-4 h-8 w-1/3 rounded-full" /></div></div>;
  if (p.error) return <div className="mx-auto max-w-6xl px-4 py-8"><ErrorBox message={p.error} onRetry={p.reload} /></div>;
  if (!p.data) return <div className="mx-auto max-w-xl px-4 py-16"><Empty title="This product isn't available" action={<Link to="/shop" className="text-navy underline">Back to shop</Link>} /></div>;
  const prod = p.data;
  const allow = s.allow_orders_without_stock === true;
  const max = allow ? 100 : Math.max(0, prod.available_qty);
  const st = stockText(prod, allow);
  const add2cart = () => { add({ product_id: prod.id, name: prod.name, price: Number(prod.price), unit: prod.unit, image: prod.images?.[0], max: allow ? undefined : prod.available_qty }, qty); };

  const buy = (go: boolean) => { haptic('success'); add2cart(); if (go) nav('/checkout/location'); else toast('success', `${prod.name} added`); };
  const Qty = (
    <div className="flex h-[52px] items-center rounded-full bg-white p-1 shadow-[0_1px_0_rgba(45,18,51,.08)]">
      <button className="press flex h-11 w-11 items-center justify-center rounded-full text-navy hover:bg-ember-50 disabled:opacity-30" disabled={qty <= 1} onClick={() => { haptic(); setQty(qty - 1); }} aria-label="Less"><Minus className="h-4 w-4" /></button>
      <span key={qty} className="pop-in w-8 text-center font-bold tabular-nums" aria-live="polite">{qty}</span>
      <button className="press flex h-11 w-11 items-center justify-center rounded-full text-navy hover:bg-ember-50 disabled:opacity-30" disabled={qty >= max} onClick={() => { haptic(); setQty(qty + 1); }} aria-label="More"><Plus className="h-4 w-4" /></button>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-4 sm:py-8">
      <button onClick={() => nav(-1)} className="press mb-3 inline-flex items-center gap-1 rounded-full py-1.5 pr-3 text-sm font-semibold text-charcoal-500 hover:text-navy"><ChevronLeft className="h-4 w-4" />Back</button>
      <div className="grid gap-8 md:grid-cols-2 md:gap-12">
        <div>
          <div className="overflow-hidden rounded-[32px]" style={{ backgroundColor: tintFor(prod.id) }}>
            {prod.images?.length ? <img src={large(prod.images[img])} alt={prod.name} className="rise aspect-square w-full object-cover drop-shadow-[0_16px_22px_rgba(45,18,51,.18)]" fetchPriority="high" key={img} /> : <PlainBox className="aspect-square w-full" />}
          </div>
          {prod.images?.length > 1 && (
            <div className="mt-3 flex gap-2">
              {prod.images.map((u, i) => <button key={u} onClick={() => setImg(i)} className={cn('press h-16 w-16 overflow-hidden rounded-2xl border-[3px] bg-white', i === img ? 'border-ember' : 'border-transparent')}><img src={thumb(u)} alt="" className="h-full w-full object-contain" /></button>)}
            </div>
          )}
        </div>
        <div>
          <Link to={`/category/${prod.category_slug}`} className="inline-block rounded-full bg-white px-3 py-1 text-xs font-bold uppercase tracking-wide text-charcoal-500 hover:text-navy">{prod.category_name}</Link>
          <h1 className="mt-3 text-[2.1rem] leading-[1.02] sm:text-5xl">{prod.name}</h1>
          <div className="mt-4 flex items-center gap-3">
            <p className="font-serif text-[2rem] font-extrabold tracking-tight text-navy">{money(prod.price)}</p>
            <span className="text-sm text-charcoal-400">per {prod.unit}</span>
            <span className={cn('ml-auto flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-bold', st.tone)}><span className={cn('h-2 w-2 rounded-full', st.dot)} />{st.text}</span>
          </div>
          {prod.description && <p className="mt-5 max-w-prose whitespace-pre-line leading-relaxed text-charcoal-500">{prod.description}</p>}
          <div className="mt-7 hidden flex-wrap items-center gap-3 md:flex">
            {Qty}
            <Button size="lg" variant="primary" disabled={max === 0} onClick={() => buy(false)}>Add to cart</Button>
            <Button size="lg" variant="action" disabled={max === 0} onClick={() => buy(true)}>Order now</Button>
          </div>
          {max === 0 && <p className="mt-4 rounded-2xl bg-white p-4 text-sm">Sold out right now. <Link className="font-semibold text-ember-700 underline" to={`/enquiries?product=${encodeURIComponent(prod.name)}`}>Tell me when it's back</Link></p>}
          <p className="mt-8 flex flex-wrap gap-2 text-[13px] font-semibold text-navy">
            <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5"><Package className="h-4 w-4 text-ember-600" />Plain box</span>
            <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5"><Wallet className="h-4 w-4 text-ember-600" />Pay on delivery</span>
          </p>
        </div>
      </div>

      {/* Mobile: buying stays under your thumb */}
      {max > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 border-t border-navy/[.06] bg-cream/95 px-3 py-2.5 backdrop-blur-xl md:hidden">
          <div className="flex items-center gap-2">
            {Qty}
            <Button size="lg" variant="primary" className="flex-1" onClick={() => buy(false)}>Add · {money(prod.price * qty)}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
