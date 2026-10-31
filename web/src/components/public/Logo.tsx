import { cn } from '@/lib/format';

/** The "sp" badge: a soft squircle with a two-tone split and a gloss — a hint of a pill, not a cartoon one. */
export function LogoBadge({ className }: { className?: string }) {
  return (
    <span className={cn('relative flex h-[34px] w-[40px] -rotate-6 items-center justify-center overflow-hidden rounded-[13px] text-[15px] font-extrabold tracking-[-0.04em] text-navy shadow-[0_3px_0_0_#E0448F] transition-transform duration-300 ease-[cubic-bezier(.3,.7,.4,1.5)] group-hover:rotate-6 group-active:scale-90', className)}
      style={{ background: 'linear-gradient(90deg, #FF7AB8 0 50%, #FF9ACB 50% 100%)' }} aria-hidden>
      <span className="absolute left-[6px] top-[4px] h-[7px] w-[13px] rounded-full bg-white/55 blur-[0.5px]" />
      <span className="relative">sp</span>
    </span>
  );
}

