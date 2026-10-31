import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { useAuth } from '@/hooks/auth';
import { Badge, Button, Checkbox, ErrorBox, Field, Input, Loading, Modal, PageHeader, Pager, Panel, Select, Table, Textarea, useConfirm, useToast } from '@/components/ui';
import { ORDER_STATUSES, dateTime, errorText, humanize, money } from '@/lib/format';
import { CrudTable } from '@/components/admin/Crud';

const PAGE = 25;
const OPEN = ['received', 'confirmed', 'processing', 'ready_for_delivery', 'out_for_delivery', 'failed_delivery'];

export function OrdersPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [f, setF] = useState({ status: 'open', search: '', from: '', to: '', method: '' });
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<string[]>([]);
  const [bulk, setBulk] = useState({ status: 'confirmed', note: '' });
  const [bulkOpen, setBulkOpen] = useState(false);
  const list = useAsync(async () => {
    let query = db.from('orders').select('id,reference,customer_name,phone,status,payment_status,total,delivery_method,hostel_name,institution_name,address_line,created_at,fulfilment_mode', { count: 'exact' })
      .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (f.status === 'open') query = query.in('status', OPEN); else if (f.status) query = query.eq('status', f.status);
    if (f.method) query = query.eq('delivery_method', f.method);
    if (f.from) query = query.gte('created_at', `${f.from}T00:00:00Z`);
    if (f.to) query = query.lte('created_at', `${f.to}T23:59:59Z`);
    if (f.search.trim()) {
      const s = f.search.trim().replace(/[,()]/g, '');
      query = query.or(`reference.ilike.%${s}%,customer_name.ilike.%${s}%,phone.ilike.%${s}%,hostel_name.ilike.%${s}%`);
    }
    const { data, error, count } = await query;
    if (error) throw error;
    return { rows: data ?? [], count: count ?? 0 };
  }, [JSON.stringify(f), page]);

  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void list.reload(); }, 20000);
    return () => clearInterval(t);
  }, [list.reload]);

  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setPage(0); setSel([]); };
  async function applyBulk() {
    const { data, error } = await db.rpc('bulk_update_order_status', { p_orders: sel, p_status: bulk.status, p_note: bulk.note || null });
    if (error) return toast('error', errorText(error));
    toast(data.failed.length ? 'info' : 'success', `${data.updated} updated${data.failed.length ? `, ${data.failed.length} could not be changed` : ''}`);
    setBulkOpen(false); setSel([]); void list.reload();
  }

  return (
    <div>
      <PageHeader title="Orders" description="New orders appear automatically (checked every 20 seconds)." />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
        <Input placeholder="Search reference, name, phone, hostel" value={f.search} onChange={(e) => set('search', e.target.value)} />
        <Select value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="open">Open orders</option><option value="">All statuses</option>
          {ORDER_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </Select>
        <Select value={f.method} onChange={(e) => set('method', e.target.value)} aria-label="Delivery"><option value="">Any delivery</option><option value="distributor">Distributor</option><option value="courier">Courier</option></Select>
        <Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="From" />
        <Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="To" />
      </div>
      {sel.length > 0 && can('manager', 'order_manager') && (
        <div className="mb-3 flex items-center gap-3 rounded-md bg-navy-50 px-3 py-2 text-sm">
          <span>{sel.length} selected</span><Button size="sm" onClick={() => setBulkOpen(true)}>Update status</Button>
          <button className="text-charcoal-400" onClick={() => setSel([])}>Clear</button>
        </div>
      )}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.loading && !list.data ? <Loading /> : (
        <>
          <Table empty={!list.data?.rows.length} head={[
            <input key="all" type="checkbox" className="accent-navy" aria-label="Select all" checked={!!list.data?.rows.length && sel.length === list.data.rows.length}
              onChange={(e) => setSel(e.target.checked ? list.data!.rows.map((r: any) => r.id) : [])} />,
            'Order', 'Customer', 'Where', 'Total', 'Status', 'Payment', 'Placed']}>
            {list.data?.rows.map((o: any) => (
              <tr key={o.id} className="hover:bg-cream-100/40">
                <td className="table-cell"><input type="checkbox" className="accent-navy" aria-label={`Select ${o.reference}`} checked={sel.includes(o.id)} onChange={(e) => setSel(e.target.checked ? [...sel, o.id] : sel.filter((x) => x !== o.id))} /></td>
                <td className="table-cell"><Link to={`/admin/orders/${o.id}`} className="font-medium text-navy hover:underline">{o.reference}</Link>
                  {o.fulfilment_mode === 'split' && <span className="ml-1 text-xs text-ember-700">split</span>}{o.fulfilment_mode === 'manual' && <span className="ml-1 text-xs text-ember-700">needs stock</span>}</td>
                <td className="table-cell">{o.customer_name}<div className="text-xs text-charcoal-400">{o.phone}</div></td>
                <td className="table-cell">{o.hostel_name ?? (o.institution_name ? `${o.institution_name} (unlisted)` : 'Off-campus')}<div className="text-xs"><Badge value={o.delivery_method} /></div></td>
                <td className="table-cell tabular-nums">{money(o.total)}</td>
                <td className="table-cell"><Badge value={o.status} /></td>
                <td className="table-cell"><Badge value={o.payment_status} /></td>
                <td className="table-cell whitespace-nowrap text-charcoal-500">{dateTime(o.created_at)}</td>
              </tr>
            ))}
          </Table>
          <Pager page={page} pageSize={PAGE} total={list.data?.count ?? 0} onPage={setPage} />
        </>
      )}
      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title={`Update ${sel.length} orders`}
        footer={<><Button variant="ghost" onClick={() => setBulkOpen(false)}>Cancel</Button><Button onClick={applyBulk}>Update {sel.length} orders</Button></>}>
        <div className="space-y-3">
          <Field label="New status"><Select value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })}>{ORDER_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
          <Field label="Note (optional)"><Input value={bulk.note} onChange={(e) => setBulk({ ...bulk, note: e.target.value })} /></Field>
          <p className="text-xs text-charcoal-400">Delivered takes the stock out of each distributor. Cancelled puts reserved stock back.</p>
        </div>
      </Modal>
    </div>
  );
}

