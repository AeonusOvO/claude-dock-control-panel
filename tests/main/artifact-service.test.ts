import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProtocolHandler = (request: Request) => Promise<Response>;
type BeforeRequestCallback = (result: { cancel?: boolean }) => void;
type BeforeRequestListener = (
  details: {
    frame?: MockFrame;
    id: number;
    method: string;
    referrer?: string;
    url: string;
    webContentsId?: number;
  },
  callback: BeforeRequestCallback,
) => void;
type CompletedListener = (details: {
  id: number;
  responseHeaders?: Record<string, string[] | undefined>;
  statusCode: number;
}) => void;
type ErrorListener = (details: { error: string; id: number }) => void;

interface MockFrame {
  frameTreeNodeId?: number;
  parent?: MockFrame | null;
  url?: string;
}

interface MockNavigationDetails {
  frame: MockFrame | null;
  initiator?: MockFrame | null;
  isMainFrame: boolean;
  isSameDocument: boolean;
  preventDefault: ReturnType<typeof vi.fn>;
  url: string;
}

interface MockWebContents {
  emitNavigation: (details: MockNavigationDetails) => void;
  id: number;
  isDestroyed: () => boolean;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  beforeRequest: undefined as BeforeRequestListener | undefined,
  completed: undefined as CompletedListener | undefined,
  errorOccurred: undefined as ErrorListener | undefined,
  protocolHandler: undefined as ProtocolHandler | undefined,
  registerSchemesAsPrivileged: vi.fn(),
  webContentsCreated: undefined as
    ((event: unknown, contents: MockWebContents) => void) | undefined,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    on: vi.fn((event: string, listener: (event: unknown, contents: MockWebContents) => void) => {
      if (event === 'web-contents-created') {
        mocks.webContentsCreated = listener;
      }
    }),
  },
  protocol: {
    handle: vi.fn((_scheme: string, handler: ProtocolHandler) => {
      mocks.protocolHandler = handler;
    }),
    registerSchemesAsPrivileged: mocks.registerSchemesAsPrivileged,
  },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeRequest: vi.fn(
          (_filter: unknown, listener: BeforeRequestListener) => (mocks.beforeRequest = listener),
        ),
        onCompleted: vi.fn(
          (_filter: unknown, listener: CompletedListener) => (mocks.completed = listener),
        ),
        onErrorOccurred: vi.fn(
          (_filter: unknown, listener: ErrorListener) => (mocks.errorOccurred = listener),
        ),
      },
    },
  },
  webContents: {
    getAllWebContents: vi.fn(() => []),
  },
}));

const { ArtifactService, registerArtifactScheme } = await import('../../src/main/artifact/service');
const { mainLogger } = await import('../../src/main/infra/logger');

const fixtureRoots: string[] = [];

const createWebContents = (id = 7): MockWebContents => {
  let navigationListener: ((details: MockNavigationDetails) => void) | undefined;
  return {
    emitNavigation: (details) => navigationListener?.(details),
    id,
    isDestroyed: () => false,
    on: vi.fn((event: string, listener: (details: MockNavigationDetails) => void) => {
      if (event === 'will-frame-navigate') {
        navigationListener = listener;
      }
    }),
    once: vi.fn(),
  };
};

const createService = () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-artifact-'));
  fixtureRoots.push(fixtureRoot);
  const onNetworkLog = vi.fn();
  return {
    fixtureRoot,
    onNetworkLog,
    service: new ArtifactService(fixtureRoot, onNetworkLog),
  };
};

beforeEach(() => {
  mocks.beforeRequest = undefined;
  mocks.completed = undefined;
  mocks.errorOccurred = undefined;
  mocks.protocolHandler = undefined;
  mocks.registerSchemesAsPrivileged.mockClear();
  mocks.webContentsCreated = undefined;
});

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

