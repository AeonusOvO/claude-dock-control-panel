import path from 'node:path';
import { app } from 'electron';

/*
 * Every packaged path is derived from `app.getAppPath()` rather than `__dirname`, so moving a main
 * process file between directories cannot silently break window creation: `__dirname` changes with
 * the file's depth inside `dist/`, `app.getAppPath()` does not. In development it is the repository
 * root; when packaged it is `resources/app.asar`, which contains the same `dist/` tree.
 */
const fromAppRoot = (...segments: readonly string[]): string =>
  path.join(app.getAppPath(), ...segments);

/** Icons and images produced by `scripts/build/generate-icons.mjs`. */
export const assetPath = (fileName: string): string => fromAppRoot('assets', 'generated', fileName);

/*
 * Runtime PowerShell scripts must exist as real files on disk for the shell to execute them, so they
 * are unpacked out of the asar; the unpacked copy sits next to it under `resources/`.
 */
export const runtimeAssetPath = (fileName: string): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'runtime', fileName)
    : fromAppRoot('assets', 'runtime', fileName);

/** The compiled preload bundle, referenced by `webPreferences.preload`. */
export const preloadScriptPath = (): string => fromAppRoot('dist', 'preload', 'preload.js');

/** The built renderer entry, used when `ELECTRON_RENDERER_URL` is absent. */
export const rendererEntryPath = (): string => fromAppRoot('dist', 'renderer', 'index.html');
