export const money = (n: number | string | null | undefined) =>
  `GH₵ ${Number(n ?? 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TZ = 'Africa/Accra';
export const dateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
export const dateOnly = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export const daysAgoISO = (n: number) => new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });

export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');

export const ORDER_STATUSES = ['received', 'confirmed', 'processing', 'ready_for_delivery', 'out_for_delivery', 'delivered',
  'cancelled', 'refund_pending', 'refunded', 'failed_delivery', 'returned'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CUSTOMER_STATUS_TEXT: Record<string, string> = {
  received: 'We have your order', confirmed: 'Confirmed', processing: 'Being packed', ready_for_delivery: 'Packed and ready',
  out_for_delivery: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled', refund_pending: 'Refund in progress',
  refunded: 'Refunded', failed_delivery: "We couldn't reach you", returned: 'Returned',
};

/** Database errors are raised as "CODE: message"; show only the message. */
/** Network hiccups (dropped connection, aborted request, timeout) that are worth retrying. */
export function isTransient(e: unknown): boolean {
  const n = (e as { name?: string })?.name ?? '';
  const m = (e as { message?: string })?.message ?? String(e);
  return n === 'AbortError' || /abort|failed to fetch|fetch failed|networkerror|network request failed|load failed|timed? ?out|ECONNRESET|503|502|504/i.test(m);
}

export function errorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  if (isTransient(e)) return 'Connection is slow right now. Tap "Try again".';
  return m.replace(/^[A-Z_]+:\s*/, '').replace(/^FORBIDDEN$/, 'You do not have permission for this action');
}

export const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
