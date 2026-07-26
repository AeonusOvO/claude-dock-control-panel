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

export interface TerminalThemeDefinition {
  label: string;
  palette: TerminalThemePalette;
}

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
  },
};

export const isTerminalThemeId = (value: unknown): value is TerminalThemeId =>
  typeof value === 'string' && Object.hasOwn(TERMINAL_THEMES, value);
