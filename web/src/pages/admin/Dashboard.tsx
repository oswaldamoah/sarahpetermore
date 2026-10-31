import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { useAuth } from '@/hooks/auth';
import { Badge, ErrorBox, Field, Input, Loading, PageHeader, Panel, Select, Stat, Table, Tabs } from '@/components/ui';
import { daysAgoISO, dateTime, money, todayISO } from '@/lib/format';
import { downloadFile, toCSV } from '@/lib/csv';

export const SERIES_IN = '#3949AB';
export const SERIES_OUT = '#E65100';
const axis = { fontSize: 12, fill: '#757575' };

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const presets = [{ l: 'Today', d: 0 }, { l: '7 days', d: 6 }, { l: '30 days', d: 29 }, { l: '90 days', d: 89 }, { l: 'Year', d: 364 }];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {presets.map((p) => (
        <button key={p.l} onClick={() => onChange(daysAgoISO(p.d), todayISO())}
          className={`rounded-full px-3 py-1 text-xs ${from === daysAgoISO(p.d) && to === todayISO() ? 'bg-navy text-cream' : 'bg-white text-charcoal-500 ring-1 ring-charcoal-300/50 hover:text-navy'}`}>{p.l}</button>
      ))}
      <div className="w-36"><Input type="date" className="h-8 text-xs" value={from} onChange={(e) => onChange(e.target.value, to)} aria-label="From" /></div>
      <div className="w-36"><Input type="date" className="h-8 text-xs" value={to} onChange={(e) => onChange(from, e.target.value)} aria-label="To" /></div>
    </div>
  );
}

