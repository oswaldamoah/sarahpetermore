import { createContext, forwardRef, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2, X, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { cn, humanize } from '@/lib/format';
import { haptic } from '@/lib/haptics';

// ---------- Buttons ----------
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'action' | 'outline' | 'ghost' | 'danger' | 'quiet'; size?: 'sm' | 'md' | 'lg'; loading?: boolean;
};
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'primary', size = 'md', loading, className, children, disabled, onPointerDown, ...rest }, ref) {
  const pop = variant === 'primary' || variant === 'action' || variant === 'outline';
  const v = {
    primary: 'btn-pop btn-pink',
    action: 'btn-pop btn-ink',
    outline: 'btn-pop btn-soft',
    ghost: 'rounded-full text-navy hover:bg-ember-50 press',
    quiet: 'rounded-full text-charcoal-500 hover:text-navy press',
    danger: 'rounded-full bg-white border-2 border-red-200 text-red-700 hover:bg-red-50 press',
  }[variant];
  const s = { sm: 'h-8 px-3.5 text-sm', md: 'h-11 px-5 text-[0.95rem]', lg: 'h-[52px] px-7 text-base' }[size];
  return (
    <button ref={ref} disabled={disabled || loading}
      onPointerDown={(e) => { if (!disabled && !loading) haptic(); onPointerDown?.(e); }}
      className={cn('inline-flex items-center justify-center gap-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50', pop ? '' : 'transition-colors', v, s, className)}
      {...rest}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

// ---------- Form controls ----------
const control = 'rounded-2xl border-2 border-navy/10 bg-white px-3.5 text-[1rem] text-charcoal-800 placeholder:text-charcoal-300 transition focus:border-ember focus:outline-none focus:ring-4 focus:ring-ember/15 disabled:bg-cream-100';
// Full width unless the caller sets its own width.
const widthOf = (className?: string) => (className && /(^|\s)(max-)?w-/.test(className) ? '' : 'w-full');
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(control, widthOf(className), 'h-11', className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(control, widthOf(className), 'min-h-[84px] py-2', className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return <select ref={ref} className={cn(control, widthOf(className), 'h-11 pr-8', className)} {...p}>{children}</select>;
});

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-sm font-medium text-charcoal-800">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-700">{error}</span> : hint ? <span className="mt-1 block text-xs text-charcoal-400">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-navy" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ---------- Feedback ----------
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('h-5 w-5 animate-spin text-navy', className)} aria-label="Loading" />;

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="flex items-center gap-2 py-10 text-sm text-charcoal-400"><Spinner />{label}…</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1">{message}</div>
      {onRetry && <button className="font-medium underline" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-charcoal-300/70 px-6 py-10 text-center">
      <p className="font-medium text-charcoal-800">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-charcoal-400">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  received: 'bg-navy-50 text-navy', confirmed: 'bg-navy-100 text-navy', processing: 'bg-cream-200 text-charcoal-800',
  ready_for_delivery: 'bg-kraft-100 text-kraft-700', out_for_delivery: 'bg-ember-50 text-ember-700', delivered: 'bg-sage-100 text-sage-800',
  cancelled: 'bg-charcoal-300/25 text-charcoal-500', refund_pending: 'bg-ember-50 text-ember-700', refunded: 'bg-charcoal-300/25 text-charcoal-500',
  failed_delivery: 'bg-red-50 text-red-700', returned: 'bg-charcoal-300/25 text-charcoal-500',
  unpaid: 'bg-ember-50 text-ember-700', pending: 'bg-cream-200 text-charcoal-800', partially_paid: 'bg-kraft-100 text-kraft-700', paid: 'bg-sage-100 text-sage-800',
  failed: 'bg-red-50 text-red-700', active: 'bg-sage-100 text-sage-800', inactive: 'bg-charcoal-300/25 text-charcoal-500',
  suspended: 'bg-red-50 text-red-700', archived: 'bg-charcoal-300/25 text-charcoal-500', draft: 'bg-cream-200 text-charcoal-800',
  in_transit: 'bg-ember-50 text-ember-700', open: 'bg-ember-50 text-ember-700', in_progress: 'bg-navy-50 text-navy', resolved: 'bg-sage-100 text-sage-800',
  closed: 'bg-charcoal-300/25 text-charcoal-500', courier: 'bg-kraft-100 text-kraft-700', distributor: 'bg-navy-50 text-navy',
};
export function Badge({ value, label, className }: { value: string; label?: string; className?: string }) {
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium', STATUS_TONE[value] ?? 'bg-cream-200 text-charcoal-800', className)}>{label ?? humanize(value)}</span>;
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/40 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}
        className={cn('flex max-h-[92vh] w-full flex-col rounded-t-xl bg-white shadow-xl sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-charcoal-300/30 px-5 py-3">
          <h2 className="font-sans text-base font-semibold text-navy">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-charcoal-400 hover:bg-cream-100" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-charcoal-300/30 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    if (kind !== 'info') haptic(kind === 'error' ? 'error' : 'success');
    setList((l) => [...l, { id, kind, text }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-[calc(84px+env(safe-area-inset-bottom))] left-1/2 z-[60] flex w-[min(92vw,420px)] -translate-x-1/2 flex-col gap-2 md:bottom-6" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={cn('pop-in pointer-events-auto flex items-start gap-2 rounded-2xl px-4 py-3 text-sm font-medium shadow-card',
            t.kind === 'error' ? 'bg-red-700 text-white' : t.kind === 'success' ? 'bg-navy text-white' : 'bg-charcoal-800 text-white')}>
            {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : t.kind === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4" /> : <Info className="mt-0.5 h-4 w-4" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Confirm ----------
export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: ReactNode; confirmLabel: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = (title: string, body: ReactNode, confirmLabel = 'Confirm', danger = false) =>
    new Promise<boolean>((resolve) => setState({ title, body, confirmLabel, danger, resolve }));
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  const dialog = (
    <Modal open={!!state} onClose={() => close(false)} title={state?.title ?? ''}
      footer={<><Button variant="ghost" onClick={() => close(false)}>Back</Button>
        <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel}</Button></>}>
      <div className="text-sm text-charcoal-800">{state?.body}</div>
    </Modal>
  );
  return { confirm, dialog };
}

// ---------- Layout helpers (admin) ----------
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-sans text-xl font-semibold text-navy">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-charcoal-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-3xl border border-navy/10 bg-white', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-charcoal-300/30 px-4 py-2.5">
          {title && <h2 className="font-sans text-sm font-semibold text-charcoal-800">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'good' }) {
  return (
    <div className="rounded-lg border border-charcoal-300/40 bg-white px-4 py-3">
      <div className="text-xs text-charcoal-400">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', tone === 'warn' ? 'text-ember-700' : tone === 'good' ? 'text-sage-800' : 'text-navy')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-charcoal-400">{sub}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-charcoal-300/40">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} onClick={() => onChange(i.value)}
          className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm', value === i.value ? 'border-navy font-medium text-navy' : 'border-transparent text-charcoal-400 hover:text-navy')}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-charcoal-300/40 bg-white">
      <table className="w-full min-w-[640px] border-collapse">
        <thead className="border-b border-charcoal-300/40 bg-cream-100/60"><tr>{head.map((h, i) => <th key={i} className="table-head">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-charcoal-300/25">{children}</tbody>
      </table>
      {empty && <div className="px-4 py-8 text-center text-sm text-charcoal-400">Nothing here yet.</div>}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-charcoal-400">
      <span>{total === 0 ? 'No results' : `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} of ${total}`}</span>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}
