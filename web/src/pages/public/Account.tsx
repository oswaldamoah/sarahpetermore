import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '@/lib/neon';
import { useAuth } from '@/hooks/auth';
import { useCart } from '@/hooks/cart';
import { useAsync, q } from '@/hooks/useAsync';
import type { Institution } from '@/lib/types';
import { Badge, Button, Checkbox, Empty, ErrorBox, Field, Input, Loading, Modal, Select, useToast } from '@/components/ui';
import { CUSTOMER_STATUS_TEXT, cn, dateOnly, errorText, money } from '@/lib/format';

export function AuthForm({ next }: { next?: string }) {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>((params.get('mode') as any) === 'signup' ? 'signup' : 'login');
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const nav = useNavigate();
  const { refresh } = useAuth();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      if (mode === 'login') {
        const { error } = await db.auth.signInWithPassword({ email: f.email, password: f.password });
        if (error && !/retrieve user session/i.test(error.message)) throw error;
        // Re-check with the server and go straight in (admins land on the dashboard)
        const r = await refresh();
        if (!r.session) throw new Error("Your password was right, but this browser didn't keep you signed in. Refresh the page and try once more.");
        nav(next ?? (r.roles.some((x) => x !== 'distributor') ? '/admin' : '/account'), { replace: true });
      } else if (mode === 'signup') {
        const { data, error } = await db.auth.signUp({ email: f.email, password: f.password,
          options: { data: { displayName: f.name }, emailRedirectTo: `${location.origin}/account` } });
        if (error && !/retrieve user session/i.test(error.message)) throw error;
        const r = await refresh();
        if (r.session || data?.session) { await db.rpc('ensure_profile', { p_full_name: f.name, p_phone: f.phone }); nav(next ?? '/account', { replace: true }); }
        else setMsg({ kind: 'info', text: 'Account created. Sign in to continue.' });
      } else {
        const { error } = await db.auth.resetPasswordForEmail(f.email, { redirectTo: `${location.origin}/account` });
        if (error) throw error;
        setMsg({ kind: 'info', text: 'If that email has an account, a reset link is on its way.' });
      }
    } catch (err) { setMsg({ kind: 'error', text: errorText(err) }); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {mode === 'signup' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={set('name')} required /></Field>
          <Field label="Phone"><Input type="tel" value={f.phone} onChange={set('phone')} /></Field>
        </div>
      )}
      <Field label="Email"><Input type="email" autoComplete="email" value={f.email} onChange={set('email')} required /></Field>
      {mode !== 'forgot' && <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters' : undefined}>
        <Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'signup' ? 8 : undefined} value={f.password} onChange={set('password')} required /></Field>}
      {msg && (msg.kind === 'error' ? <ErrorBox message={msg.text} /> : <p className="rounded-2xl bg-sage-50 p-3 text-sm text-sage-800">{msg.text}</p>)}
      <Button type="submit" size="lg" className="w-full" loading={busy}>{mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}</Button>
      <div className="flex justify-between text-sm">
        {mode === 'login' ? <>
          <button type="button" className="text-navy underline" onClick={() => setMode('signup')}>Create an account</button>
          <button type="button" className="text-charcoal-400 hover:text-navy" onClick={() => setMode('forgot')}>Forgot password?</button>
        </> : <button type="button" className="text-navy underline" onClick={() => setMode('login')}>Back to sign in</button>}
      </div>
    </form>
  );
}

// Neon Auth (Better Auth) emails a link that returns here with ?token=…
function ResetPassword({ token }: { token: string }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  return (
    <form className="max-w-sm space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      const { error } = await db.auth.getBetterAuthInstance().resetPassword({ newPassword: pw, token });
      setBusy(false);
      if (error) toast('error', errorText(error)); else { toast('success', 'Password updated — sign in with your new password'); nav('/account?mode=login'); }
    }}>
      <Field label="New password" hint="At least 8 characters"><Input type="password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
      <Button type="submit" loading={busy}>Save new password</Button>
    </form>
  );
}

