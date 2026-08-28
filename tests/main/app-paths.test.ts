import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
afterEach(() => {
  if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
  else Reflect.deleteProperty(process, 'resourcesPath');
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('relocated application assets', () => {
  it.each(['E:\\Apps with spaces\\ClaudeDock', 'Z:\\软件\\ClaudeDock'])(
    'resolves packaged resources from the current installation: %s',
    async (installation) => {
      const resources = path.join(installation, 'resources');
      const archive = path.join(resources, 'app.asar');
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
      vi.doMock('electron', () => ({ app: { getAppPath: () => archive, isPackaged: true } }));
      const paths = await import('../../src/main/app/paths');

      expect(paths.preloadScriptPath()).toBe(path.join(archive, 'dist', 'preload', 'preload.js'));
      expect(paths.rendererEntryPath()).toBe(path.join(archive, 'dist', 'renderer', 'index.html'));
      expect(paths.assetPath('app-icon.ico')).toBe(
        path.join(archive, 'assets', 'generated', 'app-icon.ico'),
      );
      expect(paths.runtimeAssetPath('claude-runtime-event.ps1')).toBe(
        path.join(resources, 'app.asar.unpacked', 'assets', 'runtime', 'claude-runtime-event.ps1'),
      );
    },
  );

  it('uses the current repository for development scripts, not a packaged resource directory', async () => {
    const root = path.resolve('relocated development workspace');
    vi.doMock('electron', () => ({ app: { getAppPath: () => root, isPackaged: false } }));
    const paths = await import('../../src/main/app/paths');
    expect(paths.runtimeAssetPath('claude-runtime-event.ps1')).toBe(
      path.join(root, 'assets', 'runtime', 'claude-runtime-event.ps1'),
    );
    expect(paths.rendererEntryPath()).toBe(path.join(root, 'dist', 'renderer', 'index.html'));
  });
});
