import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_CSS_VARIABLES, TERMINAL_THEMES } from '../src/shared/terminal-themes';

const stylesPath = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const styles = readFileSync(stylesPath, 'utf8');

/** `:root` owns every literal value; the rest of the file may only reference tokens. */
const lines = styles.split('\n');
const rootEnd = lines.findIndex((line) => line.trim() === '}') + 1;
const body = lines.slice(rootEnd);
const bodyText = body.join('\n');

const withLineNumbers = (matcher: RegExp): string[] =>
  body.flatMap((line, index) =>
    matcher.test(line) ? [`styles.css:${rootEnd + index + 1}: ${line.trim()}`] : [],
  );

describe('design tokens', () => {
  it('keeps every colour outside :root behind a token so themes repaint the whole shell', () => {
    expect(withLineNumbers(/#[0-9a-fA-F]{3,8}\b/)).toEqual([]);
  });

  it('keeps hue-carrying alpha values behind tokens too', () => {
    // Pure-black shadows are theme independent; any other literal rgb() would freeze a hue.
    const offenders = withLineNumbers(/rgba?\(\s*\d/).filter(
      (line) => !/rgba?\(\s*0 0 0\s*\/|rgba?\(\s*255 255 255\s*\//.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it('uses only the three font families of the design system', () => {
    const offenders = withLineNumbers(/font-family:/).filter(
      (line) => !/font-family:\s*(var\(--font-(ui|mono|display)\)|inherit);/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps font sizes on the --text-* ladder', () => {
    // `font-size: 0` is a label-collapsing trick in a narrow-screen query, not a type step.
    const offenders = withLineNumbers(/font-size:\s*[0-9]/).filter(
      (line) => !/font-size:\s*0;/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it('exposes every shell token that the themes drive', () => {
    for (const property of Object.values(SHELL_CSS_VARIABLES)) {
      // Each themed property must have a `:root` default, or the first paint has nothing to use.
      expect(styles.slice(0, styles.indexOf('\n}'))).toContain(`${property}:`);
      expect(bodyText).toContain(`var(${property})`);
    }
  });

  it('drops the decorative window lights from the terminal toolbar', () => {
    expect(styles).not.toContain('window-lights');
  });

  it('keeps motion timing outside :root on the duration and easing tokens', () => {
    // A literal ms value or a hand-written curve freezes the tempo of that one rule, so a theme with a
    // slower, springier personality (Telegram) would still snap there like Claude.
    expect(withLineNumbers(/\b\d+ms\b/).filter((line) => !/0\.01ms/.test(line))).toEqual([]);
    expect(withLineNumbers(/cubic-bezier\(/)).toEqual([]);
  });

  it('keeps leading, tracking and weight outside :root on the derived ladders', () => {
    // Unitless leading and em tracking are the two typography axes the themes actually move; a literal
    // here survives the theme switch. Pixel leading is an optical alignment value, not a prose ladder.
    expect(withLineNumbers(/line-height:\s*[0-9]+\.[0-9]/)).toEqual([]);
    expect(withLineNumbers(/letter-spacing:\s*-[0-9]/)).toEqual([]);
    expect(withLineNumbers(/font-weight:\s*[5-9]\d\d/)).toEqual([]);
  });
});

describe('theme personality reaches the generic ladders', () => {
  /** The `:root` block, where the generic names must alias the theme-authored tokens. */
  const root = styles.slice(0, styles.indexOf('\n}'));

  it.each([
    ['--ease-standard', '--ease-enter'],
    ['--ease-decel', '--ease-spring'],
    ['--ease-accel', '--ease-exit'],
    ['--dur-2', '--dur-micro'],
    ['--dur-4', '--dur-enter'],
    ['--dur-exit', '--dur-exit-theme'],
    ['--r-sm', '--r-theme-sm'],
    ['--r-md', '--r-theme-md'],
    ['--r-lg', '--r-theme-lg'],
    ['--r-2xl', '--r-bubble'],
    ['--r-pill', '--r-theme-pill'],
    ['--press-lg', '--press-theme'],
  ])('%s derives from the theme-owned %s', (generic, themed) => {
    const declaration = new RegExp(`${generic}:[^;]*var\\(${themed}\\)`);
    expect(root).toMatch(declaration);
  });

  it.each([
    ['--lh-relaxed', '--lh-body'],
    ['--lh-prose', '--lh-body'],
    ['--lh-note', '--lh-body'],
    ['--lh-compact', '--lh-body'],
    ['--lh-tight', '--lh-body'],
    ['--lh-heading', '--lh-body'],
    ['--ls-display', '--ls-title'],
    ['--ls-tight', '--ls-title'],
    ['--ls-snug', '--ls-title'],
    ['--ls-body', '--ls-title'],
    ['--fw-medium', '--fw-strong'],
    ['--fw-heavy', '--fw-strong'],
    ['--fw-semi', '--fw-strong'],
    ['--r-xs', '--r-theme-sm'],
    ['--dur-1', '--dur-micro'],
    ['--dur-3', '--dur-enter'],
    ['--dur-stagger', '--dur-micro'],
    ['--dur-blink', '--dur-micro'],
    ['--dur-progress', '--dur-enter'],
    ['--dur-refresh', '--dur-enter'],
    ['--r-xl', '--r-theme-lg'],
    ['--press-sm', '--press-theme'],
  ])('%s scales off the theme-owned %s', (derived, themed) => {
    expect(root).toMatch(new RegExp(`${derived}:[^;]*calc\\([^;]*var\\(${themed}\\)`));
  });

  it('gives Claude and Telegram visibly different motion, geometry and typography', () => {
    const claude = TERMINAL_THEMES.claude.shell;
    const telegram = TERMINAL_THEMES.telegram.shell;
    for (const field of [
      'durEnter',
      'durMicro',
      'easeEnter',
      'easeSpring',
      'fontDisplay',
      'fontUi',
      'lineHeightBody',
      'letterSpacingTitle',
      'pressScale',
      'radiusBubble',
      'radiusLg',
    ] as const) {
      expect(claude[field]).not.toBe(telegram[field]);
    }
    // Claude pairs a serif display against its sans UI; Telegram deliberately uses one family.
    expect(claude.fontDisplay).not.toBe(claude.fontUi);
    expect(telegram.fontDisplay).toBe(telegram.fontUi);
  });
});

describe('terminal theme shells', () => {
  const luminance = (hex: string): number => {
    const channel = (offset: number): number => {
      const scaled = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return scaled <= 0.040_45 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };

  const contrast = (a: string, b: string): number => {
    const [light, dark] = [luminance(a), luminance(b)].sort((first, second) => second - first) as [
      number,
      number,
    ];
    return (light + 0.05) / (dark + 0.05);
  };

  for (const [themeId, definition] of Object.entries(TERMINAL_THEMES)) {
    it(`gives ${themeId} a complete, legible shell`, () => {
      for (const field of Object.keys(SHELL_CSS_VARIABLES)) {
        expect(definition.shell[field as keyof typeof definition.shell].trim()).not.toBe('');
      }
      // The canvas has to sit behind the raised surfaces, otherwise cards read as holes.
      expect(luminance(definition.shell.surfaceCanvas)).toBeLessThan(
        luminance(definition.shell.surface4),
      );
      expect(contrast(definition.shell.textHi, definition.shell.surfaceCanvas)).toBeGreaterThan(7);
      expect(contrast(definition.shell.text, definition.shell.surface2)).toBeGreaterThan(4.5);
      expect(contrast(definition.shell.accentText, definition.shell.surface2)).toBeGreaterThan(4.5);
      expect(contrast(definition.shell.okText, definition.shell.surface2)).toBeGreaterThan(4.5);
      expect(contrast(definition.shell.warnText, definition.shell.surface2)).toBeGreaterThan(4.5);
      expect(contrast(definition.shell.badText, definition.shell.surface2)).toBeGreaterThan(4.5);
    });
  }
});