export default function Account() {
  const { session, loading, signOut, isStaff } = useAuth();
  const [params] = useSearchParams();
  const path = useLocation().pathname;
  const tab = path.endsWith('/addresses') ? 'addresses' : path.endsWith('/orders') ? 'orders' : 'profile';
  if (params.get('token')) return <div className="mx-auto max-w-md px-4 py-10"><h1 className="mb-6 text-3xl">Set a new password</h1><ResetPassword token={params.get('token')!} /></div>;
  if (loading) return <div className="mx-auto max-w-3xl px-4"><Loading /></div>;
  if (!session) return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-3xl">Your account</h1>
      <p className="mb-6 mt-1 text-charcoal-500">Save your delivery details and see your orders. You can always order without an account.</p>
      <AuthForm next={params.get('next') ?? undefined} />
    </div>
  );
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Your account</h1>
        <div className="flex gap-2">
          {isStaff && <Link to="/admin" className="press inline-flex h-9 items-center rounded-full border-2 border-navy/10 bg-white px-4 text-sm font-semibold text-navy">Admin</Link>}
          <Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>
        </div>
      </div>
      <nav className="mt-6 flex gap-4 border-b border-kraft-600/30 text-sm">
        {[['profile', '/account', 'Profile'], ['orders', '/account/orders', 'Orders'], ['addresses', '/account/addresses', 'Addresses']].map(([k, to, l]) => (
          <Link key={k} to={to} className={cn('-mb-px border-b-2 pb-2', tab === k ? 'border-navy text-navy' : 'border-transparent text-charcoal-400')}>{l}</Link>
        ))}
      </nav>
      <div className="mt-6">{tab === 'orders' ? <MyOrders /> : tab === 'addresses' ? <Addresses /> : <Profile />}</div>
    </div>
  );
}

function Profile() {
  const { session } = useAuth();
  const toast = useToast();
  const p = useAsync(() => q<any>(db.from('profiles').select('*').eq('id', session!.user.id).maybeSingle()), [session?.user.id]);
  const [f, setF] = useState<{ full_name: string; phone: string } | null>(null);
  const v = f ?? { full_name: p.data?.full_name ?? '', phone: p.data?.phone ?? '' };
  if (p.loading) return <Loading />;
  return (
    <form className="max-w-md space-y-4" onSubmit={async (e) => {
      e.preventDefault();
      const { error } = await db.from('profiles').upsert({ id: session!.user.id, ...v });
      if (error) toast('error', errorText(error)); else toast('success', 'Profile saved');
    }}>
      <p className="text-sm text-charcoal-400">{session?.user.email}</p>
      <Field label="Name"><Input value={v.full_name} onChange={(e) => setF({ ...v, full_name: e.target.value })} /></Field>
      <Field label="Phone"><Input type="tel" value={v.phone} onChange={(e) => setF({ ...v, phone: e.target.value })} /></Field>
      <div className="flex gap-3"><Button type="submit">Save profile</Button><button type="button" className="inline-flex h-10 items-center text-sm text-charcoal-400 hover:text-navy" onClick={async () => {
        const { error } = await db.auth.resetPasswordForEmail(session!.user.email!, { redirectTo: `${location.origin}/account` });
        if (error) toast('error', errorText(error)); else toast('success', 'We emailed you a link to change your password');
      }}>Change password</button></div>
    </form>
  );
}

function MyOrders() {
  const { add } = useCart();
  const toast = useToast();
  const nav = useNavigate();
  const o = useAsync(async () => { const { data, error } = await db.rpc('my_orders'); if (error) throw error; return data as any[]; });
  if (o.loading) return <Loading />;
  if (o.error) return <ErrorBox message={o.error} onRetry={o.reload} />;
  if (!o.data?.length) return <Empty title="No orders yet" action={<Link className="text-navy underline" to="/shop">Start shopping</Link>}>Orders you place while signed in appear here.</Empty>;
  async function reorder(items: { product_id: string; quantity: number }[]) {
    const { data } = await db.from('storefront_products').select('id,name,price,unit,images,available_qty').in('id', items.map((i) => i.product_id));
    const avail = new Map((data ?? []).map((p) => [p.id, p]));
    let missing = 0;
    for (const i of items) {
      const p = avail.get(i.product_id);
      if (!p) { missing++; continue; }
      add({ product_id: p.id, name: p.name, price: Number(p.price), unit: p.unit, image: p.images?.[0], max: p.available_qty || undefined }, i.quantity);
    }
    toast(missing ? 'info' : 'success', missing ? `${missing} item(s) are no longer available; the rest are in your cart` : 'Added to your cart');
    nav('/cart');
  }
  return (
    <ul className="divide-y divide-kraft-600/20 rounded-lg border border-kraft-600/30 bg-white">
      {o.data.map((r) => (
        <li key={r.reference} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <Link to={`/order-confirmation/${r.reference}?t=${r.access_token}`} className="font-medium text-navy hover:underline">{r.reference}</Link>
            <p className="text-xs text-charcoal-400">{dateOnly(r.created_at)} · {r.item_count} item(s) · {money(r.total)}</p>
          </div>
          <Badge value={r.status} label={CUSTOMER_STATUS_TEXT[r.status]} />
          <Button size="sm" variant="outline" onClick={() => reorder(r.items ?? [])}>Reorder</Button>
        </li>
      ))}
    </ul>
  );
}

