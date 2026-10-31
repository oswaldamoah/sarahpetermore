import { Fragment, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { callApi, db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { useAuth } from '@/hooks/auth';
import { useSettings } from '@/hooks/settings';
import { Badge, Button, Checkbox, ErrorBox, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table, Tabs, Textarea, useConfirm, useToast } from '@/components/ui';
import { STOCK_COLUMNS, STOCK_DIST_COLUMNS, downloadFile, parseCSV, toCSV } from '@/lib/csv';
import { dateTime, errorText, humanize, todayISO } from '@/lib/format';

async function fetchAll(table: string, select = '*') {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

const TABLES: { key: string; label: string; table: string; select?: string; roles?: string[] }[] = [
  { key: 'products', label: 'Products', table: 'products' }, { key: 'categories', label: 'Categories', table: 'categories' },
  { key: 'stakeholders', label: 'Stakeholders', table: 'stakeholders' }, { key: 'distributors', label: 'Distributors', table: 'distributors' },
  { key: 'locations', label: 'Hostels & campuses', table: 'hostels', select: '*, institutions(name)' },
  { key: 'inventory', label: 'Inventory', table: 'inventory', select: '*, products(name), distributors(name)' },
  { key: 'orders', label: 'Orders', table: 'orders' }, { key: 'order_items', label: 'Order items', table: 'order_items' },
  { key: 'customers', label: 'Customers', table: 'customers' }, { key: 'stock_movements', label: 'Stock movements', table: 'stock_movements' },
  { key: 'stock_transfers', label: 'Transfers', table: 'stock_transfers', select: '*, stock_transfer_items(*)' },
  { key: 'restocks', label: 'Restocks', table: 'restocks', select: '*, restock_items(*)' }, { key: 'expenses', label: 'Expenses', table: 'expenses' },
  { key: 'financial_transactions', label: 'Ledger', table: 'financial_transactions' }, { key: 'stakeholder_settlements', label: 'Settlements', table: 'stakeholder_settlements' },
  { key: 'enquiries', label: 'Enquiries', table: 'enquiries' },
];

const flatten = (r: Record<string, any>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]));

export function ImportExportPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const dists = useAsync(() => q<any[]>(db.from('distributors').select('id,name').order('name')));
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } catch (e) { toast('error', errorText(e)); } finally { setBusy(null); } };

  const exportStock = () => run('stock', async () => {
    const [prods, inv] = await Promise.all([fetchAll('products', 'id,name,cost_price,final_price,unit,categories(name)'), fetchAll('inventory', 'product_id,on_hand')]);
    const qty = new Map<string, number>(); inv.forEach((i) => qty.set(i.product_id, (qty.get(i.product_id) ?? 0) + i.on_hand));
    const rows = prods.map((p) => ({ 'Product Name': p.name, Category: p.categories?.name ?? '', 'Cost Price': Number(p.cost_price).toFixed(2), 'Selling Price': Number(p.final_price).toFixed(2), 'Stock Quantity': qty.get(p.id) ?? 0, Unit: p.unit }));
    downloadFile(`stock-${todayISO()}.csv`, toCSV(rows, STOCK_COLUMNS));
  });
  const exportStockByDistributor = () => run('stockd', async () => {
    const inv = await fetchAll('inventory', 'on_hand, products(name,cost_price,final_price,unit,categories(name)), distributors(name, distributor_service_areas(hostels(name, institutions(name))))');
    const rows = inv.map((i) => {
      const areas = i.distributors?.distributor_service_areas ?? [];
      return { 'Product Name': i.products?.name, Category: i.products?.categories?.name ?? '', Distributor: i.distributors?.name,
        Institution: [...new Set(areas.map((a: any) => a.hostels?.institutions?.name))].join('; '), Hostel: areas.map((a: any) => a.hostels?.name).join('; '),
        'Cost Price': Number(i.products?.cost_price ?? 0).toFixed(2), 'Selling Price': Number(i.products?.final_price ?? 0).toFixed(2), 'Stock Quantity': i.on_hand, Unit: i.products?.unit };
    }).sort((a, b) => String(a.Distributor).localeCompare(String(b.Distributor)) || String(a['Product Name']).localeCompare(String(b['Product Name'])));
    downloadFile(`stock-by-distributor-${todayISO()}.csv`, toCSV(rows, STOCK_DIST_COLUMNS));
  });
  const exportTable = (t: typeof TABLES[number], fmt: 'csv' | 'json') => run(`${t.key}-${fmt}`, async () => {
    const rows = await fetchAll(t.table, t.select);
    if (fmt === 'json') downloadFile(`${t.key}-${todayISO()}.json`, JSON.stringify(rows, null, 2), 'application/json');
    else downloadFile(`${t.key}-${todayISO()}.csv`, toCSV(rows.map(flatten)));
  });
  const backup = () => run('backup', async () => {
    const out: Record<string, unknown> = { exported_at: new Date().toISOString(), app: 'SarahPetermore' };
    for (const t of TABLES) { try { out[t.key] = await fetchAll(t.table, t.select); } catch { out[t.key] = 'no access'; } }
    downloadFile(`sarahpetermore-backup-${todayISO()}.json`, JSON.stringify(out, null, 2), 'application/json');
  });
  const template = () => downloadFile('stock-import-template.csv', toCSV([
    { 'Product Name': 'Classic Condoms (3-pack)', Category: 'Condoms', 'Cost Price': '6.00', 'Selling Price': '12.00', 'Stock Quantity': '30', Unit: 'pack', Stakeholder: '' },
    { 'Product Name': 'Personal Massager', Category: 'Adult Toys', 'Cost Price': '120.00', 'Selling Price': '230.00', 'Stock Quantity': '4', Unit: 'pc', Stakeholder: 'Goldy' },
  ], [...STOCK_COLUMNS, 'Stakeholder']));

  return (
    <div className="space-y-6">
      <PageHeader title="Import & export" />
      <Panel title="Export stock">
        <div className="flex flex-wrap gap-2">
          <Button loading={busy === 'stock'} onClick={exportStock}><Download className="h-4 w-4" />Stock CSV</Button>
          <Button variant="outline" loading={busy === 'stockd'} onClick={exportStockByDistributor}><Download className="h-4 w-4" />Stock by distributor CSV</Button>
          <Button variant="outline" loading={busy === 'backup'} onClick={backup}><Download className="h-4 w-4" />Export all data (JSON backup)</Button>
        </div>
        <p className="mt-2 text-xs text-charcoal-400">Stock CSV columns: {STOCK_COLUMNS.join(', ')}. Selling Price is the price customers pay; Stock Quantity is the total across all distributors.</p>
      </Panel>
      {can('manager', 'inventory_manager') && <ImportPanel dists={dists.data ?? []} onTemplate={template} />}
      <Panel title="Export a table">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TABLES.map((t) => (
            <div key={t.key} className="flex items-center justify-between rounded-md border border-charcoal-300/40 px-3 py-2 text-sm">
              <span>{t.label}</span>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" loading={busy === `${t.key}-csv`} onClick={() => exportTable(t, 'csv')}>CSV</Button>
                <Button size="sm" variant="ghost" loading={busy === `${t.key}-json`} onClick={() => exportTable(t, 'json')}>JSON</Button>
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

const HEADER_MAP: Record<string, string> = { 'product name': 'product_name', category: 'category', 'cost price': 'cost_price', 'selling price': 'selling_price', 'stock quantity': 'stock_quantity', unit: 'unit', stakeholder: 'stakeholder' };

function ImportPanel({ dists, onTemplate }: { dists: any[]; onTemplate: () => void }) {
  const toast = useToast();
  const [dist, setDist] = useState('');
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setResult(null);
    try {
      const raw = await parseCSV(file);
      const missing = ['product name', 'category', 'cost price', 'selling price'].filter((h) => !Object.keys(raw[0] ?? {}).some((k) => k.trim().toLowerCase() === h));
      if (missing.length) return toast('error', `Missing column(s): ${missing.join(', ')}. Download the template to see the format.`);
      const mapped = raw.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [HEADER_MAP[k.trim().toLowerCase()] ?? k, String(v ?? '').trim()])));
      setRows(mapped);
      await check(mapped, dist);
    } catch (e) { toast('error', errorText(e)); }
  }
  async function check(r = rows, d = dist) {
    if (!r) return;
    setBusy(true);
    const { data, error } = await db.rpc('import_stock', { p_rows: r, p_distributor: d || null, p_dry_run: true });
    setBusy(false);
    if (error) toast('error', errorText(error)); else setPreview(data);
  }
  async function commit() {
    setBusy(true);
    const { data, error } = await db.rpc('import_stock', { p_rows: rows, p_distributor: dist || null, p_dry_run: false, p_skip_invalid: skip });
    setBusy(false);
    if (error) return toast('error', errorText(error));
    setResult(data.summary); setPreview(null); setRows(null);
    toast('success', 'Import finished');
  }
  const errors = preview?.summary?.errors ?? 0;
  return (
    <Panel title="Import products & stock" actions={<button className="text-xs text-navy underline" onClick={onTemplate}>Download CSV template</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Put stock quantities at" hint="Leave empty to import products and prices only"><Select value={dist} onChange={(e) => { setDist(e.target.value); void check(rows, e.target.value); }}>
          <option value="">No distributor (products only)</option>{dists.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
        <Field label="CSV file"><label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-charcoal-300 bg-white px-3 text-sm text-charcoal-500 hover:border-navy">
          <Upload className="h-4 w-4" />Choose file<input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} /></label></Field>
      </div>
      <p className="mt-2 text-xs text-charcoal-400">Products are matched by name. Stock Quantity sets the count at the chosen distributor (the difference is recorded in the stock ledger). Selling Price is the customer price.</p>
      {busy && <Loading label="Checking file" />}
      {preview && (
        <div className="mt-4 space-y-3">
          <p className="text-sm"><strong>{preview.summary.create}</strong> new · <strong>{preview.summary.update}</strong> updates · <strong className={errors ? 'text-red-700' : ''}>{errors}</strong> with problems</p>
          <div className="max-h-80 overflow-y-auto">
            <Table head={['Row', 'Product', 'Action', 'Current stock here', 'Problems']}>
              {preview.rows.map((r: any) => (
                <tr key={r.row} className={r.action === 'error' ? 'bg-red-50' : ''}>
                  <td className="table-cell">{r.row + 1}</td><td className="table-cell">{r.product_name || '—'}</td>
                  <td className="table-cell"><Badge value={r.action === 'error' ? 'failed' : r.action === 'create' ? 'active' : 'pending'} label={humanize(r.action)} /></td>
                  <td className="table-cell">{r.current_stock ?? '—'}</td><td className="table-cell text-xs text-red-700">{r.errors.join('; ')}</td>
                </tr>
              ))}
            </Table>
          </div>
          {errors > 0 && <Checkbox label={`Skip the ${errors} row(s) with problems and import the rest`} checked={skip} onChange={setSkip} />}
          <div className="flex gap-2"><Button onClick={commit} loading={busy} disabled={errors > 0 && !skip}>Import {preview.summary.create + preview.summary.update} row(s)</Button><Button variant="ghost" onClick={() => { setPreview(null); setRows(null); }}>Cancel</Button></div>
        </div>
      )}
      {result && <p className="mt-4 rounded-md bg-sage-50 p-3 text-sm text-sage-800">Done: {result.created} created, {result.updated} updated, {result.skipped} skipped.</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------- Settings
const BUSINESS_FIELDS: { key: string; label: string; type?: 'text' | 'textarea' | 'number' | 'bool'; hint?: string; isPublic?: boolean }[] = [
  { key: 'contact_business_phone', label: 'Business line', hint: 'Private: only shown to a customer after they place an order', isPublic: false },
  { key: 'contact_customer_service_phone', label: 'Customer service number', hint: 'Private: only shown after an order', isPublic: false },
  { key: 'contact_whatsapp', label: 'WhatsApp number', hint: 'Private: only shown after an order', isPublic: false },
  { key: 'contact_snapchat', label: 'Snapchat username', hint: 'Public: shown on the site' },
  { key: 'contact_email', label: 'Email' },
  { key: 'tagline', label: 'Tagline' }, { key: 'hero_title', label: 'Home page headline' }, { key: 'hero_subtitle', label: 'Home page sub-headline', type: 'textarea' },
  { key: 'discreet_note', label: 'Packaging note', type: 'textarea' }, { key: 'courier_note', label: 'Courier delivery message', type: 'textarea' },
  { key: 'policies', label: 'Payment & returns policy', type: 'textarea' },
  { key: 'delivery_fee_distributor', label: 'Delivery fee — campus distributor (GH₵)', type: 'number' },
  { key: 'delivery_fee_courier', label: 'Delivery fee — courier (GH₵)', type: 'number', hint: '0 if you confirm it by phone' },
  { key: 'allow_orders_without_stock', label: 'Accept orders even when stock is not recorded (assign stock later)', type: 'bool' },
  { key: 'allow_split_fulfilment', label: 'Split an order across two distributors at the same hostel when needed', type: 'bool', isPublic: false },
  { key: 'max_orders_per_phone_10min', label: 'Max orders per phone number per 10 minutes', type: 'number', isPublic: false },
  { key: 'assistant_rate_limit_per_10min', label: 'Max customer-service messages per visitor per 10 minutes', type: 'number', isPublic: false },
];

export function SettingsPage() {
  const [tab, setTab] = useState<'business' | 'alerts' | 'ai' | 'staff'>('business');
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'business', label: 'Business & delivery' }, { value: 'alerts', label: 'Order alerts' }, { value: 'ai', label: 'AI models' }, { value: 'staff', label: 'Staff & roles' }]} />
      {tab === 'business' ? <BusinessSettings /> : tab === 'alerts' ? <AlertSettings /> : tab === 'ai' ? <AiSettings /> : <StaffSettings />}
    </div>
  );
}

