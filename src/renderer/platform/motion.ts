/** Shared IDE-style motion: respond promptly, then decelerate without overshooting the target. */
export const SCROLL_DURATION_MS = 180;
export const EASE_OUT_CUBIC = 'cubic-bezier(0.333333, 1, 0.666667, 1)';
export const easeOutCubic = (progress: number): number => 1 - (1 - progress) ** 3;

export const prefersReducedMotion = (targetWindow: Window = window): boolean =>
  targetWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Programmatic user navigation uses Chromium's nonlinear smooth scroll, unless motion is reduced. */
export const userScrollBehavior = (): ScrollBehavior =>
  prefersReducedMotion() ? 'instant' : 'smooth';
