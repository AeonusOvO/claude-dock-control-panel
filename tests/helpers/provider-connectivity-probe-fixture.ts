import { vi } from 'vitest';
import {
  ProviderConnectivityProbe,
  type ApplicationEndpointRequest,
} from '../../src/main/network/provider-connectivity-probe';
import {
  NO_PROXY_ENVIRONMENT_KEYS,
  PROXY_ENVIRONMENT_KEYS,
} from '../../src/main/network/path-resolver';

const PROXY_TEST_KEYS = [...PROXY_ENVIRONMENT_KEYS, ...NO_PROXY_ENVIRONMENT_KEYS] as const;

export const withProxyEnvironment = async (
  values: Partial<Record<(typeof PROXY_TEST_KEYS)[number], string>>,
  operation: () => Promise<void>,
): Promise<void> => {
  const originalEnvironment = PROXY_TEST_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of PROXY_TEST_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    await operation();
  } finally {
    for (const key of PROXY_TEST_KEYS) delete process.env[key];
    for (const [key, value] of originalEnvironment) {
      if (value !== undefined) process.env[key] = value;
    }
  }
};

export const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

export const createProbe = (
  cliRequest?: (url: string, websocket: boolean) => Promise<string>,
  applicationRequest?: ApplicationEndpointRequest,
) => {
  const appFetch = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }),
  );
  return {
    appFetch,
    probe: new ProviderConnectivityProbe({
      appFetch,
      applicationRequest,
      cliRequest:
        cliRequest ??
        (async (url, websocket) =>
          websocket ? `101|${url.replace(/^wss:/, 'https:')}|0|` : `401|${url}|0|application/json`),
      clientVersion: async () => '0.146.0',
      dnsLookup: async () => [{ address: '203.0.113.10', family: 4 }],
      resolveProxy: async () => 'DIRECT',
    }),
  };
};
