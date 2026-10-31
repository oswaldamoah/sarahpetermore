import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useForm, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Minus, Plus, Trash2, Building2, MapPin, Truck, Users } from 'lucide-react';
import { db, flushAlerts } from '@/lib/neon';
import { useCart } from '@/hooks/cart';
import { useAuth } from '@/hooks/auth';
import { useAsync, q } from '@/hooks/useAsync';
import type { Institution, OrderPayload, PublicOrder, Quote } from '@/lib/types';
import { Button, Checkbox, Empty, ErrorBox, Field, Input, Loading, Textarea, useToast } from '@/components/ui';
import { PlainBox, thumb } from '@/components/public/Product';
import { haptic } from '@/lib/haptics';
import { cn, errorText, money } from '@/lib/format';

// ---------------------------------------------------------------- Cart
export function CartPage() {
  const { lines, setQty, remove, subtotal } = useCart();
  if (!lines.length) return (
    <div className="mx-auto max-w-xl px-4 py-16"><Empty title="Your cart is empty" action={<Link to="/shop" className="font-medium text-navy underline">Go to the shop</Link>} /></div>
  );
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-[2.2rem] sm:text-5xl">Your cart</h1>
      <ul className="mt-6 space-y-3">
        {lines.map((l) => (
          <li key={l.product_id} className="rise flex items-center gap-3 rounded-[24px] bg-white p-3 shadow-[0_1px_0_rgba(45,18,51,.06)]">
            {l.image ? <img src={thumb(l.image)} alt="" className="h-[72px] w-[72px] rounded-[18px] bg-cream-100 object-cover" /> : <PlainBox className="h-[72px] w-[72px] rounded-[18px]" />}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 font-semibold leading-tight text-navy">{l.name}</p>
              <p className="mt-0.5 font-serif text-lg font-extrabold text-navy">{money(l.price * l.quantity)}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="flex items-center rounded-full bg-cream-100">
                  <button className="press flex h-9 w-9 items-center justify-center rounded-full text-navy disabled:opacity-30" disabled={l.quantity <= 1} onClick={() => { haptic(); setQty(l.product_id, l.quantity - 1); }} aria-label="Less"><Minus className="h-4 w-4" /></button>
                  <span key={l.quantity} className="pop-in w-7 text-center text-sm font-bold tabular-nums">{l.quantity}</span>
                  <button className="press flex h-9 w-9 items-center justify-center rounded-full text-navy disabled:opacity-30" disabled={!!l.max && l.quantity >= l.max} onClick={() => { haptic(); setQty(l.product_id, l.quantity + 1); }} aria-label="More"><Plus className="h-4 w-4" /></button>
                </div>
                <span className="text-xs text-charcoal-400">{money(l.price)} each</span>
              </div>
            </div>
            <button onClick={() => { haptic(); remove(l.product_id); }} className="press self-start rounded-full p-2 text-charcoal-300 hover:bg-red-50 hover:text-red-700" aria-label={`Remove ${l.name}`}><Trash2 className="h-4 w-4" /></button>
          </li>
        ))}
      </ul>
      <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] mt-6 rounded-[24px] bg-navy p-5 text-white md:static">
        <div className="flex items-baseline justify-between"><span className="text-white/70">Subtotal</span><span className="font-serif text-2xl font-extrabold">{money(subtotal)}</span></div>
        <p className="mt-1 text-xs text-white/60">Delivery is worked out next. You pay when it arrives.</p>
        <Link to="/checkout/location" onClick={() => haptic('success')} className="btn-pop btn-pink mt-4 h-[52px] w-full text-base">Checkout</Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Checkout state
type Loc = { type: 'on_campus' | 'off_campus' | null; institution_id: string | null; hostel_id: string | null; unlisted: boolean };
type Details = { name: string; phone: string; alt_phone?: string; email?: string; room_number?: string; address_line?: string; digital_address?: string; instructions?: string; save?: boolean };
const KEY = 'sp_checkout_v1';
function useCheckoutState() {
  const [state, setState] = useState<{ loc: Loc; details: Partial<Details> }>(() => {
    try { return JSON.parse(sessionStorage.getItem(KEY) ?? '') ; } catch { return { loc: { type: null, institution_id: null, hostel_id: null, unlisted: false }, details: {} }; }
  });
  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } }, [state]);
  return [state, setState] as const;
}

