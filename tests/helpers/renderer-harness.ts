import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { vi, type Mock } from 'vitest';
import type {
  ClaudeProjectState,
  CodexProjectState,
  ControlPanelApi,
  WorkspaceState,
} from '../../src/shared/contracts';

export const rendererMarkup = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'index.html'),
  'utf8',
);

const emptyWorkspace: WorkspaceState = {
  activeSessionId: '',
  projects: [],
  sessions: [],
};

const defaultClaudeState = (sessionId: string): ClaudeProjectState => ({
  active: false,
  allowBypassPermissions: false,
  config: {
    apiKeyHelperPolicy: 'inherit',
    authMode: 'existing',
    baseUrl: '',
    credentialConfigured: false,
    model: 'default',
    preset: 'anthropic',
    protocol: 'anthropic',
    provider: 'anthropic',
  },
  cwd: 'D:\\Project',
  installation: {
    installationKind: 'native',
    installed: true,
    message: 'Claude Code 已就绪。',
    security: 'ready',
  },
  sessionId,
  speed: {
    availability: 'unsupported',
    canSelectFast: false,
    detail: '',
    mechanism: 'none',
    model: 'default',
    preference: 'standard',
    status: 'standard',
  },
  stateRevision: 0,
});

const defaultCodexState = (sessionId: string): CodexProjectState => ({
  active: false,
  cwd: 'D:\\Project',
  installation: {
    installed: false,
    message: '',
    updateAvailable: false,
  },
  login: { phase: 'idle' },
  requiresOpenaiAuth: false,
  sessionId,
});

export interface RendererCall {
  args: unknown[];
  method: keyof ControlPanelApi;
}

export interface RendererHarnessOptions {
  prepareDom?: (dom: JSDOM) => void;
}

export interface RendererHarness {
  readonly api: ControlPanelApi;
  readonly calls: readonly RendererCall[];
  readonly document: Document;
  readonly dom: JSDOM;
  cleanup: () => Promise<void>;
  clearCalls: () => void;
  click: (selector: string) => void;
  emit: (method: keyof ControlPanelApi, ...args: unknown[]) => void;
  flush: () => Promise<void>;
  method: (name: keyof ControlPanelApi) => Mock;
  query: <ElementType extends Element = HTMLElement>(selector: string) => ElementType;
}

const defaultAppSettings = {
  advanced: {
    chatIdleTimeoutMinutes: 0 as const,
    webResearchIsolation: false,
  },
  artifactNetworkAllowed: true,
  claudeContextWindowMode: 'auto' as const,
  closeBehavior: 'tray' as const,
  footerResourcePreference: 'auto' as const,
  language: 'zh-CN' as const,
  launchAtLogin: false,
  managedChatGptContextWindowMode: 'standard' as const,
  theme: 'claude' as const,
  version: 'test',
};

const setGlobal = (
  descriptors: Map<PropertyKey, PropertyDescriptor | undefined>,
  key: PropertyKey,
  value: unknown,
): void => {
  if (!descriptors.has(key)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
    writable: true,
  });
};

