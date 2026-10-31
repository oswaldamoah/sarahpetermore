import { useMemo, useState } from 'react';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { db, uploadFile } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { useAuth } from '@/hooks/auth';
import { Badge, Button, Checkbox, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, Textarea, useConfirm, useToast } from '@/components/ui';
import { CrudTable } from '@/components/admin/Crud';
import { cn, dateOnly, dateTime, errorText, humanize, money, todayISO } from '@/lib/format';

const IN_TYPES = ['adjustment_in', 'correction', 'return'];
const OUT_TYPES = ['adjustment_out', 'damaged', 'expired', 'internal_use', 'correction'];

function useStockMeta() {
  return useAsync(async () => ({
    dists: await q<any[]>(db.from('distributors').select('id,name,is_active,is_hub').order('name')),
    prods: await q<any[]>(db.from('products').select('id,name,unit,cost_price').order('name')),
  }));
}

// ---------------------------------------------------------------- Inventory (+/- with confirmation)
type Pending = { product_id: string; distributor_id: string; delta: number; movement_type?: string };

export function InventoryPage() {
  const toast = useToast();
  const { can } = useAuth();
  const meta = useStockMeta();
  const [tab, setTab] = useState<'stock' | 'history'>('stock');
  const [f, setF] = useState({ distributor: '', search: '', low: false });
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [review, setReview] = useState<any[] | null>(null);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assign, setAssign] = useState<{ distributor: string; products: string[] } | null>(null);
  const editable = can('manager', 'inventory_manager');

  const inv = useAsync(async () => {
    let query = db.from('inventory').select('id,product_id,distributor_id,on_hand,reserved,available,updated_at,products!inner(name,unit,low_stock_threshold,cost_price),distributors!inner(name)').order('updated_at', { ascending: false }).limit(2000);
    if (f.distributor) query = query.eq('distributor_id', f.distributor);
    if (f.search) query = query.ilike('products.name', `%${f.search}%`);
    return q<any[]>(query);
  }, [f.distributor, f.search]);
  const rows = useMemo(() => (inv.data ?? [])
    .filter((r) => !f.low || r.available <= (r.products.low_stock_threshold ?? 5))
    .sort((a, b) => a.products.name.localeCompare(b.products.name) || a.distributors.name.localeCompare(b.distributors.name)), [inv.data, f.low]);
  const key = (r: { product_id: string; distributor_id: string }) => `${r.product_id}:${r.distributor_id}`;
  const bump = (r: any, n: number) => setPending((p) => {
    const cur = p[key(r)]?.delta ?? 0;
    const next = cur + n;
    const copy = { ...p };
    if (next === 0) delete copy[key(r)]; else copy[key(r)] = { product_id: r.product_id, distributor_id: r.distributor_id, delta: next, movement_type: p[key(r)]?.movement_type };
    return copy;
  });
  const setDelta = (r: any, v: string) => setPending((p) => {
    const n = parseInt(v || '0', 10); const copy = { ...p };
    if (!n) delete copy[key(r)]; else copy[key(r)] = { product_id: r.product_id, distributor_id: r.distributor_id, delta: n, movement_type: p[key(r)]?.movement_type };
    return copy;
  });
  const setType = (r: any, t: string) => setPending((p) => ({ ...p, [key(r)]: { ...p[key(r)], movement_type: t || undefined } }));
  const changes = Object.values(pending);

  async function openReview() {
    const { data, error } = await db.rpc('preview_stock_adjustments', { p_adjustments: changes });
    if (error) return toast('error', errorText(error));
    setReview(data as any[]);
  }
  async function commit() {
    setBusy(true);
    const { error } = await db.rpc('adjust_stock_batch', { p_adjustments: changes, p_reason: reason || null, p_override: override });
    setBusy(false);
    if (error) return toast('error', errorText(error));
    toast('success', `${changes.length} stock change(s) saved`);
    setPending({}); setReview(null); setReason(''); setOverride(false); void inv.reload();
  }
  async function doAssign() {
    if (!assign?.distributor || !assign.products.length) return;
    const { data, error } = await db.rpc('assign_products_to_distributor', { p_distributor: assign.distributor, p_products: assign.products });
    if (error) return toast('error', errorText(error));
    toast('success', `${data} product(s) added at 0 — use + to set the count`); setAssign(null); void inv.reload();
  }

  return (
    <div className="pb-20">
      <PageHeader title="Inventory" description="Stock is counted per distributor. Use + and −, then review before anything is saved."
        actions={editable && <Button variant="outline" onClick={() => setAssign({ distributor: f.distributor, products: [] })}>Add products to a distributor</Button>} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'stock', label: 'Stock levels' }, { value: 'history', label: 'Movement history' }]} />
      {tab === 'history' ? <MovementHistory dists={meta.data?.dists ?? []} /> : (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Select value={f.distributor} onChange={(e) => setF({ ...f, distributor: e.target.value })} aria-label="Distributor">
              <option value="">All distributors</option>{meta.data?.dists.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_hub ? ' (hub)' : ''}</option>)}</Select>
            <Input placeholder="Search product" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
            <div className="flex items-center"><Checkbox label="Low stock only" checked={f.low} onChange={(v) => setF({ ...f, low: v })} /></div>
          </div>
          {inv.error && <ErrorBox message={inv.error} onRetry={inv.reload} />}
          {inv.loading && !inv.data ? <Loading /> : (
            <Table empty={!rows.length} head={['Product', 'Distributor', 'On hand', 'Held for orders', 'Available', editable ? 'Change' : '', editable ? 'Reason' : '']}>
              {rows.map((r) => {
                const p = pending[key(r)];
                const low = r.available <= (r.products.low_stock_threshold ?? 5);
                return (
                  <tr key={r.id} className={cn(p && 'bg-ember-50/50')}>
                    <td className="table-cell font-medium">{r.products.name}</td>
                    <td className="table-cell">{r.distributors.name}</td>
                    <td className="table-cell tabular-nums">{r.on_hand}{p && <span className="ml-1 text-ember-700">→ {r.on_hand + p.delta}</span>}</td>
                    <td className="table-cell tabular-nums text-charcoal-500">{r.reserved || '—'}</td>
                    <td className={cn('table-cell tabular-nums', low && 'font-medium text-ember-700')}>{r.available}</td>
                    {editable && <td className="table-cell">
                      <div className="flex items-center gap-1">
                        <button className="rounded border border-charcoal-300/60 p-1 hover:bg-cream-100" onClick={() => bump(r, -1)} aria-label={`Decrease ${r.products.name} at ${r.distributors.name}`}><Minus className="h-3.5 w-3.5" /></button>
                        <input className="h-7 w-14 rounded border border-charcoal-300/60 text-center text-sm tabular-nums" value={p?.delta ?? ''} placeholder="0" onChange={(e) => setDelta(r, e.target.value.replace(/[^\d-]/g, ''))} aria-label="Change amount" />
                        <button className="rounded border border-charcoal-300/60 p-1 hover:bg-cream-100" onClick={() => bump(r, 1)} aria-label={`Increase ${r.products.name} at ${r.distributors.name}`}><Plus className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>}
                    {editable && <td className="table-cell">{p && (
                      <select className="h-7 rounded border border-charcoal-300/60 bg-white text-xs" value={p.movement_type ?? ''} onChange={(e) => setType(r, e.target.value)} aria-label="Reason">
                        <option value="">{p.delta > 0 ? 'Adjustment in' : 'Adjustment out'}</option>
                        {(p.delta > 0 ? IN_TYPES : OUT_TYPES).filter((t) => !t.startsWith('adjustment')).map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                      </select>)}</td>}
                  </tr>
                );
              })}
            </Table>
          )}
        </>
      )}

      {changes.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-charcoal-300/40 bg-white px-4 py-3 shadow-[0_-4px_20px_rgba(0,0,0,.06)] lg:pl-64">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
            <span className="text-sm"><strong>{changes.length}</strong> unsaved change{changes.length > 1 ? 's' : ''}</span>
            <div className="flex gap-2"><Button variant="ghost" onClick={() => setPending({})}>Discard</Button><Button variant="action" onClick={openReview}>Review changes</Button></div>
          </div>
        </div>
      )}

      <Modal wide open={!!review} onClose={() => setReview(null)} title="Confirm stock changes"
        footer={<><Button variant="ghost" onClick={() => setReview(null)}>Back</Button>
          <Button loading={busy} disabled={review?.some((r) => r.error && r.error !== 'No change') && !override} onClick={commit}>Save {changes.length} change{changes.length > 1 ? 's' : ''}</Button></>}>
        {review && (
          <div className="space-y-3">
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr>{['Product', 'Distributor', 'Before', 'Change', 'After', 'Type', ''].map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
              <tbody className="divide-y">{review.map((r, i) => (
                <tr key={i} className={r.error && r.error !== 'No change' ? 'bg-red-50' : ''}>
                  <td className="table-cell">{r.product_name}</td><td className="table-cell">{r.distributor_name}</td>
                  <td className="table-cell tabular-nums">{r.before}</td>
                  <td className={cn('table-cell font-medium tabular-nums', r.delta > 0 ? 'text-sage-800' : 'text-ember-700')}>{r.delta > 0 ? `+${r.delta}` : r.delta}</td>
                  <td className="table-cell font-medium tabular-nums">{r.after}</td><td className="table-cell">{humanize(r.movement_type)}</td>
                  <td className="table-cell text-xs text-red-700">{r.error !== 'No change' && r.error}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <Field label="Reason (saved with every change)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Weekly count, Kwame" /></Field>
            {can('super_admin') && review.some((r) => r.error && r.error !== 'No change') && <Checkbox label="Override (allow negative stock) — super admin, needs a reason" checked={override} onChange={setOverride} />}
            <p className="text-xs text-charcoal-400">Each change is recorded permanently in the stock ledger under your name.</p>
          </div>
        )}
      </Modal>

      <Modal open={!!assign} onClose={() => setAssign(null)} title="Add products to a distributor"
        footer={<><Button variant="ghost" onClick={() => setAssign(null)}>Cancel</Button><Button onClick={doAssign} disabled={!assign?.distributor || !assign?.products.length}>Add {assign?.products.length ?? 0} product(s)</Button></>}>
        {assign && <div className="space-y-3">
          <Field label="Distributor"><Select value={assign.distributor} onChange={(e) => setAssign({ ...assign, distributor: e.target.value })}><option value="">Choose…</option>{meta.data?.dists.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
          <div className="max-h-72 space-y-1 overflow-y-auto rounded border p-2">
            {meta.data?.prods.map((p) => <div key={p.id}><Checkbox label={p.name} checked={assign.products.includes(p.id)} onChange={(v) => setAssign({ ...assign, products: v ? [...assign.products, p.id] : assign.products.filter((x) => x !== p.id) })} /></div>)}
          </div>
        </div>}
      </Modal>
    </div>
  );
}

function MovementHistory({ dists }: { dists: any[] }) {
  const [d, setD] = useState('');
  const mv = useAsync(() => {
    let query = db.from('stock_movements').select('*, products(name), distributors(name)').order('created_at', { ascending: false }).limit(300);
    if (d) query = query.eq('distributor_id', d);
    return q<any[]>(query);
  }, [d]);
  return (
    <div>
      <Select className="mb-3 max-w-xs" value={d} onChange={(e) => setD(e.target.value)} aria-label="Distributor"><option value="">All distributors</option>{dists.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
      {mv.loading ? <Loading /> : (
        <Table empty={!mv.data?.length} head={['When', 'Product', 'Distributor', 'Type', 'Change', 'Held', 'On hand after', 'Reason']}>
          {mv.data?.map((m) => (
            <tr key={m.id}>
              <td className="table-cell whitespace-nowrap">{dateTime(m.created_at)}</td><td className="table-cell">{m.products?.name}</td><td className="table-cell">{m.distributors?.name}</td>
              <td className="table-cell">{humanize(m.movement_type)}</td>
              <td className={cn('table-cell tabular-nums', m.quantity > 0 ? 'text-sage-800' : m.quantity < 0 ? 'text-ember-700' : '')}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity || '—'}</td>
              <td className="table-cell tabular-nums text-charcoal-500">{m.reserved_delta ? (m.reserved_delta > 0 ? `+${m.reserved_delta}` : m.reserved_delta) : '—'}</td>
              <td className="table-cell tabular-nums">{m.on_hand_after}</td><td className="table-cell text-charcoal-500">{m.reason}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Line-item editor shared by transfers & restocks
type Line = { product_id: string; quantity: string; unit_cost?: string };
function LineItems({ lines, setLines, prods, withCost, availability }: {
  lines: Line[]; setLines: (l: Line[]) => void; prods: any[]; withCost?: boolean; availability?: Record<string, number>;
}) {
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className={cn('grid items-end gap-2', withCost ? 'grid-cols-[1fr_80px_100px_auto]' : 'grid-cols-[1fr_90px_auto]')}>
          <Field label={i === 0 ? 'Product' : ''}><Select value={l.product_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, product_id: e.target.value, unit_cost: x.unit_cost || String(prods.find((p) => p.id === e.target.value)?.cost_price ?? '') } : x)))}>
            <option value="">Choose…</option>{prods.map((p) => <option key={p.id} value={p.id}>{p.name}{availability ? ` (${availability[p.id] ?? 0} available)` : ''}</option>)}</Select></Field>
          <Field label={i === 0 ? 'Qty' : ''}><Input type="number" min={1} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></Field>
          {withCost && <Field label={i === 0 ? 'Unit cost' : ''}><Input type="number" step="0.01" value={l.unit_cost ?? ''} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_cost: e.target.value } : x)))} /></Field>}
          <button className="mb-2 p-1 text-charcoal-400 hover:text-red-700" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { product_id: '', quantity: '1' }])}><Plus className="h-4 w-4" />Add product</Button>
    </div>
  );
}

