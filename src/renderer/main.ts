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
import 'katex/dist/katex.css';
import './styles.css';
import {
  enhanceAllSelects,
  installPressRipples,
  installSelectDismissHandlers,
} from './platform/components';
import { Registry } from './platform/registry';
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

const rendererRegistry = new Registry();

void bootstrapApplication(rendererRegistry);
