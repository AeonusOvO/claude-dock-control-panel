import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NormalizedClaudeConfig } from '../src/main/claude-configuration';
import { parseClaudePermissionMode } from '../src/shared/claude-permission-mode';
import {
  connectionProtocolForRouterProvider,
  defaultConnectionProtocolForPreset,
  parseClaudeEffortThinkingDisabledError,
  parseClaudeMetrics,
  parseClaudeRuntimeApiError,
  routerRepairInputForProject,
  routerBlockingDetail,
  usesDefaultClaudeRouter,
} from '../src/main/claude-runtime';
import type { ClaudeRouterManagementState } from '../src/shared/contracts';

const runtimeSource = readFileSync(
  new URL('../src/main/claude-runtime.ts', import.meta.url),
  'utf8',
);
const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/preload.ts', import.meta.url), 'utf8');

/** Mirrors the rolling window `consumeTerminalOutput` keeps for diagnostics. */
const DIAGNOSTIC_BUFFER_LIMIT = 4_000;

const feedChunks = (chunks: readonly string[]): string => {
  let buffer = '';
  for (const chunk of chunks) {
    buffer = `${buffer}${chunk}`.slice(-DIAGNOSTIC_BUFFER_LIMIT);
  }
  return buffer;
};

describe('connection history protocol metadata', () => {
  it('maps both OpenAI router variants without guessing unknown manual router state', () => {
    expect(connectionProtocolForRouterProvider('anthropic_messages')).toBe('anthropic');
    expect(connectionProtocolForRouterProvider('openai_chat_completions')).toBe('openai');
    expect(connectionProtocolForRouterProvider('openai_responses')).toBe('openai');
    expect(defaultConnectionProtocolForPreset('gateway')).toBe('unknown');
    expect(defaultConnectionProtocolForPreset('custom')).toBe('anthropic');
  });
});

