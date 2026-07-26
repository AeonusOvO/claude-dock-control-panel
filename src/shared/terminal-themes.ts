export type TerminalThemeId = 'claude' | 'graphite' | 'midnight';

export interface TerminalThemePalette {
  background: string;
  black: string;
  blue: string;
  brightBlack: string;
  brightBlue: string;
  brightCyan: string;
  brightGreen: string;
  brightMagenta: string;
  brightRed: string;
  brightWhite: string;
  brightYellow: string;
  cursor: string;
  cursorAccent: string;
  cyan: string;
  foreground: string;
  green: string;
  magenta: string;
  red: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  white: string;
  yellow: string;
}

/**
 * The shell colours that surround the terminal: titlebar, activity rail, sidebar, toolbar, footer
 * and cards. Every field maps one-to-one onto a CSS custom property (see `SHELL_CSS_VARIABLES`), so
 * picking a theme repaints the whole window instead of only the xterm canvas.
 */
export interface TerminalThemeShell {
  accentFg: string;
  accentLine: string;
  accentRing: string;
  accentSolid: string;
  accentSolidHover: string;
  accentText: string;
  accentTint: string;
  line: string;
  lineHover: string;
  lineStrong: string;
  lineSubtle: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceCanvas: string;
  surfaceInset: string;
  surfaceTerminal: string;
  text: string;
  textDim: string;
  textHi: string;
  textLo: string;
  textMute: string;
}

export interface TerminalThemeDefinition {
  label: string;
  palette: TerminalThemePalette;
  shell: TerminalThemeShell;
}

/** Shell field → CSS custom property. The renderer just walks this map; no per-theme wiring. */
export const SHELL_CSS_VARIABLES: Record<keyof TerminalThemeShell, string> = {
  accentFg: '--accent-fg',
  accentLine: '--accent-line',
  accentRing: '--accent-ring',
  accentSolid: '--accent-solid',
  accentSolidHover: '--accent-solid-hover',
  accentText: '--accent-text',
  accentTint: '--accent-tint',
  line: '--line',
  lineHover: '--line-hover',
  lineStrong: '--line-strong',
  lineSubtle: '--line-subtle',
  surface1: '--surface-1',
  surface2: '--surface-2',
  surface3: '--surface-3',
  surface4: '--surface-4',
  surfaceCanvas: '--surface-canvas',
  surfaceInset: '--surface-inset',
  surfaceTerminal: '--surface-terminal',
  text: '--text',
  textDim: '--text-dim',
  textHi: '--text-hi',
  textLo: '--text-lo',
  textMute: '--text-mute',
};

/** Hairlines are white alphas in every theme, so they read correctly on warm and cool surfaces. */
const HAIRLINES = {
  line: 'rgb(255 255 255 / 9%)',
  lineHover: 'rgb(255 255 255 / 20%)',
  lineStrong: 'rgb(255 255 255 / 13%)',
  lineSubtle: 'rgb(255 255 255 / 6%)',
} as const;

export const DEFAULT_TERMINAL_THEME: TerminalThemeId = 'graphite';

