export type TerminalThemeId = 'claude' | 'graphite' | 'midnight' | 'telegram';
export type TerminalThemeAppearance = 'dark' | 'light';

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
 * The visual language surrounding xterm. Light themes replace more than colours: typography,
 * elevation, interaction layers and semantic status contrast all travel through this one bridge.
 */
export interface TerminalThemeShell {
  accentFg: string;
  accentLine: string;
  accentRing: string;
  accentSolid: string;
  accentSolidHover: string;
  accentText: string;
  accentTint: string;
  badLine: string;
  badSolid: string;
  badText: string;
  badTint: string;
  durEnter: string;
  durExit: string;
  durMicro: string;
  easeEnter: string;
  easeExit: string;
  easeSpring: string;
  fontDisplay: string;
  fontMono: string;
  fontUi: string;
  fontWeightStrong: string;
  layerActive: string;
  layerHover: string;
  letterSpacingTitle: string;
  lineHeightBody: string;
  line: string;
  lineHover: string;
  lineStrong: string;
  lineSubtle: string;
  maskBlur: string;
  maskVeil: string;
  okLine: string;
  okSolid: string;
  okText: string;
  okTint: string;
  pressScale: string;
  radiusBubble: string;
  radiusLg: string;
  radiusMd: string;
  radiusPill: string;
  radiusSm: string;
  shadowDrawer: string;
  shadowOverlay: string;
  sheen: string;
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
  warnLine: string;
  warnSolid: string;
  warnText: string;
  warnTint: string;
}

export interface TerminalThemeDefinition {
  appearance: TerminalThemeAppearance;
  label: string;
  palette: TerminalThemePalette;
  shell: TerminalThemeShell;
}

/** Shell field → CSS custom property. The renderer walks this map without per-theme branches. */
export const SHELL_CSS_VARIABLES: Record<keyof TerminalThemeShell, string> = {
  accentFg: '--accent-fg',
  accentLine: '--accent-line',
  accentRing: '--accent-ring',
  accentSolid: '--accent-solid',
  accentSolidHover: '--accent-solid-hover',
  accentText: '--accent-text',
  accentTint: '--accent-tint',
  badLine: '--bad-line',
  badSolid: '--bad-solid',
  badText: '--bad-text',
  badTint: '--bad-tint',
  durEnter: '--dur-enter',
  durExit: '--dur-exit-theme',
  durMicro: '--dur-micro',
  easeEnter: '--ease-enter',
  easeExit: '--ease-exit',
  easeSpring: '--ease-spring',
  fontDisplay: '--font-display',
  fontMono: '--font-mono',
  fontUi: '--font-ui',
  fontWeightStrong: '--fw-strong',
  layerActive: '--layer-active',
  layerHover: '--layer-hover',
  letterSpacingTitle: '--ls-title',
  lineHeightBody: '--lh-body',
  line: '--line',
  lineHover: '--line-hover',
  lineStrong: '--line-strong',
  lineSubtle: '--line-subtle',
  maskBlur: '--mask-blur',
  maskVeil: '--mask-veil',
  okLine: '--ok-line',
  okSolid: '--ok-solid',
  okText: '--ok-text',
  okTint: '--ok-tint',
  pressScale: '--press-theme',
  radiusBubble: '--r-bubble',
  radiusLg: '--r-theme-lg',
  radiusMd: '--r-theme-md',
  radiusPill: '--r-theme-pill',
  radiusSm: '--r-theme-sm',
  shadowDrawer: '--shadow-drawer',
  shadowOverlay: '--shadow-overlay',
  sheen: '--sheen',
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
  warnLine: '--warn-line',
  warnSolid: '--warn-solid',
  warnText: '--warn-text',
  warnTint: '--warn-tint',
};

const DARK_CHROME = {
  badLine: 'rgb(216 67 79 / 34%)',
  badSolid: '#d8434f',
  badText: '#f58c95',
  badTint: 'rgb(216 67 79 / 12%)',
  layerActive: 'rgb(255 255 255 / 7%)',
  layerHover: 'rgb(255 255 255 / 4%)',
  line: 'rgb(255 255 255 / 9%)',
  lineHover: 'rgb(255 255 255 / 20%)',
  lineStrong: 'rgb(255 255 255 / 13%)',
  lineSubtle: 'rgb(255 255 255 / 6%)',
  okLine: 'rgb(31 157 99 / 32%)',
  okSolid: '#1f9d63',
  okText: '#5fd39d',
  okTint: 'rgb(31 157 99 / 12%)',
  shadowDrawer: '-1px 0 0 rgb(255 255 255 / 9%), -32px 0 64px -24px rgb(0 0 0 / 55%)',
  shadowOverlay: '0 16px 40px -12px rgb(0 0 0 / 60%), 0 4px 12px -4px rgb(0 0 0 / 40%)',
  sheen: 'inset 0 1px 0 rgb(255 255 255 / 4%)',
  warnLine: 'rgb(180 130 12 / 34%)',
  warnSolid: '#b4820c',
  warnText: '#e0b95a',
  warnTint: 'rgb(180 130 12 / 14%)',
} as const;

