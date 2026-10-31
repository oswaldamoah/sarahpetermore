import { Link } from 'react-router-dom';
import { ArrowRight, MessageCircle, Package, Wallet } from 'lucide-react';
import { db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { useSettings, contactList } from '@/hooks/settings';
import type { StoreCategory, StoreProduct } from '@/lib/types';
import { ProductGrid, ProductSkeletons, thumb, tintFor } from '@/components/public/Product';
import { openChat } from '@/components/public/Chat';
import { ErrorBox } from '@/components/ui';
import { haptic } from '@/lib/haptics';

/** Four product photos as floating "stickers" — shows what we sell at a glance. */
function Stickers({ items }: { items: StoreProduct[] }) {
  const pics = items.filter((p) => p.images?.[0]).slice(0, 4);
  const spots = [
    'left-[4%] top-[6%] w-[46%] [--r:-7deg]', 'right-[2%] top-[0%] w-[42%] [--r:6deg] [animation-delay:-2s]',
    'left-[12%] bottom-[2%] w-[40%] [--r:5deg] [animation-delay:-4s]', 'right-[6%] bottom-[8%] w-[44%] [--r:-4deg] [animation-delay:-1s]',
  ];
  return (
    <div className="relative mx-auto hidden aspect-square w-full max-w-[480px] md:block" aria-hidden>
      <div className="absolute inset-[8%] rounded-full bg-ember/30 blur-3xl" />
      {pics.map((p, i) => (
        <Link key={p.id} to={`/product/${p.slug}`} tabIndex={-1} className={`float absolute overflow-hidden rounded-[30px] border-[5px] border-white shadow-card ${spots[i]}`} style={{ backgroundColor: tintFor(p.id) }}>
          <img src={thumb(p.images[0])} alt="" className="aspect-square w-full object-cover drop-shadow-[0_8px_12px_rgba(45,18,51,.18)]" fetchPriority={i === 0 ? 'high' : 'auto'} />
        </Link>
      ))}
    </div>
  );
}

const Section = ({ title, link, children }: { title: string; link?: { to: string; label: string }; children: React.ReactNode }) => (
  <section className="mx-auto max-w-6xl px-4 pt-12 sm:pt-16">
    <div className="mb-5 flex items-end justify-between">
      <h2 className="text-[1.75rem] sm:text-3xl">{title}</h2>
      {link && <Link to={link.to} className="press inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-semibold text-navy hover:bg-ember-50">{link.label}<ArrowRight className="h-4 w-4" aria-hidden /></Link>}
    </div>
    {children}
  </section>
);

export default function Home() {
  const { s } = useSettings();
  const cats = useAsync(() => q<StoreCategory[]>(db.from('storefront_categories').select('*').order('sort_order')));
  const prods = useAsync(() => q<StoreProduct[]>(db.from('storefront_products').select('*').limit(200)));
  const all = prods.data ?? [];
  const featured = all.filter((p) => p.is_featured).slice(0, 8);
  const fresh = [...all].sort((a, b) => b.created_at.localeCompare(a.created_at)).filter((p) => !featured.includes(p)).slice(0, 8);
  const [first, ...rest] = String(s.tagline ?? 'No long talk. Just get it.').split(/(?<=\.)\s+/);
  const snap = contactList(s).find((c) => c.label === 'Snapchat');

  return (
    <>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-ember/25 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -right-20 top-40 h-72 w-72 rounded-full bg-sage/40 blur-3xl" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl items-center gap-8 px-4 pb-4 pt-8 sm:pt-14 md:grid-cols-[1.05fr_1fr]">
          <div>
            <h1 className="text-[3.1rem] leading-[0.92] sm:text-[4.6rem]">{first}{rest.length > 0 && <><br /><span className="text-ember-600">{rest.join(' ')}</span></>}</h1>
            <p className="mt-5 max-w-md text-[1.08rem] leading-relaxed text-charcoal-500">{s.hero_subtitle}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link to="/shop" onPointerDown={() => haptic()} className="btn-pop btn-pink h-[54px] px-8 text-base">Shop now<ArrowRight className="h-5 w-5" aria-hidden /></Link>
              <button onClick={() => { haptic(); openChat(); }} className="btn-pop btn-soft h-[54px] px-6 text-base"><MessageCircle className="h-5 w-5" aria-hidden />Ask us</button>
            </div>
            <ul className="mt-7 flex flex-wrap gap-2 text-[13px] font-semibold text-navy">
              {[{ i: Package, t: 'Plain box' }, { i: Wallet, t: 'Pay on delivery' }].map(({ i: Icon, t }) => (
                <li key={t} className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-[0_1px_0_rgba(45,18,51,.06)]"><Icon className="h-4 w-4 text-ember-600" aria-hidden />{t}</li>
              ))}
            </ul>
          </div>
          <Stickers items={featured.length >= 4 ? featured : all} />
        </div>
      </section>

      <section className="mx-auto max-w-6xl pt-8 sm:pt-12" aria-label="Categories">
        {cats.error && <div className="px-4"><ErrorBox message={cats.error} onRetry={cats.reload} /></div>}
        <div className="no-scrollbar flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 lg:grid lg:grid-cols-6 lg:overflow-visible">
          {(cats.data ?? Array.from({ length: 6 }, () => null)).filter((c) => !c || c.product_count > 0).map((c, i) => c ? (
            <Link key={c.id} to={`/category/${c.slug}`} onPointerDown={() => haptic()}
              className="press flex min-h-[92px] min-w-[44%] snap-start flex-col justify-between rounded-[22px] p-4 sm:min-w-[30%] lg:min-w-0"
              style={{ backgroundColor: tintFor(c.id) }}>
              <span className="font-serif text-[1.05rem] font-extrabold leading-tight text-navy">{c.name}</span>
              <span className="flex items-center justify-between text-xs font-semibold text-navy/60">{c.product_count} item{c.product_count === 1 ? '' : 's'}<ArrowRight className="h-4 w-4" aria-hidden /></span>
            </Link>
          ) : <div key={i} className="skeleton min-h-[92px] min-w-[44%] rounded-[22px] sm:min-w-[30%] lg:min-w-0" />)}
        </div>
      </section>

      {prods.error && <div className="mx-auto max-w-6xl px-4 pt-8"><ErrorBox message={prods.error} onRetry={prods.reload} /></div>}
      {prods.loading && <Section title="Our picks"><ProductSkeletons n={4} /></Section>}
      {featured.length > 0 && <Section title="Our picks" link={{ to: '/shop', label: 'Shop all' }}><ProductGrid items={featured} eager={2} /></Section>}
      {fresh.length > 0 && <Section title="New in" link={{ to: '/shop?sort=new', label: 'See more' }}><ProductGrid items={fresh} /></Section>}

      <section className="mx-auto mt-16 max-w-6xl px-4">
        <div className="relative overflow-hidden rounded-[32px] bg-ember p-7 sm:p-10">
          <div className="pointer-events-none absolute -bottom-16 -right-10 h-56 w-56 rounded-full bg-white/25 blur-2xl" aria-hidden />
          <h2 className="max-w-md text-[2rem] leading-tight sm:text-4xl">Not sure what to get?</h2>
          <p className="mt-2 max-w-md font-medium text-navy/75">Ask in chat. You can order there too.</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button onClick={() => { haptic(); openChat(); }} className="btn-pop btn-ink h-12 px-6 text-sm"><MessageCircle className="h-4 w-4" aria-hidden />Chat now</button>
            {snap && <a href={snap.href} target="_blank" rel="noreferrer" className="press rounded-full px-4 py-3 text-sm font-semibold text-navy hover:bg-white/30">Snapchat {snap.value}</a>}
          </div>
        </div>
      </section>
    </>
  );
}