const STEPS = [{ id: 'location', label: 'Location' }, { id: 'delivery', label: 'Delivery details' }, { id: 'review', label: 'Review' }];

export default function Checkout() {
  const { step = 'location' } = useParams();
  const { lines } = useCart();
  const [state, setState] = useCheckoutState();
  if (!lines.length) return <Navigate to="/cart" replace />;
  if (step !== 'location' && !state.loc.type) return <Navigate to="/checkout/location" replace />;
  const idx = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <ol className="mb-8 flex gap-2 text-sm" aria-label="Checkout steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={cn('flex flex-1 flex-col gap-1.5', i <= idx ? 'text-navy' : 'text-charcoal-300')} aria-current={i === idx ? 'step' : undefined}>
            <span className={cn('h-1 rounded-full', i <= idx ? 'bg-navy' : 'bg-charcoal-300/40')} />
            {s.label}
          </li>
        ))}
      </ol>
      {step === 'location' && <LocationStep state={state} setState={setState} />}
      {step === 'delivery' && <DeliveryStep state={state} setState={setState} />}
      {step === 'review' && <ReviewStep state={state} setState={setState} />}
    </div>
  );
}

type StepProps = { state: ReturnType<typeof useCheckoutState>[0]; setState: ReturnType<typeof useCheckoutState>[1] };

function useQuote(hostelId: string | null, enabled = true) {
  const { lines } = useCart();
  const items = useMemo(() => lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })), [lines]);
  return useAsync(async () => {
    if (!enabled) return null;
    const { data, error } = await db.rpc('quote_order', { p_items: items, p_hostel_id: hostelId });
    if (error) throw error;
    return data as Quote;
  }, [JSON.stringify(items), hostelId, enabled]);
}

function DeliveryNotice({ quote, unlisted }: { quote: Quote; unlisted?: boolean }) {
  if (quote.unavailable?.length && !quote.manual_fulfilment) return (
    <ErrorBox message={`Not enough stock: ${quote.unavailable.map((u) => `${u.name} (${u.available} left)`).join(', ')}. Reduce the quantity in your cart or ask us to restock.`} />
  );
  if (quote.delivery_method === 'courier') return (
    <div className="flex gap-3 rounded-[20px] bg-cream-100 p-4 text-sm">
      <Truck className="h-5 w-5 shrink-0 text-kraft-700" aria-hidden />
      <div>
        <p className="font-medium text-charcoal-800">{quote.courier_fallback ? "Your hostel's distributor doesn't have all of this right now" : unlisted ? "We don't have a distributor there yet" : 'Delivered by courier'}</p>
        <p className="mt-0.5 text-charcoal-500">{quote.courier_fallback
          ? "So we'll send your order by courier from our central stock instead. We'll call to confirm timing. If you'd rather wait for the distributor, remove the missing item from your cart."
          : quote.courier_note}</p>
      </div>
    </div>
  );
  return (
    <div className="flex gap-3 rounded-[20px] bg-sage-50 p-4 text-sm">
      <Users className="h-5 w-5 shrink-0 text-sage-800" aria-hidden />
      <div>
        <p className="font-medium text-sage-800">Our distributor at your hostel will bring it</p>
        <p className="mt-0.5 text-charcoal-500">{quote.split ? "It's coming from two of our people nearby — you'll get both numbers." : "You'll get their number as soon as you order."}</p>
      </div>
    </div>
  );
}