describe('Artifact protocol service', () => {
  it('registers a secure standard scheme without bypassing CSP', () => {
    registerArtifactScheme();

    expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        privileges: {
          bypassCSP: false,
          corsEnabled: true,
          secure: true,
          standard: true,
          supportFetchAPI: true,
        },
        scheme: 'claudedock-artifact',
      },
    ]);
  });

  it('serves only live artifact documents and tightens CSP when networking is disabled', async () => {
    const { service } = createService();
    const created = service.create('<main id="chart">safe chart</main>');
    service.install();
    const handler = mocks.protocolHandler as ProtocolHandler;

    const enabled = await handler(new Request(created.url));
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get('content-security-policy')).toContain('connect-src https: http:');
    const documentText = await enabled.text();
    expect(documentText).toContain(`<base href="claudedock-artifact://${created.artifactId}/">`);
    expect(documentText).toContain('event.source !== window.parent');
    expect(documentText).toContain('<main id="chart">safe chart</main>');

    service.setNetworkAllowed(false);
    const disabled = await handler(new Request(created.url));
    expect(disabled.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(disabled.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(disabled.headers.get('content-security-policy')).toContain("form-action 'none'");

    expect(service.destroy(created.artifactId)).toBe(true);
    expect((await handler(new Request(created.url))).status).toBe(410);
    expect(
      (await handler(new Request(`claudedock-artifact://${created.artifactId}/../settings.json`)))
        .status,
    ).toBe(404);
  });

  it('serves only explicitly packaged library resources and rejects traversal or unknown files', async () => {
    const { service } = createService();
    const created = service.create('<main>library alias</main>');
    service.install();
    const handler = mocks.protocolHandler as ProtocolHandler;

    const library = await handler(new Request('claudedock-artifact://libs/d3.min.js'));
    expect(library.status).toBe(200);
    expect(library.headers.get('content-type')).toContain('text/javascript');
    expect(library.headers.get('cache-control')).toContain('immutable');
    expect((await library.arrayBuffer()).byteLength).toBeGreaterThan(1_000);

    const liveHostAlias = await handler(
      new Request(`claudedock-artifact://${created.artifactId}/libs/d3.min.js`),
    );
    expect(liveHostAlias.status).toBe(200);
    expect(liveHostAlias.headers.get('content-type')).toContain('text/javascript');
    expect((await liveHostAlias.arrayBuffer()).byteLength).toBeGreaterThan(1_000);

    expect(
      (await handler(new Request('claudedock-artifact://libs/%2e%2e/%2e%2e/package.json'))).status,
    ).toBe(404);
    expect((await handler(new Request('claudedock-artifact://libs/not-installed.js'))).status).toBe(
      404,
    );
  });

  it('persists the networking switch and blocks requests attributed to an artifact frame', () => {
    const { fixtureRoot, onNetworkLog, service } = createService();
    const created = service.create('<main>network chart</main>');
    service.install();
    service.setNetworkAllowed(false);
    const callback = vi.fn<BeforeRequestCallback>();

    mocks.beforeRequest?.(
      {
        frame: { url: created.url },
        id: 41,
        method: 'GET',
        url: 'https://api.example.test/data.json',
      },
      callback,
    );

    expect(callback).toHaveBeenCalledWith({ cancel: true });
    expect(service.getState()).toMatchObject({
      allowed: false,
      entries: [
        {
          artifactId: created.artifactId,
          blocked: true,
          id: '41',
          method: 'GET',
          url: 'https://api.example.test/data.json',
        },
      ],
    });
    expect(onNetworkLog).toHaveBeenCalledWith(expect.objectContaining({ blocked: true }));
    expect(
      JSON.parse(readFileSync(path.join(fixtureRoot, 'claude', 'artifact-settings.json'), 'utf8')),
    ).toEqual({ allowNetwork: false, version: 1 });
    expect(new ArtifactService(fixtureRoot, vi.fn()).getState().allowed).toBe(false);
  });

  it('binds a live artifact to frame identity and blocks self-navigation outside its origin', () => {
    const { service } = createService();
    const created = service.create('<main>navigation boundary</main>');
    service.install();
    const contents = createWebContents();
    mocks.webContentsCreated?.({}, contents);
    const frame: MockFrame = {
      frameTreeNodeId: 73,
      parent: null,
      url: 'about:blank',
    };
    const initialNavigation: MockNavigationDetails = {
      frame,
      isMainFrame: false,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url: created.url,
    };
    contents.emitNavigation(initialNavigation);
    expect(initialNavigation.preventDefault).not.toHaveBeenCalled();

    // Electron preserves frameTreeNodeId while a cross-origin navigation changes process/URL.
    frame.url = created.url;
    const escapeNavigation: MockNavigationDetails = {
      frame,
      isMainFrame: false,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url: 'https://untrusted.example/escape',
    };
    contents.emitNavigation(escapeNavigation);

    expect(escapeNavigation.preventDefault).toHaveBeenCalledTimes(1);
    expect(service.getState().entries).toContainEqual(
      expect.objectContaining({
        artifactId: created.artifactId,
        blocked: true,
        method: 'NAVIGATE',
        url: 'https://untrusted.example/escape',
      }),
    );

    service.setNetworkAllowed(false);
    frame.url = 'https://untrusted.example/escape';
    const callback = vi.fn<BeforeRequestCallback>();
    mocks.beforeRequest?.(
      {
        frame,
        id: 74,
        method: 'GET',
        url: 'https://untrusted.example/after-navigation.json',
        webContentsId: contents.id,
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });

  it('fails closed for corrupt settings while preserving first-run ENOENT compatibility', () => {
    const missing = createService();
    expect(missing.service.getState().allowed).toBe(true);

    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'claudedock-artifact-corrupt-'));
    fixtureRoots.push(fixtureRoot);
    const settingsDirectory = path.join(fixtureRoot, 'claude');
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(path.join(settingsDirectory, 'artifact-settings.json'), '{not-json', 'utf8');
    const service = new ArtifactService(fixtureRoot, vi.fn());

    expect(service.getState().allowed).toBe(false);
    expect(mainLogger.query({ domain: 'artifact', message: '设置读取失败', limit: 1 })).toEqual([
      expect.objectContaining({
        kind: 'environment',
        message: expect.stringContaining('读取失败'),
      }),
    ]);
  });

  it('does not change the in-memory network policy when persistence fails', () => {
    const { fixtureRoot, service } = createService();
    const settingsPath = path.join(fixtureRoot, 'claude', 'artifact-settings.json');
    mkdirSync(settingsPath, { recursive: true });

    expect(service.getState().allowed).toBe(true);
    expect(() => service.setNetworkAllowed(false)).toThrow();
    expect(service.getState().allowed).toBe(true);
    expect(mainLogger.query({ domain: 'artifact', message: '设置保存失败', limit: 1 })).toEqual([
      expect.objectContaining({
        kind: 'environment',
        message: expect.stringContaining('保存失败'),
      }),
    ]);
  });

  it('audits successful and failed requests but ignores traffic outside artifact frames', () => {
    const { service } = createService();
    const created = service.create('<main>network chart</main>');
    service.install();
    const allowed = vi.fn<BeforeRequestCallback>();

    mocks.beforeRequest?.(
      {
        frame: { url: created.url },
        id: 51,
        method: 'POST',
        url: 'https://api.example.test/render',
      },
      allowed,
    );
    expect(allowed).toHaveBeenCalledWith({});
    mocks.completed?.({
      id: 51,
      responseHeaders: { 'Content-Length': ['321'] },
      statusCode: 201,
    });

    mocks.beforeRequest?.(
      {
        frame: { url: created.url },
        id: 52,
        method: 'GET',
        url: 'https://api.example.test/failure',
      },
      vi.fn(),
    );
    mocks.errorOccurred?.({ error: 'net::ERR_FAILED', id: 52 });

    const unrelated = vi.fn<BeforeRequestCallback>();
    mocks.beforeRequest?.(
      {
        frame: { url: 'https://claudedock.example.test/' },
        id: 53,
        method: 'GET',
        url: 'https://api.example.test/ignored',
      },
      unrelated,
    );
    expect(unrelated).toHaveBeenCalledWith({});

    expect(service.getState().entries).toEqual([
      expect.objectContaining({
        blocked: false,
        id: '51',
        responseBytes: 321,
        status: 201,
      }),
      expect.objectContaining({
        blocked: false,
        error: 'net::ERR_FAILED',
        id: '52',
      }),
    ]);
  });

  it('rejects empty, oversized, and malformed lifecycle inputs', () => {
    const { service } = createService();

    expect(() => service.create('')).toThrow(/2 MiB/u);
    expect(() => service.create('x'.repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MiB/u);
    expect(() => service.destroy('../artifact')).toThrow(/标识/u);
  });
});
