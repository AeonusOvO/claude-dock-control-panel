import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postcss, { type AtRule, type ChildNode, type Node, type Root, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { SHELL_CSS_VARIABLES, TERMINAL_THEMES } from '../../src/shared/ui/terminal-themes';

const rendererDirectory = path.join(__dirname, '..', '..', 'src', 'renderer');
const stylesDirectory = path.join(rendererDirectory, 'styles');
const TOKENS_FILE = '01-tokens.css';
const MOTION_FILE = '04-motion.css';
const RESPONSIVE_FILE = '07-responsive.css';

interface StyleSource {
  css: string;
  relativePath: string;
  root: Root;
}

const listCssFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listCssFiles(absolutePath);
      return entry.isFile() && entry.name.endsWith('.css') ? [absolutePath] : [];
    })
    .sort((left, right) => left.localeCompare(right));

const listTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(absolutePath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [absolutePath] : [];
    })
    .sort((left, right) => left.localeCompare(right));

/*
 * Built fresh per call rather than shared: a `/g` regex carries `lastIndex` between `test()` calls,
 * which would silently skip files once the scan below moved past the first match.
 */
const stylesheetImports = (source: string): string[] =>
  [...source.matchAll(/^import '([^']+\.css)';$/gm)].flatMap((match) => match[1] ?? []);

const styleSources: StyleSource[] = listCssFiles(stylesDirectory).map((absolutePath) => {
  const css = readFileSync(absolutePath, 'utf8');
  return {
    css,
    relativePath: path.relative(stylesDirectory, absolutePath).replaceAll('\\', '/'),
    root: postcss.parse(css, { from: absolutePath }),
  };
});

const sourceByPath = new Map(styleSources.map((source) => [source.relativePath, source]));
if (!sourceByPath.has(TOKENS_FILE)) throw new Error(`Missing ${TOKENS_FILE}`);

const entryStyles = readFileSync(path.join(rendererDirectory, 'styles.css'), 'utf8');
const rendererEntry = readFileSync(path.join(rendererDirectory, 'main.ts'), 'utf8');
const rendererMarkup = readFileSync(path.join(rendererDirectory, 'index.html'), 'utf8');
const componentSource = readFileSync(
  path.join(rendererDirectory, 'platform', 'components.ts'),
  'utf8',
);
const allStyles = styleSources.map((source) => source.css).join('\n');
const uncommentedStyles = allStyles.replaceAll(/\/\*[\s\S]*?\*\//g, '');

const locationOf = (source: StyleSource, node: ChildNode): string => {
  const start = node.source?.start;
  return `${source.relativePath}:${start?.line ?? '?'}:${start?.column ?? '?'}`;
};

const isInsideRoot = (node: ChildNode): boolean => {
  let parent: Node | undefined = node.parent;
  while (parent) {
    if (
      parent.type === 'rule' &&
      (parent as Rule).selectors.some((selector) => selector.trim() === ':root')
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
};

const isUnconditionalRule = (node: ChildNode): boolean => {
  const conditionalAtRules = new Set([
    '-webkit-keyframes',
    'container',
    'document',
    'keyframes',
    'media',
    'scope',
    'starting-style',
    'supports',
  ]);
  let parent: Node | undefined = node.parent;
  while (parent) {
    if (parent.type === 'atrule' && conditionalAtRules.has((parent as AtRule).name.toLowerCase())) {
      return false;
    }
    parent = parent.parent;
  }
  return true;
};

const normalizeSelector = (selector: string): string =>
  selector
    .replaceAll(/\s*([>+~])\s*/g, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim();

const customPropertyDefinitions = new Set<string>();
const customPropertyReferences = new Map<string, string[]>();
for (const source of styleSources) {
  source.root.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) customPropertyDefinitions.add(declaration.prop);
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const property = match[1];
      if (!property) continue;
      const references = customPropertyReferences.get(property) ?? [];
      references.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
      customPropertyReferences.set(property, references);
    }
  });
}

