/**
 * Clamps a percentage value to the 0-100 range for display consistency.
 * Exported for testing and production use.
 */
export const clampPercentage = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.min(100, Math.max(0, value));