export function DashboardPage() {
  const { can } = useAuth();
  const [r, setR] = useState({ from: daysAgoISO(29), to: todayISO() });
  const stats = useAsync(async () => { const { data, error } = await db.rpc('dashboard_stats', { p_from: r.from, p_to: r.to }); if (error) throw error; return data as any; }, [r.from, r.to]);
  const recent = useAsync(() => can('manager', 'order_manager', 'finance_manager', 'inventory_manager')
    ? q<any[]>(db.from('orders').select('id,reference,customer_name,status,total,hostel_name,delivery_method,created_at').order('created_at', { ascending: false }).limit(8)) : Promise.resolve([]));
  const low = useAsync(() => q<any[]>(db.from('inventory').select('available,on_hand,products!inner(name,low_stock_threshold,is_active),distributors(name)').order('available').limit(60)));
  const lowRows = (low.data ?? []).filter((i) => i.products.is_active && i.available <= (i.products.low_stock_threshold ?? 5)).slice(0, 8);
  const s = stats.data; const fin = s?.finance;

  return (
    <div>
      <PageHeader title="Dashboard" actions={<DateRange from={r.from} to={r.to} onChange={(from, to) => setR({ from, to })} />} />
      {stats.error && <ErrorBox message={stats.error} onRetry={stats.reload} />}
      {stats.loading && !s ? <Loading /> : s && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Open orders (all time)" value={s.open_orders_all_time} sub={`${s.orders_new_today} new today`} tone={s.open_orders_all_time > 0 ? 'warn' : undefined} />
            <Stat label="Orders in period" value={s.orders_total} sub={`${s.orders_delivered} delivered · ${s.orders_cancelled} cancelled`} />
            <Stat label="Delivered sales" value={money(s.sales_delivered)} sub={`${money(s.pipeline_value)} still open`} />
            {fin ? <Stat label="Net profit" value={money(fin.net_profit)} sub={`after ${money(fin.operating_expenses)} expenses`} tone={fin.net_profit >= 0 ? 'good' : 'warn'} />
                 : <Stat label="Open enquiries" value={s.open_enquiries} />}
            <Stat label="Low-stock products" value={s.low_stock} sub={`${s.out_of_stock} out of stock`} tone={s.out_of_stock ? 'warn' : undefined} />
            <Stat label="Units in stock" value={s.inventory_units} sub={`worth ${money(s.inventory_value)} at cost`} />
            {fin && <Stat label="Cash received" value={money(fin.cash_received)} sub={`${money(fin.cash_paid)} paid out`} />}
            {fin && <Stat label="Owed to partners" value={money(fin.stakeholder_liabilities)} sub={`${money(fin.receivables)} owed by customers`} />}
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Panel title="Latest orders" actions={<Link to="/admin/orders" className="text-xs text-navy underline">All orders</Link>}>
              {!recent.data?.length ? <p className="text-sm text-charcoal-400">No orders yet. Share your shop link to get the first one.</p> : (
                <ul className="-my-2 divide-y">{recent.data.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span><Link to={`/admin/orders/${o.id}`} className="font-medium text-navy">{o.reference}</Link> · {o.customer_name}<span className="block text-xs text-charcoal-400">{o.hostel_name ?? (o.delivery_method === 'courier' ? 'Courier' : '')} · {dateTime(o.created_at)}</span></span>
                    <span className="flex items-center gap-2"><span className="tabular-nums">{money(o.total)}</span><Badge value={o.status} /></span>
                  </li>))}</ul>
              )}
            </Panel>
            <Panel title="Running low" actions={<Link to="/admin/inventory" className="text-xs text-navy underline">Inventory</Link>}>
              {!lowRows.length ? <p className="text-sm text-charcoal-400">Nothing is running low.</p> : (
                <ul className="-my-2 divide-y">{lowRows.map((i, k) => (
                  <li key={k} className="flex justify-between py-2 text-sm"><span>{i.products.name}<span className="block text-xs text-charcoal-400">{i.distributors?.name}</span></span>
                    <span className={i.available <= 0 ? 'font-medium text-ember-700' : 'text-charcoal-800'}>{i.available} left</span></li>))}</ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

const DIMENSIONS = [
  { value: 'hostel', label: 'Hostel' }, { value: 'institution', label: 'Campus' }, { value: 'distributor', label: 'Distributor' },
  { value: 'product', label: 'Product' }, { value: 'category', label: 'Category' }, { value: 'stakeholder', label: 'Stakeholder' },
  { value: 'delivery_method', label: 'Delivery method' }, { value: 'day', label: 'Day' },
];

export function AnalyticsPage() {
  const [r, setR] = useState({ from: daysAgoISO(29), to: todayISO(), dim: 'hostel', scope: 'placed' });
  const data = useAsync(async () => {
    const { data, error } = await db.rpc('sales_breakdown', { p_from: r.from, p_to: r.to, p_dimension: r.dim, p_scope: r.scope });
    if (error) throw error;
    return (data as any[]).map((d) => ({ ...d, revenue: Number(d.revenue), platform_revenue: Number(d.platform_revenue) }));
  }, [JSON.stringify(r)]);
  const rows = data.data ?? [];
  const total = rows.reduce((s, x) => s + x.revenue, 0);
  const dimLabel = DIMENSIONS.find((d) => d.value === r.dim)?.label ?? '';
  return (
    <div>
      <PageHeader title="Sales breakdown" description="Where your sales come from." actions={<DateRange from={r.from} to={r.to} onChange={(from, to) => setR({ ...r, from, to })} />} />
      <Tabs value={r.dim} onChange={(dim) => setR({ ...r, dim })} items={DIMENSIONS} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select className="w-80" value={r.scope} onChange={(e) => setR({ ...r, scope: e.target.value })} aria-label="Which orders">
          <option value="placed">All orders placed (excl. cancelled)</option><option value="delivered">Delivered orders only</option>
        </Select>
        <button className="text-sm text-navy underline" onClick={() => downloadFile(`sales-by-${r.dim}-${r.from}-${r.to}.csv`, toCSV(rows.map((x) => ({ [dimLabel]: x.label, Orders: x.orders, Units: x.units, Sales: x.revenue.toFixed(2), 'Platform revenue': x.platform_revenue.toFixed(2) }))))}>Download CSV</button>
      </div>
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {data.loading ? <Loading /> : rows.length === 0 ? <p className="py-10 text-center text-sm text-charcoal-400">No sales in this period.</p> : (
        <div className="space-y-4">
          <Panel title={`Sales by ${dimLabel.toLowerCase()}`}>
            <div style={{ height: Math.max(220, r.dim === 'day' ? 280 : rows.length * 34 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                {r.dim === 'day' ? (
                  <BarChart data={rows} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid vertical={false} stroke="#eee" />
                    <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} tickFormatter={(v) => String(v).slice(5)} />
                    <YAxis tick={axis} tickLine={false} axisLine={false} width={60} />
                    <Tooltip formatter={(v) => money(Number(v))} cursor={{ fill: 'rgba(57,73,171,.06)' }} />
                    <Bar dataKey="revenue" name="Sales" fill={SERIES_IN} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                ) : (
                  <BarChart data={rows.slice(0, 20)} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid horizontal={false} stroke="#eee" />
                    <XAxis type="number" tick={axis} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="label" tick={axis} tickLine={false} axisLine={false} width={140} />
                    <Tooltip formatter={(v) => money(Number(v))} cursor={{ fill: 'rgba(57,73,171,.06)' }} />
                    <Bar dataKey="revenue" name="Sales" fill={SERIES_IN} radius={[0, 4, 4, 0]} maxBarSize={22} />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
          </Panel>
          <Table head={[dimLabel, 'Orders', 'Units', 'Sales', 'Share', 'Your revenue']}>
            {rows.map((x) => (
              <tr key={x.label}><td className="table-cell">{x.label}</td><td className="table-cell tabular-nums">{x.orders}</td><td className="table-cell tabular-nums">{x.units}</td>
                <td className="table-cell tabular-nums">{money(x.revenue)}</td><td className="table-cell tabular-nums">{total ? Math.round((x.revenue / total) * 100) : 0}%</td><td className="table-cell tabular-nums">{money(x.platform_revenue)}</td></tr>
            ))}
          </Table>
        </div>
      )}
    </div>
  );
}

export function ReconciliationPage() {
  const [day, setDay] = useState(todayISO());
  const rec = useAsync(async () => { const { data, error } = await db.rpc('reconciliation', { p_day: day }); if (error) throw error; return data as any[]; }, [day]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Daily reconciliation" description="Check what each distributor was given, delivered and collected — and what stock they should still be holding."
        actions={<Field label=""><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" /></Field>} />
      {rec.error && <ErrorBox message={rec.error} onRetry={rec.reload} />}
      {rec.loading ? <Loading /> : (
        <Table empty={!rec.data?.length} head={['Distributor', 'Assigned', 'Confirmed', 'Delivered', 'Still open', 'Expected', 'Collected', 'Gap', 'Units sold', 'Should hold']}>
          {rec.data?.map((d) => {
            const gap = Number(d.money_expected) - Number(d.money_collected);
            return (
              <Fragment key={d.distributor_id}>
                <tr className="cursor-pointer hover:bg-cream-100/40" onClick={() => setOpen(open === d.distributor_id ? null : d.distributor_id)}>
                  <td className="table-cell font-medium">{d.distributor_name}<div className="text-xs text-charcoal-400">{d.phone}</div></td>
                  <td className="table-cell">{d.orders_assigned}</td><td className="table-cell">{d.orders_confirmed}</td><td className="table-cell">{d.orders_delivered}</td>
                  <td className="table-cell">{d.orders_outstanding}</td><td className="table-cell tabular-nums">{money(d.money_expected)}</td><td className="table-cell tabular-nums">{money(d.money_collected)}</td>
                  <td className={`table-cell tabular-nums ${gap > 0.009 ? 'font-medium text-ember-700' : 'text-sage-800'}`}>{gap > 0.009 ? money(gap) : 'None'}</td>
                  <td className="table-cell">{d.units_sold}</td><td className="table-cell">{d.stock_on_hand}{d.stock_reserved > 0 && <span className="text-xs text-charcoal-400"> ({d.stock_reserved} held)</span>}</td>
                </tr>
                {open === d.distributor_id && (
                  <tr><td colSpan={10} className="bg-cream-100/50 px-4 py-3 text-sm">
                    {d.stock_lines.length ? <div className="grid gap-1 sm:grid-cols-3">{d.stock_lines.map((l: any) => <span key={l.product}>{l.product}: <strong>{l.on_hand}</strong>{l.reserved > 0 && ` (${l.reserved} held)`}</span>)}</div> : 'No stock recorded.'}
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </Table>
      )}
    </div>
  );
}
