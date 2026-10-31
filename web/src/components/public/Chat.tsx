import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MessageCircle, Send, X } from 'lucide-react';
import { callApi, db, flushAlerts } from '@/lib/neon';
import { haptic } from '@/lib/haptics';
import { money, errorText, cn } from '@/lib/format';
import { useSettings, contactList } from '@/hooks/settings';
import { useCart } from '@/hooks/cart';
import type { OrderPayload, PublicOrder, Quote } from '@/lib/types';
import { Button } from '@/components/ui';
import { ContactCards } from './Contacts';
import { LogoBadge } from './Logo';

type Draft = { payload: OrderPayload; quote: Quote; institution_name: string | null; hostel_name: string | null };
type Msg = {
  role: 'user' | 'assistant'; content: string;
  draft?: Draft; placed?: PublicOrder; products?: { id: string; name: string; price: number; unit: string; available_qty: number; images?: string[] }[];
};

const SESSION_KEY = 'sp_cs_session';
const HISTORY_KEY = 'sp_cs_history';

function sessionId() {
  try {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(SESSION_KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}

export function ChatPanel({ compact }: { compact?: boolean }) {
  const { s } = useSettings();
  const { add } = useCart();
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; }
  });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-40))); } catch { /* ignore */ }
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, busy]);

  const greeting = `Hi! What do you need, and where should we bring it?`;

  async function send(content: string) {
    const t = content.trim();
    if (!t || busy) return;
    setText('');
    setMsgs((m) => [...m, { role: 'user', content: t }]);
    setBusy(true);
    try {
      const { data, error } = await callApi('customer-assistant', { session_id: sessionId(), message: t });
      if (error) throw error;
      setMsgs((m) => [...m, { role: 'assistant', content: data.reply, draft: data.draft ?? undefined, products: data.products ?? undefined }]);
    } catch {
      const c = contactList(s).map((x) => `${x.label}: ${x.value}`).join(' · ');
      setMsgs((m) => [...m, { role: 'assistant', content: `I can't load right now. You can still order from the shop in a minute${c ? `, or reach us — ${c}` : ''}.` }]);
    } finally { setBusy(false); }
  }

  async function confirm(idx: number, d: Draft) {
    setPlacing(true);
    try {
      const { data, error } = await db.rpc('place_order', { p: d.payload });
      if (error) throw error;
      const order = data as PublicOrder;
      flushAlerts();
      setMsgs((m) => m.map((x, i) => (i === idx ? { ...x, draft: undefined } : x)).concat({
        role: 'assistant', content: `Done — we've received order ${order.reference} and we're processing it now.`, placed: order }));
      void callApi('customer-assistant', { session_id: sessionId(), event: { type: 'order_placed', reference: order.reference } });
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: `That didn't go through: ${errorText(e)}` }]);
    } finally { setPlacing(false); }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', compact ? 'flex-1' : 'h-full rounded-[24px] bg-white')}>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4" aria-live="polite">
        <Bubble role="assistant">{greeting}</Bubble>
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {['Condoms to my hostel', 'Pregnancy tests?', 'Track my order'].map((q) => (
              <button key={q} onClick={() => { haptic(); void send(q); }} className="press rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-navy shadow-[0_1px_0_rgba(45,18,51,.08)] hover:bg-ember-50">{q}</button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className="space-y-2">
            <Bubble role={m.role}>{m.content}</Bubble>
            {m.products && m.products.length > 0 && !m.draft && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {m.products.slice(0, 6).map((p) => (
                  <button key={p.id} onClick={() => add({ product_id: p.id, name: p.name, price: Number(p.price), unit: p.unit, image: p.images?.[0] })}
                    className="press shrink-0 rounded-2xl bg-cream px-3 py-2 text-left text-xs hover:bg-ember-50">
                    <span className="block font-medium text-charcoal-800">{p.name}</span>
                    <span className="text-navy">{money(p.price)}</span> <span className="text-charcoal-400">· add to cart</span>
                  </button>
                ))}
              </div>
            )}
            {m.draft && <DraftCard d={m.draft} busy={placing} onConfirm={() => confirm(i, m.draft!)} />}
            {m.placed && (
              <div className="rounded-[20px] bg-sage-50 p-3 text-sm">
                <p className="font-medium text-sage-800">Order {m.placed.reference} received</p>
                <ContactCards contacts={m.placed.contacts} reference={m.placed.reference} small />
                <Link to={`/order-confirmation/${m.placed.reference}?t=${m.placed.access_token}`} className="mt-2 inline-block text-navy underline">View order</Link>
              </div>
            )}
          </div>
        ))}
        {busy && <Bubble role="assistant"><span className="inline-flex gap-1"><Dot /><Dot d={150} /><Dot d={300} /></span></Bubble>}
        <div ref={end} />
      </div>
      <form className="flex shrink-0 gap-2 border-t border-navy/[.06] bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" onSubmit={(e) => { e.preventDefault(); haptic(); void send(text); }}>
        <label className="sr-only" htmlFor="cs-input">Message</label>
        <input id="cs-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your message" autoComplete="off" enterKeyHint="send"
          className="h-12 min-w-0 flex-1 rounded-full border-2 border-navy/10 bg-cream px-4 text-base focus:border-ember focus:outline-none" maxLength={1200} />
        <button disabled={busy || !text.trim()} className="btn-pop btn-pink h-12 w-12 shrink-0 disabled:opacity-40" aria-label="Send">
          <Send className="h-5 w-5" />
        </button>
      </form>

    </div>
  );
}

