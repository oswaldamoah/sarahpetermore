import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ShoppingBag, Search, User, X, Package, Wallet, Home as HomeIcon, Store, MessageCircle, MapPin } from 'lucide-react';
import { useCart } from '@/hooks/cart';
import { useSettings, contactList } from '@/hooks/settings';
import { useAuth } from '@/hooks/auth';
import { cn } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { ChatWidget, openChat } from './Chat';
import { LogoBadge } from './Logo';
export { LogoBadge };

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn('group flex items-center gap-2.5 text-navy', className)} aria-label="SarahPetermore home">
      <LogoBadge />
      <span className="font-serif text-[1.25rem] font-extrabold leading-none tracking-[-0.045em]">sarahpetermore</span>
    </Link>
  );
}

/** Cart icon whose badge does a little jelly bounce whenever something is added. */
function CartButton({ className }: { className?: string }) {
  const { count } = useCart();
  const prev = useRef(count);
  const [bump, setBump] = useState(0);
  useEffect(() => { if (count > prev.current) setBump((b) => b + 1); prev.current = count; }, [count]);
  return (
    <Link to="/cart" className={cn('press relative rounded-full p-2.5 text-navy hover:bg-ember-50', className)} aria-label={`Cart, ${count} items`}>
      <ShoppingBag className="h-[22px] w-[22px]" />
      {count > 0 && <span key={bump} className="jelly absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-ember px-1 text-[11px] font-bold text-navy ring-2 ring-white">{count}</span>}
    </Link>
  );
}

export function PublicLayout() {
  const { isStaff, session } = useAuth();
  const [searching, setSearching] = useState(false);
  const [term, setTerm] = useState('');
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => { setSearching(false); }, [loc.pathname]);

  const links = [
    { to: '/shop', label: 'Shop' },
    { to: '/track-order', label: 'Track order' },
    { to: '/enquiries', label: 'Request a product' },
  ];
  const go = (e: React.FormEvent) => { e.preventDefault(); if (term.trim()) nav(`/shop?q=${encodeURIComponent(term.trim())}`); };

  return (
    <div className="flex min-h-screen flex-col">
      <TrustBar />
      <header className="sticky top-0 z-40 border-b border-navy/[.06] bg-cream/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <Wordmark />
          <nav className="ml-6 hidden gap-1 md:flex" aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => cn('press rounded-full px-3.5 py-2 text-sm font-semibold', isActive ? 'bg-navy text-white' : 'text-charcoal-500 hover:bg-ember-50 hover:text-navy')}>
                {l.label}
              </NavLink>
            ))}
            <button onClick={() => openChat()} className="press rounded-full px-3.5 py-2 text-sm font-semibold text-charcoal-500 hover:bg-ember-50 hover:text-navy">Chat with us</button>
          </nav>
          <form className="ml-auto hidden items-center lg:flex" onSubmit={go} role="search">
            <label className="relative">
              <span className="sr-only">Search products</span>
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-400" aria-hidden />
              <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search products"
                className="h-10 w-56 rounded-full border-2 border-transparent bg-white pl-9 pr-3 text-sm shadow-[0_1px_0_rgba(45,18,51,.06)] transition focus:w-64 focus:border-ember focus:outline-none" />
            </label>
          </form>
          <div className="ml-auto flex items-center lg:ml-1">
            <button onClick={() => { haptic(); setSearching((v) => !v); }} className="press rounded-full p-2.5 text-navy hover:bg-ember-50 lg:hidden" aria-label="Search">
              {searching ? <X className="h-[22px] w-[22px]" /> : <Search className="h-[22px] w-[22px]" />}
            </button>
            {isStaff && <Link to="/admin" className="hidden rounded-full px-3 py-1.5 text-xs font-semibold text-charcoal-400 hover:bg-ember-50 hover:text-navy sm:block">Admin</Link>}
            <Link to={session ? '/account' : '/account?mode=login'} className="press hidden rounded-full p-2.5 text-navy hover:bg-ember-50 md:block" aria-label="Account"><User className="h-[22px] w-[22px]" /></Link>
            <CartButton className="hidden md:block" />
          </div>
        </div>
        {searching && (
          <form className="rise px-4 pb-3 lg:hidden" onSubmit={go} role="search">
            <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="What do you need?" enterKeyHint="search"
              className="h-12 w-full rounded-full border-2 border-ember/40 bg-white px-5 text-base focus:border-ember focus:outline-none" />
          </form>
        )}
      </header>
      <main key={loc.pathname} className="page-in flex-1 pb-24 md:pb-0"><Outlet /></main>
      <Footer />
      <BottomBar />
      <ChatWidget />
    </div>
  );
}

