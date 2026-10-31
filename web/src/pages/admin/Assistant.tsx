import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { callApi, db } from '@/lib/neon';
import { useAsync, q } from '@/hooks/useAsync';
import { Badge, Button, PageHeader, Select, useToast } from '@/components/ui';
import { cn, errorText } from '@/lib/format';

type Proposal = { id: string; type: string; summary?: string; preview: { title: string; rows: Record<string, unknown>[]; footer?: string; reason?: string } };
type Msg = { role: 'user' | 'assistant'; content: string; proposal?: Proposal; state?: 'done' | 'rejected' | 'failed'; result?: string; model?: string };

const EXAMPLES = [
  'Which orders are still pending?',
  'Restock Legon North with 20 Classic Condoms (3-pack) at GH₵6 each, paid by momo',
  'Move 10 pregnancy tests from HQ Stock to UPSA Team',
  'Sales by hostel for the last 30 days',
  'Turn off the Lubricants category',
  'Add these products for Goldy: Silk Ribbon Set 80, Velvet Massager 150 (category Adult Toys)',
];

export function AssistantPage() {
  const toast = useToast();
  const providers = useAsync(() => q<any[]>(db.from('ai_provider_settings').select('id,name,model,scope,is_enabled,requires_key,has_key').eq('is_enabled', true).in('scope', ['admin', 'both']).order('priority')));
  const [provider, setProvider] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy]);

  async function send(t = text) {
    if (!t.trim() || busy) return;
    const next = [...msgs, { role: 'user' as const, content: t.trim() }];
    setMsgs(next); setText(''); setBusy(true);
    const history = next.map((m) => ({ role: m.role, content: m.proposal ? `${m.content}\n[Proposed ${m.proposal.type}: ${m.state ?? 'awaiting confirmation'}${m.result ? ` — ${m.result}` : ''}]` : m.content }));
    const { data, error } = await callApi('admin-assistant', { mode: 'chat', messages: history, provider_id: provider || undefined });
    setBusy(false);
    if (error) return setMsgs([...next, { role: 'assistant', content: `Couldn't reach the assistant: ${errorText(error)}. Check that the admin-assistant function is deployed.` }]);
    setMsgs([...next, { role: 'assistant', content: data.reply ?? data.error, proposal: data.proposal, model: data.model }]);
  }

  async function decide(i: number, ok: boolean) {
    const m = msgs[i];
    if (!m.proposal) return;
    const { data, error } = await callApi('admin-assistant', { mode: ok ? 'execute' : 'reject', action_id: m.proposal.id });
    const failed = error || data?.ok === false;
    setMsgs((all) => all.map((x, j) => (j === i ? { ...x, state: !ok ? 'rejected' : failed ? 'failed' : 'done', result: failed ? errorText(error ?? data.error) : ok ? 'Done' : undefined } : x)));
    if (ok) toast(failed ? 'error' : 'success', failed ? `Not saved: ${errorText(error ?? data.error)}` : 'Saved');
  }

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <PageHeader title="Sarah Assistant" description="Ask questions or give instructions in plain words. Nothing changes until you press Confirm."
        actions={<Select className="w-64" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Model">
          <option value="">Automatic (best available)</option>
          {providers.data?.map((p) => <option key={p.id} value={p.id} disabled={p.requires_key && !p.has_key}>{p.name} · {p.model}{p.requires_key && !p.has_key ? ' (add key)' : ''}</option>)}
        </Select>} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border border-charcoal-300/40 bg-white p-4">
        {msgs.length === 0 && (
          <div className="py-6">
            <p className="flex items-center gap-2 text-sm text-charcoal-500"><Sparkles className="h-4 w-4 text-ember" />Try one of these, or paste a list of products, prices or stock counts.</p>
            <div className="mt-3 flex flex-wrap gap-2">{EXAMPLES.map((e) => <button key={e} onClick={() => send(e)} className="rounded-full border border-navy/20 px-3 py-1.5 text-left text-sm text-navy hover:bg-navy-50">{e}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
            <div className={cn('max-w-[90%] whitespace-pre-wrap rounded-xl px-3.5 py-2 text-sm', m.role === 'user' ? 'bg-navy text-cream' : 'bg-cream-100 text-charcoal-800')}>{m.content}</div>
            {m.model && <span className="mt-0.5 text-[11px] text-charcoal-300">{m.model}</span>}
            {m.proposal && (
              <div className="mt-2 w-full max-w-3xl rounded-lg border-2 border-dashed border-kraft-600/50 bg-cream/60 p-3">
                <div className="mb-2 flex items-center justify-between"><p className="text-sm font-medium text-navy">{m.proposal.preview.title}</p>
                  {m.state && <Badge value={m.state === 'done' ? 'paid' : m.state === 'failed' ? 'failed' : 'inactive'} label={m.state === 'done' ? 'Saved' : humanizeState(m.state)} />}</div>
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead><tr>{Object.keys(m.proposal.preview.rows[0] ?? {}).map((h) => <th key={h} className="table-head">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-kraft-600/20">{m.proposal.preview.rows.map((r, k) => <tr key={k}>{Object.values(r).map((v, j) => <td key={j} className="table-cell">{String(v)}</td>)}</tr>)}</tbody>
                </table></div>
                {(m.proposal.preview.footer || m.proposal.preview.reason) && <p className="mt-2 text-xs text-charcoal-500">{m.proposal.preview.footer ?? `Reason: ${m.proposal.preview.reason}`}</p>}
                {m.state === 'failed' && <p className="mt-2 text-sm text-red-700">{m.result}</p>}
                {!m.state && <div className="mt-3 flex gap-2"><Button size="sm" variant="action" onClick={() => decide(i, true)}>Confirm</Button><Button size="sm" variant="ghost" onClick={() => decide(i, false)}>Reject</Button></div>}
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-sm text-charcoal-400">Working…</p>}
        <div ref={end} />
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="e.g. Set Akuafo stock of pregnancy tests to 15 — reason: weekly count"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); void send(); } }}
          className="flex-1 resize-none rounded-lg border border-charcoal-300/60 bg-white px-3 py-2 text-sm focus:border-navy focus:outline-none" />
        <Button type="submit" size="lg" disabled={busy || !text.trim()} aria-label="Send"><Send className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}
const humanizeState = (s: string) => (s === 'rejected' ? 'Rejected' : 'Failed');