function BusinessSettings() {
  const toast = useToast();
  const { reload } = useSettings();
  const data = useAsync(() => q<any[]>(db.from('system_settings').select('*')));
  const [vals, setVals] = useState<Record<string, any> | null>(null);
  const current = vals ?? Object.fromEntries((data.data ?? []).map((r) => [r.key, r.value]));
  const [busy, setBusy] = useState(false);
  if (data.loading) return <Loading />;
  async function save() {
    setBusy(true);
    const rows = BUSINESS_FIELDS.map((f) => ({ key: f.key, is_public: f.isPublic !== false, updated_at: new Date().toISOString(),
      value: f.type === 'number' ? Number(current[f.key] ?? 0) : f.type === 'bool' ? !!current[f.key] : String(current[f.key] ?? '') }));
    const { error } = await db.from('system_settings').upsert(rows);
    setBusy(false);
    if (error) toast('error', errorText(error)); else { toast('success', 'Settings saved'); reload(); setVals(null); void data.reload(); }
  }
  return (
    <div className="max-w-3xl">
      <div className="grid gap-4 sm:grid-cols-2">
        {BUSINESS_FIELDS.map((f) => f.type === 'bool'
          ? <div key={f.key} className="sm:col-span-2"><Checkbox label={f.label} checked={!!current[f.key]} onChange={(v) => setVals({ ...current, [f.key]: v })} /></div>
          : <Field key={f.key} label={f.label} hint={f.hint} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
              {f.type === 'textarea' ? <Textarea rows={2} value={current[f.key] ?? ''} onChange={(e) => setVals({ ...current, [f.key]: e.target.value })} />
                : <Input type={f.type === 'number' ? 'number' : 'text'} value={current[f.key] ?? ''} onChange={(e) => setVals({ ...current, [f.key]: e.target.value })} />}
            </Field>)}
      </div>
      <Button className="mt-6" loading={busy} onClick={save}>Save settings</Button>
    </div>
  );
}