const LIGHT_CHROME = {
  badLine: 'rgb(167 61 57 / 36%)',
  badSolid: '#a73d39',
  badText: '#7f2c28',
  badTint: 'rgb(167 61 57 / 9%)',
  layerActive: 'rgb(20 20 19 / 7%)',
  layerHover: 'rgb(20 20 19 / 4%)',
  line: 'rgb(31 30 29 / 16%)',
  lineHover: 'rgb(31 30 29 / 30%)',
  lineStrong: 'rgb(31 30 29 / 22%)',
  lineSubtle: 'rgb(31 30 29 / 10%)',
  okLine: 'rgb(67 116 38 / 36%)',
  okSolid: '#437426',
  okText: '#265b19',
  okTint: 'rgb(67 116 38 / 9%)',
  shadowDrawer: '-1px 0 0 rgb(31 30 29 / 12%), -20px 0 50px -26px rgb(31 30 29 / 28%)',
  shadowOverlay: '0 18px 44px -18px rgb(31 30 29 / 28%), 0 3px 10px -4px rgb(31 30 29 / 18%)',
  sheen: '0 1px 2px rgb(31 30 29 / 5%), 0 5px 18px -14px rgb(31 30 29 / 22%)',
  warnLine: 'rgb(128 92 31 / 36%)',
  warnSolid: '#805c1f',
  warnText: '#5a4815',
  warnTint: 'rgb(128 92 31 / 9%)',
} as const;

export const DEFAULT_TERMINAL_THEME: TerminalThemeId = 'claude';

const MONO_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', monospace";
const SEGOE_FONT = "'Segoe UI Variable', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif";

