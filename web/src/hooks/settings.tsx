import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { db } from '@/lib/neon';

export type PublicSettings = Record<string, any>;
const DEFAULTS: PublicSettings = {
  business_name: 'SarahPetermore', tagline: 'No long talk. Just get it.', hero_title: 'No long talk.',
  hero_subtitle: 'Condoms, tests, postpills and toys. Packed plain, brought to you, paid for when it arrives.',
  discreet_note: 'Every order is packed in a plain box. No product names on the outside.',
};
const Ctx = createContext<{ s: PublicSettings; reload: () => void }>({ s: DEFAULTS, reload: () => {} });

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<PublicSettings>(DEFAULTS);
  const load = () => {
    db.from('system_settings').select('key,value').eq('is_public', true).then(({ data }) => {
      if (data) setS({ ...DEFAULTS, ...Object.fromEntries(data.map((r) => [r.key, r.value])) });
    });
  };
  useEffect(load, []);
  return <Ctx.Provider value={{ s, reload: load }}>{children}</Ctx.Provider>;
}
export const useSettings = () => useContext(Ctx);

/**
 * Contacts that may appear anywhere on the public site. Phone numbers are deliberately NOT here:
 * customers only see a number on their order confirmation, after they've placed an order.
 */
export function contactList(s: PublicSettings) {
  const out: { label: string; value: string; href: string }[] = [];
  if (s.contact_snapchat) {
    const h = String(s.contact_snapchat).replace(/^@/, '');
    out.push({ label: 'Snapchat', value: `@${h}`, href: `https://snapchat.com/add/${h}` });
  }
  return out;
}
