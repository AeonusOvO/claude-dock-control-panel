/*
 * Every theme's UI and display face ships self-hosted, because a theme switch is meant to change
 * typography as visibly as it changes colour. Claude pairs Hanken Grotesk with the Newsreader
 * serif (the closest free stand-ins for Anthropic's Styrene/Tiempos); Telegram uses Roboto, the
 * face its own desktop client uses; the dark themes keep Inter so they read as tooling.
 */
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/roboto';
import '@fontsource-variable/inter';
/*
 * Vendor stylesheets are imported here, ahead of `styles.css`, because emit order *is* the cascade
 * for them. xterm.css hardcodes `background-color: #000` on `.xterm .xterm-viewport` at exactly the
 * same specificity as the override in `views/terminal.css`, so whichever rule the bundler writes
 * last wins. While this import lived in `features/terminal/terminal-views-create.ts`, Vite emitted
 * it *after* the design system and the viewport kept its opaque black — the character grid only
 * covers whole cells, so every theme showed a black ring in the leftover strip right of and below
 * the grid. It reproduced only in packaged builds; `vite serve` injects <style> tags in a different
 * order. Keep every third-party stylesheet on this side of `styles.css`.
 */
import 'katex/dist/katex.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import {
  enhanceAllSelects,
  installPressRipples,
  installSelectDismissHandlers,
} from './platform/components';
import { Registry } from './platform/registry';
import { installScrollChaining } from './platform/scroll-chaining';
import { bootstrapApplication } from './bootstrap';

/*
 * The component kit is installed at module scope, before anything touches `window.controlPanel`, so
 * a native `<select>` is never painted by the OS — not even for the frame the bridge takes to come
 * up, and not if some later initialisation throws. Options populated afterwards are picked up by the
 * per-select MutationObserver.
 */
enhanceAllSelects();
installSelectDismissHandlers();
installPressRipples();
installScrollChaining();

const rendererRegistry = new Registry();

void bootstrapApplication(rendererRegistry);
