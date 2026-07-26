import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  TERMINAL_THEMES,
} from '../src/shared/terminal-themes';

const perceivedLightness = (hexColor: string): number => {
  const color = hexColor.replace('#', '');
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000;
};

describe('terminal themes', () => {
  it('ships only dark terminal backgrounds with readable foregrounds', () => {
    for (const theme of Object.values(TERMINAL_THEMES)) {
      expect(perceivedLightness(theme.palette.background)).toBeLessThan(48);
      expect(perceivedLightness(theme.palette.foreground)).toBeGreaterThan(150);
      expect(theme.palette.foreground).not.toBe(theme.palette.background);
    }
  });

  it('validates persisted theme identifiers', () => {
    expect(isTerminalThemeId(DEFAULT_TERMINAL_THEME)).toBe(true);
    expect(isTerminalThemeId('claude')).toBe(true);
    expect(isTerminalThemeId('pure-white')).toBe(false);
    expect(isTerminalThemeId(null)).toBe(false);
  });
});
