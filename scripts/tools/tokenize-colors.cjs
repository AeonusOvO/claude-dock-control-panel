/*
 * One-off migration helper: recursively follows the renderer's `styles.css` import graph and
 * rewrites bare `#rrggbb` literals outside `01-tokens.css` to the design tokens they are closest to.
 * Matching is role-aware — the CSS property decides which tokens are even candidates, because a
 * border and a label are never interchangeable even when the hex is similar. Alpha tokens are
 * compared as they actually render, composited over `--surface-2`.
 *
 * Run `node scripts/tools/tokenize-colors.cjs` for the review report, `--write` to apply. Kept in the
 * repo as the record of how the sweep was done; the resulting invariant is enforced by
 * `tests/design-tokens.test.ts`.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const rendererDirectory = path.join(__dirname, '..', '..', 'src', 'renderer');
const stylesPath = path.join(rendererDirectory, 'styles.css');
const tokensPath = path.join(rendererDirectory, 'styles', '01-tokens.css');
const importRule =
  /^\s*@import\s+(?:url\(\s*)?(?<quote>['"])(?<specifier>[^'"]+)\k<quote>\s*\)?\s*;\s*$/gmu;

const loadStyleGraph = (entryPath) => {
  const ordered = [];
  const visited = new Set();
  const ancestors = [];
  const rendererPrefix = `${path.resolve(rendererDirectory)}${path.sep}`.toLowerCase();

  const visit = (filePath) => {
    const absolutePath = path.resolve(filePath);
    const normalizedPath = absolutePath.toLowerCase();
    if (ancestors.includes(normalizedPath)) {
      throw new Error(`Circular CSS import: ${[...ancestors, normalizedPath].join(' -> ')}`);
    }
    if (visited.has(normalizedPath)) return;
    if (
      normalizedPath !== path.resolve(stylesPath).toLowerCase() &&
      !normalizedPath.startsWith(rendererPrefix)
    ) {
      throw new Error(`CSS import escapes the renderer directory: ${absolutePath}`);
    }

    const source = readFileSync(absolutePath, 'utf8');
    ancestors.push(normalizedPath);
    for (const match of source.matchAll(importRule)) {
      const specifier = match.groups?.specifier;
      if (!specifier || !specifier.startsWith('.')) continue;
      visit(path.resolve(path.dirname(absolutePath), specifier));
    }
    ancestors.pop();
    visited.add(normalizedPath);
    ordered.push({ absolutePath, source });
  };

  visit(entryPath);
  return ordered;
};

const styleGraph = loadStyleGraph(stylesPath);

const SURFACE_2 = '#101419';

/** Token → its `:root` value. Alpha tokens are written as `[hex, alpha]`. */
const TOKENS = {
  '--accent-fg': '#04121a',
  '--accent-line': ['#2ea8d8', 0.3],
  '--accent-ring': ['#7cd4f0', 0.55],
  '--accent-solid': '#2ea8d8',
  '--accent-solid-hover': '#3fb8e8',
  '--accent-text': '#7cd4f0',
  '--accent-tint': ['#2ea8d8', 0.1],
  '--bad-line': ['#d8434f', 0.34],
  '--bad-solid': '#d8434f',
  '--bad-text': '#f58c95',
  '--bad-tint': ['#d8434f', 0.12],
  '--line': ['#ffffff', 0.09],
  '--line-hover': ['#ffffff', 0.2],
  '--line-strong': ['#ffffff', 0.13],
  '--line-subtle': ['#ffffff', 0.06],
  '--ok-line': ['#1f9d63', 0.32],
  '--ok-solid': '#1f9d63',
  '--ok-text': '#5fd39d',
  '--ok-tint': ['#1f9d63', 0.12],
  '--surface-1': '#0b0e13',
  '--surface-2': SURFACE_2,
  '--surface-3': '#151a20',
  '--surface-4': '#1b2128',
  '--surface-canvas': '#07090c',
  '--surface-inset': '#080b0f',
  '--surface-terminal': '#05070a',
  '--text': '#c2ccd4',
  '--text-dim': '#66727c',
  '--text-hi': '#e8eef2',
  '--text-lo': '#8b98a3',
  '--text-mute': '#525d67',
  '--warn-line': ['#b4820c', 0.34],
  '--warn-solid': '#b4820c',
  '--warn-text': '#e0b95a',
  '--warn-tint': ['#b4820c', 0.14],
};

/**
 * Which tokens a property is allowed to become. Anything else stays a literal for review.
 * `surface` and `border` share a broad list on purpose: status dots, scrollbar thumbs and focus
 * rings are legitimately painted with foreground hues. The separation that matters is that text
 * never collapses onto a surface step (which would make it unreadable).
 */