export const createRendererHarness = async (
  overrides: Partial<ControlPanelApi> = {},
  options: RendererHarnessOptions = {},
): Promise<RendererHarness> => {
  vi.resetModules();
  vi.doMock('shiki/core', () => ({
    createHighlighterCore: () =>
      Promise.reject(new Error('Syntax highlighting disabled in harness.')),
  }));
  vi.doMock('shiki/engine/oniguruma', () => ({
    createOnigurumaEngine: () => ({}),
  }));

  const dom = new JSDOM(rendererMarkup, {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const domWindow = dom.window;
  options.prepareDom?.(dom);
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const calls: RendererCall[] = [];
  const methods = new Map<keyof ControlPanelApi, Mock>();
  const listeners = new Map<keyof ControlPanelApi, Set<(...args: unknown[]) => void>>();

  const defaultMethod = (name: keyof ControlPanelApi, args: unknown[]): unknown => {
    if (name.startsWith('on')) {
      const listener = args[0];
      if (typeof listener !== 'function') {
        throw new Error(`${String(name)} requires a listener.`);
      }
      const registered = listeners.get(name) ?? new Set<(...values: unknown[]) => void>();
      registered.add(listener as (...values: unknown[]) => void);
      listeners.set(name, registered);
      return () => {
        registered.delete(listener as (...values: unknown[]) => void);
      };
    }
    switch (name) {
      case 'getAppSettings':
        return Promise.resolve(defaultAppSettings);
      case 'getWorkspace':
        return Promise.resolve(emptyWorkspace);
      case 'getDevelopmentRuntime':
        return Promise.resolve({
          cwd: 'D:\\Project',
          runtime: 'claude',
          sessionId: String(args[0] ?? ''),
        });
      case 'getClaudeConnectionHistory':
      case 'listBusyLeases':
      case 'listDownloads':
      case 'listNativeRecoveries':
      case 'setConversationBusy':
        return Promise.resolve([]);
      case 'getDroppedPath':
        return '';
      case 'getClaudeModelOptions':
        return Promise.resolve({ activeModel: 'claude-sonnet-5', options: [] });
      case 'getClaudeProjectState':
        return Promise.resolve(defaultClaudeState(String(args[0] ?? '')));
      case 'getCodexProjectState':
        return Promise.resolve(defaultCodexState(String(args[0] ?? '')));
      case 'startTerminal':
        return Promise.resolve({
          ok: true,
          status: {
            cwd: 'D:\\Project',
            id: String(args[0] ?? ''),
            phase: 'running',
            ptyGeneration: Number(args[1] ?? 1),
            shell: 'powershell.exe',
            title: 'Project',
          },
        });
      default:
        return Promise.resolve(undefined);
    }
  };

  const method = (name: keyof ControlPanelApi): Mock => {
    const existing = methods.get(name);
    if (existing) return existing;
    const replacement = overrides[name] as ((...args: unknown[]) => unknown) | undefined;
    const mock = vi.fn((...args: unknown[]) => {
      calls.push({ args, method: name });
      return replacement ? replacement(...args) : defaultMethod(name, args);
    });
    methods.set(name, mock);
    return mock;
  };

  const api = new Proxy({} as ControlPanelApi, {
    get: (_target, property) => method(property as keyof ControlPanelApi),
  });

  const dialogPrototype = domWindow.HTMLDialogElement.prototype;
  Object.defineProperties(dialogPrototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement, returnValue = '') {
        this.returnValue = returnValue;
        this.removeAttribute('open');
        this.dispatchEvent(new domWindow.Event('close'));
      },
    },
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
  });

  Object.defineProperty(domWindow.HTMLFormElement.prototype, 'requestSubmit', {
    configurable: true,
    value(this: HTMLFormElement, submitter?: HTMLElement) {
      const event = new domWindow.Event('submit', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'submitter', { configurable: true, value: submitter });
      this.dispatchEvent(event);
    },
  });

  Object.defineProperty(domWindow, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
    }),
  });
  Object.defineProperty(domWindow, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => domWindow.setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(domWindow, 'cancelAnimationFrame', {
    configurable: true,
    value: (handle: number) => domWindow.clearTimeout(handle),
  });
  Object.defineProperty(domWindow.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  });
  Object.defineProperty(domWindow.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(domWindow.HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(domWindow.HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(domWindow, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replaceAll(/[^a-zA-Z0-9_-]/gu, '\\$&') },
  });
  Object.defineProperty(domWindow, 'controlPanel', {
    configurable: true,
    value: api,
  });

  class FakeResizeObserver implements ResizeObserver {
    public disconnect(): void {}
    public observe(): void {}
    public unobserve(): void {}
  }

  for (const [key, value] of Object.entries({
    Blob: domWindow.Blob,
    CSS: domWindow.CSS,
    CustomEvent: domWindow.CustomEvent,
    DocumentFragment: domWindow.DocumentFragment,
    Element: domWindow.Element,
    Event: domWindow.Event,
    File: domWindow.File,
    HTMLButtonElement: domWindow.HTMLButtonElement,
    HTMLDialogElement: domWindow.HTMLDialogElement,
    HTMLElement: domWindow.HTMLElement,
    HTMLFormElement: domWindow.HTMLFormElement,
    HTMLIFrameElement: domWindow.HTMLIFrameElement,
    HTMLInputElement: domWindow.HTMLInputElement,
    HTMLSelectElement: domWindow.HTMLSelectElement,
    HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
    MessageEvent: domWindow.MessageEvent,
    MutationObserver: domWindow.MutationObserver,
    Node: domWindow.Node,
    ResizeObserver: FakeResizeObserver,
    Window: domWindow.Window,
    cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
    document: domWindow.document,
    getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
    localStorage: domWindow.localStorage,
    navigator: domWindow.navigator,
    requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
    window: domWindow,
  })) {
    setGlobal(descriptors, key, value);
  }

  await import('../../src/renderer/main');

  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  await flush();

  const query = <ElementType extends Element = HTMLElement>(selector: string): ElementType => {
    const element = domWindow.document.querySelector<ElementType>(selector);
    if (!element) {
      throw new Error(`Missing renderer fixture element: ${selector}`);
    }
    return element;
  };

  return {
    api,
    calls,
    document: domWindow.document,
    dom,
    cleanup: async () => {
      domWindow.dispatchEvent(new domWindow.Event('beforeunload'));
      await flush();
      domWindow.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
      vi.doUnmock('shiki/core');
      vi.doUnmock('shiki/engine/oniguruma');
      vi.resetModules();
    },
    clearCalls: () => {
      calls.splice(0);
      for (const mock of methods.values()) mock.mockClear();
    },
    click: (selector) => {
      query<HTMLElement>(selector).click();
    },
    emit: (name, ...args) => {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    flush,
    method,
    query,
  };
};
