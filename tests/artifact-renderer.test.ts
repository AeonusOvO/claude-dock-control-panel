// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ArtifactController } from '../src/renderer/artifact';
import { createMarkdownRenderer } from '../src/renderer/markdown';

const ARTIFACT_ID = 'artifact-00000000-0000-4000-8000-000000000001';
const ARTIFACT_URL = `claudedock-artifact://${ARTIFACT_ID}/index.html`;
const originalSandboxDescriptor = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'sandbox',
);
const sandboxTokens = new WeakMap<HTMLIFrameElement, Set<string>>();

beforeAll(() => {
  // jsdom 30 does not implement HTMLIFrameElement.sandbox's DOMTokenList yet.
  Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      const tokens = sandboxTokens.get(this) ?? new Set<string>();
      sandboxTokens.set(this, tokens);
      return {
        add: (...values: string[]) => values.forEach((value) => tokens.add(value)),
        contains: (value: string) => tokens.has(value),
      };
    },
  });
});

afterAll(() => {
  if (originalSandboxDescriptor) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', originalSandboxDescriptor);
  } else {
    Reflect.deleteProperty(HTMLIFrameElement.prototype, 'sandbox');
  }
});

const nextMicrotask = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const controllers: ArtifactController[] = [];

const createController = () => {
  const create = vi.fn(async () => ({ artifactId: ARTIFACT_ID, url: ARTIFACT_URL }));
  const destroy = vi.fn(async () => true);
  const onActiveChange = vi.fn();
  const onError = vi.fn();
  const controller = new ArtifactController({
    create,
    destroy,
    getTheme: () => ({
      appearance: 'light',
      variables: {
        '--accent-text': '#8a4b38',
        '--surface-canvas': '#f3f1ea',
      },
    }),
    onActiveChange,
    onError,
  });
  controllers.push(controller);
  return { controller, create, destroy, onActiveChange, onError };
};

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
  document.body.replaceChildren();
});