export function OrderDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const { confirm, dialog } = useConfirm();
  const o = useAsync(async () => {
    const [order, items, hist, asg, refunds, dists] = await Promise.all([
      q<any>(db.from('orders').select('*').eq('id', id!).single()),
      q<any[]>(db.from('order_items').select('*, distributors(name)').eq('order_id', id!).order('product_name')),
      q<any[]>(db.from('order_status_history').select('*').eq('order_id', id!).order('created_at')),
      q<any[]>(db.from('order_fulfilment_assignments').select('*, distributors(name,phone,contact_person)').eq('order_id', id!).neq('status', 'cancelled')),
      can('manager', 'order_manager', 'finance_manager') ? q<any[]>(db.from('refunds').select('*').eq('order_id', id!).order('created_at')) : Promise.resolve([]),
      q<any[]>(db.from('distributors').select('id,name,is_active').eq('is_active', true).order('name')),
    ]);
    return { order, items, hist, asg, refunds, dists };
  }, [id]);
  const [status, setStatus] = useState({ to: '', note: '', payNow: true });
  const [pay, setPay] = useState({ amount: '', method: 'cash' });
  const [refund, setRefund] = useState<{ amount: string; reason: string; method: string; paid: boolean } | null>(null);
  const [assign, setAssign] = useState<{ distributor: string; method: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string> | null>(null);

  if (o.loading && !o.data) return <Loading />;
  if (o.error) return <ErrorBox message={o.error} onRetry={o.reload} />;
  const { order, items, hist, asg, refunds, dists } = o.data!;
  const balance = Number(order.total) - Number(order.amount_paid);
  const run = async (fn: () => PromiseLike<{ error: any }>, ok: string) => {
    const { error } = await fn();
    if (error) toast('error', errorText(error)); else { toast('success', ok); void o.reload(); }
  };

  async function changeStatus() {
    if (!status.to) return;
    const body = status.to === 'delivered' ? `Stock will be taken out of the distributor${balance > 0 && status.payNow ? `, and ${money(balance)} recorded as collected` : ''}.`
      : status.to === 'cancelled' ? 'Reserved stock goes back to the distributor. This cannot be reopened.' : `Move ${order.reference} to ${humanize(status.to)}.`;
    if (!(await confirm(`Mark as ${humanize(status.to)}?`, body, `Mark ${humanize(status.to).toLowerCase()}`, status.to === 'cancelled'))) return;
    const { error } = await db.rpc('update_order_status', { p_order: order.id, p_status: status.to, p_note: status.note || null });
    if (error) return toast('error', errorText(error));
    if (status.to === 'delivered' && status.payNow && balance > 0) {
      const r = await db.rpc('record_order_payment', { p_order: order.id, p_amount: balance, p_method: 'cash', p_note: 'Collected on delivery' });
      if (r.error) toast('error', `Delivered, but payment not recorded: ${errorText(r.error)}`);
    }
    toast('success', `Order marked ${humanize(status.to).toLowerCase()}`);
    setStatus({ to: '', note: '', payNow: true }); void o.reload();
  }

  return (
    <div>
      <PageHeader title={`Order ${order.reference}`} description={`Placed ${dateTime(order.created_at)} · via ${order.source}`}
        actions={<><Badge value={order.status} className="text-sm" /><Badge value={order.payment_status} className="text-sm" /></>} />
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Panel title="Items">
            <div className="-m-4 overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead className="bg-cream-100/60"><tr>{['Product', 'Qty', 'Price', 'Total', 'From', 'Stock'].map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-charcoal-300/25">
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="table-cell">{i.product_name}<div className="text-xs text-charcoal-400">{i.stakeholder_name}{!i.is_platform_owned && ` · partner gets ${money(i.stakeholder_proceeds)}`}</div></td>
                      <td className="table-cell">{i.quantity}</td>
                      <td className="table-cell tabular-nums">{money(i.unit_price)}</td>
                      <td className="table-cell tabular-nums">{money(i.line_total)}</td>
                      <td className="table-cell">{i.distributors?.name ?? <span className="text-ember-700">Not assigned</span>}</td>
                      <td className="table-cell"><Badge value={i.stock_state === 'reserved' ? 'pending' : i.stock_state === 'fulfilled' ? 'paid' : 'inactive'} label={humanize(i.stock_state)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 space-y-0.5 text-right text-sm">
              <p>Subtotal {money(order.subtotal)}{Number(order.delivery_fee) > 0 && ` · Delivery ${money(order.delivery_fee)}`}</p>
              <p className="text-base font-semibold text-navy">Total {money(order.total)}</p>
              <p className="text-charcoal-500">Paid {money(order.amount_paid)}{balance > 0 && <span className="text-ember-700"> · Due {money(balance)}</span>}</p>
            </div>
          </Panel>

          {can('manager', 'order_manager') && (
            <Panel title="Update status">
              <div className="grid gap-3 sm:grid-cols-[1fr_1.5fr_auto] sm:items-end">
                <Field label="New status"><Select value={status.to} onChange={(e) => setStatus({ ...status, to: e.target.value })}>
                  <option value="">Choose…</option>{ORDER_STATUSES.filter((s) => s !== order.status).map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
                <Field label="Reason or note"><Input value={status.note} onChange={(e) => setStatus({ ...status, note: e.target.value })} /></Field>
                <Button onClick={changeStatus} disabled={!status.to}>Update</Button>
              </div>
              {status.to === 'delivered' && balance > 0 && <div className="mt-2"><Checkbox label={`Also record ${money(balance)} collected in cash`} checked={status.payNow} onChange={(v) => setStatus({ ...status, payNow: v })} /></div>}
            </Panel>
          )}

          <Panel title="Status history">
            <ol className="space-y-2 text-sm">
              {hist.map((h) => (
                <li key={h.id} className="flex flex-wrap gap-x-2">
                  <span className="w-32 shrink-0 text-charcoal-400">{dateTime(h.created_at)}</span>
                  <span>{h.from_status ? `${humanize(h.from_status)} → ` : ''}<strong className="font-medium">{humanize(h.to_status)}</strong></span>
                  {h.note && <span className="text-charcoal-500">— {h.note}</span>}
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Customer & delivery" actions={can('manager', 'order_manager') && <button className="text-xs text-navy underline" onClick={() => setNotes({ courier_name: order.courier_name ?? '', courier_phone: order.courier_phone ?? '', courier_tracking: order.courier_tracking ?? '', internal_notes: order.internal_notes ?? '', room_number: order.room_number ?? '', address_line: order.address_line ?? '' })}>Edit</button>}>
            <p className="font-medium">{order.customer_name}</p>
            <a href={`tel:${order.phone}`} className="inline-flex items-center gap-1 text-sm text-navy"><Phone className="h-3 w-3" />{order.phone}</a>
            {order.alt_phone && <p className="text-sm text-charcoal-500">Alt: {order.alt_phone}</p>}
            <p className="mt-2 text-sm">{order.location_type === 'on_campus' ? [order.institution_name, order.hostel_name, order.room_number && `Room ${order.room_number}`].filter(Boolean).join(', ') : 'Off-campus'}</p>
            {order.address_line && <p className="text-sm text-charcoal-500">{order.address_line}{order.digital_address && ` · ${order.digital_address}`}</p>}
            {order.delivery_instructions && <p className="mt-1 text-sm italic text-charcoal-500">“{order.delivery_instructions}”</p>}
            <p className="mt-2 text-sm"><Badge value={order.delivery_method} /> {!order.is_supported_location && order.delivery_method === 'courier' && <span className="text-xs text-charcoal-400">location not served by a distributor</span>}</p>
            {(order.courier_name || order.courier_tracking) && <p className="mt-1 text-sm">Courier: {[order.courier_name, order.courier_phone, order.courier_tracking].filter(Boolean).join(' · ')}</p>}
            {order.internal_notes && <p className="mt-2 rounded bg-cream-100 p-2 text-sm">{order.internal_notes}</p>}
          </Panel>

          <Panel title={order.delivery_method === 'courier' ? 'Stock source' : 'Distributors'} actions={can('manager', 'order_manager', 'inventory_manager') && OPEN.includes(order.status) &&
            <button className="text-xs text-navy underline" onClick={() => setAssign({ distributor: '', method: order.delivery_method })}>Reassign</button>}>
            {asg.length === 0 ? <p className="text-sm text-ember-700">No distributor assigned yet.</p> : (
              <ul className="space-y-2 text-sm">{asg.map((a) => (
                <li key={a.id}><p className="font-medium">{a.distributors?.name}</p><p className="text-charcoal-500">{a.distributors?.contact_person} · <a className="text-navy" href={`tel:${a.distributors?.phone}`}>{a.distributors?.phone}</a> · {humanize(a.status)}</p></li>
              ))}</ul>
            )}
          </Panel>

          {can('manager', 'order_manager', 'finance_manager') && (
            <Panel title="Payments & refunds">
              {balance > 0 && !['cancelled', 'refunded'].includes(order.status) && (
                <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <Field label="Amount"><Input type="number" step="0.01" value={pay.amount} placeholder={balance.toFixed(2)} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
                  <Field label="Method"><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="cash">Cash</option><option value="momo">Mobile Money</option><option value="card">Card</option><option value="bank">Bank</option></Select></Field>
                  <Button onClick={() => run(() => db.rpc('record_order_payment', { p_order: order.id, p_amount: Number(pay.amount || balance), p_method: pay.method }), 'Payment recorded').then(() => setPay({ amount: '', method: 'cash' }))}>Record</Button>
                </div>
              )}
              {Number(order.amount_paid) > 0 && <Button className="mt-3" size="sm" variant="outline" onClick={() => setRefund({ amount: '', reason: '', method: 'momo', paid: true })}>Refund…</Button>}
              {refunds.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">{refunds.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2"><span>{money(r.amount)} · {r.reason}</span>
                    {r.status === 'pending' ? <Button size="sm" variant="outline" onClick={() => run(() => db.rpc('mark_refund_paid', { p_refund: r.id }), 'Refund marked paid')}>Mark paid</Button> : <Badge value={r.status} />}</li>
                ))}</ul>
              )}
            </Panel>
          )}
        </div>
      </div>

      <Modal open={!!assign} onClose={() => setAssign(null)} title="Reassign stock"
        footer={<><Button variant="ghost" onClick={() => setAssign(null)}>Cancel</Button>
          <Button disabled={!assign?.distributor} onClick={() => run(() => db.rpc('assign_order_distributor', { p_order: order.id, p_distributor: assign!.distributor, p_delivery_method: assign!.method }), 'Reassigned').then(() => setAssign(null))}>Reassign all items</Button></>}>
        {assign && <div className="space-y-3">
          <Field label="Distributor" hint="Stock is released from the old distributor and reserved at the new one."><Select value={assign.distributor} onChange={(e) => setAssign({ ...assign, distributor: e.target.value })}>
            <option value="">Choose…</option>{dists.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
          <Field label="Delivered by"><Select value={assign.method} onChange={(e) => setAssign({ ...assign, method: e.target.value })}><option value="distributor">The distributor</option><option value="courier">Courier</option></Select></Field>
        </div>}
      </Modal>

      <Modal open={!!refund} onClose={() => setRefund(null)} title="Record a refund"
        footer={<><Button variant="ghost" onClick={() => setRefund(null)}>Cancel</Button>
          <Button onClick={async () => {
            if (!(await confirm('Record refund?', `${money(refund!.amount)} will be ${refund!.paid ? 'recorded as paid out' : 'logged as pending'}.`, 'Record refund'))) return;
            await run(() => db.rpc('create_refund', { p_order: order.id, p_amount: Number(refund!.amount), p_reason: refund!.reason, p_method: refund!.method, p_paid: refund!.paid }), 'Refund recorded');
            setRefund(null);
          }}>Record refund</Button></>}>
        {refund && <div className="space-y-3">
          <Field label="Amount" hint={`Up to ${money(order.amount_paid)}`}><Input type="number" step="0.01" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></Field>
          <Field label="Reason"><Input value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></Field>
          <Field label="Method"><Select value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}><option value="momo">Mobile Money</option><option value="cash">Cash</option><option value="bank">Bank</option></Select></Field>
          <Checkbox label="Already paid out" checked={refund.paid} onChange={(v) => setRefund({ ...refund, paid: v })} />
        </div>}
      </Modal>

      <Modal open={!!notes} onClose={() => setNotes(null)} title="Delivery details & notes"
        footer={<><Button variant="ghost" onClick={() => setNotes(null)}>Cancel</Button><Button onClick={() => run(() => db.from('orders').update(notes!).eq('id', order.id), 'Saved').then(() => setNotes(null))}>Save</Button></>}>
        {notes && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Room"><Input value={notes.room_number} onChange={(e) => setNotes({ ...notes, room_number: e.target.value })} /></Field>
          <Field label="Address"><Input value={notes.address_line} onChange={(e) => setNotes({ ...notes, address_line: e.target.value })} /></Field>
          <Field label="Courier"><Input value={notes.courier_name} onChange={(e) => setNotes({ ...notes, courier_name: e.target.value })} /></Field>
          <Field label="Courier phone"><Input value={notes.courier_phone} onChange={(e) => setNotes({ ...notes, courier_phone: e.target.value })} /></Field>
          <Field label="Tracking number" className="sm:col-span-2"><Input value={notes.courier_tracking} onChange={(e) => setNotes({ ...notes, courier_tracking: e.target.value })} /></Field>
          <Field label="Internal notes (never shown to customers)" className="sm:col-span-2"><Textarea value={notes.internal_notes} onChange={(e) => setNotes({ ...notes, internal_notes: e.target.value })} /></Field>
        </div>}
      </Modal>
      {dialog}
    </div>
  );
}

export function EnquiriesPage() {
  const [status, setStatus] = useState('open');
  return (
    <div>
      <PageHeader title="Enquiries" description="Customers asking for products you don't have, or have run out of." />
      <CrudTable<any> table="enquiries" title="Enquiries" noun="Enquiry" deps={[status]}
        filter={(qq) => (status ? qq.eq('status', status) : qq)} order={[{ column: 'created_at', ascending: false }]}
        toolbar={<Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status"><option value="">All</option>{['open', 'in_progress', 'resolved', 'closed'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>}
        columns={[
          { label: 'Ref', render: (r) => <span className="font-medium">{r.reference}</span> },
          { label: 'Looking for', render: (r) => <>{r.product_name ?? '—'}{r.quantity && ` × ${r.quantity}`}<div className="max-w-xs truncate text-xs text-charcoal-400">{r.message}</div></> },
          { label: 'Contact', render: (r) => <>{r.customer_name ?? '—'}<div><a className="text-xs text-navy" href={`tel:${r.phone}`}>{r.phone}</a></div></> },
          { label: 'Status', render: (r) => <Badge value={r.status} /> },
          { label: 'Received', render: (r) => dateTime(r.created_at) },
        ]}
        fields={[
          { name: 'status', label: 'Status', type: 'select', options: ['open', 'in_progress', 'resolved', 'closed'].map((s) => ({ value: s, label: humanize(s) })) },
          { name: 'admin_response', label: 'What we told them / next step', type: 'textarea' },
        ]}
        canCreate={false}
      />
    </div>
  );
}