const PAINTABLE = [
  '--surface-canvas',
  '--surface-terminal',
  '--surface-inset',
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--surface-4',
  '--line-subtle',
  '--line',
  '--line-strong',
  '--line-hover',
  '--text-mute',
  '--text-dim',
  '--text-lo',
  '--text',
  '--text-hi',
  '--accent-fg',
  '--accent-tint',
  '--accent-line',
  '--accent-solid',
  '--accent-solid-hover',
  '--accent-ring',
  '--accent-text',
  '--ok-tint',
  '--ok-line',
  '--ok-solid',
  '--ok-text',
  '--warn-tint',
  '--warn-line',
  '--warn-solid',
  '--warn-text',
  '--bad-tint',
  '--bad-line',
  '--bad-solid',
  '--bad-text',
];

const ROLES = {
  border: PAINTABLE,
  surface: PAINTABLE,
  text: [
    '--text-hi',
    '--text',
    '--text-lo',
    '--text-dim',
    '--text-mute',
    '--accent-text',
    '--accent-solid',
    '--ok-text',
    '--ok-solid',
    '--warn-text',
    '--warn-solid',
    '--bad-text',
    '--bad-solid',
    '--surface-canvas',
    '--accent-fg',
  ],
};

const roleOf = (property) => {
  if (/^(color|-webkit-text-fill-color|caret-color)$/.test(property)) {
    return 'text';
  }
  if (/^(background|background-color|background-image|fill|stroke|accent-color)$/.test(property)) {
    return 'surface';
  }
  if (
    /^(border|border-[a-z-]*|outline|outline-color|scrollbar-color|box-shadow|text-shadow|column-rule)$/.test(
      property,
    )
  ) {
    return 'border';
  }
  return undefined;
};

const rgb = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));

const composite = (value) => {
  if (typeof value === 'string') {
    return rgb(value);
  }
  const [hex, alpha] = value;
  const base = rgb(SURFACE_2);
  return rgb(hex).map((channel, index) => alpha * channel + (1 - alpha) * base[index]);
};

const toLab = ([red, green, blue]) => {
  const linear = (value) => {
    const scaled = value / 255;
    return scaled <= 0.040_45 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [linear(red), linear(green), linear(blue)];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.9505;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.089;
  const f = (value) => (value > 0.008_856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};

const TOKEN_LABS = Object.fromEntries(
  Object.entries(TOKENS).map(([name, value]) => [name, toLab(composite(value))]),
);

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const report = new Map();
const skipped = new Map();
const rewrittenGraph = styleGraph.map(({ absolutePath, source }) => {
  if (path.resolve(absolutePath).toLowerCase() === path.resolve(tokensPath).toLowerCase()) {
    return { absolutePath, output: source, source };
  }

  let property = '';
  const output = source
    .split('\n')
    .map((line) => {
      const declaration = /^\s*(-{0,2}[a-z][a-z0-9-]*)\s*:/.exec(line);
      if (declaration) property = declaration[1];
      return line.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => {
        const role = roleOf(property);
        if (!role) {
          skipped.set(`${property}: ${hex}`, (skipped.get(`${property}: ${hex}`) ?? 0) + 1);
          return hex;
        }
        const lab = toLab(rgb(hex.toLowerCase()));
        let best = ROLES[role][0];
        let bestDistance = distance(lab, TOKEN_LABS[best]);
        for (const candidate of ROLES[role].slice(1)) {
          const candidateDistance = distance(lab, TOKEN_LABS[candidate]);
          if (candidateDistance < bestDistance) {
            best = candidate;
            bestDistance = candidateDistance;
          }
        }
        const key = `${role.padEnd(8)} ${hex.toLowerCase()} -> var(${best})`;
        report.set(key, Math.max(report.get(key) ?? 0, bestDistance));
        return `var(${best})`;
      });
    })
    .join('\n');
  return { absolutePath, output, source };
});

for (const [key, delta] of [...report.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${delta.toFixed(1).padStart(5)}  ${key}`);
}
console.log(
  `\n${report.size} distinct colours mapped across ${styleGraph.length} stylesheet files.`,
);
if (skipped.size > 0) {
  console.log('\nleft literal (unknown property role):');
  for (const [key, count] of skipped) {
    console.log(`  ${key} ×${count}`);
  }
}

if (process.argv.includes('--write')) {
  const changed = rewrittenGraph.filter(({ output, source }) => output !== source);
  for (const { absolutePath, output } of changed) {
    writeFileSync(absolutePath, output, 'utf8');
    console.log(`\nwritten: ${path.relative(rendererDirectory, absolutePath)}`);
  }
  if (changed.length === 0) console.log('\nno stylesheet changes needed.');
}
