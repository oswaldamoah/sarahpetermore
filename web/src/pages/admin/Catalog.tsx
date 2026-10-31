import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowUp, ImagePlus, Plus, X } from 'lucide-react';
import { db, uploadFile } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { Badge, Button, ErrorBox, Field, Input, Loading, PageHeader, Panel, Select, Table, Textarea, useConfirm, useToast } from '@/components/ui';
import { CrudTable } from '@/components/admin/Crud';
import { errorText, humanize, money, slugify } from '@/lib/format';
import { PlainBox } from '@/components/public/Product';

export function ProductsPage() {
  const [f, setF] = useState({ search: '', category: '', stakeholder: '', state: 'all' });
  const meta = useAsync(async () => ({
    cats: await q<any[]>(db.from('categories').select('id,name,status').order('sort_order')),
    shs: await q<any[]>(db.from('stakeholders').select('id,name,status').order('name')),
  }));
  const list = useAsync(async () => {
    let query = db.from('products').select('*, categories(name,status), stakeholders(name,status), inventory(on_hand,reserved)').order('name').limit(1000);
    if (f.search) query = query.or(`name.ilike.%${f.search}%,sku.ilike.%${f.search}%`);
    if (f.category) query = query.eq('category_id', f.category);
    if (f.stakeholder) query = query.eq('stakeholder_id', f.stakeholder);
    if (f.state === 'active') query = query.eq('is_active', true);
    if (f.state === 'inactive') query = query.eq('is_active', false);
    return q<any[]>(query);
  }, [JSON.stringify(f)]);
  const toast = useToast();
  const toggle = async (p: any, field: 'is_active' | 'is_available' | 'is_featured') => {
    const { error } = await db.from('products').update({ [field]: !p[field] }).eq('id', p.id);
    if (error) toast('error', errorText(error)); else void list.reload();
  };

  return (
    <div>
      <PageHeader title="Products" description="A product shows in the shop only when it, its category and its stakeholder are all active."
        actions={<Link to="/admin/products/new" className="inline-flex h-10 items-center gap-2 rounded-md bg-navy px-4 text-sm font-medium text-cream"><Plus className="h-4 w-4" />Add product</Link>} />
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <Input placeholder="Search name or SKU" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Category"><option value="">All categories</option>{meta.data?.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select value={f.stakeholder} onChange={(e) => setF({ ...f, stakeholder: e.target.value })} aria-label="Stakeholder"><option value="">All stakeholders</option>{meta.data?.shs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} aria-label="State"><option value="all">Active and inactive</option><option value="active">Active</option><option value="inactive">Inactive</option></Select>
      </div>
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.loading && !list.data ? <Loading /> : (
        <Table empty={!list.data?.length} head={['Product', 'Category', 'Stakeholder', 'Cost', 'Customer price', 'Stock', 'In shop', 'Active', 'Available', 'Featured']}>
          {list.data?.map((p) => {
            const stock = (p.inventory ?? []).reduce((s: number, i: any) => s + i.on_hand, 0);
            const reserved = (p.inventory ?? []).reduce((s: number, i: any) => s + i.reserved, 0);
            const visible = p.is_active && p.is_available && p.categories?.status === 'active' && p.stakeholders?.status === 'active';
            return (
              <tr key={p.id} className="hover:bg-cream-100/40">
                <td className="table-cell"><Link to={`/admin/products/${p.id}`} className="font-medium text-navy hover:underline">{p.name}</Link>{p.sku && <div className="text-xs text-charcoal-400">{p.sku}</div>}</td>
                <td className="table-cell">{p.categories?.name}{p.categories?.status !== 'active' && <span className="ml-1 text-xs text-ember-700">(off)</span>}</td>
                <td className="table-cell">{p.stakeholders?.name}{p.stakeholders?.status !== 'active' && <span className="ml-1 text-xs text-ember-700">(off)</span>}</td>
                <td className="table-cell tabular-nums">{money(p.cost_price)}</td>
                <td className="table-cell tabular-nums">{money(p.final_price)}{Number(p.final_price) !== Number(p.base_price) && <div className="text-xs text-charcoal-400">base {money(p.base_price)}</div>}</td>
                <td className="table-cell tabular-nums">{stock}{reserved > 0 && <span className="text-xs text-charcoal-400"> ({reserved} held)</span>}</td>
                <td className="table-cell">{visible ? <Badge value="active" label="Visible" /> : <Badge value="inactive" label="Hidden" />}</td>
                {(['is_active', 'is_available', 'is_featured'] as const).map((k) => (
                  <td key={k} className="table-cell"><input type="checkbox" className="h-4 w-4 accent-navy" checked={p[k]} onChange={() => toggle(p, k)} aria-label={`${k} ${p.name}`} /></td>
                ))}
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}

const productSchema = z.object({
  name: z.string().trim().min(2, 'Name is required'),
  description: z.string().optional(),
  sku: z.string().optional(),
  category_id: z.string().uuid('Choose a category'),
  stakeholder_id: z.string().uuid('Choose a stakeholder'),
  cost_price: z.coerce.number().min(0),
  base_price: z.coerce.number().positive('Enter a selling price'),
  markup_percent: z.union([z.literal(''), z.coerce.number().min(0)]).optional(),
  unit: z.string().trim().min(1),
  low_stock_threshold: z.coerce.number().int().min(0),
  is_active: z.boolean(), is_available: z.boolean(), is_featured: z.boolean(),
});
type ProductForm = z.output<typeof productSchema>;
type ProductInput = z.input<typeof productSchema>;

export function ProductFormPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [images, setImages] = useState<string[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const data = useAsync(async () => ({
    cats: await q<any[]>(db.from('categories').select('id,name,status').order('sort_order')),
    shs: await q<any[]>(db.from('stakeholders').select('id,name,status,markup_percent,is_platform_owner').order('name')),
    product: isNew ? null : await q<any>(db.from('products').select('*').eq('id', id!).single()),
    stock: isNew ? [] : await q<any[]>(db.from('inventory').select('on_hand,reserved,available,distributors(name)').eq('product_id', id!)),
  }), [id]);
  const p = data.data?.product;
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<ProductInput, unknown, ProductForm>({
    resolver: zodResolver(productSchema),
    values: data.data ? {
      name: p?.name ?? '', description: p?.description ?? '', sku: p?.sku ?? '', category_id: p?.category_id ?? '',
      stakeholder_id: p?.stakeholder_id ?? data.data.shs.find((s) => s.is_platform_owner)?.id ?? '',
      cost_price: p?.cost_price ?? 0, base_price: p?.base_price ?? 0, markup_percent: p?.markup_percent ?? '', unit: p?.unit ?? 'pc',
      low_stock_threshold: p?.low_stock_threshold ?? 5, is_active: p?.is_active ?? true, is_available: p?.is_available ?? true, is_featured: p?.is_featured ?? false,
    } : undefined,
  });
  const imgs = images ?? p?.images ?? [];
  const w = watch();
  const sh = data.data?.shs.find((s) => s.id === w.stakeholder_id);
  const markup = w.markup_percent === '' || w.markup_percent == null ? Number(sh?.markup_percent ?? 0) : Number(w.markup_percent);
  const finalPrice = useMemo(() => Math.round(Number(w.base_price || 0) * (1 + markup / 100) * 100) / 100, [w.base_price, markup]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const urls: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) { toast('error', `${file.name}: images up to 5 MB only`); continue; }
      try { urls.push(await uploadFile(file, 'product')); }
      catch (e) { toast('error', `${file.name}: ${errorText(e)}`); }
    }
    setImages([...imgs, ...urls]); setUploading(false);
  }

  async function onSubmit(v: ProductForm) {
    const row = { ...v, markup_percent: v.markup_percent === '' ? null : v.markup_percent, sku: v.sku || null, images: imgs };
    const res = isNew
      ? await db.from('products').insert({ ...row, slug: `${slugify(v.name)}-${Math.random().toString(36).slice(2, 5)}` }).select('id').single()
      : await db.from('products').update(row).eq('id', id!).select('id').single();
    if (res.error) return toast('error', errorText(res.error));
    toast('success', 'Product saved');
    nav(`/admin/products/${res.data.id}`, { replace: true });
    void data.reload();
  }

  async function remove() {
    if (!(await confirm('Delete product?', 'Only products that were never ordered or stocked can be deleted. Otherwise switch it off (untick Active).', 'Delete', true))) return;
    const { error } = await db.from('products').delete().eq('id', id!);
    if (error) toast('error', 'This product has orders or stock history. Untick Active to hide it instead.');
    else { toast('success', 'Product deleted'); nav('/admin/products'); }
  }

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <PageHeader title={isNew ? 'New product' : p?.name} actions={<>
        {!isNew && <Button type="button" variant="danger" onClick={remove}>Delete</Button>}
        <Button type="submit" loading={isSubmitting}>Save product</Button></>} />
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Panel title="Details">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" error={errors.name?.message} className="sm:col-span-2"><Input {...register('name')} /></Field>
              <Field label="Category" error={errors.category_id?.message}><Select {...register('category_id')}><option value="">Choose…</option>{data.data!.cats.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status !== 'active' ? ' (off)' : ''}</option>)}</Select></Field>
              <Field label="Stakeholder" error={errors.stakeholder_id?.message}><Select {...register('stakeholder_id')}>{data.data!.shs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
              <Field label="SKU (optional)"><Input {...register('sku')} /></Field>
              <Field label="Unit" hint="pc, pack, bottle…"><Input {...register('unit')} /></Field>
              <Field label="Description" className="sm:col-span-2"><Textarea rows={4} {...register('description')} /></Field>
            </div>
          </Panel>
          <Panel title="Pricing">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Cost price (GH₵)" hint="What it costs you"><Input type="number" step="0.01" {...register('cost_price')} /></Field>
              <Field label="Selling price (GH₵)" error={errors.base_price?.message} hint={sh && !sh.is_platform_owner ? `${sh.name}'s price` : 'Before markup'}><Input type="number" step="0.01" {...register('base_price')} /></Field>
              <Field label="Markup %" hint={`Blank uses ${sh?.name ?? 'stakeholder'} default (${sh?.markup_percent ?? 0}%)`}><Input type="number" step="0.01" {...register('markup_percent')} /></Field>
            </div>
            <p className="mt-3 rounded-md bg-navy-50 px-3 py-2 text-sm">Customer pays <strong className="text-navy">{money(finalPrice)}</strong>
              {sh && !sh.is_platform_owner ? <> · {sh.name} gets {money(Number(w.base_price || 0))} · you keep {money(finalPrice - Number(w.base_price || 0))}</> : <> · margin {money(finalPrice - Number(w.cost_price || 0))}</>}</p>
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="Visibility">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-navy" {...register('is_active')} />Active (shown in shop)</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-navy" {...register('is_available')} />Available to buy</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-navy" {...register('is_featured')} />Featured on home page</label>
              <Field label="Low-stock alert at"><Input type="number" {...register('low_stock_threshold')} /></Field>
            </div>
          </Panel>
          <Panel title="Images">
            <div className="grid grid-cols-3 gap-2">
              {imgs.map((u: string) => (
                <div key={u} className="relative"><img src={u} alt="" className="aspect-square w-full rounded object-cover" />
                  <button type="button" onClick={() => setImages(imgs.filter((x: string) => x !== u))} className="absolute right-1 top-1 rounded-full bg-white/90 p-0.5" aria-label="Remove image"><X className="h-3 w-3" /></button></div>
              ))}
              {imgs.length === 0 && <PlainBox className="aspect-square w-full rounded" />}
              <label className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded border border-dashed border-charcoal-300 text-xs text-charcoal-400 hover:border-navy">
                <ImagePlus className="h-5 w-5" />{uploading ? 'Uploading…' : 'Add'}
                <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => upload(e.target.files)} />
              </label>
            </div>
            <p className="mt-2 text-xs text-charcoal-400">No photo? The shop shows a plain box — discreet by default.</p>
          </Panel>
          {!isNew && (
            <Panel title="Stock by distributor" actions={<Link to="/admin/inventory" className="text-xs text-navy underline">Adjust</Link>}>
              {data.data!.stock.length === 0 ? <p className="text-sm text-charcoal-400">Not stocked anywhere yet.</p> : (
                <ul className="space-y-1 text-sm">{data.data!.stock.map((s: any, i: number) => <li key={i} className="flex justify-between"><span>{s.distributors?.name}</span><span className="tabular-nums">{s.on_hand}{s.reserved > 0 && ` (${s.reserved} held)`}</span></li>)}</ul>
              )}
            </Panel>
          )}
        </div>
      </div>
      {dialog}
    </form>
  );
}

const STATUS_OPTS = (vals: string[]) => vals.map((v) => ({ value: v, label: humanize(v) }));

export function CategoriesPage() {
  const toast = useToast();
  const move = async (row: any, dir: -1 | 1, reload: () => void) => {
    const { error } = await db.from('categories').update({ sort_order: row.sort_order + dir * 1.5 }).eq('id', row.id);
    if (error) return toast('error', errorText(error));
    const { data } = await db.from('categories').select('id,sort_order').order('sort_order');
    await Promise.all((data ?? []).map((c, i) => db.from('categories').update({ sort_order: i + 1 }).eq('id', c.id)));
    reload();
  };
  return (
    <div>
      <PageHeader title="Categories" description="Turning a category off hides all its products from the shop. Orders already placed are kept." />
      <CrudTable<any> table="categories" title="Categories" noun="Category" autoSlug canDelete deleteLabel="Delete"
        select="*, products(count)" order={[{ column: 'sort_order' }]}
        transform={(v) => { delete v.products; return v; }}
        columns={[
          { label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
          { label: 'Group', render: (r) => r.description ?? '—' },
          { label: 'Products', render: (r) => r.products?.[0]?.count ?? 0 },
          { label: 'Status', render: (r) => <Badge value={r.status} /> },
        ]}
        rowActions={(r, reload) => <>
          <button className="rounded p-1.5 text-charcoal-400 hover:text-navy" onClick={() => move(r, -1, reload)} aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>
          <button className="rounded p-1.5 text-charcoal-400 hover:text-navy" onClick={() => move(r, 1, reload)} aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>
          <button className="mx-1 text-xs text-navy underline" onClick={async () => { await db.from('categories').update({ status: r.status === 'active' ? 'inactive' : 'active' }).eq('id', r.id); reload(); }}>{r.status === 'active' ? 'Turn off' : 'Turn on'}</button>
        </>}
        fields={[
          { name: 'name', label: 'Name', required: true },
          { name: 'description', label: 'Group / description', hint: 'e.g. Classic' },
          { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTS(['active', 'inactive', 'archived']), default: 'active' },
          { name: 'sort_order', label: 'Position', type: 'number', default: 99 },
        ]} />
    </div>
  );
}

export function StakeholdersPage() {
  const balances = useAsync(async () => { const { data } = await db.rpc('stakeholder_balances'); return (data ?? []) as any[]; });
  const bal = (id: string) => balances.data?.find((b) => b.stakeholder_id === id);
  return (
    <div>
      <PageHeader title="Stakeholders" description="Partners who sell through your platform. Switching a stakeholder off removes all their products from the shop instantly; their orders, stock and money history stay." />
      <CrudTable<any> table="stakeholders" title="Stakeholders" noun="Stakeholder" autoSlug select="*, products(count)" order={[{ column: 'is_platform_owner', ascending: false }, { column: 'name' }]}
        transform={(v) => { delete v.products; return v; }}
        columns={[
          { label: 'Name', render: (r) => <><span className="font-medium">{r.name}</span>{r.is_platform_owner && <div className="text-xs text-charcoal-400">You</div>}</> },
          { label: 'Markup', render: (r) => `${r.markup_percent}%` },
          { label: 'Products', render: (r) => r.products?.[0]?.count ?? 0 },
          { label: 'Owed to them', render: (r) => r.is_platform_owner ? '—' : bal(r.id) ? money(bal(r.id).outstanding) : '—' },
          { label: 'Contact (private)', render: (r) => <span className="text-xs">{[r.contact_name, r.phone].filter(Boolean).join(' · ') || '—'}</span> },
          { label: 'Status', render: (r) => <Badge value={r.status} /> },
        ]}
        rowActions={(r, reload) => !r.is_platform_owner && (
          <button className="mx-1 text-xs text-navy underline" onClick={async () => { await db.from('stakeholders').update({ status: r.status === 'active' ? 'inactive' : 'active' }).eq('id', r.id); reload(); }}>
            {r.status === 'active' ? 'Switch off' : 'Switch on'}</button>
        )}
        fields={[
          { name: 'name', label: 'Name', required: true },
          { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTS(['active', 'inactive', 'suspended']), default: 'active' },
          { name: 'markup_percent', label: 'Our markup %', type: 'number', step: '0.01', default: 15, hint: 'Added on top of their price' },
          { name: 'commission_percent', label: 'Commission % of their price', type: 'number', step: '0.01', default: 0, hint: 'Optional extra cut' },
          { name: 'contact_name', label: 'Contact person' },
          { name: 'phone', label: 'Phone (never shown to customers)' },
          { name: 'email', label: 'Email' },
          { name: 'pricing_arrangement', label: 'Pricing arrangement', type: 'textarea' },
          { name: 'settlement_arrangement', label: 'Settlement arrangement', type: 'textarea' },
          { name: 'description', label: 'Notes', type: 'textarea' },
        ]} />
    </div>
  );
}