function Addresses() {
  const { session } = useAuth();
  const toast = useToast();
  const list = useAsync(() => q<any[]>(db.from('customer_addresses').select('*, institutions(name), hostels(name)').order('created_at')), []);
  const inst = useAsync(() => q<Institution[]>(db.from('institutions').select('*, hostels(*)').eq('is_active', true).order('sort_order')));
  const [edit, setEdit] = useState<any | null>(null);
  const save = async () => {
    const row = { ...edit }; delete row.institutions; delete row.hostels;
    row.user_id = session!.user.id;
    if (row.is_default) await db.from('customer_addresses').update({ is_default: false }).neq('id', row.id ?? '00000000-0000-0000-0000-000000000000');
    const { error } = row.id ? await db.from('customer_addresses').update(row).eq('id', row.id) : await db.from('customer_addresses').insert(row);
    if (error) toast('error', errorText(error)); else { toast('success', 'Address saved'); setEdit(null); void list.reload(); }
  };
  const hostels = inst.data?.find((i) => i.id === edit?.institution_id)?.hostels ?? [];
  return (
    <div>
      {list.loading ? <Loading /> : !list.data?.length ? <Empty title="No saved addresses">Save one here or tick "save these details" at checkout.</Empty> : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.data.map((a) => (
            <li key={a.id} className="rounded-lg border border-kraft-600/30 bg-white p-4 text-sm">
              <p className="font-medium text-charcoal-800">{a.label} {a.is_default && <Badge value="active" label="Default" />}</p>
              <p className="text-charcoal-500">{a.recipient_name} · {a.phone}</p>
              <p className="text-charcoal-500">{a.location_type === 'on_campus' ? [a.institutions?.name, a.hostels?.name, a.room_number && `Room ${a.room_number}`].filter(Boolean).join(', ') : a.address_line}</p>
              <div className="mt-2 flex gap-3">
                <button className="text-navy underline" onClick={() => setEdit(a)}>Edit</button>
                <button className="text-red-700 underline" onClick={async () => { await db.from('customer_addresses').delete().eq('id', a.id); void list.reload(); }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button className="mt-4" variant="outline" onClick={() => setEdit({ label: 'Hostel', recipient_name: '', phone: '', location_type: 'on_campus', is_default: false })}>Add address</Button>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit address' : 'New address'}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save address</Button></>}>
        {edit && (
          <div className="grid gap-3">
            <Field label="Label"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><Input value={edit.recipient_name} onChange={(e) => setEdit({ ...edit, recipient_name: e.target.value })} /></Field>
              <Field label="Phone"><Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            </div>
            <Field label="Where"><Select value={edit.location_type} onChange={(e) => setEdit({ ...edit, location_type: e.target.value })}>
              <option value="on_campus">On campus</option><option value="off_campus">Off campus</option></Select></Field>
            {edit.location_type === 'on_campus' ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Campus"><Select value={edit.institution_id ?? ''} onChange={(e) => setEdit({ ...edit, institution_id: e.target.value || null, hostel_id: null })}>
                  <option value="">Choose</option>{inst.data?.map((i) => <option key={i.id} value={i.id}>{i.short_name ?? i.name}</option>)}</Select></Field>
                <Field label="Hostel"><Select value={edit.hostel_id ?? ''} onChange={(e) => setEdit({ ...edit, hostel_id: e.target.value || null })}>
                  <option value="">Not listed</option>{hostels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</Select></Field>
                <Field label="Room"><Input value={edit.room_number ?? ''} onChange={(e) => setEdit({ ...edit, room_number: e.target.value })} /></Field>
              </div>
            ) : (
              <Field label="Address"><Input value={edit.address_line ?? ''} onChange={(e) => setEdit({ ...edit, address_line: e.target.value })} /></Field>
            )}
            <Checkbox label="Use as default" checked={!!edit.is_default} onChange={(v) => setEdit({ ...edit, is_default: v })} />
          </div>
        )}
      </Modal>
    </div>
  );
}
