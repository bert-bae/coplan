/**
 * Motion, in one place.
 *
 * The stylesheet honours `prefers-reduced-motion` for everything it owns, but
 * a scroll started from JavaScript carries its own behaviour and would keep
 * animating regardless. Asking here means the preference is respected by the
 * whole app rather than by the CSS half of it.
 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