/** Mobile tab bar: everything a shopper needs within thumb reach. */
function BottomBar() {
  const { count } = useCart();
  const { pathname } = useLocation();
  if (pathname.startsWith('/checkout')) return null;
  const tab = 'press flex flex-1 flex-col items-center gap-0.5 pt-2 text-[11px] font-semibold';
  const cls = ({ isActive }: { isActive: boolean }) => cn(tab, isActive ? 'text-navy' : 'text-charcoal-400');
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-navy/[.06] bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden" aria-label="Quick">
      <div className="flex h-16">
        <NavLink to="/" end className={cls} onClick={() => haptic()}><HomeIcon className="h-[22px] w-[22px]" />Home</NavLink>
        <NavLink to="/shop" className={cls} onClick={() => haptic()}><Store className="h-[22px] w-[22px]" />Shop</NavLink>
        <button className={cn(tab, 'text-charcoal-400')} onClick={() => { haptic(); openChat(); }}>
          <span className="-mt-6 flex h-12 w-12 items-center justify-center rounded-full bg-ember text-navy shadow-[0_4px_0_0_#E0448F] ring-4 ring-white"><MessageCircle className="h-[22px] w-[22px]" /></span>Chat
        </button>
        <NavLink to="/track-order" className={cls} onClick={() => haptic()}><MapPin className="h-[22px] w-[22px]" />Track</NavLink>
        <NavLink to="/cart" className={cls} onClick={() => haptic()}>
          <span className="relative"><ShoppingBag className="h-[22px] w-[22px]" />
            {count > 0 && <span key={count} className="jelly absolute -right-2.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-ember px-1 text-[10px] font-bold text-navy">{count}</span>}</span>
          Cart
        </NavLink>
      </div>
    </nav>
  );
}

/** Slim strip above the header: the promises that matter to a first-time buyer. No phone numbers here. */
function TrustBar() {
  return (
    <div className="bg-navy text-[12px] font-medium text-white/85">
      <ul className="no-scrollbar mx-auto flex h-8 max-w-6xl items-center justify-center gap-6 overflow-x-auto whitespace-nowrap px-4">
        <li className="flex items-center gap-1.5"><Package className="h-3.5 w-3.5 text-ember" aria-hidden />Plain packaging</li>
        <li className="flex items-center gap-1.5"><Wallet className="h-3.5 w-3.5 text-ember" aria-hidden />Pay on delivery</li>
      </ul>
    </div>
  );
}

function Footer() {
  const { s } = useSettings();
  const socials = contactList(s);
  return (
    <footer className="mt-20 rounded-t-[36px] bg-navy text-white/80">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 pb-10 pt-12 md:grid-cols-[1.4fr_1fr_1fr] md:pb-12">
        <div>
          <p className="font-serif text-3xl font-extrabold tracking-[-0.045em] text-white">sarahpetermore</p>
          <p className="mt-1 text-ember">{s.tagline}</p>
          <p className="mt-5 flex max-w-sm items-start gap-2 text-sm"><Package className="mt-0.5 h-4 w-4 shrink-0 text-ember" aria-hidden />{s.discreet_note}</p>
        </div>
        <div>
          <p className="mb-3 text-sm font-semibold text-white">Talk to us</p>
          <button onClick={() => openChat()} className="btn-pop btn-pink h-11 px-5 text-sm">Chat now</button>
          {socials.map((c) => <a key={c.label} className="mt-3 block text-sm hover:text-white" href={c.href} target="_blank" rel="noreferrer">{c.label}: {c.value}</a>)}
          <p className="mt-3 text-xs text-white/50">You get a delivery number when you order.</p>
        </div>
        <div>
          <p className="mb-3 text-sm font-semibold text-white">How it works</p>
          <p className="text-sm">{s.policies ?? 'Payment on delivery.'}</p>
          <div className="mt-3 flex flex-col gap-1.5 text-sm">
            <Link to="/track-order" className="hover:text-white">Track an order</Link>
            <Link to="/enquiries" className="hover:text-white">Request a product</Link>
            <Link to="/account" className="hover:text-white">Your account</Link>
          </div>
        </div>
      </div>
      <div className="border-t border-white/10 py-4 pb-[calc(1rem+80px)] text-center text-xs text-white/40 md:pb-4">© {new Date().getFullYear()} {s.business_name}</div>
    </footer>
  );
}
