import { describe, expect, it } from 'vitest';
import {
  ansiBackground,
  ansiForeground,
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  SHELL_CSS_VARIABLES,
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
  it('ships genuinely distinct light and dark terminal appearances', () => {
    for (const theme of Object.values(TERMINAL_THEMES)) {
      if (theme.appearance === 'light') {
        expect(perceivedLightness(theme.palette.background)).toBeGreaterThan(220);
        expect(perceivedLightness(theme.palette.foreground)).toBeLessThan(90);
      } else {
        expect(perceivedLightness(theme.palette.background)).toBeLessThan(48);
        expect(perceivedLightness(theme.palette.foreground)).toBeGreaterThan(150);
      }
      expect(theme.palette.foreground).not.toBe(theme.palette.background);
    }
  });

  it('paints the canvas and the surface around it the same colour', () => {
    /*
     * The xterm canvas only covers whole character cells, so a strip of `--surface-terminal` is
     * always visible below and to the right of the grid. If it differs from the palette background
     * that strip reads as a frame around the terminal — which is the black-border bug, since
     * xterm.css defaults that surround to #000.
     */
    for (const [id, theme] of Object.entries(TERMINAL_THEMES)) {
      expect(theme.palette.background, `${id} canvas vs surround`).toBe(
        theme.shell.surfaceTerminal,
      );
    }
  });

  it('validates persisted theme identifiers', () => {
    expect(isTerminalThemeId(DEFAULT_TERMINAL_THEME)).toBe(true);
    expect(isTerminalThemeId('claude')).toBe(true);
    expect(isTerminalThemeId('telegram')).toBe(true);
    expect(isTerminalThemeId('pure-white')).toBe(false);
    expect(isTerminalThemeId(null)).toBe(false);
  });

  it('ships a complete personality contract for every theme', () => {
    for (const [id, theme] of Object.entries(TERMINAL_THEMES)) {
      for (const field of Object.keys(SHELL_CSS_VARIABLES)) {
        expect(theme.shell[field as keyof typeof theme.shell], `${id}.${field}`).toBeTruthy();
      }
    }

    expect(TERMINAL_THEMES.claude.shell.fontUi).toContain('Inter Variable');
    expect(TERMINAL_THEMES.claude.shell.fontDisplay).toContain('Source Serif 4 Variable');
    expect(TERMINAL_THEMES.telegram.shell.fontUi).toContain('Open Sans Variable');
    expect(TERMINAL_THEMES.telegram.shell.fontDisplay).toBe(TERMINAL_THEMES.telegram.shell.fontUi);
    expect(TERMINAL_THEMES.claude.shell.radiusBubble).not.toBe(
      TERMINAL_THEMES.telegram.shell.radiusBubble,
    );
    expect(TERMINAL_THEMES.claude.shell.lineHeightBody).not.toBe(
      TERMINAL_THEMES.telegram.shell.lineHeightBody,
    );
    expect(TERMINAL_THEMES.graphite.shell.fontUi).toContain('Segoe UI Variable');
    expect(TERMINAL_THEMES.midnight.shell.fontUi).toContain('Segoe UI Variable');
  });

  it('converts strict hex palette values to PowerShell ANSI true colour', () => {
    expect(ansiForeground('#246c72')).toBe('$([char]0x1b)[38;2;36;108;114m');
    expect(ansiBackground('#EAD8CF')).toBe('$([char]0x1b)[48;2;234;216;207m');
    expect(() => ansiForeground('#fff')).toThrow(/#RRGGBB/);
    expect(() => ansiBackground('red')).toThrow(/#RRGGBB/);
  });
});
