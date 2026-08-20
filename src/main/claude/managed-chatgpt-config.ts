import net from 'node:net';
import path from 'node:path';

export const DEFAULT_PORT = 8317;
export const LAST_PORT = 8327;
export const OAUTH_DEFAULT_PORT = 1455;
export const OAUTH_LAST_PORT = 1465;

const MANAGED_GATEWAY_ROUTE_ENVIRONMENT_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_AGENT_',
  'CLAUDE_CODE_',
  'CODEX_',
  'CODEXL_',
  'CCR_',
  'OPENAI_',
] as const;

/**
 * The managed gateway must authenticate and route with its app-owned config/auth directory only.
 * Transport proxy variables remain available because they describe how to reach the official
 * endpoint, while provider credentials and base-URL overrides could silently send the request to
 * a relay inherited from the process that launched ClaudeDock.
 */
export const buildManagedGatewayEnvironment = (
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized === 'ELECTRON_RUN_AS_NODE' ||
      MANAGED_GATEWAY_ROUTE_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      delete environment[key];
    }
  }
  return environment;
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

export const portIsAvailable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });

export const findAvailablePort = async (
  firstPort: number,
  lastPort: number,
  purpose: string,
): Promise<number> => {
  for (let port = firstPort; port <= lastPort; port += 1) {
    if (await portIsAvailable(port)) {
      return port;
    }
  }
  throw new Error(`本机 ${firstPort}–${lastPort} 端口均被占用，无法${purpose}。`);
};