function DraftCard({ d, busy, onConfirm }: { d: Draft; busy: boolean; onConfirm: () => void }) {
  const q = d.quote; const l = d.payload.location;
  const where = l.type === 'on_campus'
    ? [d.institution_name, d.hostel_name, l.room_number && `Room ${l.room_number}`, !d.hostel_name && l.address_line].filter(Boolean).join(', ')
    : l.address_line;
  return (
    <div className="rounded-[20px] border-2 border-dashed border-ember/50 bg-ember-50 p-3 text-sm">
      <p className="mb-2 font-medium text-navy">Check your order</p>
      <ul className="space-y-0.5">
        {q.items.map((i) => <li key={i.product_id} className="flex justify-between gap-2"><span>{i.quantity} × {i.name}</span><span>{money(i.line_total)}</span></li>)}
      </ul>
      {q.delivery_fee > 0 && <p className="mt-1 flex justify-between text-charcoal-500"><span>Delivery</span><span>{money(q.delivery_fee)}</span></p>}
      <p className="mt-1 flex justify-between border-t border-ember/30 pt-1 font-semibold"><span>Total (pay on delivery)</span><span>{money(q.total)}</span></p>
      <p className="mt-2 text-charcoal-500">To: {d.payload.customer.name}, {d.payload.customer.phone}<br />{where}</p>
      {q.delivery_method === 'courier' && <p className="mt-1 text-ember-700">{q.courier_note}</p>}
      <Button variant="action" className="mt-3 w-full" loading={busy} onClick={onConfirm}>Confirm order</Button>
      <p className="mt-1 text-center text-xs text-charcoal-400">Need a change? Just type it.</p>
    </div>
  );
}

const Dot = ({ d = 0 }: { d?: number }) => <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-charcoal-300" style={{ animationDelay: `${d}ms` }} />;

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm',
        role === 'user' ? 'rounded-br-sm bg-navy text-cream' : 'rounded-bl-sm bg-cream-100 text-charcoal-800')}>
        {children}
      </div>
    </div>
  );
}

/** Open the chat from anywhere (header link, bottom bar, footer). */
export function openChat() { window.dispatchEvent(new Event('sp:open-chat')); }

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener('sp:open-chat', on);
    return () => window.removeEventListener('sp:open-chat', on);
  }, []);
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', esc); };
  }, [open]);
  if (loc.pathname.startsWith('/customer-service') || loc.pathname.startsWith('/checkout')) return null;
  return (
    <>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Customer service chat" className="page-in fixed inset-0 z-[55] flex h-[100dvh] flex-col bg-cream">
          <div className="shrink-0 bg-ember pt-[env(safe-area-inset-top)] text-navy">
            <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="relative rounded-[15px] bg-white p-[3px]"><LogoBadge className="!rotate-0 !shadow-none" />
                  <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-[#2BD67B] ring-2 ring-ember" aria-hidden /></span>
                <div>
                  <p className="text-lg font-extrabold leading-tight">sarahpetermore</p>
                  <p className="text-xs font-medium text-navy/70">Customer service · 24/7</p>
                </div>
              </div>
              <button onClick={() => { haptic(); setOpen(false); }} aria-label="Close chat" className="press flex h-11 w-11 items-center justify-center rounded-full bg-white/40 hover:bg-white/60"><X className="h-6 w-6" /></button>
            </div>
          </div>
          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col bg-white sm:my-4 sm:overflow-hidden sm:rounded-[24px] sm:shadow-card">
            <ChatPanel compact />
          </div>
        </div>
      )}
      <button onClick={() => { haptic(); setOpen(!open); }} aria-label={open ? 'Close customer service' : 'Open 24/7 customer service'}
        className={cn('btn-pop btn-pink fixed bottom-6 right-6 z-50 h-14 pl-5 pr-6', open ? 'hidden' : 'hidden md:inline-flex')}>
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
        <span className="text-sm">{open ? 'Close' : 'Chat with us'}</span>
      </button>
    </>
  );
}
