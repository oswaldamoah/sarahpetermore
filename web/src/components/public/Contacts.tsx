import { Phone, MessageSquare } from 'lucide-react';
import type { Contact } from '@/lib/types';
import { cn } from '@/lib/format';
import { haptic } from '@/lib/haptics';

export function ContactCards({ contacts, small, reference }: { contacts: { primary: Contact[]; backup: Contact[] }; small?: boolean; reference?: string }) {
  const backup = contacts.backup.filter((b) => !contacts.primary.some((p) => p.phone && p.phone === b.phone));
  return (
    <div className={cn('space-y-3', small ? 'mt-2' : '')}>
      <div className="space-y-2">
        {contacts.primary.map((c, i) => {
          const wa = c.phone ? `https://wa.me/${c.phone.replace(/\D/g, '').replace(/^0/, '233')}${reference ? `?text=${encodeURIComponent(`Hi, it's about my order ${reference}`)}` : ''}` : null;
          return (
            <div key={i} className={cn('flex items-center justify-between gap-3 rounded-[20px] bg-navy text-white', small ? 'px-3 py-2' : 'px-4 py-3')}>
              <span className="min-w-0">
                <span className="block text-xs text-white/60">{c.label}</span>
                <span className="font-semibold">{c.name && c.name !== 'SarahPetermore' ? `${c.name} · ` : ''}{c.phone || 'Number coming soon'}</span>
              </span>
              {c.phone && <span className="flex shrink-0 gap-1.5">
                <a href={`tel:${c.phone}`} onClick={() => haptic()} className="press flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20" aria-label={`Call ${c.name ?? c.label}`}><Phone className="h-4 w-4" /></a>
                {wa && <a href={wa} target="_blank" rel="noreferrer" onClick={() => haptic()} className="press flex h-10 items-center gap-1.5 rounded-full bg-ember px-3.5 text-sm font-semibold text-navy" aria-label={`WhatsApp ${c.name ?? c.label}`}><MessageSquare className="h-4 w-4" />WhatsApp</a>}
              </span>}
            </div>
          );
        })}
      </div>
      {backup.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-charcoal-400">Can't reach them? Use any of these:</p>
          <ul className="flex flex-wrap gap-2">
            {backup.map((b, i) => (
              <li key={i}>
                <a href={b.handle ? `https://snapchat.com/add/${b.handle.replace(/^@/, '')}` : b.label === 'WhatsApp' ? `https://wa.me/${(b.phone ?? '').replace(/\D/g, '').replace(/^0/, '233')}` : `tel:${b.phone}`}
                  className="press inline-flex items-center gap-1.5 rounded-full border-2 border-navy/10 bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:bg-ember-50">
                  {b.handle ? <MessageSquare className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                  {b.label}: {b.handle ? `@${b.handle.replace(/^@/, '')}` : b.phone}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