describe('Artifact renderer isolation', () => {
  it('does not create an iframe until the Markdown HTML opt-in button is clicked', async () => {
    const { controller, create } = createController();
    const renderer = createMarkdownRenderer({
      document,
      onOpenExternal: vi.fn(),
      onRunArtifact: (html, mount) => controller.run(html, mount).then(() => undefined),
      writeClipboardText: vi.fn(),
    });
    const container = document.createElement('div');
    document.body.append(container);
    const html = '<main><h1>交互图</h1><script>window.started = true</script></main>';

    await renderer.renderInto(container, `\`\`\`html\n${html}\n\`\`\``);

    expect(create).not.toHaveBeenCalled();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe(html);

    const run = container.querySelector<HTMLButtonElement>('.markdown-artifact-run');
    run?.click();
    await nextMicrotask();

    expect(create).toHaveBeenCalledWith(html);
    const frame = container.querySelector<HTMLIFrameElement>('.artifact-view__frame');
    expect(frame?.src).toBe(ARTIFACT_URL);
    expect(frame?.sandbox.contains('allow-scripts')).toBe(true);
    expect(frame?.sandbox.contains('allow-same-origin')).toBe(false);
  });

  it('accepts JSON-RPC notifications only from the matching iframe window', async () => {
    const { controller } = createController();
    const mount = document.createElement('div');
    document.body.append(mount);
    await controller.run('<main>chart</main>', mount);
    const frame = mount.querySelector<HTMLIFrameElement>('iframe');
    expect(frame?.contentWindow).not.toBeNull();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          method: 'artifact/resize',
          params: { height: 777 },
        },
        origin: 'null',
        source: window,
      }),
    );
    expect(frame?.style.height).toBe('');

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          method: 'artifact/resize',
          params: { height: 9_999 },
        },
        origin: 'https://untrusted.example',
        source: frame?.contentWindow,
      }),
    );
    expect(frame?.style.height).toBe('1200px');
  });

  it('posts the current theme on load and on a verified ready notification', async () => {
    const { controller } = createController();
    const mount = document.createElement('div');
    document.body.append(mount);
    await controller.run('<main>chart</main>', mount);
    const frame = mount.querySelector<HTMLIFrameElement>('iframe');
    const postMessage = vi.spyOn(frame?.contentWindow as Window, 'postMessage');

    frame?.dispatchEvent(new Event('load'));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          method: 'artifact/ready',
          params: { height: 320 },
        },
        source: frame?.contentWindow,
      }),
    );

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        jsonrpc: '2.0',
        method: 'claudedock/theme',
        params: {
          appearance: 'light',
          variables: {
            '--accent-text': '#8a4b38',
            '--surface-canvas': '#f3f1ea',
          },
        },
      },
      '*',
    );
    expect(frame?.style.height).toBe('320px');
  });

  it('removes the iframe immediately and destroys the main-process record exactly once', async () => {
    const { controller, destroy, onActiveChange } = createController();
    const mount = document.createElement('div');
    document.body.append(mount);
    await controller.run('<main>chart</main>', mount);

    expect(controller.activeIds()).toEqual([ARTIFACT_ID]);
    await controller.stop(ARTIFACT_ID);
    await controller.stop(ARTIFACT_ID);

    expect(controller.activeIds()).toEqual([]);
    expect(mount.dataset.state).toBe('stopped');
    expect(mount.querySelector('iframe')).toBeNull();
    expect(mount.textContent).toContain('可视化已停止');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(ARTIFACT_ID);
    expect(onActiveChange).toHaveBeenLastCalledWith([]);
  });

  it('destroys a record returned after its mount was disconnected', async () => {
    let resolveCreate!: (record: { artifactId: string; url: string }) => void;
    const create = vi.fn(
      () =>
        new Promise<{ artifactId: string; url: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const destroy = vi.fn(async () => true);
    const onError = vi.fn();
    const controller = new ArtifactController({
      create,
      destroy,
      getTheme: () => ({ appearance: 'dark', variables: {} }),
      onActiveChange: vi.fn(),
      onError,
    });
    controllers.push(controller);
    const mount = document.createElement('div');
    document.body.append(mount);

    const run = controller.run('<main>late chart</main>', mount);
    await nextMicrotask();
    mount.remove();
    resolveCreate({ artifactId: ARTIFACT_ID, url: ARTIFACT_URL });

    await expect(run).rejects.toThrow(/mount was removed/u);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(ARTIFACT_ID);
    expect(controller.activeIds()).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('force-cleans pending creates and waits for their main-process record cleanup', async () => {
    let resolveCreate!: (record: { artifactId: string; url: string }) => void;
    const destroy = vi.fn(async () => true);
    const controller = new ArtifactController({
      create: vi.fn(
        () =>
          new Promise<{ artifactId: string; url: string }>((resolve) => {
            resolveCreate = resolve;
          }),
      ),
      destroy,
      getTheme: () => ({ appearance: 'dark', variables: {} }),
      onActiveChange: vi.fn(),
      onError: vi.fn(),
    });
    controllers.push(controller);
    const mount = document.createElement('div');
    document.body.append(mount);
    const run = controller.run('<main>pending chart</main>', mount);

    // Cleanup may happen in the same task as the click/stream teardown.
    const cleanup = controller.forceCleanup();
    resolveCreate({ artifactId: ARTIFACT_ID, url: ARTIFACT_URL });

    await expect(run).rejects.toThrow(/mount was removed/u);
    await cleanup;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(controller.activeIds()).toEqual([]);
  });

  it('automatically destroys an active record when streaming removes its mount', async () => {
    const { controller, destroy } = createController();
    const mount = document.createElement('div');
    document.body.append(mount);
    await controller.run('<main>streamed chart</main>', mount);

    mount.remove();
    await nextMicrotask();

    expect(controller.activeIds()).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(ARTIFACT_ID);
  });

  it('rejects malformed artifact identifiers before mounting an iframe', async () => {
    const onError = vi.fn();
    const controller = new ArtifactController({
      create: vi.fn(async () => ({
        artifactId: 'not-an-artifact',
        url: 'claudedock-artifact://not-an-artifact/index.html',
      })),
      destroy: vi.fn(async () => false),
      getTheme: () => ({ appearance: 'dark', variables: {} }),
      onActiveChange: vi.fn(),
      onError,
    });
    controllers.push(controller);
    const mount = document.createElement('div');
    document.body.append(mount);

    await expect(controller.run('<main>chart</main>', mount)).rejects.toThrow(/标识/u);
    expect(mount.dataset.state).toBe('error');
    expect(mount.querySelector('iframe')).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/标识/u));
  });
});
