import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { db } from '@/lib/neon';
import type { Role } from '@/lib/types';

type Session = { access_token: string; user: { id: string; email?: string | null } };

type AuthState = {
  session: Session | null; loading: boolean; roles: Role[];
  isStaff: boolean; can: (...r: Role[]) => boolean; refreshRoles: () => Promise<void>; signOut: () => Promise<void>;
  /** Re-read the session from the server (call right after signing in). */
  refresh: () => Promise<{ session: Session | null; roles: Role[] }>;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshRoles = async () => {
    const { data } = await db.rpc('my_roles');
    setRoles((data as Role[] | null) ?? []);
  };

  const refresh = async () => {
    const { data } = await db.auth.getSession({ forceFetch: true } as any).catch(() => db.auth.getSession());
    const s = (data?.session ?? null) as Session | null;
    setSession(s);
    let r: Role[] = [];
    if (s) {
      r = ((await db.rpc('my_roles')).data as Role[] | null) ?? [];
      void db.rpc('ensure_profile', {});
    }
    setRoles(r);
    setLoading(false);
    return { session: s, roles: r };
  };

  useEffect(() => {
    db.auth.getSession().then(async ({ data }) => {
      setSession(data.session as Session | null);
      if (data.session) { await refreshRoles(); void db.rpc('ensure_profile', {}); }
      setLoading(false);
    }).catch(() => setLoading(false));
    const { data: sub } = db.auth.onAuthStateChange((_e: unknown, s: any) => {
      setSession(s as Session | null);
      if (s) void refreshRoles(); else setRoles([]);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const can = (...r: Role[]) => roles.includes('super_admin') || r.some((x) => roles.includes(x));
  const value: AuthState = {
    session, loading, roles, isStaff: roles.some((r) => r !== 'distributor'), can, refreshRoles, refresh,
    signOut: async () => { await db.auth.signOut(); setRoles([]); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