const routerConfig: NormalizedClaudeConfig = {
  apiKeyHelperPolicy: 'prefer-claudedock',
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
  it('keeps the official status-line session title for workspace synchronization', () => {
    const metrics = parseClaudeMetrics(
      JSON.stringify({
        capturedAt: Date.now(),
        modelId: 'claude-sonnet',
        sessionId: 'conversation-id',
        sessionName: '修复登录重定向',
      }),
    );

    expect(metrics).toMatchObject({
      sessionId: 'conversation-id',
      sessionName: '修复登录重定向',
    });
  });

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

  it('recognizes wrapped effort errors only when high effort conflicts with disabled thinking', () => {
    const wrappedMax =
      "API Error: 400 output_config.effort 'max' is not supported when thinking is\r\n" +
      'disabled on this model. Use effort high or below, or enable thinking.';
    const wrappedXhigh =
      "API Error: 400 output_config.effort 'xhigh' is not supported when thinking is\n" +
      'disabled on this model.';

    expect(parseClaudeEffortThinkingDisabledError(wrappedMax)).toBe('max');
    expect(parseClaudeEffortThinkingDisabledError(wrappedXhigh)).toBe('xhigh');
    expect(parseClaudeRuntimeApiError(wrappedMax)).toContain('自动降到“均衡”');
    expect(
      parseClaudeEffortThinkingDisabledError(
        "API Error: 400 output_config.effort 'high' is not supported by this relay.",
      ),
    ).toBeUndefined();
    expect(
      parseClaudeEffortThinkingDisabledError('API Error: 500 upstream unavailable'),
    ).toBeUndefined();
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
      apiKeyHelperPolicy: 'prefer-claudedock',
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

  it('uses a temporary high-priority setting for the single-credential policy', () => {
    expect(runtimeSource).toContain(
      "shouldDisableInheritedApiKeyHelper(config) ? { apiKeyHelper: '' } : {}",
    );
    expect(runtimeSource).toContain('apiKeyHelperPolicy: config.apiKeyHelperPolicy');
  });

  it('keeps every effort level and narrowly recovers the disabled-thinking compatibility error', () => {
    expect(runtimeSource).toContain('alwaysThinkingEnabled: true');
    expect(runtimeSource).toContain("await this.submitClaudeCommand(runtime, '/effort high');");
    expect(runtimeSource).toContain("runtime.effortRequest = 'high';");
    expect(runtimeSource).toContain(
      'parseClaudeEffortThinkingDisabledError(runtime.diagnosticBuffer)',
    );
    expect(runtimeSource).toContain('isClaudeEffortSafeAfterThinkingDisabledError(effort)');
  });
});

describe('Claude runtime permission mode observation', () => {
  it('reads the badge even when a repaint straddles two PTY chunks', () => {
    expect(parseClaudePermissionMode(feedChunks(['⏵⏵ accept ', 'edits on']))).toBe('acceptEdits');
    expect(
      parseClaudePermissionMode(feedChunks(['\u001b[38;5;208m⏸ pl', 'an mo', 'de on\u001b[39m'])),
    ).toBe('plan');
  });

  it('does not mistake a cursor-movement delta for a complete mode badge', () => {
    const rawDelta = '\u001b[23;3H⏵⏵ \u001b[1Cccept e\u001b[1Cits on (shift+tab to cycle)';

    expect(parseClaudePermissionMode(rawDelta)).toBeUndefined();
  });

  it('follows the mode forward as the session repaints new badges', () => {
    const chunks = ['⏸ manual mode on', '\r\n⏵⏵ accept edits on', '\r\n⏸ plan mode on'];
    expect(parseClaudePermissionMode(feedChunks(chunks.slice(0, 1)))).toBe('default');
    expect(parseClaudePermissionMode(feedChunks(chunks.slice(0, 2)))).toBe('acceptEdits');
    expect(parseClaudePermissionMode(feedChunks(chunks))).toBe('plan');
  });

  it('keeps reading the badge after the rolling buffer has scrolled past the older ones', () => {
    const overflowed = feedChunks([
      '⏸ plan mode on',
      'x'.repeat(DIAGNOSTIC_BUFFER_LIMIT),
      '⏵⏵ bypass permissions on',
    ]);

    expect(overflowed.length).toBeLessThanOrEqual(DIAGNOSTIC_BUFFER_LIMIT);
    expect(overflowed).not.toContain('plan mode on');
    expect(parseClaudePermissionMode(overflowed)).toBe('bypassPermissions');
  });

  it('steps the Shift+Tab cycle in a closed loop instead of counting presses blind', () => {
    // `auto` and `bypassPermissions` may or may not join the cycle, so a computed press count would
    // silently land on the wrong mode. Read a fresh screen before any key, confirm every step, and
    // stop as soon as the live cycle revisits a mode.
    expect(runtimeSource).toContain('const PERMISSION_MODE_MAX_STEPS = 8;');
    expect(runtimeSource).toContain(
      'const current = await this.readPermissionModeFromScreen(sessionId);',
    );
    expect(runtimeSource).toContain(
      '当前终端没有显示权限模式徽标。请先关闭 Claude Code 的选择器或确认框',
    );
    expect(runtimeSource).toMatch(
      /const visited = new Set<ClaudePermissionMode>\(\[current\]\);\s+for \(let step = 0; step < PERMISSION_MODE_MAX_STEPS; step \+= 1\) \{\s+const before = runtime\.permissionMode \?\? current;\s+this\.writeToTerminal\(sessionId, SHIFT_TAB_SEQUENCE\);\s+const changed = await this\.waitForPermissionModeChange\(sessionId, before\);/,
    );
    expect(runtimeSource).toContain('if (visited.has(changed))');
    expect(runtimeSource).toContain("throw new Error('该模式不在当前会话的可用循环中。');");
    expect(runtimeSource).toContain('const observed = await this.readPermissionModeFromScreen');
    expect(runtimeSource).toContain('已停止继续按键以避免切到错误模式');
    expect(runtimeSource).not.toContain('请在终端里直接按 Shift+Tab 试试');
    expect(runtimeSource).toContain('private readonly modeSwitchLocks = new Set<string>();');
    expect(runtimeSource).toContain('this.modeSwitchLocks.add(sessionId);');
    expect(runtimeSource).toContain('this.modeSwitchLocks.delete(sessionId);');
    expect(runtimeSource).toContain('public observePermissionModeFromScreen(');
    expect(runtimeSource).toContain('this.recordPermissionMode(runtime, mode);');
    expect(mainSource).toContain(
      "target.send('claude:permission-mode-probe', sessionId, probeId);",
    );
    expect(mainSource).toContain("'claude:permission-mode-probe-result'");
    expect(preloadSource).toContain("ipcRenderer.on('claude:permission-mode-probe', callback);");
    expect(preloadSource).toContain("ipcRenderer.send('claude:permission-mode-probe-result'");
    expect(runtimeSource).toMatch(
      /observePermissionModeFromRawOutput\(runtime: RuntimeSession\): void \{\s+if \(runtime\.permissionMode !== undefined\) \{\s+return;/,
    );
  });

  it('refuses the two modes the Shift+Tab cycle can never reach', () => {
    expect(runtimeSource).toContain(
      "throw new Error('「仅预批准」不在 Shift+Tab 循环内，需要重启会话才能进入。');",
    );
    expect(runtimeSource).toMatch(
      /if \(mode === 'bypassPermissions' && !this\.configStore\.getAllowBypassPermissions\(cwd\)\)/,
    );
  });

  it('re-derives and re-validates a model option in the main process before writing to the shell', () => {
    expect(runtimeSource).toMatch(
      /const option = this\.getModelOptions\(cwd, sessionId\)\.options\.find\(\s+\(candidate\) => candidate\.id === optionId,\s+\);/,
    );
    expect(runtimeSource).toContain(
      "throw new Error('这个模型属于其他接入端点，需要重启会话才能切换。');",
    );
    expect(runtimeSource).toContain('if (!MODEL_NAME_PATTERN.test(option.model))');
  });

  it('runs the official network guard before a real Anthropic connection test', () => {
    const testHandler = mainSource.slice(
      mainSource.indexOf("'claude:test-connection'"),
      mainSource.indexOf("ipcMain.handle('app:open-external'"),
    );
    expect(testHandler).toContain('const validatedInput = validateClaudeConfigInput(input);');
    expect(testHandler).toMatch(
      /if \(validatedInput\.provider === 'anthropic' && validatedInput\.protocol !== 'openai'\) \{[\s\S]*?assertAllowed\(\s*'anthropic-claude',\s*'first-request',\s*status\.cwd,\s*\);/,
    );
    expect(testHandler.indexOf('assertAllowed(')).toBeLessThan(
      testHandler.indexOf('requireClaudeRuntime().testConnection('),
    );
  });

  it('requests a fresh saved connection test when the hidden app window is restored', () => {
    const showWindow = mainSource.slice(
      mainSource.indexOf('const showMainWindow ='),
      mainSource.indexOf('const chooseDirectory ='),
    );
    expect(showWindow).toContain(
      'const wasVisible = mainWindow.isVisible() && !mainWindow.isMinimized();',
    );
    expect(showWindow).toContain("mainWindow.webContents.send('app:window-restored');");
    expect(preloadSource).toContain("ipcRenderer.on('app:window-restored', callback);");
    expect(preloadSource).toContain("ipcRenderer.removeListener('app:window-restored', callback);");
  });

  it('submits every main-process slash command as queued body and return writes', () => {
    expect(runtimeSource).toContain(
      'private readonly commandSubmissionQueues = new Map<string, Promise<void>>();',
    );
    expect(runtimeSource).toContain(
      'await this.submitClaudeCommand(runtime, `/model ${option.model}`);',
    );
    expect(runtimeSource).toContain(
      'await this.submitClaudeCommand(runtime, `/compact ${COMPACT_INSTRUCTION}`);',
    );
    expect(runtimeSource).toContain('const submitted = await writeTerminalSubmission(');
    expect(runtimeSource).toContain('buildTerminalSubmission(commandLine),');
    expect(runtimeSource).toContain(
      'const activeModel = runtime?.expectedModel ?? runtime?.metrics?.modelId ?? config.model;',
    );
    expect(mainSource).toContain(
      'return requireClaudeRuntime().getModelOptions(status.cwd, validatedSessionId);',
    );
    expect(runtimeSource).not.toContain(
      'this.writeToTerminal(sessionId, `/model ${option.model}\\r`);',
    );
    expect(mainSource).toContain('state: await runtime.runCommand(');
    expect(mainSource).not.toMatch(
      /workspace\.write\(\s*validatedSessionId,\s*`\$\{command\}.*\\r`/,
    );
  });

  it('waits for the PostCompact signal on the existing metrics tick and only acts on fresh stamps', () => {
    expect(runtimeSource).toMatch(
      /pollMetrics\(\): void \{\s+for \(const runtime of this\.sessions\.values\(\)\) \{\s+this\.pollRuntimeSignal\(runtime\);/,
    );
    expect(runtimeSource).toContain(
      "if (parsed.event !== 'PostCompact' || !signaledAt || signaledAt === runtime.signalSeenAt)",
    );
    expect(runtimeSource).toContain('runtime.signalSeenAt = signaledAt;');
    expect(runtimeSource).toContain('const COMPACT_TIMEOUT_MS = 120_000;');
  });
});
