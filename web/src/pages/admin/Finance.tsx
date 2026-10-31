import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Plus } from 'lucide-react';
import { db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { useAuth } from '@/hooks/auth';
import { Badge, Button, ErrorBox, Field, Input, Loading, Modal, PageHeader, Panel, Select, Stat, Table, useConfirm, useToast } from '@/components/ui';
import { CrudTable } from '@/components/admin/Crud';
import { dateOnly, daysAgoISO, errorText, humanize, money, todayISO } from '@/lib/format';
import { DateRange, SERIES_IN, SERIES_OUT } from './Dashboard';

const axis = { fontSize: 12, fill: '#757575' };

function ManualTxn({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any | null>(null);
  return (
    <>
      <Button variant="outline" onClick={() => setF({ type: 'capital', direction: 'in', amount: '', description: '', txn_date: todayISO(), payment_method: 'cash' })}><Plus className="h-4 w-4" />Record money in/out</Button>
      <Modal open={!!f} onClose={() => setF(null)} title="Record a ledger entry"
        footer={<><Button variant="ghost" onClick={() => setF(null)}>Cancel</Button><Button onClick={async () => {
          const { error } = await db.rpc('create_manual_transaction', { p: f });
          if (error) toast('error', errorText(error)); else { toast('success', 'Entry recorded'); setF(null); onDone(); }
        }}>Record entry</Button></>}>
        {f && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, direction: e.target.value === 'capital' || e.target.value === 'income' ? 'in' : e.target.value === 'expenditure' ? 'out' : f.direction })}>
            <option value="capital">Capital put in</option><option value="income">Other income</option><option value="expenditure">Other spending</option><option value="adjustment">Adjustment</option></Select></Field>
          <Field label="Direction"><Select value={f.direction} disabled={f.type !== 'adjustment'} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="in">Money in</option><option value="out">Money out</option></Select></Field>
          <Field label="Amount (GH₵)"><Input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Date"><Input type="date" value={f.txn_date} onChange={(e) => setF({ ...f, txn_date: e.target.value })} /></Field>
          <Field label="Description" className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <p className="text-xs text-charcoal-400 sm:col-span-2">Order payments, refunds, restocks, expenses and partner settlements are recorded from their own screens, so they're never counted twice.</p>
        </div>}
      </Modal>
    </>
  );
}

