import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CartLine } from '@/lib/types';

type CartState = {
  lines: CartLine[]; count: number; subtotal: number;
  add: (l: Omit<CartLine, 'quantity'>, qty?: number) => void; setQty: (id: string, q: number) => void;
  remove: (id: string) => void; clear: () => void;
};
const Ctx = createContext<CartState | null>(null);
const KEY = 'sp_cart_v1';

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => {
    try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* storage unavailable */ } }, [lines]);

  const value = useMemo<CartState>(() => ({
    lines,
    count: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal: lines.reduce((s, l) => s + l.quantity * l.price, 0),
    add: (l, qty = 1) => setLines((prev) => {
      const found = prev.find((p) => p.product_id === l.product_id);
      const cap = (q: number) => Math.max(1, Math.min(q, l.max && l.max > 0 ? l.max : 100));
      return found ? prev.map((p) => (p.product_id === l.product_id ? { ...p, ...l, quantity: cap(p.quantity + qty) } : p))
                   : [...prev, { ...l, quantity: cap(qty) }];
    }),
    setQty: (id, q) => setLines((prev) => prev.map((p) => (p.product_id === id ? { ...p, quantity: Math.max(1, Math.min(q, 100)) } : p))),
    remove: (id) => setLines((prev) => prev.filter((p) => p.product_id !== id)),
    clear: () => setLines([]),
  }), [lines]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCart outside provider');
  return v;
}
