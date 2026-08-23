import net from 'node:net';
import path from 'node:path';

export const DEFAULT_PORT = 8317;
export const LAST_PORT = 8327;
export const OAUTH_DEFAULT_PORT = 1455;
export const OAUTH_LAST_PORT = 1465;

const MANAGED_GATEWAY_ENVIRONMENT_ALLOWLIST = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PSMODULEPATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

/**
 * The managed gateway must authenticate and route with its app-owned config/auth directory only.
 * Transport proxy variables remain available because they describe how to reach the official
 * endpoint, while provider credentials and base-URL overrides could silently send the request to
 * a relay inherited from the process that launched ClaudeDock.
 */
export type ManagedGatewayEnvironmentOverrides = Record<string, null | string | undefined>;

const setEnvironmentValue = (
  environment: NodeJS.ProcessEnv,
  name: string,
  value: null | string | undefined,
): void => {
  const normalizedName = name.toUpperCase();
  for (const existingName of Object.keys(environment)) {
    if (existingName.toUpperCase() === normalizedName) {
      delete environment[existingName];
    }
  }
  if (value !== null && value !== undefined) {
    environment[name] = value;
  }
};

export const buildManagedGatewayEnvironment = (
  inherited: NodeJS.ProcessEnv = process.env,
  overrides: ManagedGatewayEnvironmentOverrides = {},
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (MANAGED_GATEWAY_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (MANAGED_GATEWAY_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) {
      setEnvironmentValue(environment, name, value);
    }
  }
  return environment;
};

const normalizedEnvironmentEntries = (
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<readonly [string, string]> =>
  Object.entries(environment)
    .map(([name, value]) => [name.toUpperCase(), value ?? ''] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName),
    );

export const managedGatewayEnvironmentsEqual = (
  left: NodeJS.ProcessEnv,
  right: NodeJS.ProcessEnv,
): boolean => {
  const leftEntries = normalizedEnvironmentEntries(left);
  const rightEntries = normalizedEnvironmentEntries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([leftName, leftValue], index) =>
        leftName === rightEntries[index]?.[0] && leftValue === rightEntries[index]?.[1],
    )
  );
};

export const buildManagedGatewayConfig = (input: {
  authDirectory: string;
  clientKey: string;
  managementKey: string;
  port: number;
}): string => {
  if (
    !path.isAbsolute(input.authDirectory) ||
    !/^sk-claudedock-[A-Za-z0-9_-]{32,}$/.test(input.clientKey) ||
    !/^mgmt-claudedock-[A-Za-z0-9_-]{32,}$/.test(input.managementKey) ||
    !Number.isInteger(input.port) ||
    input.port < DEFAULT_PORT ||
    input.port > LAST_PORT
  ) {
    throw new Error('ClaudeDock 托管网关配置参数无效。');
  }
  return [
    'host: "127.0.0.1"',
    `port: ${input.port}`,
    'tls:',
    '  enable: false',
    'remote-management:',
    '  allow-remote: false',
    `  secret-key: ${JSON.stringify(input.managementKey)}`,
    '  disable-control-panel: false',
    '  disable-auto-update-panel: true',
    '  panel-github-repository: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"',
    `auth-dir: ${JSON.stringify(input.authDirectory.replaceAll('\\', '/'))}`,
    'api-keys:',
    `  - ${JSON.stringify(input.clientKey)}`,
    'debug: false',
    'logging-to-file: false',
    'usage-statistics-enabled: false',
    'request-retry: 5',
    'max-retry-credentials: 0',
    'max-retry-interval: 60',
    'routing:',
    '  strategy: "round-robin"',
    '  session-affinity: true',
    '  session-affinity-ttl: "36h"',
    'streaming:',
    '  keepalive-seconds: 15',
    '  bootstrap-retries: 2',
    '',
  ].join('\n');
};

export const portIsAvailable = (port: number, timeoutMs = 1_000): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeAllListeners();
      resolve(available);
    };
    const timer = setTimeout(
      () => {
        try {
          server.close();
        } catch {
          // A timed-out listen may not have reached a closable state.
        }
        finish(false);
      },
      Math.max(1, timeoutMs),
    );
    timer.unref();
    server.unref();
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => finish(true));
    });
  });

export const findAvailablePort = async (
  firstPort: number,
  lastPort: number,
  purpose: string,
  signal?: AbortSignal,
): Promise<number> => {
  for (let port = firstPort; port <= lastPort; port += 1) {
    if (signal?.aborted) throw new Error('托管网关端口检查已取消。');
    if (await portIsAvailable(port)) {
      return port;
    }
  }
  throw new Error(`本机 ${firstPort}–${lastPort} 端口均被占用，无法${purpose}。`);
};
