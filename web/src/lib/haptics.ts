/**
 * Tiny vibration feedback on phones that support it (most Android browsers).
 * iPhones ignore it silently. Respects the "reduce motion" accessibility setting.
 */
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function haptic(kind: 'tap' | 'success' | 'error' = 'tap') {
  try {
    if (reduced() || typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
    navigator.vibrate(kind === 'success' ? [12, 50, 22] : kind === 'error' ? [30, 40, 30] : 8);
  } catch { /* not supported */ }
}