// ---------------------------------------------------------------- Transfers
export function TransfersPage() {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const meta = useStockMeta();
  const list = useAsync(() => q<any[]>(db.from('stock_transfers').select('*, src:distributors!stock_transfers_source_distributor_id_fkey(name), dst:distributors!stock_transfers_destination_distributor_id_fkey(name), stock_transfer_items(quantity, products(name))').order('created_at', { ascending: false }).limit(200)));
  const [form, setForm] = useState<{ src: string; dst: string; notes: string; lines: Line[]; receiveNow: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const srcStock = useAsync(async () => {
    if (!form?.src) return {} as Record<string, number>;
    const d = await q<any[]>(db.from('inventory').select('product_id,available').eq('distributor_id', form.src));
    return Object.fromEntries(d.map((x) => [x.product_id, x.available])) as Record<string, number>;
  }, [form?.src]);

  async function submit() {
    if (!form) return;
    const items = form.lines.filter((l) => l.product_id && Number(l.quantity) > 0).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) }));
    if (!form.src || !form.dst || !items.length) return toast('error', 'Choose both distributors and at least one product');
    const name = (id: string) => meta.data?.dists.find((d) => d.id === id)?.name;
    const pname = (id: string) => meta.data?.prods.find((p) => p.id === id)?.name;
    const ok = await confirm('Confirm transfer', (
      <div className="space-y-2">
        <table className="w-full text-sm"><thead><tr>{['Product', 'Qty', `${name(form.src)} after`, `${name(form.dst)} after`].map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
          <tbody>{items.map((i) => <tr key={i.product_id}><td className="table-cell">{pname(i.product_id)}</td><td className="table-cell">{i.quantity}</td>
            <td className="table-cell">{(srcStock.data?.[i.product_id] ?? 0) - i.quantity}</td><td className="table-cell">{form.receiveNow ? `+${i.quantity}` : 'on arrival'}</td></tr>)}</tbody></table>
        <p className="text-xs text-charcoal-400">{form.receiveNow ? 'Stock moves immediately.' : 'Stock leaves the source now and is added to the destination when you mark it received.'}</p>
      </div>), form.receiveNow ? 'Move stock now' : 'Send transfer');
    if (!ok) return;
    setBusy(true);
    const { data, error } = await db.rpc('create_transfer', { p: { source_distributor_id: form.src, destination_distributor_id: form.dst, notes: form.notes, items, dispatch: true, receive: form.receiveNow } });
    setBusy(false);
    if (error) return toast('error', errorText(error));
    toast('success', `Transfer ${data.reference} ${form.receiveNow ? 'completed' : 'sent'}`); setForm(null); void list.reload();
  }
  const act = async (fn: string, id: string, msg: string) => {
    const { error } = await db.rpc(fn, fn === 'cancel_transfer' ? { p_id: id, p_reason: 'Cancelled from admin' } : { p_id: id });
    if (error) toast('error', errorText(error)); else { toast('success', msg); void list.reload(); }
  };

  return (
    <div>
      <PageHeader title="Transfers" description="Move stock between distributors. Stock is only added at the destination once received."
        actions={<Button onClick={() => setForm({ src: '', dst: '', notes: '', lines: [{ product_id: '', quantity: '1' }], receiveNow: true })}><Plus className="h-4 w-4" />Move stock</Button>} />
      {list.loading ? <Loading /> : (
        <Table empty={!list.data?.length} head={['Ref', 'From', 'To', 'Items', 'Status', 'Created', '']}>
          {list.data?.map((t) => (
            <tr key={t.id}>
              <td className="table-cell font-medium">{t.reference}</td><td className="table-cell">{t.src?.name}</td><td className="table-cell">{t.dst?.name}</td>
              <td className="table-cell text-xs">{t.stock_transfer_items.map((i: any) => `${i.quantity} × ${i.products?.name}`).join(', ')}</td>
              <td className="table-cell"><Badge value={t.status} /></td><td className="table-cell whitespace-nowrap">{dateTime(t.created_at)}</td>
              <td className="table-cell whitespace-nowrap text-right">
                {t.status === 'in_transit' && <Button size="sm" onClick={() => act('receive_transfer', t.id, 'Marked received')}>Mark received</Button>}
                {['draft', 'in_transit'].includes(t.status) && <Button size="sm" variant="ghost" onClick={async () => (await confirm('Cancel transfer?', 'Stock in transit goes back to the source.', 'Cancel transfer', true)) && act('cancel_transfer', t.id, 'Transfer cancelled')}>Cancel</Button>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Modal wide open={!!form} onClose={() => setForm(null)} title="Move stock"
        footer={<><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy} onClick={submit}>Review transfer</Button></>}>
        {form && meta.data && <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From"><Select value={form.src} onChange={(e) => setForm({ ...form, src: e.target.value })}><option value="">Choose…</option>{meta.data.dists.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
            <Field label="To"><Select value={form.dst} onChange={(e) => setForm({ ...form, dst: e.target.value })}><option value="">Choose…</option>{meta.data.dists.filter((d) => d.id !== form.src).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
          </div>
          <LineItems lines={form.lines} setLines={(lines) => setForm({ ...form, lines })} prods={meta.data.prods} availability={form.src ? srcStock.data ?? {} : undefined} />
          <Field label="Notes"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" className="accent-navy" checked={form.receiveNow} onChange={() => setForm({ ...form, receiveNow: true })} />Handed over now</label>
            <label className="flex items-center gap-2"><input type="radio" className="accent-navy" checked={!form.receiveNow} onChange={() => setForm({ ...form, receiveNow: false })} />Send — confirm receipt later</label>
          </div>
        </div>}
      </Modal>
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------- Restocks
export function RestocksPage() {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const meta = useStockMeta();
  const list = useAsync(() => q<any[]>(db.from('restocks').select('*, distributors(name), restock_items(quantity, unit_cost, products(name))').order('created_at', { ascending: false }).limit(200)));
  const [form, setForm] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const blank = () => ({ distributor_id: '', supplier: '', restock_date: todayISO(), payment_status: 'paid', payment_method: 'momo', notes: '', reference: '', update_cost_price: true, lines: [{ product_id: '', quantity: '1', unit_cost: '' }], receipt: null as File | null });

  async function submit() {
    const items = form.lines.filter((l: Line) => l.product_id && Number(l.quantity) > 0).map((l: Line) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost || 0) }));
    if (!form.distributor_id || !items.length) return toast('error', 'Choose the distributor and at least one product');
    const current = await q<any[]>(db.from('inventory').select('product_id,on_hand').eq('distributor_id', form.distributor_id));
    const before = (pid: string) => current.find((c) => c.product_id === pid)?.on_hand ?? 0;
    const total = items.reduce((s: number, i: any) => s + i.quantity * i.unit_cost, 0);
    const ok = await confirm('Confirm restock', (
      <div className="space-y-2">
        <table className="w-full text-sm"><thead><tr>{['Product', 'Before', 'Adding', 'After', 'Cost'].map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
          <tbody>{items.map((i: any) => <tr key={i.product_id}><td className="table-cell">{meta.data?.prods.find((p) => p.id === i.product_id)?.name}</td>
            <td className="table-cell">{before(i.product_id)}</td><td className="table-cell text-sage-800">+{i.quantity}</td><td className="table-cell font-medium">{before(i.product_id) + i.quantity}</td><td className="table-cell">{money(i.quantity * i.unit_cost)}</td></tr>)}</tbody></table>
        <p className="text-sm">Total {money(total)} · {form.payment_status === 'paid' ? 'recorded as paid out now' : 'recorded as unpaid (no cash out yet)'}</p>
      </div>), 'Record restock');
    if (!ok) return;
    setBusy(true);
    let receipt_url: string | null = null;
    if (form.receipt) {
      try { receipt_url = await uploadFile(form.receipt, 'receipt'); }
      catch (e) { toast('error', `Receipt not uploaded: ${errorText(e)}`); }
    }
    const { data, error } = await db.rpc('record_restock', { p: { ...form, lines: undefined, receipt: undefined, receipt_url, items } });
    setBusy(false);
    if (error) return toast('error', errorText(error));
    toast('success', `Restock ${data.reference} recorded`); setForm(null); void list.reload();
  }

  return (
    <div>
      <PageHeader title="Restocks" description="New stock in. Each restock adds stock and records the purchase once." actions={<Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" />Record restock</Button>} />
      {list.loading ? <Loading /> : (
        <Table empty={!list.data?.length} head={['Ref', 'Date', 'Distributor', 'Supplier', 'Items', 'Total', 'Payment', '']}>
          {list.data?.map((r) => (
            <tr key={r.id}>
              <td className="table-cell font-medium">{r.reference}</td><td className="table-cell">{dateOnly(r.restock_date)}</td><td className="table-cell">{r.distributors?.name}</td><td className="table-cell">{r.supplier ?? '—'}</td>
              <td className="table-cell text-xs">{r.restock_items.map((i: any) => `${i.quantity} × ${i.products?.name}`).join(', ')}</td>
              <td className="table-cell tabular-nums">{money(r.total_cost)}</td><td className="table-cell"><Badge value={r.payment_status} /></td>
              <td className="table-cell text-right">{r.payment_status !== 'paid' && <Button size="sm" variant="outline" onClick={async () => {
                if (!(await confirm('Mark restock paid?', `${money(r.total_cost)} will be recorded as cash out today.`, 'Mark paid'))) return;
                const { error } = await db.rpc('mark_restock_paid', { p_id: r.id }); if (error) toast('error', errorText(error)); else { toast('success', 'Marked paid'); void list.reload(); }
              }}>Mark paid</Button>}</td>
            </tr>
          ))}
        </Table>
      )}
      <Modal wide open={!!form} onClose={() => setForm(null)} title="Record restock"
        footer={<><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button><Button loading={busy} onClick={submit}>Review restock</Button></>}>
        {form && meta.data && <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Receiving distributor"><Select value={form.distributor_id} onChange={(e) => setForm({ ...form, distributor_id: e.target.value })}><option value="">Choose…</option>{meta.data.dists.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
            <Field label="Supplier"><Input value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} /></Field>
            <Field label="Date"><Input type="date" value={form.restock_date} onChange={(e) => setForm({ ...form, restock_date: e.target.value })} /></Field>
            <Field label="Payment"><Select value={form.payment_status} onChange={(e) => setForm({ ...form, payment_status: e.target.value })}><option value="paid">Paid</option><option value="unpaid">Not paid yet</option></Select></Field>
            <Field label="Method"><Select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}><option value="momo">Mobile Money</option><option value="cash">Cash</option><option value="bank">Bank</option></Select></Field>
            <Field label="Supplier ref (optional)"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
          </div>
          <LineItems withCost lines={form.lines} setLines={(lines) => setForm({ ...form, lines })} prods={meta.data.prods} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Receipt (optional)"><Input type="file" accept="image/*,application/pdf" onChange={(e) => setForm({ ...form, receipt: e.target.files?.[0] ?? null })} /></Field>
            <Field label="Notes"><Textarea rows={1} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          </div>
          <Checkbox label="Update each product's cost price to this unit cost" checked={form.update_cost_price} onChange={(v) => setForm({ ...form, update_cost_price: v })} />
        </div>}
      </Modal>
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------- Distributors
export function DistributorsPage() {
  const toast = useToast();
  const insts = useAsync(() => q<any[]>(db.from('institutions').select('id,name,short_name,hostels(id,name,is_active)').order('sort_order')));
  const [areas, setAreas] = useState<{ id: string; name: string; hostels: string[]; reload: () => void } | null>(null);
  return (
    <div>
      <PageHeader title="Distributors" description="The people holding your stock. A distributor can serve many hostels, and a hostel can have several distributors." />
      <CrudTable<any> table="distributors" title="Distributors" noun="Distributor" select="*, distributor_service_areas(hostel_id, hostels(name)), inventory(on_hand)" order={[{ column: 'name' }]}
        transform={(v) => { delete v.distributor_service_areas; delete v.inventory; return v; }}
        columns={[
          { label: 'Name', render: (r) => <><span className="font-medium">{r.name}</span>{r.is_hub && <span className="ml-1 text-xs text-kraft-700">hub</span>}</> },
          { label: 'Contact', render: (r) => <>{r.contact_person}<div className="text-xs text-charcoal-400">{r.phone}</div></> },
          { label: 'Serves', render: (r) => <span className="text-xs">{r.distributor_service_areas.map((a: any) => a.hostels?.name).join(', ') || (r.is_hub ? 'Courier orders' : '—')}</span> },
          { label: 'Units', render: (r) => r.inventory.reduce((s: number, i: any) => s + i.on_hand, 0) },
          { label: 'Status', render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> },
        ]}
        rowActions={(r, reload) => <button className="mx-1 text-xs text-navy underline" onClick={() => setAreas({ id: r.id, name: r.name, hostels: r.distributor_service_areas.map((a: any) => a.hostel_id), reload })}>Hostels</button>}
        fields={[
          { name: 'name', label: 'Name', required: true }, { name: 'contact_person', label: 'Contact person' },
          { name: 'phone', label: 'Phone (shown to customers after ordering)' }, { name: 'alt_phone', label: 'Other phone' },
          { name: 'is_active', label: 'Active — receives new orders', type: 'checkbox', default: true },
          { name: 'is_hub', label: 'Central hub — supplies courier orders', type: 'checkbox', default: false },
          { name: 'notes', label: 'Notes', type: 'textarea' },
        ]} />
      <Modal wide open={!!areas} onClose={() => setAreas(null)} title={`Hostels served by ${areas?.name}`}
        footer={<><Button variant="ghost" onClick={() => setAreas(null)}>Cancel</Button><Button onClick={async () => {
          const { error } = await db.rpc('set_distributor_service_areas', { p_distributor: areas!.id, p_hostels: areas!.hostels });
          if (error) toast('error', errorText(error)); else { toast('success', 'Service areas saved'); areas!.reload(); setAreas(null); }
        }}>Save hostels</Button></>}>
        {areas && insts.data?.map((i) => (
          <div key={i.id} className="mb-4">
            <p className="mb-1 text-sm font-medium">{i.short_name ?? i.name}</p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {i.hostels.map((h: any) => <Checkbox key={h.id} label={h.name} checked={areas.hostels.includes(h.id)} onChange={(v) => setAreas({ ...areas, hostels: v ? [...areas.hostels, h.id] : areas.hostels.filter((x) => x !== h.id) })} />)}
              {!i.hostels.length && <p className="text-xs text-charcoal-400">No hostels yet — add them in Locations.</p>}
            </div>
          </div>
        ))}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------- Locations
export function LocationsPage() {
  const insts = useAsync(() => q<any[]>(db.from('institutions').select('id,name,short_name').order('sort_order')));
  const [inst, setInst] = useState('');
  const current = inst || insts.data?.[0]?.id || '';
  return (
    <div className="space-y-8">
      <div>
        <PageHeader title="Campuses" description="Customers choose a campus, then a hostel. Hostels without a distributor get courier delivery." />
        <CrudTable<any> table="institutions" title="Campuses" noun="Campus" order={[{ column: 'sort_order' }]} canDelete
          columns={[{ label: 'Name', render: (r) => r.name }, { label: 'Short name', render: (r) => r.short_name }, { label: 'Status', render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> }]}
          fields={[{ name: 'name', label: 'Name', required: true }, { name: 'short_name', label: 'Short name (shown on buttons)' }, { name: 'sort_order', label: 'Position', type: 'number', default: 9 }, { name: 'is_active', label: 'Active', type: 'checkbox', default: true }]} />
      </div>
      <div>
        <PageHeader title="Hostels" />
        <CrudTable<any> table="hostels" title="Hostels" noun="Hostel" canDelete deps={[current]} select="*, distributor_service_areas(distributor_id)"
          filter={(qq) => qq.eq('institution_id', current)} order={[{ column: 'sort_order' }, { column: 'name' }]}
          transform={(v) => { delete v.distributor_service_areas; return { ...v, institution_id: current }; }}
          toolbar={<Select className="w-60" value={current} onChange={(e) => setInst(e.target.value)} aria-label="Campus">{insts.data?.map((i) => <option key={i.id} value={i.id}>{i.short_name ?? i.name}</option>)}</Select>}
          columns={[
            { label: 'Hostel', render: (r) => r.name },
            { label: 'Delivery', render: (r) => r.distributor_service_areas.length ? <Badge value="distributor" label={`${r.distributor_service_areas.length} distributor(s)`} /> : <Badge value="courier" label="Courier" /> },
            { label: 'Status', render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> },
          ]}
          fields={[{ name: 'name', label: 'Hostel name', required: true }, { name: 'sort_order', label: 'Position', type: 'number', default: 0 }, { name: 'is_active', label: 'Active', type: 'checkbox', default: true }]} />
      </div>
    </div>
  );
}