export const TERMINAL_THEMES: Record<TerminalThemeId, TerminalThemeDefinition> = {
  claude: {
    label: 'Claude 暖色',
    palette: {
      background: '#17130f',
      black: '#211b16',
      blue: '#7aa2f7',
      brightBlack: '#75675c',
      brightBlue: '#9bbcff',
      brightCyan: '#8ad8d2',
      brightGreen: '#a7d98b',
      brightMagenta: '#d8a6d8',
      brightRed: '#ff9b82',
      brightWhite: '#fff8ee',
      brightYellow: '#f3d98b',
      cursor: '#d97757',
      cursorAccent: '#17130f',
      cyan: '#65c3bd',
      foreground: '#eadfd2',
      green: '#8bcf75',
      magenta: '#c58ac5',
      red: '#e87962',
      selectionBackground: '#533a2d',
      selectionInactiveBackground: '#342922',
      white: '#ded2c5',
      yellow: '#d9b85f',
    },
    shell: {
      accentFg: '#1a0f08',
      accentLine: 'rgb(217 119 87 / 32%)',
      accentRing: 'rgb(240 161 132 / 55%)',
      accentSolid: '#d97757',
      accentSolidHover: '#e88b6b',
      accentText: '#f0a184',
      accentTint: 'rgb(217 119 87 / 12%)',
      ...HAIRLINES,
      surface1: '#1c1712',
      surface2: '#221b16',
      surface3: '#2a221b',
      surface4: '#332a21',
      surfaceCanvas: '#100c09',
      surfaceInset: '#130f0c',
      surfaceTerminal: '#17130f',
      text: '#d6c8b8',
      textDim: '#7c6b5b',
      textHi: '#f4ece2',
      textLo: '#a1907f',
      textMute: '#63544a',
    },
  },
  graphite: {
    label: '石墨深色',
    palette: {
      background: '#050708',
      black: '#12171b',
      blue: '#66b8ff',
      brightBlack: '#67747d',
      brightBlue: '#8dcdff',
      brightCyan: '#8deaff',
      brightGreen: '#78efbc',
      brightMagenta: '#dcb9ff',
      brightRed: '#ff8792',
      brightWhite: '#ffffff',
      brightYellow: '#ffe38a',
      cursor: '#68dcff',
      cursorAccent: '#081016',
      cyan: '#64d8ff',
      foreground: '#e4edf1',
      green: '#51e6a6',
      magenta: '#c997ff',
      red: '#ff6b7a',
      selectionBackground: '#294653',
      selectionInactiveBackground: '#1c2c33',
      white: '#d9e3e8',
      yellow: '#ffd66b',
    },
    /* Byte-for-byte the ladder that `styles.css` ships in `:root`, so the default look is unchanged. */
    shell: {
      accentFg: '#04121a',
      accentLine: 'rgb(46 168 216 / 30%)',
      accentRing: 'rgb(124 212 240 / 55%)',
      accentSolid: '#2ea8d8',
      accentSolidHover: '#3fb8e8',
      accentText: '#7cd4f0',
      accentTint: 'rgb(46 168 216 / 10%)',
      ...HAIRLINES,
      surface1: '#0b0e13',
      surface2: '#101419',
      surface3: '#151a20',
      surface4: '#1b2128',
      surfaceCanvas: '#07090c',
      surfaceInset: '#080b0f',
      surfaceTerminal: '#05070a',
      text: '#c2ccd4',
      textDim: '#66727c',
      textHi: '#e8eef2',
      textLo: '#8b98a3',
      textMute: '#525d67',
    },
  },
  midnight: {
    label: '深海蓝',
    palette: {
      background: '#07111c',
      black: '#0d1b29',
      blue: '#62aef7',
      brightBlack: '#64788d',
      brightBlue: '#91c9ff',
      brightCyan: '#7ee4e8',
      brightGreen: '#7fe0b2',
      brightMagenta: '#c6a7ff',
      brightRed: '#ff8b9a',
      brightWhite: '#f5fbff',
      brightYellow: '#f5d878',
      cursor: '#5bd5e5',
      cursorAccent: '#07111c',
      cyan: '#4ecbd7',
      foreground: '#d9e7f2',
      green: '#5bd39e',
      magenta: '#aa8be8',
      red: '#ef6f81',
      selectionBackground: '#214b66',
      selectionInactiveBackground: '#142f43',
      white: '#c9d7e2',
      yellow: '#dbbc58',
    },
    shell: {
      accentFg: '#02141a',
      accentLine: 'rgb(56 176 196 / 32%)',
      accentRing: 'rgb(126 216 226 / 55%)',
      accentSolid: '#38b0c4',
      accentSolidHover: '#4bc4d6',
      accentText: '#7ed8e2',
      accentTint: 'rgb(56 176 196 / 12%)',
      ...HAIRLINES,
      surface1: '#0b1725',
      surface2: '#101f30',
      surface3: '#16283b',
      surface4: '#1d3247',
      surfaceCanvas: '#050d16',
      surfaceInset: '#08131f',
      surfaceTerminal: '#07111c',
      text: '#c4d4e2',
      textDim: '#63788c',
      textHi: '#e9f2f9',
      textLo: '#8b9dae',
      textMute: '#4f6273',
    },
  },
};

export const isTerminalThemeId = (value: unknown): value is TerminalThemeId =>
  typeof value === 'string' && Object.hasOwn(TERMINAL_THEMES, value);
