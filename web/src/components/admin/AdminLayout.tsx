import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, LayoutDashboard, ShoppingCart, MessageSquareText, ClipboardCheck, Package, Tags, Handshake, MapPin, Users, Boxes,
  ArrowLeftRight, PackagePlus, Wallet, Receipt, BookOpen, Scale, BarChart3, FileSpreadsheet, Sparkles, Settings, ScrollText, Menu, X, LogOut, Store } from 'lucide-react';
import { useAuth } from '@/hooks/auth';
import { db } from '@/lib/neon';
import type { Role } from '@/lib/types';
import { cn, dateTime } from '@/lib/format';
import { AuthForm } from '@/pages/public/Account';
import { Loading } from '@/components/ui';

type Item = { to: string; label: string; icon: typeof Bell; roles?: Role[] };
const ORDERS: Role[] = ['manager', 'order_manager'];
const INV: Role[] = ['manager', 'inventory_manager'];
const FIN: Role[] = ['finance_manager', 'manager'];
const GROUPS: { title: string; items: Item[] }[] = [
  { title: 'Overview', items: [{ to: '/admin', label: 'Dashboard', icon: LayoutDashboard }] },
  { title: 'Sales', items: [
    { to: '/admin/orders', label: 'Orders', icon: ShoppingCart, roles: [...ORDERS, 'finance_manager', 'inventory_manager'] },
    { to: '/admin/enquiries', label: 'Enquiries', icon: MessageSquareText, roles: ORDERS },
    { to: '/admin/reconciliation', label: 'Daily reconciliation', icon: ClipboardCheck, roles: [...ORDERS, 'finance_manager', 'inventory_manager'] },
  ] },
  { title: 'Catalogue', items: [
    { to: '/admin/products', label: 'Products', icon: Package },
    { to: '/admin/categories', label: 'Categories', icon: Tags },
    { to: '/admin/stakeholders', label: 'Stakeholders', icon: Handshake },
  ] },
  { title: 'Stock', items: [
    { to: '/admin/inventory', label: 'Inventory', icon: Boxes },
    { to: '/admin/inventory/transfers', label: 'Transfers', icon: ArrowLeftRight },
    { to: '/admin/inventory/restocks', label: 'Restocks', icon: PackagePlus },
    { to: '/admin/distributors', label: 'Distributors', icon: Users },
    { to: '/admin/locations', label: 'Locations', icon: MapPin },
  ] },
  { title: 'Money', items: [
    { to: '/admin/finance', label: 'Cashflow', icon: Wallet, roles: FIN },
    { to: '/admin/finance/expenses', label: 'Expenses', icon: Receipt, roles: FIN },
    { to: '/admin/finance/transactions', label: 'Ledger', icon: BookOpen, roles: FIN },
    { to: '/admin/finance/settlements', label: 'Settlements', icon: Scale, roles: FIN },
  ] },
  { title: 'Tools', items: [
    { to: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
    { to: '/admin/import-export', label: 'Import / export', icon: FileSpreadsheet, roles: [...INV, 'finance_manager'] },
    { to: '/admin/ai-assistant', label: 'Sarah Assistant', icon: Sparkles },
    { to: '/admin/settings', label: 'Settings', icon: Settings, roles: ['super_admin'] },
    { to: '/admin/audit-logs', label: 'Audit log', icon: ScrollText, roles: ['manager'] },
  ] },
];

export function AdminLayout() {
  const { session, loading, isStaff, can, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  if (loading) return <div className="p-8"><Loading /></div>;
  if (!session) return (
    <div className="flex min-h-screen items-center justify-center bg-cream-100 px-4">
      <div className="w-full max-w-sm rounded-xl border border-charcoal-300/40 bg-white p-6">
        <p className="font-serif text-2xl text-navy">Sarah Petermore</p>
        <p className="mb-5 text-sm text-charcoal-400">Admin sign in</p>
        <AuthForm />
      </div>
    </div>
  );
  if (!isStaff) return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-2xl">No admin access</h1>
      <p className="mt-2 text-sm text-charcoal-500">You're signed in as {session.user.email}, but this account has no staff role. A super admin can add you in Settings → Staff.</p>
      <div className="mt-4 flex justify-center gap-3"><Link to="/" className="text-navy underline">Go to shop</Link><button className="text-charcoal-400" onClick={signOut}>Sign out</button></div>
    </div>
  );

  const nav = (
    <nav className="space-y-5 px-3 py-4" aria-label="Admin">
      {GROUPS.map((g) => {
        const items = g.items.filter((i) => !i.roles || can(...i.roles));
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <p className="px-2 pb-1 text-[11px] text-cream/45">{g.title}</p>
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === '/admin' || i.to === '/admin/inventory' || i.to === '/admin/finance'}
                className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-cream/15 text-white' : 'text-cream/75 hover:bg-cream/10 hover:text-white')}>
                <i.icon className="h-4 w-4" aria-hidden />{i.label}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-[#FAF9F2]">
      <aside className={cn('fixed inset-y-0 left-0 z-40 w-60 overflow-y-auto bg-navy transition-transform lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-14 items-center justify-between px-5">
          <Link to="/admin" className="font-serif text-lg text-cream">Sarah Petermore</Link>
          <button className="text-cream lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
        </div>
        {nav}
        <div className="border-t border-cream/10 px-5 py-3 text-xs text-cream/60">
          <p className="truncate">{session.user.email}</p>
          <div className="mt-2 flex gap-3">
            <Link to="/" className="inline-flex items-center gap-1 hover:text-white"><Store className="h-3 w-3" />Shop</Link>
            <button onClick={signOut} className="inline-flex items-center gap-1 hover:text-white"><LogOut className="h-3 w-3" />Sign out</button>
          </div>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-navy-900/40 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-charcoal-300/40 bg-white/90 px-4 backdrop-blur">
          <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5 text-navy" /></button>
          <div className="ml-auto"><Notifications /></div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6"><Outlet /></main>
      </div>
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const load = () => db.from('notifications').select('*').order('created_at', { ascending: false }).limit(30).then(({ data }) => setItems(data ?? []));
  useEffect(() => {
    void load();
    // Check for new orders / alerts every 20 seconds while the admin panel is open.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 20000);
    return () => clearInterval(t);
  }, []);
  const unread = items.filter((i) => !i.is_read).length;
  const markAll = async () => { await db.from('notifications').update({ is_read: true }).eq('is_read', false); void load(); };
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative rounded-full p-2 text-navy hover:bg-cream-100" aria-label={`Notifications, ${unread} unread`}>
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-ember px-1 text-[10px] text-white">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-[min(92vw,360px)] overflow-hidden rounded-lg border border-charcoal-300/40 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
            <span className="font-medium">Notifications</span>
            {unread > 0 && <button className="text-xs text-navy underline" onClick={markAll}>Mark all read</button>}
          </div>
          <ul className="max-h-96 divide-y overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-6 text-center text-sm text-charcoal-400">You're all caught up.</li>}
            {items.map((n) => (
              <li key={n.id} className={cn('px-4 py-2.5 text-sm', !n.is_read && 'bg-navy-50/50')}>
                <Link to={n.link ?? '/admin'} onClick={() => { setOpen(false); void db.from('notifications').update({ is_read: true }).eq('id', n.id); }}>
                  <p className="font-medium text-charcoal-800">{n.title}</p>
                  {n.body && <p className="text-charcoal-500">{n.body}</p>}
                  <p className="text-xs text-charcoal-400">{dateTime(n.created_at)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
