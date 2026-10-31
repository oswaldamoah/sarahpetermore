import { useState, type ReactNode } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { Button, Checkbox, ErrorBox, Field, Input, Loading, Modal, Select, Table, Textarea, useConfirm, useToast } from '@/components/ui';
import { errorText, slugify } from '@/lib/format';

export type FieldDef = {
  name: string; label: string; type?: 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date';
  options?: { value: string; label: string }[]; required?: boolean; hint?: string; step?: string; default?: unknown;
};
export type ColDef<T> = { label: string; render: (row: T) => ReactNode };

type Props<T> = {
  table: string; select?: string; order?: { column: string; ascending?: boolean }[];
  filter?: (q: any) => any; columns: ColDef<T>[]; fields: FieldDef[];
  title: string; noun: string; canEdit?: boolean; canCreate?: boolean; canDelete?: boolean; autoSlug?: boolean;
  deleteLabel?: string; onDelete?: (row: T) => Promise<void>; transform?: (values: Record<string, any>) => Record<string, any>;
  rowActions?: (row: T, reload: () => void) => ReactNode; toolbar?: ReactNode; deps?: unknown[];
};

/** Generic list + create/edit modal for simple config tables. Writes go through RLS. */
export function CrudTable<T extends { id: string }>(p: Props<T>) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [edit, setEdit] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useAsync(() => {
    let query = db.from(p.table).select(p.select ?? '*');
    if (p.filter) query = p.filter(query);
    for (const o of p.order ?? []) query = query.order(o.column, { ascending: o.ascending ?? true });
    return q<T[]>(query as any);
  }, p.deps ?? []);

  const blank = () => Object.fromEntries(p.fields.map((f) => [f.name, f.default ?? (f.type === 'checkbox' ? false : '')]));
  async function save() {
    if (!edit) return;
    for (const f of p.fields) if (f.required && (edit[f.name] === '' || edit[f.name] == null)) { toast('error', `${f.label} is required`); return; }
    setBusy(true);
    let row: Record<string, any> = {};
    for (const f of p.fields) {
      const v = edit[f.name];
      row[f.name] = f.type === 'number' ? (v === '' || v == null ? null : Number(v)) : v === '' ? null : v;
    }
    if (p.autoSlug && !edit.id) row.slug = `${slugify(row.name)}-${Math.random().toString(36).slice(2, 5)}`;
    if (p.transform) row = p.transform(row);
    const { error } = edit.id ? await db.from(p.table).update(row).eq('id', edit.id) : await db.from(p.table).insert(row);
    setBusy(false);
    if (error) toast('error', errorText(error));
    else { toast('success', `${p.noun} saved`); setEdit(null); void list.reload(); }
  }
  async function remove(row: T) {
    if (!(await confirm(`${p.deleteLabel ?? 'Delete'} ${p.noun.toLowerCase()}?`, 'This cannot be undone. Records linked to it (orders, stock) are kept.', p.deleteLabel ?? 'Delete', true))) return;
    try {
      if (p.onDelete) await p.onDelete(row);
      else { const { error } = await db.from(p.table).delete().eq('id', row.id); if (error) throw error; }
      toast('success', `${p.noun} removed`); void list.reload();
    } catch (e) {
      const m = errorText(e);
      toast('error', /foreign key|violates/i.test(m) ? `This ${p.noun.toLowerCase()} is used elsewhere. Deactivate it instead.` : m);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">{p.toolbar}</div>
        {p.canEdit !== false && p.canCreate !== false && <Button onClick={() => setEdit(blank())}><Plus className="h-4 w-4" />Add {p.noun.toLowerCase()}</Button>}
      </div>
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.loading ? <Loading /> : (
        <Table head={[...p.columns.map((c) => c.label), '']} empty={!list.data?.length}>
          {(list.data ?? []).map((r) => (
            <tr key={r.id} className="hover:bg-cream-100/40">
              {p.columns.map((c, i) => <td key={i} className="table-cell">{c.render(r)}</td>)}
              <td className="table-cell whitespace-nowrap text-right">
                {p.rowActions?.(r, list.reload)}
                {p.canEdit !== false && <button className="ml-1 rounded p-1.5 text-charcoal-400 hover:bg-cream-100 hover:text-navy" onClick={() => setEdit({ ...blank(), ...r })} aria-label="Edit"><Pencil className="h-4 w-4" /></button>}
                {p.canDelete && <button className="rounded p-1.5 text-charcoal-400 hover:bg-red-50 hover:text-red-700" onClick={() => remove(r)} aria-label="Delete"><Trash2 className="h-4 w-4" /></button>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`${edit?.id ? 'Edit' : 'New'} ${p.noun.toLowerCase()}`}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save {p.noun.toLowerCase()}</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            {p.fields.map((f) => {
              const v = edit[f.name] ?? '';
              const set = (val: unknown) => setEdit({ ...edit, [f.name]: val });
              if (f.type === 'checkbox') return <div key={f.name} className="sm:col-span-2"><Checkbox label={f.label} checked={!!v} onChange={set} /></div>;
              return (
                <Field key={f.name} label={f.label} hint={f.hint} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                  {f.type === 'textarea' ? <Textarea value={v} onChange={(e) => set(e.target.value)} />
                    : f.type === 'select' ? <Select value={v} onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                    : <Input type={f.type ?? 'text'} step={f.step} value={v} onChange={(e) => set(e.target.value)} required={f.required} />}
                </Field>
              );
            })}
          </div>
        )}
      </Modal>
      {dialog}
    </div>
  );
}