export function FinancePage() {
  const { can } = useAuth();
  const [r, setR] = useState({ from: daysAgoISO(29), to: todayISO() });
  const rep = useAsync(async () => { const { data, error } = await db.rpc('finance_report', { p_from: r.from, p_to: r.to }); if (error) throw error; return data as any; }, [r.from, r.to]);
  const d = rep.data;
  return (
    <div>
      <PageHeader title="Cashflow & profit" actions={<><DateRange from={r.from} to={r.to} onChange={(from, to) => setR({ from, to })} />{can('finance_manager') && <ManualTxn onDone={rep.reload} />}</>} />
      {rep.error && <ErrorBox message={rep.error} onRetry={rep.reload} />}
      {rep.loading && !d ? <Loading /> : d && (
        <>
          <h2 className="mb-2 font-sans text-sm font-semibold text-charcoal-800">Profit (delivered orders)</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Gross sales" value={money(d.gross_sales)} sub={`${money(d.discounts)} discounts · ${money(d.refunds)} refunds`} />
            <Stat label="Partner share" value={money(d.stakeholder_proceeds)} sub="Not your revenue" />
            <Stat label="Your gross margin" value={money(d.platform_gross_margin)} sub={`${money(d.platform_sales)} revenue − ${money(d.cogs)} cost of goods`} />
            <Stat label="Net profit" value={money(d.net_profit)} sub={`after ${money(d.operating_expenses)} expenses`} tone={d.net_profit >= 0 ? 'good' : 'warn'} />
          </div>
          <h2 className="mb-2 mt-6 font-sans text-sm font-semibold text-charcoal-800">Cash</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Cash in" value={money(d.cash_received)} />
            <Stat label="Cash out" value={money(d.cash_paid)} sub={`incl. ${money(d.refunds_paid_in_period)} refunds`} />
            <Stat label="Net cash (period)" value={money(d.net_cash)} tone={d.net_cash >= 0 ? 'good' : 'warn'} sub={`Balance all time ${money(d.cash_balance_all_time)}`} />
            <Stat label="Outstanding" value={money(d.receivables)} sub={`customers owe · you owe partners ${money(d.stakeholder_liabilities)}`} />
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Panel title="Money in and out per day">
              {d.cashflow.length === 0 ? <p className="text-sm text-charcoal-400">No cash movements in this period.</p> : (
                <div className="h-64"><ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.cashflow.map((c: any) => ({ date: c.date, in: Number(c.in ?? 0), out: Number(c.out ?? 0) }))} barGap={2}>
                    <CartesianGrid vertical={false} stroke="#eee" />
                    <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} tickFormatter={(v) => String(v).slice(5)} />
                    <YAxis tick={axis} tickLine={false} axisLine={false} width={60} />
                    <Tooltip formatter={(v) => money(Number(v))} cursor={{ fill: 'rgba(57,73,171,.06)' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="in" name="Money in" fill={SERIES_IN} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    <Bar dataKey="out" name="Money out" fill={SERIES_OUT} radius={[4, 4, 0, 0]} maxBarSize={22} />
                  </BarChart>
                </ResponsiveContainer></div>
              )}
            </Panel>
            <div className="space-y-4">
              <Panel title="Cash by type">
                <ul className="space-y-1 text-sm">{Object.entries(d.cash_by_type).map(([k, v]) => <li key={k} className="flex justify-between"><span>{humanize(k)}</span><span className="tabular-nums">{money(v as number)}</span></li>)}
                  {!Object.keys(d.cash_by_type).length && <li className="text-charcoal-400">Nothing yet.</li>}</ul>
              </Panel>
              <Panel title="Expenses by category">
                <ul className="space-y-1 text-sm">{Object.entries(d.expenses_by_category).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="tabular-nums">{money(v as number)}</span></li>)}
                  {!Object.keys(d.expenses_by_category).length && <li className="text-charcoal-400">No expenses.</li>}</ul>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function ExpensesPage() {
  const { can } = useAuth();
  const [showVoid, setShowVoid] = useState(false);
  return (
    <div>
      <PageHeader title="Expenses" description="Running costs (riders, data, rent…). Stock purchases go under Restocks so they aren't counted twice." />
      <CrudTable<any> table="expenses" title="Expenses" noun="Expense" deps={[showVoid]} canEdit={can('finance_manager')}
        filter={(qq) => (showVoid ? qq : qq.eq('is_void', false))} order={[{ column: 'expense_date', ascending: false }]}
        toolbar={<label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-navy" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} />Show voided</label>}
        columns={[
          { label: 'Date', render: (r) => dateOnly(r.expense_date) },
          { label: 'Expense', render: (r) => <>{r.name}{r.is_recurring && <span className="ml-1 text-xs text-charcoal-400">recurring</span>}<div className="text-xs text-charcoal-400">{r.recipient}</div></> },
          { label: 'Category', render: (r) => r.category },
          { label: 'Amount', render: (r) => <span className={r.is_void ? 'line-through text-charcoal-400' : 'tabular-nums'}>{money(r.amount)}</span> },
          { label: 'Paid by', render: (r) => r.payment_method ?? '—' },
        ]}
        fields={[
          { name: 'name', label: 'What for', required: true },
          { name: 'category', label: 'Category', type: 'select', default: 'General', options: ['General', 'Delivery', 'Marketing', 'Packaging', 'Data & airtime', 'Rent', 'Salaries', 'Fees', 'Other'].map((v) => ({ value: v, label: v })) },
          { name: 'amount', label: 'Amount (GH₵)', type: 'number', step: '0.01', required: true },
          { name: 'expense_date', label: 'Date', type: 'date', default: todayISO() },
          { name: 'recipient', label: 'Paid to' },
          { name: 'payment_method', label: 'Method', type: 'select', default: 'momo', options: [{ value: 'momo', label: 'Mobile Money' }, { value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'card', label: 'Card' }] },
          { name: 'is_recurring', label: 'Recurring', type: 'checkbox' },
          { name: 'recurrence', label: 'How often (if recurring)', hint: 'e.g. monthly' },
          { name: 'is_void', label: 'Void this expense (keeps the record, reverses it in the ledger)', type: 'checkbox' },
          { name: 'description', label: 'Notes', type: 'textarea' },
        ]} />
      <p className="mt-3 text-xs text-charcoal-400">Editing an amount or voiding an expense never rewrites history: the ledger records a reversal and a new entry.</p>
    </div>
  );
}

export function LedgerPage() {
  const toast = useToast();
  const { can } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [r, setR] = useState({ from: daysAgoISO(29), to: todayISO(), type: '' });
  const list = useAsync(() => {
    let query = db.from('financial_transactions').select('*').gte('txn_date', r.from).lte('txn_date', r.to).order('txn_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
    if (r.type) query = query.eq('type', r.type);
    return q<any[]>(query);
  }, [JSON.stringify(r)]);
  return (
    <div>
      <PageHeader title="Ledger" description="Every real movement of money. Entries are permanent; mistakes are fixed with a reversal." actions={<DateRange from={r.from} to={r.to} onChange={(from, to) => setR({ ...r, from, to })} />} />
      <Select className="mb-3 w-48" value={r.type} onChange={(e) => setR({ ...r, type: e.target.value })} aria-label="Type">
        <option value="">All types</option>{['income', 'expenditure', 'refund', 'restock', 'settlement', 'capital', 'adjustment'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
      </Select>
      {list.loading ? <Loading /> : (
        <Table empty={!list.data?.length} head={['Date', 'Type', 'Description', 'Method', 'In', 'Out', '']}>
          {list.data?.map((t) => (
            <tr key={t.id} className={t.is_reversed || t.reverses_id ? 'text-charcoal-400' : ''}>
              <td className="table-cell whitespace-nowrap">{dateOnly(t.txn_date)}</td><td className="table-cell">{humanize(t.type)}</td>
              <td className="table-cell">{t.description}{t.is_reversed && <Badge value="cancelled" label="Reversed" className="ml-1" />}</td>
              <td className="table-cell">{t.payment_method ?? '—'}</td>
              <td className="table-cell tabular-nums text-sage-800">{t.direction === 'in' ? money(t.amount) : ''}</td>
              <td className="table-cell tabular-nums text-ember-700">{t.direction === 'out' ? money(t.amount) : ''}</td>
              <td className="table-cell text-right">{can('finance_manager') && t.source_type === 'manual' && !t.is_reversed && !t.reverses_id &&
                <button className="text-xs text-navy underline" onClick={async () => {
                  if (!(await confirm('Reverse this entry?', 'A matching opposite entry will be added. The original stays visible.', 'Reverse', true))) return;
                  const { error } = await db.rpc('reverse_transaction', { p_id: t.id, p_reason: 'Reversed from ledger' });
                  if (error) toast('error', errorText(error)); else { toast('success', 'Reversed'); void list.reload(); }
                }}>Reverse</button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {dialog}
    </div>
  );
}

export function SettlementsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const bal = useAsync(async () => { const { data, error } = await db.rpc('stakeholder_balances'); if (error) throw error; return data as any[]; });
  const hist = useAsync(() => q<any[]>(db.from('stakeholder_settlements').select('*, stakeholders(name)').order('settlement_date', { ascending: false })));
  const [f, setF] = useState<any | null>(null);
  return (
    <div>
      <PageHeader title="Partner settlements" description="What you owe partners like Goldy for their delivered items. Partner money is never counted as your revenue." />
      {bal.error && <ErrorBox message={bal.error} />}
      <Table empty={!bal.data?.length} head={['Partner', 'Markup', 'Their items sold', 'Your markup earned', 'Owed for delivered items', 'Paid so far', 'Outstanding', '']}>
        {bal.data?.map((b) => (
          <tr key={b.stakeholder_id}>
            <td className="table-cell font-medium">{b.name} <Badge value={b.status} /></td><td className="table-cell">{b.markup_percent}%</td>
            <td className="table-cell tabular-nums">{money(b.sales_generated)}</td><td className="table-cell tabular-nums">{money(b.platform_commission)}</td>
            <td className="table-cell tabular-nums">{money(b.proceeds_due)}</td><td className="table-cell tabular-nums">{money(b.settled)}</td>
            <td className={`table-cell font-medium tabular-nums ${Number(b.outstanding) > 0 ? 'text-ember-700' : ''}`}>{money(b.outstanding)}</td>
            <td className="table-cell text-right">{can('finance_manager') && <Button size="sm" onClick={() => setF({ stakeholder_id: b.stakeholder_id, name: b.name, amount_paid: Number(b.outstanding) > 0 ? Number(b.outstanding).toFixed(2) : '', period_start: '', period_end: todayISO(), method: 'momo', reference: '', notes: '' })}>Pay</Button>}</td>
          </tr>
        ))}
      </Table>
      <h2 className="mb-2 mt-8 font-sans text-sm font-semibold">Settlement history</h2>
      <Table empty={!hist.data?.length} head={['Date', 'Partner', 'Period', 'Sales', 'Due for period', 'Paid', 'Ref']}>
        {hist.data?.map((s) => (
          <tr key={s.id}><td className="table-cell">{dateOnly(s.settlement_date)}</td><td className="table-cell">{s.stakeholders?.name}</td>
            <td className="table-cell text-xs">{s.period_start ? `${dateOnly(s.period_start)} – ${dateOnly(s.period_end)}` : `Up to ${dateOnly(s.period_end)}`}</td>
            <td className="table-cell tabular-nums">{money(s.sales_generated)}</td><td className="table-cell tabular-nums">{money(s.amount_due)}</td><td className="table-cell tabular-nums">{money(s.amount_paid)}</td><td className="table-cell">{s.reference ?? '—'}</td></tr>
        ))}
      </Table>
      <Modal open={!!f} onClose={() => setF(null)} title={`Pay ${f?.name}`}
        footer={<><Button variant="ghost" onClick={() => setF(null)}>Cancel</Button><Button onClick={async () => {
          const { name: _n, ...p } = f; void _n;
          const { error } = await db.rpc('create_settlement', { p: { ...p, period_start: p.period_start || null } });
          if (error) toast('error', errorText(error)); else { toast('success', 'Settlement recorded'); setF(null); void bal.reload(); void hist.reload(); }
        }}>Record payment</Button></>}>
        {f && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount paid (GH₵)"><Input type="number" step="0.01" value={f.amount_paid} onChange={(e) => setF({ ...f, amount_paid: e.target.value })} /></Field>
          <Field label="Method"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="momo">Mobile Money</option><option value="cash">Cash</option><option value="bank">Bank</option></Select></Field>
          <Field label="Period from (optional)"><Input type="date" value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} /></Field>
          <Field label="Period to"><Input type="date" value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} /></Field>
          <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
          <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
