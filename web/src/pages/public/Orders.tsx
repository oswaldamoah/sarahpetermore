import { useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { db, flushAlerts } from '@/lib/neon';
import { useAsync } from '@/hooks/useAsync';
import type { PublicOrder } from '@/lib/types';
import { Button, ErrorBox, Field, Input, Loading, Textarea, useToast } from '@/components/ui';
import { ContactCards } from '@/components/public/Contacts';
import { ChatPanel } from '@/components/public/Chat';
import { useSettings, contactList } from '@/hooks/settings';
import { CUSTOMER_STATUS_TEXT, cn, dateTime, errorText, money } from '@/lib/format';

const FLOW = ['received', 'confirmed', 'processing', 'out_for_delivery', 'delivered'];

export function OrderSummary({ o }: { o: PublicOrder }) {
  const reached = new Set(o.timeline.map((t) => t.status));
  const ended = ['cancelled', 'refunded', 'returned', 'refund_pending', 'failed_delivery'].includes(o.status);
  const where = o.location_type === 'on_campus'
    ? [o.institution_name, o.hostel_name, o.room_number && `Room ${o.room_number}`, !o.hostel_name && o.address_line].filter(Boolean).join(', ')
    : o.address_line;
  return (
    <div className="space-y-6">
      <div className="rounded-[24px] bg-white p-5">
        <p className="text-sm text-charcoal-400">Status</p>
        <p className="font-serif text-xl text-navy">{CUSTOMER_STATUS_TEXT[o.status] ?? o.status}</p>
        {!ended && (
          <ol className="mt-4 grid grid-cols-5 gap-1 text-[11px] text-charcoal-400 sm:text-xs" aria-label="Order progress">
            {FLOW.map((s) => {
              const done = reached.has(s) || FLOW.indexOf(o.status) >= FLOW.indexOf(s);
              return (
                <li key={s} className="flex flex-col gap-1.5">
                  <span className={cn('h-1.5 rounded-full', done ? 'bg-sage-700' : 'bg-charcoal-300/40')} />
                  <span className={done ? 'text-sage-800' : ''}>{CUSTOMER_STATUS_TEXT[s]}</span>
                </li>
              );
            })}
          </ol>
        )}
        {o.courier && (o.courier.name || o.courier.tracking) && (
          <p className="mt-3 text-sm text-charcoal-500">Courier: {[o.courier.name, o.courier.phone, o.courier.tracking && `tracking ${o.courier.tracking}`].filter(Boolean).join(' · ')}</p>
        )}
      </div>
      <div>
        <h2 className="mb-2 font-sans text-base font-medium text-charcoal-800">Who to call</h2>
        <ContactCards contacts={o.contacts} reference={o.reference} />
      </div>
      <div className="rounded-[24px] bg-white px-1">
        <ul className="divide-y divide-kraft-600/15 px-4">
          {o.items.map((i) => <li key={i.product_id} className="flex justify-between py-2.5 text-sm"><span>{i.quantity} × {i.name}</span><span className="tabular-nums">{money(i.line_total)}</span></li>)}
        </ul>
        <div className="border-t border-kraft-600/30 px-4 py-3 text-sm">
          {o.delivery_fee > 0 && <p className="flex justify-between"><span>Delivery</span><span>{money(o.delivery_fee)}</span></p>}
          <p className="flex justify-between font-semibold text-navy"><span>Total{o.amount_paid < o.total ? ' — pay on delivery' : ''}</span><span>{money(o.total)}</span></p>
        </div>
      </div>
      <div className="text-sm text-charcoal-500">
        <p>{o.delivery_method === 'courier' ? 'Delivery by courier' : 'Delivered by our campus distributor'} to {o.customer_name} ({o.phone_masked})</p>
        <p>{where}</p>
        <p className="mt-1 text-charcoal-400">Placed {dateTime(o.created_at)}</p>
      </div>
    </div>
  );
}

export function OrderConfirmation() {
  const { reference } = useParams();
  const [params] = useSearchParams();
  const loc = useLocation();
  const initial = (loc.state as { order?: PublicOrder } | null)?.order;
  const o = useAsync(async () => {
    if (initial) return initial;
    const { data, error } = await db.rpc('get_order_by_token', { p_reference: reference, p_token: params.get('t') });
    if (error) throw error;
    return data as PublicOrder;
  }, [reference]);
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      {o.loading ? <Loading /> : o.error ? (
        <><ErrorBox message="We couldn't open this order link. Track it with your reference and phone number instead." />
          <Link to="/track-order" className="mt-4 inline-block text-navy underline">Track order</Link></>
      ) : o.data && (
        <>
          <div className="flex items-start gap-4">
            <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sage text-sage-800"><Check className="h-5 w-5" /></span>
            <div>
              <h1 className="text-3xl">We've received your order</h1>
              <p className="mt-1 text-charcoal-500">Keep this reference to track it.</p>
            </div>
          </div>
          <div className="pop-in my-6 inline-block -rotate-2 rounded-2xl bg-ember px-5 py-2.5 font-serif text-3xl font-extrabold tracking-wide text-navy shadow-[0_4px_0_0_#E0448F]">{o.data.reference}</div>
          <OrderSummary o={o.data} />
        </>
      )}
    </div>
  );
}

