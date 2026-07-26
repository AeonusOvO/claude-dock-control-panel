import { describe, expect, it } from 'vitest';
import type { NormalizedClaudeConfig } from '../src/main/claude-configuration';
import {
  parseClaudeRuntimeApiError,
  routerRepairInputForProject,
  routerBlockingDetail,
  usesDefaultClaudeRouter,
} from '../src/main/claude-runtime';
import type { ClaudeRouterManagementState } from '../src/shared/contracts';

const routerConfig: NormalizedClaudeConfig = {
  authMode: 'authToken',
  baseUrl: 'http://127.0.0.1:3456',
  model: 'relay/claude-sonnet-4-5',
  preset: 'gateway',
  provider: 'gateway',
};

const routerState: ClaudeRouterManagementState = {
  canUninstall: true,
  checkedAt: Date.now(),
  endpoint: 'http://127.0.0.1:3456',
  gatewayState: 'error',
  installed: true,
  installationKind: 'npm',
  manageable: true,
  managementAvailable: true,
  message: 'No available models.',
  providers: [],
  serviceRunning: true,
  version: '3.0.15',
};

describe('Claude runtime route diagnostics', () => {
  it('recognizes the real Claude Code ConnectionRefused output without echoing raw details', () => {
    expect(
      parseClaudeRuntimeApiError(
        '\u001B[31mAPI Error: Unable to connect to API (ConnectionRefused)\u001B[0m\r\n',
      ),
    ).toContain('无法连接');
    expect(
      parseClaudeRuntimeApiError(
        '\u001B[31mAPI Error: Unable to connect to API (ConnectionRefused)\u001B[0m\r\n',
      ),
    ).not.toContain('ConnectionRefused');
    expect(parseClaudeRuntimeApiError('Claude Code ready')).toBeUndefined();
  });

  it('redacts credential-shaped values from generic API errors', () => {
    const result = parseClaudeRuntimeApiError(
      'API Error: upstream rejected Bearer sk-example-sensitive-token',
    );

    expect(result).toContain('接口请求失败');
    expect(result).not.toContain('upstream rejected');
    expect(result).not.toContain('sk-example-sensitive-token');
  });

  it('blocks a project that points at CCR while its Provider list is empty', () => {
    expect(usesDefaultClaudeRouter(routerConfig)).toBe(true);
    expect(routerBlockingDetail(routerConfig, routerState)).toContain('没有任何服务提供方');
  });

  it('does not apply an unrelated CCR failure to a direct remote endpoint', () => {
    const directConfig: NormalizedClaudeConfig = {
      ...routerConfig,
      baseUrl: 'https://gateway.example.com',
      preset: 'custom',
    };

    expect(usesDefaultClaudeRouter(directConfig)).toBe(false);
    expect(routerBlockingDetail(directConfig, routerState)).toBeUndefined();
  });

  it('builds a secret-preserving one-click repair input from a direct Anthropic project', () => {
    const directConfig: NormalizedClaudeConfig = {
      authMode: 'apiKey',
      baseUrl: 'https://gateway.example.com/team',
      model: 'team-opus',
      preset: 'custom',
      provider: 'gateway',
    };

    expect(routerRepairInputForProject(directConfig, 'stored-project-key')).toEqual({
      apiKey: 'stored-project-key',
      baseUrl: 'https://gateway.example.com/team/v1/messages',
      credentialAction: 'replace',
      makePreferred: true,
      models: ['team-opus'],
      name: 'claudedock-gateway.example.com',
      protocol: 'anthropic_messages',
      useForCurrentProject: false,
    });
    expect(() =>
      routerRepairInputForProject({ ...directConfig, authMode: 'authToken' }, 'bearer-token'),
    ).toThrow('接口密钥');
  });
});
