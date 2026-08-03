/*
 * Captures the themed dropdown open, in every theme, so the popup can be checked against each
 * theme's own surfaces, radius and accent rather than the OS listbox it replaced.
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const typescript = require('typescript');

const outputDirectory = path.join(__dirname, '..', 'dist', 'visual-qa');
app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-select-visual'));

const loadThemeDefinitions = () => {
  const source = readFileSync(
    path.join(__dirname, '..', 'src', 'shared', 'terminal-themes.ts'),
    'utf8',
  );
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const themeModule = { exports: {} };
  const factory = new vm.Script(
    `(function (exports, module) { ${transpiled}\n})`,
  ).runInThisContext();
  factory(themeModule.exports, themeModule);
  return themeModule.exports;
};

const { SHELL_CSS_VARIABLES, TERMINAL_THEMES } = loadThemeDefinitions();

const applyTheme = (themeId) => `
  (() => {
    const definition = ${JSON.stringify(TERMINAL_THEMES[themeId])};
    const mapping = ${JSON.stringify(SHELL_CSS_VARIABLES)};
    for (const [field, property] of Object.entries(mapping)) {
      document.documentElement.style.setProperty(property, definition.shell[field]);
    }
    document.documentElement.dataset.theme = ${JSON.stringify(themeId)};
    document.documentElement.dataset.appearance = definition.appearance;
    document.documentElement.style.colorScheme = definition.appearance;
  })()
`;

const openSettingsWithDropdown = `
  (async () => {
    // The toolbar picker is on-screen chrome, so the capture shows the popup in context.
    const select = document.querySelector('#terminal-theme');
    const shell = select.closest('.select');
    const rect = shell.getBoundingClientRect();
    const init = {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    /*
     * Dismiss anything already open before pressing, otherwise the press toggles the previous
     * capture's popup shut — the gesture is a toggle, so each theme has to start from closed.
     */
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 2, clientY: 2 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const hit = document.elementFromPoint(init.clientX, init.clientY);
    hit.dispatchEvent(new PointerEvent('pointerdown', init));
    hit.dispatchEvent(new MouseEvent('mousedown', init));
    await new Promise((resolve) => setTimeout(resolve, 450));

    const popup = [...document.querySelectorAll('.select__listbox')].find(
      (node) => node.dataset.open === 'true',
    );
    if (!popup) return { open: false };
    const style = getComputedStyle(popup);
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      fontFamily: style.fontFamily.slice(0, 40),
      open: true,
      rows: popup.querySelectorAll('button').length,
      selectedRowColor: (() => {
        const row = popup.querySelector("button[data-selected='true']");
        return row ? getComputedStyle(row).color : '';
      })(),
    };
  })()
`;

app.whenReady().then(async () => {
  mkdirSync(outputDirectory, { recursive: true });
  const window = new BrowserWindow({
    height: 800,
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'dist', 'preload', 'preload.js') },
    width: 1180,
  });
  await window.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  /*
   * Chromium throttles animations in an offscreen window, so an entrance that starts at `opacity: 0`
   * never advances and the popup would photograph blank. The capture only cares about the settled
   * appearance, so motion is pinned off — the same approach the theme-matrix capture already takes.
   */
  await window.webContents.executeJavaScript(
    `(() => {
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
      document.head.append(style);
    })()`,
    true,
  );

  const report = {};
  for (const themeId of ['claude', 'telegram', 'graphite', 'midnight']) {
    await window.webContents.executeJavaScript(applyTheme(themeId), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const info = await window.webContents.executeJavaScript(openSettingsWithDropdown, true);
    // The popup must still be up at capture time, or the screenshot proves nothing.
    const openAtCapture = await window.webContents.executeJavaScript(
      `Boolean([...document.querySelectorAll('.select__listbox')].find((node) => node.dataset.open === 'true' && !node.hidden))`,
      true,
    );
    report[themeId] = { ...info, openAtCapture };
    // An offscreen window needs a forced repaint and a discarded first frame before the popup lands.
    window.webContents.invalidate();
    await window.capturePage();
    await new Promise((resolve) => setTimeout(resolve, 420));
    const image = await window.capturePage();
    writeFileSync(path.join(outputDirectory, `select-open-${themeId}.png`), image.toPNG());
  }

  console.log(JSON.stringify(report, undefined, 2));

  const failures = [];
  for (const [themeId, info] of Object.entries(report)) {
    if (!info.open) failures.push(`${themeId}: the dropdown did not open`);
    else if (info.rows !== 4) failures.push(`${themeId}: expected 4 rows, got ${info.rows}`);
  }
  // Each theme must paint the popup from its own tokens, not share one look.
  const backgrounds = new Set(Object.values(report).map((info) => info.background));
  if (backgrounds.size < 3) {
    failures.push(`the popup surface barely varies across themes: ${[...backgrounds].join(' | ')}`);
  }
  const radii = new Set(Object.values(report).map((info) => info.borderRadius));
  if (radii.size < 2) failures.push(`the popup radius never changes: ${[...radii].join(' | ')}`);
  const fonts = new Set(Object.values(report).map((info) => info.fontFamily));
  if (fonts.size < 2) failures.push(`the popup face never changes: ${[...fonts].join(' | ')}`);

  if (failures.length > 0) {
    console.error(`\nselect theming FAILED:\n- ${failures.join('\n- ')}`);
    app.exit(1);
    return;
  }
  console.log(`\nselect theming OK — screenshots in ${outputDirectory}`);
  app.exit(0);
});