export function TrackOrder() {
  const [ref, setRef] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [order, setOrder] = useState<PublicOrder | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const { data, error } = await db.rpc('track_order', { p_reference: ref, p_phone: phone });
    setBusy(false);
    if (error) { setErr(errorText(error)); setOrder(null); } else setOrder(data as PublicOrder);
  }
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl">Track your order</h1>
      <p className="mt-1 text-charcoal-500">Enter your order reference and the phone number you ordered with.</p>
      <form onSubmit={go} className="mt-6 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Order reference"><Input value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} placeholder="SP-XXXXXX" required /></Field>
        <Field label="Phone number"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required /></Field>
        <Button type="submit" loading={busy} size="lg">Track</Button>
      </form>
      {err && <div className="mt-4"><ErrorBox message={err} /></div>}
      {order && <div className="mt-8"><p className="mb-3 font-serif text-xl text-navy">{order.reference}</p><OrderSummary o={order} /></div>}
    </div>
  );
}

export function Enquiries() {
  const [params] = useSearchParams();
  const toast = useToast();
  const [f, setF] = useState({ name: '', phone: '', product_name: params.get('product') ?? '', quantity: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const { data, error } = await db.rpc('create_enquiry', { p: f });
    setBusy(false);
    if (error) toast('error', errorText(error)); else { setDone(data.reference); flushAlerts(); }
  }
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-3xl">Looking for something we don't have?</h1>
      <p className="mt-1 text-charcoal-500">Tell us and we'll get back to you on the number you give.</p>
      {done ? (
        <div className="mt-6 rounded-[24px] bg-sage-50 p-5">
          <p className="font-medium text-sage-800">Got it — enquiry {done}</p>
          <p className="mt-1 text-sm text-charcoal-500">We'll call or message you soon.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="What are you looking for?"><Input value={f.product_name} onChange={set('product_name')} required /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name (optional)"><Input value={f.name} onChange={set('name')} /></Field>
            <Field label="Phone number"><Input type="tel" value={f.phone} onChange={set('phone')} required /></Field>
          </div>
          <Field label="How many? (optional)"><Input type="number" min={1} value={f.quantity} onChange={set('quantity')} /></Field>
          <Field label="Anything else (optional)"><Textarea value={f.message} onChange={set('message')} /></Field>
          <Button type="submit" size="lg" loading={busy}>Send enquiry</Button>
        </form>
      )}
    </div>
  );
}

export function CustomerService() {
  const { s } = useSettings();
  const contacts = contactList(s);
  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-8 md:grid-cols-[1.6fr_1fr]">
      <div className="flex h-[min(78vh,720px)] flex-col">
        <h1 className="mb-4 text-3xl">24/7 Customer service</h1>
        <div className="min-h-0 flex-1"><ChatPanel /></div>
      </div>
      <aside className="space-y-4 md:pt-16">
        <div className="rounded-[24px] bg-white p-5">
          <h2 className="font-sans text-base font-medium text-charcoal-800">Order in chat</h2>
          <p className="mt-1 text-sm text-charcoal-500">Tell us what you need and where. You confirm before anything is ordered.</p>
        </div>
        {contacts.length > 0 && (
          <div className="rounded-[24px] bg-white p-5">
            <h2 className="font-sans text-base font-medium text-charcoal-800">Also on</h2>
            <ul className="mt-2 space-y-1.5 text-sm">{contacts.map((c) => <li key={c.label}><a className="text-navy hover:underline" href={c.href}>{c.label}: {c.value}</a></li>)}</ul>
          </div>
        )}
      </aside>
    </div>
  );
}