function LocationStep({ state, setState }: StepProps) {
  const nav = useNavigate();
  const loc = state.loc;
  const setLoc = (l: Partial<Loc>) => setState((s) => ({ ...s, loc: { ...s.loc, ...l } }));
  const inst = useAsync(() => q<Institution[]>(db.from('institutions').select('*, hostels(*)').eq('is_active', true).order('sort_order')));
  const selected = inst.data?.find((i) => i.id === loc.institution_id);
  const hostels = (selected?.hostels ?? []).filter((h) => h.is_active).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const ready = loc.type === 'off_campus' || (loc.type === 'on_campus' && !!loc.institution_id && (!!loc.hostel_id || loc.unlisted));
  const quote = useQuote(loc.hostel_id, ready);

  return (
    <div>
      <h1 className="text-3xl">Where would you like your order delivered?</h1>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {[{ v: 'on_campus' as const, t: 'On campus', d: 'UPSA or Legon — hostel delivery', I: Building2 },
          { v: 'off_campus' as const, t: 'Off campus', d: 'Anywhere else, by courier', I: MapPin }].map(({ v, t, d, I }) => (
          <button key={v} onClick={() => setLoc({ type: v, ...(v === 'off_campus' ? { institution_id: null, hostel_id: null, unlisted: false } : {}) })}
            className={cn('press flex items-start gap-3 rounded-[22px] border-2 p-4 text-left transition-colors', loc.type === v ? 'border-ember bg-ember-50' : 'border-navy/10 bg-white hover:border-ember/50')}
            aria-pressed={loc.type === v}>
            <I className="mt-0.5 h-5 w-5 text-navy" aria-hidden />
            <span><span className="block font-medium text-charcoal-800">{t}</span><span className="text-sm text-charcoal-400">{d}</span></span>
          </button>
        ))}
      </div>

      {loc.type === 'on_campus' && (
        <div className="mt-8">
          <h2 className="font-sans text-base font-medium text-charcoal-800">Which campus?</h2>
          {inst.loading ? <Loading /> : inst.error ? <ErrorBox message={inst.error} onRetry={inst.reload} /> : (
            <div className="mt-3 flex flex-wrap gap-2">
              {(inst.data ?? []).map((i) => (
                <button key={i.id} onClick={() => setLoc({ institution_id: i.id, hostel_id: null, unlisted: false })}
                  className={cn('rounded-full border px-4 py-2 text-sm', loc.institution_id === i.id ? 'border-navy bg-navy text-cream' : 'border-charcoal-300/70 bg-white text-charcoal-800 hover:border-navy')}>
                  {i.short_name ?? i.name}
                </button>
              ))}
            </div>
          )}
          {selected && (
            <div className="mt-6">
              <h2 className="font-sans text-base font-medium text-charcoal-800">Your hostel</h2>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {hostels.map((h) => (
                  <button key={h.id} onClick={() => setLoc({ hostel_id: h.id, unlisted: false })}
                    className={cn('press rounded-2xl border-2 px-3.5 py-3 text-left text-sm font-medium', loc.hostel_id === h.id ? 'border-navy bg-navy-50 font-medium text-navy' : 'border-charcoal-300/50 bg-white hover:border-navy/50')}>
                    {h.name}
                  </button>
                ))}
                <button onClick={() => setLoc({ hostel_id: null, unlisted: true })}
                  className={cn('press rounded-2xl border-2 border-dashed px-3.5 py-3 text-left text-sm font-medium', loc.unlisted ? 'border-navy bg-navy-50 text-navy' : 'border-charcoal-300 text-charcoal-500 hover:border-navy/50')}>
                  My hostel isn't listed
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {ready && (
        <div className="mt-8">
          {quote.loading ? <Loading label="Checking delivery" /> : quote.error ? <ErrorBox message={quote.error} onRetry={quote.reload} /> :
            quote.data && (quote.data.errors?.length ? <ErrorBox message={quote.data.errors.join('. ')} /> : <DeliveryNotice quote={quote.data} unlisted={loc.unlisted || loc.type === 'off_campus'} />)}
        </div>
      )}

      <div className="mt-8 flex justify-between">
        <Link to="/cart" className="inline-flex h-11 items-center text-sm text-charcoal-500 hover:text-navy">Back to cart</Link>
        <Button size="lg" disabled={!ready || !quote.data?.ok} onClick={() => nav('/checkout/delivery')}>Continue</Button>
      </div>
    </div>
  );
}

const phoneRx = /^[+\d][\d\s-]{8,16}$/;
function detailsSchema(loc: Loc) {
  const needsAddress = loc.type === 'off_campus' || loc.unlisted;
  return z.object({
    name: z.string().trim().min(2, 'Enter your name'),
    phone: z.string().trim().regex(phoneRx, 'Enter a valid phone number'),
    alt_phone: z.string().trim().regex(phoneRx, 'Enter a valid phone number').or(z.literal('')).optional(),
    email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional(),
    room_number: z.string().trim().max(30).optional(),
    address_line: needsAddress ? z.string().trim().min(4, 'Tell us where to deliver') : z.string().optional(),
    digital_address: z.string().trim().max(20).optional(),
    instructions: z.string().trim().max(300).optional(),
    save: z.boolean().optional(),
  });
}

function DeliveryStep({ state, setState }: StepProps) {
  const nav = useNavigate();
  const { session } = useAuth();
  const loc = state.loc;
  const schema = useMemo(() => detailsSchema(loc), [loc]);
  const { register, handleSubmit, formState: { errors }, reset, watch, setValue } = useForm<Details>({ resolver: zodResolver(schema) as unknown as Resolver<Details>, defaultValues: state.details });
  const saved = useAsync(async () => session ? q<any[]>(db.from('customer_addresses').select('*').order('is_default', { ascending: false })) : [], [session?.user.id]);
  const hostelSupported = loc.type === 'on_campus' && !!loc.hostel_id;

  const applySaved = (a: any) => {
    reset({ ...watch(), name: a.recipient_name, phone: a.phone, alt_phone: a.alt_phone ?? '', room_number: a.room_number ?? '', address_line: a.address_line ?? '',
      digital_address: a.digital_address ?? '', instructions: a.instructions ?? '' });
    if (a.location_type !== loc.type || a.hostel_id !== loc.hostel_id) {
      setState((s) => ({ ...s, loc: { type: a.location_type, institution_id: a.institution_id, hostel_id: a.hostel_id, unlisted: a.location_type === 'on_campus' && !a.hostel_id } }));
    }
  };

  return (
    <form onSubmit={handleSubmit((d) => { setState((s) => ({ ...s, details: d })); nav('/checkout/review'); })} noValidate>
      <h1 className="text-3xl">Delivery details</h1>
      {!!saved.data?.length && (
        <div className="mt-5 flex flex-wrap gap-2">
          <span className="w-full text-sm text-charcoal-400">Use a saved address</span>
          {saved.data.map((a) => <button type="button" key={a.id} onClick={() => applySaved(a)} className="rounded-full border border-navy/30 px-3 py-1.5 text-sm text-navy hover:bg-navy-50">{a.label}</button>)}
        </div>
      )}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Your name" error={errors.name?.message}><Input autoComplete="name" {...register('name')} /></Field>
        <Field label="Phone number" error={errors.phone?.message} hint="We call this number when we arrive"><Input type="tel" autoComplete="tel" inputMode="tel" {...register('phone')} /></Field>
        <Field label="Another number (optional)" error={errors.alt_phone?.message}><Input type="tel" inputMode="tel" {...register('alt_phone')} /></Field>
        <Field label="Email (optional)" error={errors.email?.message}><Input type="email" autoComplete="email" {...register('email')} /></Field>
        {hostelSupported && <Field label="Room number" error={errors.room_number?.message} hint="So our distributor can find you"><Input {...register('room_number')} /></Field>}
        {(loc.type === 'off_campus' || loc.unlisted) && (
          <Field className="sm:col-span-2" label={loc.unlisted ? 'Hostel name and where on campus' : 'Delivery address'} error={errors.address_line?.message}>
            <Input autoComplete="street-address" {...register('address_line')} placeholder={loc.unlisted ? 'e.g. TF Hostel, Block B, room 12' : 'Area, street, house number, landmark'} />
          </Field>
        )}
        {loc.type === 'off_campus' && <Field label="Ghana Post digital address (optional)"><Input {...register('digital_address')} placeholder="GA-123-4567" /></Field>}
        <Field className="sm:col-span-2" label="Anything the rider should know? (optional)"><Textarea rows={2} {...register('instructions')} placeholder="e.g. call when at the gate" /></Field>
      </div>
      {session && <div className="mt-4"><Checkbox label="Save these details for next time" checked={!!watch('save')} onChange={(v) => setValue('save', v)} /></div>}
      <div className="mt-8 flex justify-between">
        <Link to="/checkout/location" className="inline-flex h-11 items-center text-sm text-charcoal-500 hover:text-navy">Back</Link>
        <Button size="lg" type="submit">Review order</Button>
      </div>
    </form>
  );
}

function ReviewStep({ state }: StepProps) {
  const nav = useNavigate();
  const toast = useToast();
  const { lines, clear } = useCart();
  const { session } = useAuth();
  const quote = useQuote(state.loc.hostel_id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = state.details as Details;
  const inst = useAsync(async () => {
    const [i, h] = await Promise.all([
      state.loc.institution_id ? db.from('institutions').select('name').eq('id', state.loc.institution_id).maybeSingle() : Promise.resolve({ data: null }),
      state.loc.hostel_id ? db.from('hostels').select('name').eq('id', state.loc.hostel_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    return { institution: (i.data as any)?.name as string | undefined, hostel: (h.data as any)?.name as string | undefined };
  }, [state.loc.institution_id, state.loc.hostel_id]);
  if (!d?.name) return <Navigate to="/checkout/delivery" replace />;

  async function place() {
    setBusy(true); setErr(null);
    const payload: OrderPayload = {
      items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
      customer: { name: d.name, phone: d.phone, alt_phone: d.alt_phone || null, email: d.email || null },
      location: { type: state.loc.type!, institution_id: state.loc.institution_id, hostel_id: state.loc.hostel_id, room_number: d.room_number || null,
        address_line: d.address_line || null, digital_address: d.digital_address || null, instructions: d.instructions || null },
      source: 'web',
    };
    try {
      const { data, error } = await db.rpc('place_order', { p: payload });
      if (error) throw error;
      const order = data as PublicOrder;
      flushAlerts();
      if (d.save && session) {
        await db.from('customer_addresses').insert({ user_id: session.user.id, label: inst.data?.hostel ?? (state.loc.type === 'off_campus' ? 'Home' : 'Campus'),
          recipient_name: d.name, phone: d.phone, alt_phone: d.alt_phone || null, location_type: state.loc.type, institution_id: state.loc.institution_id,
          hostel_id: state.loc.hostel_id, room_number: d.room_number || null, address_line: d.address_line || null, digital_address: d.digital_address || null,
          instructions: d.instructions || null });
      }
      clear();
      sessionStorage.removeItem(KEY);
      nav(`/order-confirmation/${order.reference}?t=${order.access_token}`, { replace: true, state: { order } });
    } catch (e) {
      setErr(errorText(e));
      toast('error', 'Your order was not placed');
      void quote.reload();
    } finally { setBusy(false); }
  }

  const where = state.loc.type === 'on_campus'
    ? [inst.data?.institution, inst.data?.hostel, d.room_number && `Room ${d.room_number}`, d.address_line].filter(Boolean).join(', ')
    : [d.address_line, d.digital_address].filter(Boolean).join(', ');

  return (
    <div>
      <h1 className="text-3xl">Review your order</h1>
      {quote.loading ? <Loading /> : quote.error ? <ErrorBox message={quote.error} onRetry={quote.reload} /> : quote.data && (
        <>
          <div className="mt-6 rounded-[24px] bg-white">
            <ul className="divide-y divide-kraft-600/15 px-4">
              {quote.data.items?.map((i) => (
                <li key={i.product_id} className="flex justify-between gap-4 py-3 text-sm">
                  <span>{i.quantity} × {i.name}</span><span className="tabular-nums">{money(i.line_total)}</span>
                </li>
              ))}
            </ul>
            <div className="space-y-1 border-t border-kraft-600/30 px-4 py-3 text-sm">
              <p className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{money(quote.data.subtotal)}</span></p>
              <p className="flex justify-between"><span>Delivery</span><span className="tabular-nums">{quote.data.delivery_fee > 0 ? money(quote.data.delivery_fee) : 'Free'}</span></p>
              <p className="flex justify-between pt-1 text-base font-semibold text-navy"><span>Total — pay on delivery</span><span className="tabular-nums">{money(quote.data.total)}</span></p>
            </div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg bg-cream-100 p-4 text-sm">
              <p className="text-charcoal-400">Deliver to</p>
              <p className="mt-1 font-medium text-charcoal-800">{d.name} · {d.phone}</p>
              <p className="text-charcoal-500">{where}</p>
              {d.instructions && <p className="mt-1 text-charcoal-400">“{d.instructions}”</p>}
              <Link to="/checkout/delivery" className="mt-2 inline-block text-navy underline">Change</Link>
            </div>
            <DeliveryNotice quote={quote.data} unlisted={state.loc.unlisted || state.loc.type === 'off_campus'} />
          </div>
          {err && <div className="mt-4"><ErrorBox message={err} /></div>}
          <div className="mt-8 flex justify-between">
            <Link to="/checkout/delivery" className="inline-flex h-11 items-center text-sm text-charcoal-500 hover:text-navy">Back</Link>
            <Button size="lg" variant="action" loading={busy} disabled={!quote.data.ok} onClick={place}>Place order</Button>
          </div>
        </>
      )}
    </div>
  );
}
