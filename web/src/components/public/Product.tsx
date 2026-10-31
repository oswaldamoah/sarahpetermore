import { Link } from 'react-router-dom';
import { Minus, Plus } from 'lucide-react';
import type { StoreProduct } from '@/lib/types';
import { money, cn } from '@/lib/format';
import { useCart } from '@/hooks/cart';
import { useSettings } from '@/hooks/settings';
import { haptic } from '@/lib/haptics';

/** Soft candy tints. Photos with white backgrounds blend into these (multiply), so every card feels part of one set. */
const TINTS = ['#FFE1EE', '#ECE4FF', '#DDF5E8', '#FFF0D6', '#DFEEFF', '#FFE6DC'];
export const tintFor = (id: string) => TINTS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];

/** Shop-ready versions of a product photo (white backgrounds removed): sm = cards (400px), md = product page (800px). */
function sized(src: string, size: 'sm' | 'md') {
  const m = src.match(/^\/img\/products\/([^/]+)\.(webp|jpg)$/);
  return m ? `/img/products/${size}/${m[1]}.webp` : src;
}
export const thumb = (src: string) => sized(src, 'sm');
export const large = (src: string) => sized(src, 'md');

/** A plain candy box with the monogram — used when a product has no photo. */
export function PlainBox({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('kraft-paper relative flex items-center justify-center overflow-hidden', className)} aria-hidden>
      <div className="relative -rotate-6 rounded-2xl bg-white/80 px-3 py-1 font-serif text-xl font-extrabold text-navy/70">{label ?? 'sp'}</div>
    </div>
  );
}

export function stockText(p: Pick<StoreProduct, 'available_qty'>, allowWithoutStock: boolean) {
  if (p.available_qty > 5) return { text: 'In stock', tone: 'text-sage-700', dot: 'bg-[#2BD67B]' };
  if (p.available_qty > 0) return { text: `Only ${p.available_qty} left`, tone: 'text-ember-700', dot: 'bg-ember' };
  return allowWithoutStock ? { text: 'On request', tone: 'text-charcoal-400', dot: 'bg-charcoal-300' } : { text: 'Sold out', tone: 'text-charcoal-400', dot: 'bg-charcoal-300' };
}

export function ProductCard({ p, eager }: { p: StoreProduct; eager?: boolean }) {
  const { lines, add, setQty, remove } = useCart();
  const { s } = useSettings();
  const allow = s.allow_orders_without_stock === true;
  const st = stockText(p, allow);
  const buyable = p.available_qty > 0 || allow;
  const max = allow ? 100 : p.available_qty;
  const inCart = lines.find((l) => l.product_id === p.id)?.quantity ?? 0;
  const addOne = () => { haptic('success'); add({ product_id: p.id, name: p.name, price: Number(p.price), unit: p.unit, image: p.images?.[0], max: allow ? undefined : p.available_qty }); };

  return (
    <article className="group flex flex-col">
      <div className="relative">
      <Link to={`/product/${p.slug}`} className="press relative block overflow-hidden rounded-blob" style={{ backgroundColor: tintFor(p.id) }}>
        {p.images?.[0]
          ? <img src={thumb(p.images[0])} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" width={400} height={400}
              className="aspect-square w-full object-cover drop-shadow-[0_10px_14px_rgba(45,18,51,.16)] transition-transform duration-500 ease-out group-hover:scale-105" />
          : <PlainBox className="aspect-square w-full" />}
        {!buyable && <span className="absolute left-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-bold text-charcoal-500 backdrop-blur">Sold out</span>}
        {buyable && p.available_qty > 0 && p.available_qty <= 5 && <span className="absolute left-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-bold text-ember-700 backdrop-blur">{st.text}</span>}
      </Link>

      {/* Quick add: a pink + that turns into a − 1 + stepper once it's in the cart */}
      <div className="absolute bottom-2.5 right-2.5 sm:bottom-3 sm:right-3">
        {inCart > 0 ? (
          <div className="pop-in flex h-11 items-center rounded-full bg-navy p-1 text-white shadow-card">
            <button className="press flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10" aria-label={`One less ${p.name}`}
              onClick={() => { haptic(); inCart <= 1 ? remove(p.id) : setQty(p.id, inCart - 1); }}><Minus className="h-4 w-4" /></button>
            <span key={inCart} className="pop-in w-6 text-center text-sm font-bold tabular-nums" aria-live="polite">{inCart}</span>
            <button className="press flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-30" disabled={inCart >= max} aria-label={`One more ${p.name}`}
              onClick={() => { haptic(); setQty(p.id, inCart + 1); }}><Plus className="h-4 w-4" /></button>
          </div>
        ) : (
          <button disabled={!buyable} onClick={addOne} aria-label={`Add ${p.name} to cart`}
            className="btn-pop btn-pink h-11 w-11 disabled:hidden">
            <Plus className="h-5 w-5" strokeWidth={2.75} />
          </button>
        )}
      </div>
      </div>

      <Link to={`/product/${p.slug}`} className="mt-3 block px-1">
        <p className="line-clamp-2 min-h-[2.5em] text-[15px] font-semibold leading-tight text-navy">{p.name}</p>
        <div className="mt-1.5 flex items-baseline justify-between gap-2">
          <p className="font-serif text-[1.15rem] font-extrabold tracking-tight text-navy">{money(p.price)}</p>
          <p className={cn('flex items-center gap-1 text-[11px] font-semibold', st.tone)}><span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} aria-hidden />{p.available_qty > 5 || !buyable ? st.text : ''}</p>
        </div>
      </Link>
    </article>
  );
}

export function ProductGrid({ items, eager = 0 }: { items: StoreProduct[]; eager?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
      {items.map((p, i) => <ProductCard key={p.id} p={p} eager={i < eager} />)}
    </div>
  );
}

export function ProductSkeletons({ n = 8 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4" aria-label="Loading products">
      {Array.from({ length: n }, (_, i) => (
        <div key={i}><div className="skeleton aspect-square rounded-blob" /><div className="skeleton mt-3 h-4 w-3/4 rounded-full" /><div className="skeleton mt-2 h-5 w-1/3 rounded-full" /></div>
      ))}
    </div>
  );
}