export const TERMINAL_THEMES: Record<TerminalThemeId, TerminalThemeDefinition> = {
  claude: {
    appearance: 'light',
    label: 'Claude 明亮',
    palette: {
      background: '#faf9f5',
      black: '#141413',
      blue: '#3266ad',
      brightBlack: '#73726c',
      brightBlue: '#4682d5',
      brightCyan: '#247e86',
      brightGreen: '#437426',
      brightMagenta: '#8a4f8e',
      brightRed: '#a73d39',
      brightWhite: '#ffffff',
      brightYellow: '#805c1f',
      cursor: '#b85b3d',
      cursorAccent: '#ffffff',
      cyan: '#246c72',
      foreground: '#141413',
      green: '#265b19',
      magenta: '#704074',
      red: '#7f2c28',
      selectionBackground: '#ead8cf',
      selectionInactiveBackground: '#e8e5dc',
      white: '#f5f4ed',
      yellow: '#5a4815',
    },
    shell: {
      accentFg: '#ffffff',
      accentLine: 'rgb(184 91 61 / 34%)',
      accentRing: 'rgb(184 91 61 / 48%)',
      accentSolid: '#b85b3d',
      accentSolidHover: '#a64e33',
      accentText: '#91462f',
      accentTint: 'rgb(184 91 61 / 10%)',
      ...LIGHT_CHROME,
      durEnter: '240ms',
      durExit: '180ms',
      durMicro: '120ms',
      easeEnter: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
      easeExit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
      easeSpring: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fontDisplay: "'Source Serif 4 Variable', 'Microsoft YaHei UI', 'Segoe UI', system-ui, serif",
      fontMono: MONO_FONT,
      fontUi: "'Inter Variable', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif",
      fontWeightStrong: '600',
      letterSpacingTitle: '-0.012em',
      lineHeightBody: '1.7',
      maskBlur: '8px',
      maskVeil: 'rgb(250 249 245 / 58%)',
      pressScale: '0.985',
      radiusBubble: '18px',
      radiusLg: '16px',
      radiusMd: '12px',
      radiusPill: '999px',
      radiusSm: '8px',
      surface1: '#ffffff',
      surface2: '#faf9f5',
      surface3: '#ffffff',
      surface4: '#ffffff',
      surfaceCanvas: '#f5f4ed',
      surfaceInset: '#f2f0e8',
      surfaceTerminal: '#faf9f5',
      text: '#3d3d3a',
      textDim: '#73726c',
      textHi: '#141413',
      textLo: '#5f5e59',
      textMute: '#908f88',
    },
  },
  graphite: {
    appearance: 'dark',
    label: '石墨深色',
    palette: {
      background: '#05070a',
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
    shell: {
      accentFg: '#04121a',
      accentLine: 'rgb(46 168 216 / 30%)',
      accentRing: 'rgb(124 212 240 / 55%)',
      accentSolid: '#2ea8d8',
      accentSolidHover: '#3fb8e8',
      accentText: '#7cd4f0',
      accentTint: 'rgb(46 168 216 / 10%)',
      ...DARK_CHROME,
      durEnter: '200ms',
      durExit: '160ms',
      durMicro: '100ms',
      easeEnter: 'cubic-bezier(0.2, 0, 0, 1)',
      easeExit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
      easeSpring: 'cubic-bezier(0.2, 0, 0, 1)',
      fontDisplay: SEGOE_FONT,
      fontMono: MONO_FONT,
      fontUi: SEGOE_FONT,
      fontWeightStrong: '600',
      letterSpacingTitle: '-0.003em',
      lineHeightBody: '1.55',
      maskBlur: '6px',
      maskVeil: 'rgb(5 7 10 / 62%)',
      pressScale: '0.985',
      radiusBubble: '14px',
      radiusLg: '10px',
      radiusMd: '8px',
      radiusPill: '999px',
      radiusSm: '6px',
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
    appearance: 'dark',
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
      ...DARK_CHROME,
      durEnter: '200ms',
      durExit: '160ms',
      durMicro: '100ms',
      easeEnter: 'cubic-bezier(0.2, 0, 0, 1)',
      easeExit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
      easeSpring: 'cubic-bezier(0.2, 0, 0, 1)',
      fontDisplay: SEGOE_FONT,
      fontMono: MONO_FONT,
      fontUi: SEGOE_FONT,
      fontWeightStrong: '600',
      letterSpacingTitle: '-0.003em',
      lineHeightBody: '1.55',
      maskBlur: '6px',
      maskVeil: 'rgb(7 17 28 / 62%)',
      pressScale: '0.985',
      radiusBubble: '14px',
      radiusLg: '10px',
      radiusMd: '8px',
      radiusPill: '999px',
      radiusSm: '6px',
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
  telegram: {
    appearance: 'light',
    label: 'Telegram 明亮',
    palette: {
      background: '#ffffff',
      black: '#1c1c1d',
      blue: '#1267a8',
      brightBlack: '#707579',
      brightBlue: '#3390ec',
      brightCyan: '#16868f',
      brightGreen: '#18864b',
      brightMagenta: '#7c4d99',
      brightRed: '#c33a35',
      brightWhite: '#ffffff',
      brightYellow: '#9a6518',
      cursor: '#237bc4',
      cursorAccent: '#ffffff',
      cyan: '#126c73',
      foreground: '#1c1c1d',
      green: '#166b3e',
      magenta: '#653d7d',
      red: '#9a2e2a',
      selectionBackground: '#cfe7fb',
      selectionInactiveBackground: '#e5e7e9',
      white: '#f4f4f5',
      yellow: '#765019',
    },
    shell: {
      accentFg: '#ffffff',
      accentLine: 'rgb(35 123 196 / 34%)',
      accentRing: 'rgb(35 123 196 / 46%)',
      accentSolid: '#237bc4',
      accentSolidHover: '#1c6fb5',
      accentText: '#1267a8',
      accentTint: 'rgb(35 123 196 / 10%)',
      ...LIGHT_CHROME,
      durEnter: '340ms',
      durExit: '180ms',
      durMicro: '150ms',
      easeEnter: 'cubic-bezier(0.075, 0.82, 0.165, 1)',
      easeExit: 'cubic-bezier(0.4, 0, 1, 1)',
      easeSpring: 'cubic-bezier(0.23, 1, 0.32, 1)',
      fontDisplay: "'Open Sans Variable', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif",
      fontMono: MONO_FONT,
      fontUi: "'Open Sans Variable', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif",
      fontWeightStrong: '600',
      letterSpacingTitle: '-0.006em',
      lineHeightBody: '1.45',
      maskBlur: '6px',
      maskVeil: 'rgb(255 255 255 / 54%)',
      pressScale: '0.975',
      radiusBubble: '12px',
      radiusLg: '10px',
      radiusMd: '8px',
      radiusPill: '999px',
      radiusSm: '6px',
      surface1: '#ffffff',
      surface2: '#f4f4f5',
      surface3: '#ffffff',
      surface4: '#ffffff',
      surfaceCanvas: '#e8eaec',
      surfaceInset: '#eef0f2',
      surfaceTerminal: '#ffffff',
      text: '#343638',
      textDim: '#707579',
      textHi: '#17191b',
      textLo: '#565b5f',
      textMute: '#979ca0',
    },
  },
};

export const isTerminalThemeId = (value: unknown): value is TerminalThemeId =>
  typeof value === 'string' && Object.hasOwn(TERMINAL_THEMES, value);

const ansiColor = (hex: string, channel: 38 | 48): string => {
  if (!/^#[0-9a-f]{6}$/iu.test(hex)) {
    throw new Error(`ANSI 颜色必须使用 #RRGGBB 格式：${hex}`);
  }
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `$([char]0x1b)[${channel};2;${red};${green};${blue}m`;
};

/** Converts a palette colour into the PowerShell-expanded ANSI true-colour foreground sequence. */
export const ansiForeground = (hex: string): string => ansiColor(hex, 38);

/** Converts a palette colour into the PowerShell-expanded ANSI true-colour background sequence. */
export const ansiBackground = (hex: string): string => ansiColor(hex, 48);
