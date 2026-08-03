import { describe, expect, it } from 'vitest';
import { evaluateExternalProxyEnvironment } from '../src/main/proxy/external-proxy';

describe('external proxy coexistence decision', () => {
  it('allows V2RayN system-proxy mode to coexist with random ClaudeDock loopback ports', () => {
    const view = evaluateExternalProxyEnvironment({
      checkedAt: 1,
      externalProcesses: ['v2rayN'],
      resolvedSystemProxy: 'PROXY 127.0.0.1:10809; DIRECT',
      virtualInterfaces: [],
    });

    expect(view.mode).toBe('parallel-safe');
    expect(view.advice).toContain('可以并行');
    expect(view.summary).toContain('v2rayN');
  });

  it('requires an explicit decision when an external TUN may wrap the built-in Xray', () => {
    const view = evaluateExternalProxyEnvironment({
      externalProcesses: ['sing-box', 'v2rayN'],
      virtualInterfaces: ['VPN / 隧道接口'],
    });

    expect(view.mode).toBe('chain-risk');
    expect(view.summary).toContain('链式代理');
    expect(view.advice).toContain('不会代替你结束进程');
  });

  it('never exposes inline proxy credentials', () => {
    const view = evaluateExternalProxyEnvironment({
      externalProcesses: [],
      resolvedSystemProxy: 'PROXY http://user:secret@127.0.0.1:8080',
      virtualInterfaces: [],
    });
    expect(view.resolvedSystemProxy).toBe('检测到已配置代理（地址已隐藏）');
    expect(JSON.stringify(view)).not.toContain('secret');
  });
});