function AlertSettings() {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const list = useAsync(() => q<any[]>(db.from('alert_recipients').select('*').order('created_at')));
  const dists = useAsync(() => q<any[]>(db.from('distributors').select('id,name,phone').eq('is_active', true).order('name')));
  const link = useAsync(() => q<any>(db.from('system_settings').select('value').eq('key', 'whatsapp_link').maybeSingle()).then((r) => r?.value ?? null));
  const fresh = !!link.data?.updated_at && Date.now() - new Date(link.data.updated_at).getTime() < 3 * 60_000;
  const emailHint = 'Set RESEND_API_KEY on the server (free: 100 emails a day). Until you verify a domain in Resend, emails only reach the address you signed up to Resend with — so use that one for yourself.';
  const [edit, setEdit] = useState<any | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const distName = (id: string | null) => (id ? dists.data?.find((d) => d.id === id)?.name ?? 'Distributor' : 'Every order');

  async function save() {
    const row = { label: edit.label?.trim(), distributor_id: edit.distributor_id || null, whatsapp: edit.whatsapp?.trim() || null,
      email: edit.email?.trim() || null, is_active: !!edit.is_active, updated_at: new Date().toISOString() };
    if (!row.label) return toast('error', 'Give this recipient a name');
    if (!row.email && !row.whatsapp) return toast('error', 'Add a WhatsApp number or an email');
    const { error } = edit.id ? await db.from('alert_recipients').update(row).eq('id', edit.id) : await db.from('alert_recipients').insert(row);
    if (error) toast('error', errorText(error)); else { toast('success', 'Saved'); setEdit(null); void list.reload(); }
  }
  async function test(id: string) {
    setTesting(id);
    const { data, error } = await callApi('notify', { test_recipient_id: id });
    setTesting(null); void list.reload();
    if (error || !data?.ok) toast('error', data?.result ?? data?.error ?? errorText(error)); else toast('success', data.result);
  }
  return (
    <div className="max-w-5xl">
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        <Panel title="WhatsApp">
          {link.data?.connected && fresh
            ? <p className="text-sm"><span className="mr-2 inline-block h-2 w-2 rounded-full bg-[#2BD67B]" />Linked as <b>+{link.data.number}</b>. New orders go to your “Message yourself” chat. AI replies: <b>{link.data.ai_mode}</b>.</p>
            : <p className="text-sm"><span className="mr-2 inline-block h-2 w-2 rounded-full bg-charcoal-300" />Not running{link.data?.updated_at ? ` (last seen ${dateTime(link.data.updated_at)})` : ''}. Alerts wait and send as soon as it is back on.</p>}
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-charcoal-500">
            <li>In the <span className="font-mono text-xs">web</span> folder run <span className="font-mono text-xs">npm run whatsapp</span>.</li>
            <li>On your phone: WhatsApp → Linked devices → Link a device, and scan the code.</li>
            <li>Keep that window open. Add distributors below to send them their orders too.</li>
          </ol>
        </Panel>
        <Panel title="Email (Resend)">
          <p className="text-sm text-charcoal-500">{emailHint}</p>
        </Panel>
      </div>
      {list.loading ? <Loading /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : (
        <Table head={['Name', 'Gets', 'WhatsApp', 'Email', 'Last result', '']}>
          {(list.data ?? []).map((r) => (
            <tr key={r.id} className={r.is_active ? '' : 'opacity-50'}>
              <td className="table-cell font-medium">{r.label}</td>
              <td className="table-cell">{r.distributor_id ? `${distName(r.distributor_id)}'s orders` : 'Every order'}</td>
              <td className="table-cell">{r.whatsapp ?? '—'}</td>
              <td className="table-cell">{r.email ?? '—'}</td>
              <td className="table-cell text-xs text-charcoal-500">{r.last_result ?? 'Not sent yet'}</td>
              <td className="table-cell whitespace-nowrap text-right">
                <Button size="sm" variant="ghost" loading={testing === r.id} onClick={() => test(r.id)}>Test</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit({ ...r })}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (await confirm('Stop sending to this recipient?', r.label, 'Remove', true)) { await db.from('alert_recipients').delete().eq('id', r.id); void list.reload(); } }}>Remove</Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {!list.loading && !list.data?.length && <p className="mt-3 text-sm text-charcoal-500">You already get WhatsApp alerts in your own chat once WhatsApp is linked. Add your email here, and distributors if they should get their orders.</p>}
      <Button className="mt-3" onClick={() => setEdit({ label: list.data?.length ? '' : 'Me', distributor_id: '', whatsapp: '', email: '', is_active: true })}>Add recipient</Button>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.label}` : 'Add alert recipient'}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} placeholder="Me, Kwame…" /></Field>
          <Field label="Sends" hint="Distributors only get orders they deliver">
            <Select value={edit.distributor_id ?? ''} onChange={(e) => { const d = dists.data?.find((x) => x.id === e.target.value); setEdit({ ...edit, distributor_id: e.target.value, whatsapp: edit.whatsapp || d?.phone || '' }); }}>
              <option value="">Every order</option>
              {(dists.data ?? []).map((d) => <option key={d.id} value={d.id}>Only {d.name}'s orders</option>)}
            </Select></Field>
          <Field label="WhatsApp number" hint="Sent from your linked WhatsApp"><Input value={edit.whatsapp ?? ''} onChange={(e) => setEdit({ ...edit, whatsapp: e.target.value })} inputMode="tel" placeholder="024 000 0000" /></Field>
          <Field label="Email"><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          <Checkbox label="On" checked={!!edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} />
        </div>}
      </Modal>
      {dialog}
    </div>
  );
}

const PROVIDER_PRESETS: Record<string, { base_url: string; model: string; requires_key: boolean; help: string }> = {
  openrouter: { base_url: 'https://openrouter.ai/api/v1', model: 'openrouter/free', requires_key: true, help: 'Free key at openrouter.ai/keys (no card). "openrouter/free" picks a working free model automatically.' },
  groq: { base_url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', requires_key: true, help: 'Free key at console.groq.com.' },
  gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.1-flash-lite', requires_key: true, help: 'Free key at aistudio.google.com.' },
  pollinations: { base_url: 'https://text.pollinations.ai/openai', model: 'openai', requires_key: false, help: 'No key needed. Rate-limited; best as a last fallback.' },
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requires_key: true, help: 'Paid.' },
  openai_compatible: { base_url: 'https://', model: '', requires_key: true, help: 'Any OpenAI-compatible /chat/completions endpoint.' },
};

function AiSettings() {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const list = useAsync(() => q<any[]>(db.from('ai_provider_settings').select('*').order('priority')));
  const usage = useAsync(() => q<any[]>(db.from('ai_usage').select('provider_id,success,scope').gte('created_at', new Date(Date.now() - 86400000).toISOString()).limit(5000)));
  const [edit, setEdit] = useState<any | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const stat = (id: string) => { const u = (usage.data ?? []).filter((x) => x.provider_id === id); return { ok: u.filter((x) => x.success).length, fail: u.filter((x) => !x.success).length }; };

  async function test(id: string) {
    setTesting(id);
    const { data, error } = await callApi('admin-assistant', { mode: 'test', provider_id: id });
    setTesting(null);
    if (error || !data?.ok) toast('error', `Failed: ${data?.error ?? errorText(error)}`); else toast('success', `Working — replied in ${data.latency_ms} ms`);
  }
  async function save() {
    const { error } = await db.rpc('save_ai_provider', { p: edit });
    if (error) toast('error', errorText(error)); else { toast('success', 'Provider saved'); setEdit(null); void list.reload(); }
  }
  return (
    <div>
      <p className="mb-4 max-w-3xl text-sm text-charcoal-500">Both assistants try these in order (lowest priority number first) and fall back to the next if one fails or hits its limit. Keys are stored server-side and never sent to the browser. Customers never see which model answered.</p>
      {list.loading ? <Loading /> : (
        <Table head={['Priority', 'Provider', 'Model', 'Used by', 'Key', 'Last 24h', 'Status', '']}>
          {list.data?.map((p) => { const s = stat(p.id); return (
            <tr key={p.id}>
              <td className="table-cell">{p.priority}</td><td className="table-cell font-medium">{p.name}</td><td className="table-cell font-mono text-xs">{p.model}</td>
              <td className="table-cell">{p.scope === 'both' ? 'Both' : humanize(p.scope)}</td>
              <td className="table-cell text-xs">{!p.requires_key ? 'Not needed' : p.has_key ? `••••${p.key_last4}` : <span className="text-ember-700">Missing — skipped</span>}</td>
              <td className="table-cell text-xs">{s.ok} ok{s.fail ? <span className="text-ember-700"> · {s.fail} failed</span> : ''}</td>
              <td className="table-cell"><Badge value={p.is_enabled ? 'active' : 'inactive'} label={p.is_enabled ? 'On' : 'Off'} /></td>
              <td className="table-cell whitespace-nowrap text-right">
                <Button size="sm" variant="ghost" loading={testing === p.id} onClick={() => test(p.id)}>Test</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit({ ...p, api_key: '' })}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (await confirm('Remove provider?', p.name, 'Remove', true)) { await db.from('ai_provider_settings').delete().eq('id', p.id); void list.reload(); } }}>Remove</Button>
              </td>
            </tr>); })}
        </Table>
      )}
      <Button className="mt-3" variant="outline" onClick={() => setEdit({ name: 'OpenRouter', provider: 'openrouter', ...PROVIDER_PRESETS.openrouter, scope: 'both', priority: 50, is_enabled: true, api_key: '' })}>Add provider</Button>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'Add AI provider'}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save provider</Button></>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type"><Select value={edit.provider} onChange={(e) => { const pr = PROVIDER_PRESETS[e.target.value]; setEdit({ ...edit, provider: e.target.value, base_url: pr.base_url, model: pr.model, requires_key: pr.requires_key }); }}>
            {Object.keys(PROVIDER_PRESETS).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select></Field>
          <Field label="Display name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Base URL" className="sm:col-span-2"><Input value={edit.base_url} onChange={(e) => setEdit({ ...edit, base_url: e.target.value })} /></Field>
          <Field label="Model"><Input value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })} /></Field>
          <Field label="Used by"><Select value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value })}><option value="both">Both assistants</option><option value="customer">24/7 Customer service only</option><option value="admin">Sarah Assistant only</option></Select></Field>
          <Field label="Priority" hint="Lower runs first"><Input type="number" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} /></Field>
          <Field label="Daily request limit" hint="Blank = no app limit"><Input type="number" value={edit.daily_limit ?? ''} onChange={(e) => setEdit({ ...edit, daily_limit: e.target.value })} /></Field>
          <Field label={edit.has_key ? `API key (saved ••••${edit.key_last4} — type to replace)` : 'API key'} className="sm:col-span-2" hint={PROVIDER_PRESETS[edit.provider]?.help}>
            <Input type="password" autoComplete="off" value={edit.api_key} onChange={(e) => setEdit({ ...edit, api_key: e.target.value })} /></Field>
          <Checkbox label="Needs a key" checked={!!edit.requires_key} onChange={(v) => setEdit({ ...edit, requires_key: v })} />
          <Checkbox label="Enabled" checked={!!edit.is_enabled} onChange={(v) => setEdit({ ...edit, is_enabled: v })} />
          {edit.has_key && <Checkbox label="Remove saved key" checked={!!edit.remove_key} onChange={(v) => setEdit({ ...edit, remove_key: v })} />}
        </div>}
      </Modal>
      {dialog}
    </div>
  );
}

const ROLES = [
  { value: 'super_admin', label: 'Super admin — everything' }, { value: 'manager', label: 'Manager — orders, products, stock, reports' },
  { value: 'inventory_manager', label: 'Inventory manager — stock, restocks, transfers' }, { value: 'finance_manager', label: 'Finance manager — cash, expenses, settlements' },
  { value: 'order_manager', label: 'Order manager — orders & enquiries' },
];
function StaffSettings() {
  const toast = useToast();
  const list = useAsync(async () => { const { data, error } = await db.rpc('list_staff'); if (error) throw error; return data as any[]; });
  const [f, setF] = useState({ email: '', role: 'order_manager' });
  return (
    <div className="max-w-3xl">
      <Panel title="Give someone access">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Their account email" hint="They must sign up on the site first"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select></Field>
          <Button onClick={async () => { const { error } = await db.rpc('grant_role', { p_email: f.email, p_role: f.role }); if (error) toast('error', errorText(error)); else { toast('success', 'Access granted'); setF({ ...f, email: '' }); void list.reload(); } }}>Grant</Button>
        </div>
      </Panel>
      {list.error && <div className="mt-4"><ErrorBox message={list.error} /></div>}
      <div className="mt-4"><Table head={['Person', 'Roles']}>
        {list.data?.map((s) => (
          <tr key={s.user_id}><td className="table-cell">{s.full_name ?? '—'}<div className="text-xs text-charcoal-400">{s.email}</div></td>
            <td className="table-cell">{s.roles.map((r: string) => (
              <span key={r} className="mr-1 inline-flex items-center gap-1 rounded bg-navy-50 px-2 py-0.5 text-xs text-navy">{humanize(r)}
                <button aria-label={`Remove ${r}`} className="text-charcoal-400 hover:text-red-700" onClick={async () => { const { error } = await db.rpc('revoke_role', { p_user: s.user_id, p_role: r }); if (error) toast('error', errorText(error)); else void list.reload(); }}>×</button></span>))}</td></tr>
        ))}
      </Table></div>
    </div>
  );
}

export function AuditLogsPage() {
  const [entity, setEntity] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useAsync(() => {
    let query = db.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(300);
    if (entity) query = query.eq('entity_type', entity);
    return q<any[]>(query);
  }, [entity]);
  const staff = useAsync(async () => { const { data } = await db.rpc('list_staff'); return new Map(((data ?? []) as any[]).map((s) => [s.user_id, s.email])); });
  return (
    <div>
      <PageHeader title="Audit log" description="Every change to products, prices, stakeholders, categories, locations, settings, roles, stock adjustments and AI actions." />
      <Select className="mb-3 w-56" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Type">
        <option value="">Everything</option>{['products', 'categories', 'stakeholders', 'distributors', 'hostels', 'institutions', 'inventory', 'orders', 'expenses', 'system_settings', 'user_roles', 'ai_provider_settings', 'ai_action_logs', 'refunds', 'stakeholder_settlements'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
      </Select>
      {list.loading ? <Loading /> : (
        <Table empty={!list.data?.length} head={['When', 'Who', 'Action', 'What', '']}>
          {list.data?.map((l) => (
            <Fragment key={l.id}>
              <tr><td className="table-cell whitespace-nowrap">{dateTime(l.created_at)}</td><td className="table-cell text-xs">{l.actor_id ? staff.data?.get(l.actor_id) ?? 'Staff' : 'System / customer'}</td>
                <td className="table-cell">{humanize(l.action)}</td><td className="table-cell">{humanize(l.entity_type)}</td>
                <td className="table-cell text-right"><button className="text-xs text-navy underline" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Hide' : 'Details'}</button></td></tr>
              {open === l.id && <tr><td colSpan={5} className="bg-cream-100/50 px-3 py-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(l.details, null, 2)}</pre></td></tr>}
            </Fragment>
          ))}
        </Table>
      )}
    </div>
  );
}