const numericRgbIsNeutral = (contents: string): boolean => {
  const channels = contents.replaceAll(',', ' ').trim().split(/\s+/).slice(0, 3);
  if (channels.length !== 3 || channels.some((channel) => !/^\d+(?:\.\d+)?%?$/.test(channel))) {
    return false;
  }
  return (
    channels.every((channel) => /^0(?:\.0+)?%?$/.test(channel)) ||
    channels.every((channel) => /^(?:255(?:\.0+)?|100(?:\.0+)?%)$/.test(channel))
  );
};

const classTokens = (openingTag: string): string[] => {
  const classAttribute = /\bclass\s*=\s*(["'])(?<classes>[\s\S]*?)\1/i.exec(openingTag);
  return (classAttribute?.groups?.classes ?? '').split(/\s+/).filter(Boolean);
};

const openingTagWithId = (id: string): string | undefined => {
  const escapedId = id.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<[^>]+\\bid=["']${escapedId}["'][^>]*>`, 'i').exec(rendererMarkup)?.[0];
};

describe('design-system source architecture', () => {
  it('discovers the complete split stylesheet tree recursively', () => {
    expect(styleSources.map((source) => source.relativePath)).toEqual(
      expect.arrayContaining([
        TOKENS_FILE,
        '02-reset.css',
        '03-typography.css',
        MOTION_FILE,
        '05-primitives.css',
        '06-layout.css',
        RESPONSIVE_FILE,
        'views/chat.css',
        'views/markdown.css',
        'views/mcp.css',
        'views/projects.css',
        'views/router.css',
        'views/settings.css',
        'views/terminal.css',
      ]),
    );
  });

  /*
   * Emit order is the entire cascade for vendor CSS. xterm.css hardcodes
   * `background-color: #000` on `.xterm .xterm-viewport` at exactly the same specificity as the
   * override in `views/terminal.css`, so whichever rule the bundler writes last wins. This import
   * used to live in `features/terminal/terminal-views-create.ts`, which made Vite emit it *after*
   * the design system: the viewport stayed opaque black, and because the character grid only covers
   * whole cells, every theme showed a black ring in the leftover strip right of and below the grid.
   * It reproduced only in packaged builds — `vite serve` injects <style> tags in a different order —
   * so the gate is on import position, not on rendered output.
   */
  it('imports every vendor stylesheet ahead of the design system', () => {
    const imports = stylesheetImports(rendererEntry);
    const designSystemIndex = imports.indexOf('./styles.css');

    expect(designSystemIndex).toBeGreaterThan(0);
    expect(imports.slice(0, designSystemIndex)).toEqual([
      'katex/dist/katex.css',
      '@xterm/xterm/css/xterm.css',
    ]);
    // The design system is last, so nothing third-party can be appended behind it.
    expect(designSystemIndex).toBe(imports.length - 1);

    // Any other module importing a stylesheet lands in the bundle wherever its feature happens to
    // be reached, which is exactly how the ordering broke in the first place.
    const offenders = listTypeScriptFiles(rendererDirectory)
      .filter((absolutePath) => absolutePath !== path.join(rendererDirectory, 'main.ts'))
      .filter((absolutePath) => stylesheetImports(readFileSync(absolutePath, 'utf8')).length > 0)
      .map((absolutePath) => path.relative(rendererDirectory, absolutePath).replaceAll('\\', '/'));

    expect(offenders).toEqual([]);
  });

  it('defines every referenced custom property in CSS or the theme bridge', () => {
    const themeProperties = new Set(Object.values(SHELL_CSS_VARIABLES));
    const offenders = [...customPropertyReferences.entries()]
      .filter(
        ([property]) => !customPropertyDefinitions.has(property) && !themeProperties.has(property),
      )
      .flatMap(([property, references]) =>
        references.map((reference) => `${property} <- ${reference}`),
      );
    expect(offenders).toEqual([]);
  });

  it('gives every theme-driven shell property a default and a consumer', () => {
    const offenders = Object.values(SHELL_CSS_VARIABLES).flatMap((property) => {
      const problems: string[] = [];
      if (!customPropertyDefinitions.has(property))
        problems.push(`${property}: missing CSS default`);
      if (!customPropertyReferences.has(property))
        problems.push(`${property}: missing CSS consumer`);
      return problems;
    });
    expect(offenders).toEqual([]);
  });

  it('removes every legacy size-named --text-* token', () => {
    expect(
      [
        ...uncommentedStyles.matchAll(
          /--text-(?:3xs|2xs|xs|sm|base|md|lg|display|xl|eyebrow)(?![\w-])/g,
        ),
      ].map((match) => match[0]),
    ).toEqual([]);
  });

  it('keeps unconditional selector ownership unique across non-responsive files', () => {
    const owners = new Map<string, Map<string, string[]>>();
    for (const source of styleSources) {
      if (source.relativePath === RESPONSIVE_FILE) continue;
      source.root.walkRules((rule) => {
        if (!isUnconditionalRule(rule)) return;
        const selector = normalizeSelector(rule.selector);
        const files = owners.get(selector) ?? new Map<string, string[]>();
        const locations = files.get(source.relativePath) ?? [];
        locations.push(locationOf(source, rule));
        files.set(source.relativePath, locations);
        owners.set(selector, files);
      });
    }
    const offenders = [...owners.entries()]
      .filter(([, files]) => files.size > 1)
      .map(
        ([selector, files]) =>
          `${selector} -> ${[...files.entries()]
            .map(([file, locations]) => `${file} (${locations.join(', ')})`)
            .join('; ')}`,
      );
    expect(offenders).toEqual([]);
  });

  it('keeps keyframes in the motion source only', () => {
    const offenders: string[] = [];
    for (const source of styleSources) {
      source.root.walkAtRules((atRule) => {
        if (!/^(?:-[\w]+-)?keyframes$/i.test(atRule.name)) return;
        if (source.relativePath !== MOTION_FILE) {
          offenders.push(`${locationOf(source, atRule)}: @${atRule.name} ${atRule.params}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps viewport media in responsive CSS and the sole reduced-motion block in motion CSS', () => {
    const offenders: string[] = [];
    const reducedMotionBlocks: string[] = [];
    const responsiveConditions = new Set<string>();
    for (const source of styleSources) {
      source.root.walkAtRules('media', (atRule) => {
        const params = atRule.params.toLowerCase();
        const location = locationOf(source, atRule);
        if (params.includes('prefers-reduced-motion')) {
          reducedMotionBlocks.push(location);
          if (source.relativePath !== MOTION_FILE) offenders.push(`${location}: ${atRule.params}`);
        } else {
          const normalized = params.replaceAll(/\s+/g, '').trim();
          responsiveConditions.add(normalized);
          if (source.relativePath !== RESPONSIVE_FILE) {
            offenders.push(`${location}: ${atRule.params}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
    expect(reducedMotionBlocks).toHaveLength(1);
    expect([...responsiveConditions].sort()).toEqual(
      ['(max-width:720px)', '(max-width:1024px)', '(min-width:1280px)'].sort(),
    );
  });

  it('keeps the compact onboarding progress grid aligned with the versioned flow', () => {
    const stepCount = [...rendererMarkup.matchAll(/data-onboarding-progress-step=/g)].length;
    const responsive = sourceByPath.get(RESPONSIVE_FILE);
    let columns: string | undefined;
    responsive?.root.walkRules('.onboarding-progress ol', (rule) => {
      if (rule.parent?.type !== 'atrule' || rule.parent.params !== '(max-width: 1024px)') return;
      const declaration = rule.nodes.find(
        (node) => node.type === 'decl' && node.prop === 'grid-template-columns',
      );
      if (declaration?.type === 'decl') columns = declaration.value;
    });

    expect(stepCount).toBe(5);
    expect(columns).toBe(`repeat(${stepCount}, minmax(0, 1fr))`);
  });
});

describe('design-token literals', () => {
  it('keeps colours outside :root behind semantic tokens', () => {
    const offenders: string[] = [];
    for (const source of styleSources) {
      source.root.walkDecls((declaration) => {
        if (isInsideRoot(declaration)) return;
        if (/#[0-9a-f]{3,8}\b/i.test(declaration.value)) {
          offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
          return;
        }
        for (const match of declaration.value.matchAll(/\brgba?\(([^()]*)\)/gi)) {
          const contents = match[1];
          if (contents && /^\s*\d/.test(contents) && !numericRgbIsNeutral(contents)) {
            offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
            break;
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('uses only the three design-system font-family slots outside :root', () => {
    const offenders: string[] = [];
    for (const source of styleSources) {
      source.root.walkDecls('font-family', (declaration) => {
        if (
          !isInsideRoot(declaration) &&
          !/^(?:var\(--font-(?:ui|mono|display)\)|inherit)$/.test(declaration.value.trim())
        ) {
          offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('rejects literal cubic curves and numeric type values outside :root', () => {
    const offenders: string[] = [];
    for (const source of styleSources) {
      source.root.walkDecls((declaration) => {
        if (isInsideRoot(declaration)) return;
        const value = declaration.value.trim();
        const directNumber = /^[+-]?(?:\d*\.)?\d+(?:[a-z%]+)?(?:\s*!important)?$/i;
        if (
          /cubic-bezier\(/i.test(value) ||
          (declaration.prop === 'font-size' && directNumber.test(value)) ||
          (declaration.prop === 'font-weight' && directNumber.test(value))
        ) {
          offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every literal ms or s duration in the token source', () => {
    const offenders: string[] = [];
    const literalTime = /(?:^|[^\w-])[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:ms|s)\b/i;
    for (const source of styleSources) {
      if (source.relativePath === TOKENS_FILE) continue;
      source.root.walkDecls((declaration) => {
        if (literalTime.test(declaration.value)) {
          offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('forbids pixel line-height everywhere', () => {
    const offenders: string[] = [];
    for (const source of styleSources) {
      source.root.walkDecls('line-height', (declaration) => {
        if (/(?:^|\s|\()[-+]?\d*\.?\d+px\b/i.test(declaration.value)) {
          offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('tokenizes 2px through 40px spacing and exempts hairlines and structural measurements', () => {
    const spacingProperty = /^(?:(?:margin|padding|inset)(?:-.+)?|gap|row-gap|column-gap)$/;
    const offenders: string[] = [];
    for (const source of styleSources) {
      source.root.walkDecls((declaration) => {
        if (!spacingProperty.test(declaration.prop)) return;
        const hasUntokenizedStep = [...declaration.value.matchAll(/([-+]?\d*\.?\d+)px\b/gi)].some(
          (match) => {
            const magnitude = Math.abs(Number(match[1]));
            return magnitude >= 2 && magnitude <= 40;
          },
        );
        if (hasUntokenizedStep) {
          offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('drops decorative window lights from the shell', () => {
    expect(`${entryStyles}\n${allStyles}`).not.toContain('window-lights');
  });

  /*
   * The neutral-colour exemption above deliberately allows pure black and pure white, which is how
   * five dialogs came to paint a hardcoded `rgb(0 0 0 / 58%)` scrim that ignored the theme entirely.
   * A modal scrim is a theme surface, so it gets its own rule: every `::backdrop` takes its colour
   * from the per-theme `--mask-veil` token and nothing else.
   */
  it('paints every modal scrim from the per-theme mask token', () => {
    const offenders: string[] = [];
    let canonicalScrims = 0;

    for (const source of styleSources) {
      source.root.walkRules((rule) => {
        if (!rule.selector.includes('::backdrop')) return;
        if (normalizeSelector(rule.selector) === 'dialog::backdrop') canonicalScrims += 1;

        rule.walkDecls(/^background(?:-color|-image)?$/, (declaration) => {
          if (!declaration.value.includes('var(--mask-veil)')) {
            offenders.push(`${locationOf(source, declaration)}: ${declaration.toString()}`);
          }
        });
      });
    }

    expect(offenders).toEqual([]);
    // Exactly one rule owns the scrim, so a theme switch can never leave a dialog behind.
    expect(canonicalScrims).toBe(1);
  });
});

describe('popover contract', () => {
  it('provides a reusable hover and focus tooltip primitive', () => {
    const primitives = sourceByPath.get('05-primitives.css')?.css ?? '';
    expect(primitives).toContain('.tooltip__content');
    expect(primitives).toContain('.tooltip:is(:hover, :focus-within) > .tooltip__content');
    expect(primitives).toContain('visibility: hidden');
  });

  it('marks the dynamically created select listbox as a popover', () => {
    expect(componentSource).toContain("listbox.className = 'select__listbox popover'");
  });

  it('marks all five footer menus as popovers', () => {
    const ids = [
      'footer-resource-menu',
      'footer-model-menu',
      'footer-speed-menu',
      'footer-mode-menu',
      'footer-effort-menu',
    ];
    const offenders = ids.flatMap((id) => {
      const openingTag = openingTagWithId(id);
      if (!openingTag) return [`${id}: missing`];
      const classes = classTokens(openingTag);
      return classes.includes('footer-menu') && classes.includes('popover')
        ? []
        : [`${id}: ${openingTag}`];
    });
    expect(offenders).toEqual([]);
  });

  it('marks exactly eleven dialogs as popovers', () => {
    const dialogs = rendererMarkup.match(/<dialog\b[^>]*>/gi) ?? [];
    expect(dialogs).toHaveLength(11);
    expect(dialogs.filter((openingTag) => !classTokens(openingTag).includes('popover'))).toEqual(
      [],
    );
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
    it(`gives ${themeId} a complete, legible shell and a strict type ladder`, () => {
      for (const field of Object.keys(SHELL_CSS_VARIABLES)) {
        expect(definition.shell[field as keyof typeof definition.shell].trim()).not.toBe('');
      }

      const base = Number.parseFloat(definition.shell.typeBase);
      const ratio = Number.parseFloat(definition.shell.typeRatio);
      const popScaleFrom = Number.parseFloat(definition.shell.popScaleFrom);
      const popTravel = Number.parseFloat(definition.shell.popTravel);
      expect(definition.shell.typeBase).toMatch(/^\d+(?:\.\d+)?px$/);
      expect(definition.shell.typeRatio).toMatch(/^\d+(?:\.\d+)?$/);
      expect(definition.shell.popScaleFrom).toMatch(/^0?\.\d+$/);
      expect(definition.shell.popTravel).toMatch(/^\d+(?:\.\d+)?px$/);
      expect(ratio).toBeGreaterThan(1);
      expect(popScaleFrom).toBeGreaterThan(0);
      expect(popScaleFrom).toBeLessThan(1);
      expect(popTravel).toBeGreaterThanOrEqual(0);

      const sizes = [
        Math.max(10, Math.round(base / ratio / ratio)),
        Math.round(base / ratio),
        base,
        Math.round(base * ratio),
        Math.round(base * ratio * ratio),
        Math.round(base * ratio * ratio * ratio),
      ];
      for (let index = 1; index < sizes.length; index += 1) {
        expect(sizes[index]!, `${themeId} type step ${index + 1}`).toBeGreaterThan(
          sizes[index - 1]!,
        );
      }

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

  it('defines all six role sizes in CSS', () => {
    const missing = ['micro', 'caption', 'body', 'subtitle', 'title', 'display']
      .map((role) => `--type-${role}-size`)
      .filter((property) => !customPropertyDefinitions.has(property));
    expect(missing).toEqual([]);
  });

  it('matches the adopted Telegram typography, tempo and geometry exactly', () => {
    expect(TERMINAL_THEMES.telegram.shell).toMatchObject({
      durEnter: '200ms',
      durExit: '150ms',
      durMicro: '120ms',
      fontDisplay: "'Segoe UI', 'Microsoft YaHei UI', 'Roboto Variable', system-ui, sans-serif",
      fontUi: "'Segoe UI', 'Microsoft YaHei UI', 'Roboto Variable', system-ui, sans-serif",
      popScaleFrom: '0.94',
      popTravel: '6px',
      radiusBubble: '12px',
      radiusLg: '10px',
      radiusMd: '6px',
      radiusSm: '4px',
      typeBase: '13px',
      typeRatio: '1.15',
    });
  });
});
