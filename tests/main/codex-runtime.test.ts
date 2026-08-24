import { describe, expect, it, vi } from 'vitest';
import type {
  CodexInstallOperation,
  CodexLoginMethod,
  CodexProjectState,
} from '../../src/shared/contracts';
import { BusyRegistry } from '../../src/main/coordination/busy-registry';
import {
  buildCodexLaunchCommand,
  CodexRuntime,
  codexResourceUsage,
  parseCodexAccountRead,
  parseCodexRateLimits,
} from '../../src/main/codex/runtime';
import type { DownloadEngine } from '../../src/main/download/engine';

const createRuntime = (mockState = true) => {
  const onState = vi.fn<(state: CodexProjectState) => void>();
  const writeToTerminal = vi.fn(
    (_sessionId: string, _ptyGeneration: number, _data: string): boolean => true,
  );
  const runtime = new CodexRuntime(
    'D:\\claudedock-test',
    onState,
    writeToTerminal,
    {} as DownloadEngine,
    new BusyRegistry(),
    fetch,
  );
  const state = (sessionId: string, cwd: string): CodexProjectState => ({
    active: runtime.isActive(sessionId),
    activeOperation: Reflect.apply(
      Reflect.get(runtime, 'activeOperationView') as () => CodexProjectState['activeOperation'],
      runtime,
      [],
    ),
    cwd,
    installation: {
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    },
    login: { ...(Reflect.get(runtime, 'login') as CodexProjectState['login']) },
    revision: Reflect.get(runtime, 'stateRevision') as number,
    requiresOpenaiAuth: false,
    sessionId,
  });
  if (mockState) {
    vi.spyOn(runtime, 'getState').mockImplementation(async (sessionId, cwd) =>
      state(sessionId, cwd),
    );
  }
  const ensureSession = Reflect.get(runtime, 'ensureSession') as (
    sessionId: string,
    cwd: string,
  ) => unknown;
  const registerSession = (sessionId: string, cwd: string): void => {
    Reflect.apply(ensureSession, runtime, [sessionId, cwd]);
  };
  return { onState, registerSession, runtime, writeToTerminal };
};

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} => {
  let reject = (_error: unknown): void => undefined;
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const markerFromLaunchCommand = (command: string): string => {
  const marker = /\[Console\]::Write\('([^']+)'\)$/.exec(command)?.[1];
  if (!marker) {
    throw new Error('Launch command did not contain its exit marker.');
  }
  return marker;
};

describe('Codex runtime protocol adapters', () => {
  it('exposes only display-safe ChatGPT account fields', () => {
    expect(
      parseCodexAccountRead({
        account: {
          accessToken: 'must-not-escape',
          email: 'member@example.com',
          planType: 'plus',
          type: 'chatgpt',
        },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({
      account: {
        email: 'member@example.com',
        planType: 'plus',
        type: 'chatgpt',
      },
      requiresOpenaiAuth: true,
    });
  });

  it('handles a signed-out account and normalizes unknown account types', () => {
    expect(parseCodexAccountRead({ account: null, requiresOpenaiAuth: true })).toEqual({
      requiresOpenaiAuth: true,
    });
    expect(
      parseCodexAccountRead({
        account: { type: 'future-login-provider' },
        requiresOpenaiAuth: false,
      }).account?.type,
    ).toBe('other');
  });

  it('clamps usage percentages while preserving official window metadata', () => {
    expect(
      parseCodexRateLimits({
        rateLimits: {
          primary: { resetsAt: 2_000, usedPercent: 130, windowDurationMins: 300 },
          secondary: { usedPercent: -8 },
        },
      }),
    ).toEqual({
      primary: { resetsAt: 2_000, usedPercent: 100, windowDurationMins: 300 },
      secondary: { resetsAt: undefined, usedPercent: 0, windowDurationMins: undefined },
    });
  });

  it('exposes official ChatGPT quota windows with their real durations', () => {
    expect(
      codexResourceUsage(
        { email: 'member@example.com', planType: 'plus', type: 'chatgpt' },
        {
          primary: { usedPercent: 26, windowDurationMins: 300 },
          secondary: { usedPercent: 8, windowDurationMins: 10_080 },
        },
      ),
    ).toMatchObject({
      availability: 'available',
      capabilities: { windows: true },
      windows: [
        { label: '5 小时', usedPercent: 26 },
        { label: '7 天', usedPercent: 8 },
      ],
    });
  });

  it('advances the snapshot revision for external installation and warning changes', async () => {
    const { runtime } = createRuntime(false);
    const internals = runtime as unknown as {
      appServer: { request: (method: string) => Promise<unknown> };
      diagnoseInstallation: () => Promise<CodexProjectState['installation']>;
    };
    let installation: CodexProjectState['installation'] = {
      installed: false,
      message: '尚未安装 Codex CLI。',
      updateAvailable: false,
    };
    let accountReadFails = false;
    vi.spyOn(internals, 'diagnoseInstallation').mockImplementation(async () => installation);
    vi.spyOn(internals.appServer, 'request').mockImplementation(async (method) => {
      if (method === 'account/read' && accountReadFails) {
        throw new Error('synthetic account read failure');
      }
      return { account: null, requiresOpenaiAuth: true };
    });

    try {
      const missing = await runtime.getState('session-a', 'D:\\ProjectA');
      installation = {
        executable: 'C:\\OpenAI\\codex.exe',
        installed: true,
        message: 'Codex CLI 已就绪。',
        updateAvailable: false,
        version: '1.0.0',
      };
      accountReadFails = true;
      const warning = await runtime.getState('session-a', 'D:\\ProjectA');
      expect(warning.installation.installed).toBe(true);
      expect(warning.warning).toContain('synthetic account read failure');
      expect(warning.revision).toBeGreaterThan(missing.revision);

      accountReadFails = false;
      const recovered = await runtime.getState('session-a', 'D:\\ProjectA');
      expect(recovered.warning).toBeUndefined();
      expect(recovered.revision).toBeGreaterThan(warning.revision);
    } finally {
      runtime.dispose();
    }
  });

  it('discards an account snapshot that finishes after logout advances the revision', async () => {
    const { onState, runtime } = createRuntime(false);
    const staleRateLimits = deferred<unknown>();
    const internals = runtime as unknown as {
      appServer: { request: (method: string) => Promise<unknown> };
      diagnoseInstallation: (force?: boolean) => Promise<CodexProjectState['installation']>;
    };
    vi.spyOn(internals, 'diagnoseInstallation').mockResolvedValue({
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    });
    let loggedOut = false;
    let rateLimitReads = 0;
    vi.spyOn(internals.appServer, 'request').mockImplementation(async (method) => {
      if (method === 'account/read') {
        return loggedOut
          ? { account: null, requiresOpenaiAuth: true }
          : {
              account: {
                email: 'old@example.com',
                planType: 'plus',
                type: 'chatgpt',
              },
              requiresOpenaiAuth: true,
            };
      }
      if (method === 'account/rateLimits/read') {
        rateLimitReads += 1;
        if (rateLimitReads === 1) {
          return staleRateLimits.promise;
        }
        return { rateLimits: { primary: { usedPercent: 25 } } };
      }
      if (method === 'account/logout') {
        loggedOut = true;
      }
      return {};
    });

    try {
      const delayedState = runtime.getState('session-a', 'D:\\ProjectA');
      await vi.waitFor(() => {
        expect(rateLimitReads).toBe(1);
      });

      const logoutState = await runtime.logout('session-a', 'D:\\ProjectA');
      expect(logoutState.account).toBeUndefined();
      expect(logoutState.rateLimits).toBeUndefined();
      const logoutRevision = logoutState.revision;

      staleRateLimits.resolve({ rateLimits: { primary: { usedPercent: 99 } } });
      const settledState = await delayedState;
      expect(settledState.account).toBeUndefined();
      expect(settledState.rateLimits).toBeUndefined();
      expect(settledState.revision).toBeGreaterThanOrEqual(logoutRevision);
      expect(
        onState.mock.calls
          .map(([state]) => state)
          .filter((state) => state.revision >= logoutRevision)
          .every((state) => !state.account && !state.rateLimits),
      ).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it('discards a signed-out snapshot that finishes after an account update', async () => {
    const { onState, runtime } = createRuntime(false);
    const staleAccount = deferred<unknown>();
    const internals = runtime as unknown as {
      appServer: { request: (method: string) => Promise<unknown> };
      diagnoseInstallation: (force?: boolean) => Promise<CodexProjectState['installation']>;
      handleNotification: (notification: { method: string }) => void;
    };
    vi.spyOn(internals, 'diagnoseInstallation').mockResolvedValue({
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    });
    let accountReads = 0;
    let loggedIn = false;
    vi.spyOn(internals.appServer, 'request').mockImplementation(async (method) => {
      if (method === 'account/read') {
        accountReads += 1;
        if (accountReads === 1) {
          return staleAccount.promise;
        }
        return loggedIn
          ? {
              account: {
                email: 'current@example.com',
                planType: 'plus',
                type: 'chatgpt',
              },
              requiresOpenaiAuth: true,
            }
          : { account: null, requiresOpenaiAuth: true };
      }
      if (method === 'account/rateLimits/read') {
        return { rateLimits: { primary: { usedPercent: 10 } } };
      }
      return {};
    });

    try {
      const delayedState = runtime.getState('session-a', 'D:\\ProjectA');
      await vi.waitFor(() => {
        expect(accountReads).toBe(1);
      });

      loggedIn = true;
      internals.handleNotification({ method: 'account/updated' });
      await vi.waitFor(() => {
        expect(onState.mock.calls.at(-1)?.[0].account?.email).toBe('current@example.com');
      });
      const accountRevision = onState.mock.calls.at(-1)![0].revision;

      staleAccount.resolve({ account: null, requiresOpenaiAuth: true });
      const settledState = await delayedState;
      expect(settledState.account?.email).toBe('current@example.com');
      expect(settledState.rateLimits?.primary?.usedPercent).toBe(10);
      expect(settledState.revision).toBeGreaterThanOrEqual(accountRevision);
    } finally {
      runtime.dispose();
    }
  });

  it('fans application-global login transitions out to every registered project', async () => {
    const { onState, registerSession, runtime } = createRuntime();
    const internals = runtime as unknown as {
      appServer: { request: (method: string) => Promise<unknown> };
      diagnoseInstallation: (force?: boolean) => Promise<CodexProjectState['installation']>;
    };
    vi.spyOn(internals, 'diagnoseInstallation').mockResolvedValue({
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    });
    vi.spyOn(internals.appServer, 'request').mockImplementation(async (method) =>
      method === 'account/login/start'
        ? {
            loginId: 'login-1',
            userCode: 'ABCD-EFGH',
            verificationUrl: 'https://auth.openai.com/device',
          }
        : {},
    );
    registerSession('session-a', 'D:\\ProjectA');
    registerSession('session-b', 'D:\\ProjectB');
    const latestState = (sessionId: string): CodexProjectState | undefined =>
      [...onState.mock.calls]
        .reverse()
        .map(([state]) => state)
        .find((state) => state.sessionId === sessionId);

    try {
      await runtime.startLogin('session-a', 'D:\\ProjectA', 'device-code');
      expect(latestState('session-b')?.login).toMatchObject({
        method: 'device-code',
        phase: 'waiting',
        userCode: 'ABCD-EFGH',
      });

      onState.mockClear();
      await runtime.cancelLogin('session-a', 'D:\\ProjectA');
      expect(latestState('session-a')?.login).toEqual({ phase: 'idle' });
      expect(latestState('session-b')?.login).toEqual({ phase: 'idle' });

      onState.mockClear();
      await runtime.logout('session-a', 'D:\\ProjectA');
      expect(latestState('session-a')?.login).toEqual({ phase: 'idle' });
      expect(latestState('session-b')?.login).toEqual({ phase: 'idle' });
    } finally {
      runtime.dispose();
    }
  });

  it('queues matching global no-operation login snapshots before login start settles', async () => {
    const { onState, registerSession, runtime } = createRuntime();
    const internals = runtime as unknown as {
      appServer: { request: (method: string) => Promise<unknown> };
      diagnoseInstallation: (force?: boolean) => Promise<CodexProjectState['installation']>;
    };
    vi.spyOn(internals, 'diagnoseInstallation').mockResolvedValue({
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    });
    vi.spyOn(internals.appServer, 'request').mockResolvedValue({
      authUrl: 'https://auth.openai.com/authorize',
      loginId: 'login-1',
    });
    registerSession('session-a', 'D:\\ProjectA');
    registerSession('session-b', 'D:\\ProjectB');
    const events: string[] = [];
    onState.mockImplementation((state) => {
      events.push(`${state.sessionId}:${state.activeOperation?.kind ?? 'none'}`);
    });

    try {
      const pending = runtime.startLogin('session-a', 'D:\\ProjectA', 'browser').then((result) => {
        events.push('settled');
        return result;
      });
      const prepared = await pending;
      const states = onState.mock.calls.map(([state]) => state);
      const starting = states.filter((state) => state.activeOperation?.kind === 'login-browser');
      const waiting = states.filter(
        (state) => state.login.phase === 'waiting' && !state.activeOperation,
      );

      expect(starting.map((state) => state.sessionId).sort()).toEqual(['session-a', 'session-b']);
      expect(waiting.map((state) => state.sessionId).sort()).toEqual(['session-a', 'session-b']);
      expect(new Set(starting.map((state) => state.revision)).size).toBe(1);
      expect(new Set(waiting.map((state) => state.revision)).size).toBe(1);
      expect(waiting[0]!.revision).toBeGreaterThan(starting[0]!.revision);
      expect(prepared.state.revision).toBe(waiting[0]!.revision);
      expect(
        Math.max(...waiting.map((state) => events.indexOf(`${state.sessionId}:none`))),
      ).toBeLessThan(events.indexOf('settled'));
    } finally {
      runtime.dispose();
    }
  });

  it('supersedes a pending login start before it can restore waiting state', async () => {
    const { onState, registerSession, runtime } = createRuntime();
    const loginStart = deferred<unknown>();
    const internals = runtime as unknown as {
      appServer: { request: (method: string, params?: unknown) => Promise<unknown> };
      diagnoseInstallation: (force?: boolean) => Promise<CodexProjectState['installation']>;
    };
    vi.spyOn(internals, 'diagnoseInstallation').mockResolvedValue({
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    });
    const request = vi.spyOn(internals.appServer, 'request').mockImplementation(async (method) => {
      if (method === 'account/login/start') return loginStart.promise;
      return {};
    });
    registerSession('session-a', 'D:\\ProjectA');

    try {
      const start = runtime.startLogin('session-a', 'D:\\ProjectA', 'browser');
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith('account/login/start', expect.any(Object));
      });
      await runtime.cancelLogin('session-a', 'D:\\ProjectA');
      const callsAfterCancellation = onState.mock.calls.length;
      loginStart.resolve({
        authUrl: 'https://auth.openai.com/authorize',
        loginId: 'cancelled-login',
      });

      await expect(start).rejects.toThrow('已经被取消或取代');
      const latest = onState.mock.calls.at(-1)?.[0];
      expect(latest?.login).toEqual({ phase: 'idle' });
      expect(
        onState.mock.calls
          .slice(callsAfterCancellation)
          .some(([state]) => state.login.phase === 'waiting'),
      ).toBe(false);
      expect(Reflect.get(runtime, 'activeLoginAttempt')).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it('rejects a duplicate installation without clearing the owning progress', async () => {
    const { runtime } = createRuntime();
    const installation = deferred<void>();
    const installer = Reflect.get(runtime, 'installer') as { installLatest: () => Promise<void> };
    vi.spyOn(installer, 'installLatest').mockImplementation(() => installation.promise);

    try {
      const first = runtime.installOrUpdate('session-a', 'D:\\ProjectA', 'install');
      await vi.waitFor(() => {
        expect(Reflect.get(runtime, 'installProgress')).toContain('准备下载');
      });
      await expect(runtime.installOrUpdate('session-b', 'D:\\ProjectB', 'update')).rejects.toThrow(
        '仍在进行',
      );
      expect(Reflect.get(runtime, 'installProgress')).toContain('准备下载');

      installation.resolve();
      await first;
      expect(Reflect.get(runtime, 'installProgress')).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it('does not strand a Codex owner when every state notification fails', async () => {
    const { onState, registerSession, runtime } = createRuntime();
    const installer = Reflect.get(runtime, 'installer') as { installLatest: () => Promise<void> };
    vi.spyOn(installer, 'installLatest').mockResolvedValue();
    onState.mockImplementation(() => {
      throw new Error('synthetic state listener failure');
    });
    registerSession('session-a', 'D:\\ProjectA');

    try {
      const state = await runtime.installOrUpdate('session-a', 'D:\\ProjectA', 'install');
      expect(state.activeOperation).toBeUndefined();
      expect(Reflect.get(runtime, 'activeInstallAttempt')).toBeUndefined();
      expect(Reflect.get(runtime, 'installProgress')).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it.each(['install', 'update'] satisfies CodexInstallOperation[])(
    'publishes and clears the exact %s operation for every registered project',
    async (operation) => {
      const { onState, registerSession, runtime } = createRuntime();
      const installation = deferred<void>();
      const installer = Reflect.get(runtime, 'installer') as { installLatest: () => Promise<void> };
      vi.spyOn(installer, 'installLatest').mockImplementation(() => installation.promise);
      registerSession('session-a', 'D:\\ProjectA');
      registerSession('session-b', 'D:\\ProjectB');
      const latestState = (sessionId: string): CodexProjectState | undefined =>
        [...onState.mock.calls]
          .reverse()
          .map(([state]) => state)
          .find((state) => state.sessionId === sessionId);

      try {
        const pending = runtime.installOrUpdate('session-a', 'D:\\ProjectA', operation);
        await vi.waitFor(() => {
          expect(latestState('session-a')?.activeOperation).toMatchObject({ kind: operation });
          expect(latestState('session-b')?.activeOperation).toMatchObject({ kind: operation });
        });
        const pendingRevision = latestState('session-a')!.revision;
        const attempt = latestState('session-a')!.activeOperation!.attempt;
        expect(latestState('session-b')?.activeOperation?.attempt).toBe(attempt);

        installation.resolve();
        await pending;
        expect(latestState('session-a')?.activeOperation).toBeUndefined();
        expect(latestState('session-b')?.activeOperation).toBeUndefined();
        expect(latestState('session-a')!.revision).toBeGreaterThan(pendingRevision);
        expect(latestState('session-b')!.revision).toBeGreaterThan(pendingRevision);
      } finally {
        runtime.dispose();
      }
    },
  );

  it.each([
    ['browser', 'login-browser'],
    ['device-code', 'login-device'],
  ] satisfies ReadonlyArray<readonly [CodexLoginMethod, string]>)(
    'publishes %s login startup before installation diagnosis completes',
    async (method, kind) => {
      const { onState, registerSession, runtime } = createRuntime();
      const diagnosis = deferred<CodexProjectState['installation']>();
      const internals = runtime as unknown as {
        appServer: { request: (method: string) => Promise<unknown> };
        diagnoseInstallation: (force?: boolean) => Promise<CodexProjectState['installation']>;
      };
      vi.spyOn(internals, 'diagnoseInstallation').mockImplementation(() => diagnosis.promise);
      vi.spyOn(internals.appServer, 'request').mockResolvedValue(
        method === 'browser'
          ? {
              authUrl: 'https://auth.openai.com/authorize',
              loginId: 'login-browser',
            }
          : {
              loginId: 'login-device',
              userCode: 'ABCD-EFGH',
              verificationUrl: 'https://auth.openai.com/device',
            },
      );
      registerSession('session-a', 'D:\\ProjectA');
      registerSession('session-b', 'D:\\ProjectB');
      const latestState = (sessionId: string): CodexProjectState | undefined =>
        [...onState.mock.calls]
          .reverse()
          .map(([state]) => state)
          .find((state) => state.sessionId === sessionId);

      try {
        const pending = runtime.startLogin('session-a', 'D:\\ProjectA', method);
        await vi.waitFor(() => {
          expect(latestState('session-a')?.activeOperation).toMatchObject({ kind });
          expect(latestState('session-b')?.activeOperation).toMatchObject({ kind });
        });
        const pendingRevision = latestState('session-a')!.revision;

        diagnosis.resolve({
          executable: 'C:\\OpenAI\\codex.exe',
          installed: true,
          message: 'Codex CLI 已就绪。',
          updateAvailable: false,
        });
        await pending;
        expect(latestState('session-a')?.activeOperation).toBeUndefined();
        expect(latestState('session-a')?.login.phase).toBe('waiting');
        expect(latestState('session-a')!.revision).toBeGreaterThan(pendingRevision);
      } finally {
        runtime.dispose();
      }
    },
  );

  it.each([
    ['cancel-login', 'account/login/cancel'],
    ['logout', 'account/logout'],
  ] as const)(
    'publishes and clears the exact %s account operation with a newer revision',
    async (operation, requestMethod) => {
      const { onState, registerSession, runtime } = createRuntime();
      const request = deferred<unknown>();
      const internals = runtime as unknown as {
        appServer: { request: (method: string) => Promise<unknown> };
      };
      vi.spyOn(internals.appServer, 'request').mockImplementation(async (method) => {
        if (method === requestMethod) return request.promise;
        return {};
      });
      if (operation === 'cancel-login') {
        Reflect.set(runtime, 'login', {
          loginId: 'login-1',
          method: 'browser',
          phase: 'waiting',
        });
        Reflect.set(runtime, 'activeLoginAttempt', { attempt: 99, method: 'browser' });
      }
      registerSession('session-a', 'D:\\ProjectA');
      registerSession('session-b', 'D:\\ProjectB');
      const latestState = (sessionId: string): CodexProjectState | undefined =>
        [...onState.mock.calls]
          .reverse()
          .map(([state]) => state)
          .find((state) => state.sessionId === sessionId);

      try {
        const pending =
          operation === 'cancel-login'
            ? runtime.cancelLogin('session-a', 'D:\\ProjectA')
            : runtime.logout('session-a', 'D:\\ProjectA');
        await vi.waitFor(() => {
          expect(latestState('session-a')?.activeOperation).toMatchObject({ kind: operation });
          expect(latestState('session-b')?.activeOperation).toMatchObject({ kind: operation });
        });
        const pendingRevision = latestState('session-a')!.revision;

        request.resolve({});
        await pending;
        expect(latestState('session-a')?.activeOperation).toBeUndefined();
        expect(latestState('session-b')?.activeOperation).toBeUndefined();
        expect(latestState('session-a')!.revision).toBeGreaterThan(pendingRevision);
        expect(latestState('session-b')!.revision).toBeGreaterThan(pendingRevision);
      } finally {
        runtime.dispose();
      }
    },
  );

  it('ignores a delayed completion notification from a superseded login attempt', async () => {
    const { runtime } = createRuntime();
    const internals = runtime as unknown as {
      appServer: { request: (method: string) => Promise<unknown> };
      diagnoseInstallation: (force?: boolean) => Promise<CodexProjectState['installation']>;
      handleNotification: (notification: {
        method: string;
        params?: Record<string, unknown>;
      }) => void;
    };
    vi.spyOn(internals, 'diagnoseInstallation').mockResolvedValue({
      executable: 'C:\\OpenAI\\codex.exe',
      installed: true,
      message: 'Codex CLI 已就绪。',
      updateAvailable: false,
    });
    let starts = 0;
    vi.spyOn(internals.appServer, 'request').mockImplementation(async (method) => {
      if (method !== 'account/login/start') return {};
      starts += 1;
      return {
        loginId: `login-${starts}`,
        userCode: `CODE-${starts}`,
        verificationUrl: 'https://auth.openai.com/device',
      };
    });

    try {
      await runtime.startLogin('session-a', 'D:\\ProjectA', 'device-code');
      await runtime.cancelLogin('session-a', 'D:\\ProjectA');
      await runtime.startLogin('session-b', 'D:\\ProjectB', 'device-code');
      const before = Reflect.get(runtime, 'stateRevision') as number;

      internals.handleNotification({
        method: 'account/login/completed',
        params: { loginId: 'login-1', success: true },
      });
      expect(Reflect.get(runtime, 'login')).toMatchObject({
        loginId: 'login-2',
        phase: 'waiting',
      });
      expect(Reflect.get(runtime, 'stateRevision')).toBe(before);

      internals.handleNotification({
        method: 'account/login/completed',
        params: { loginId: 'login-2', success: true },
      });
      expect(Reflect.get(runtime, 'login')).toEqual({ phase: 'idle' });
      expect(Reflect.get(runtime, 'stateRevision')).toBeGreaterThan(before);
    } finally {
      runtime.dispose();
    }
  });

  it.each([
    ['new', false, false],
    ['continue', true, true],
    ['resume', true, false],
  ] as const)(
    'builds the %s TUI launch with explicit project safety flags',
    (mode, resume, last) => {
      const command = buildCodexLaunchCommand(
        "C:\\OpenAI's Tools\\codex.exe",
        "D:\\Work\\Owner's Project",
        mode,
        '\u001b]9;marker\u0007',
      );

      expect(command).toContain("& 'C:\\OpenAI''s Tools\\codex.exe'");
      expect(command).toContain("'--cd' 'D:\\Work\\Owner''s Project'");
      expect(command).toContain("'--sandbox' 'workspace-write'");
      expect(command).toContain("'--ask-for-approval' 'on-request'");
      expect(command).toContain("'--no-alt-screen'");
      expect(command.includes("'resume'")).toBe(resume);
      expect(command.includes("'--last'")).toBe(last);
      expect(command).toContain("[Console]::Write('\u001b]9;marker\u0007')");
    },
  );
});

describe('Codex runtime PTY ownership', () => {
  it('routes writes only through the exact bound PTY generation', async () => {
    const { runtime, writeToTerminal } = createRuntime();
    try {
      expect(() => runtime.bindPty('session-a', 7)).toThrow(
        'Codex 启动状态已失效，无法绑定新的终端。',
      );

      await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      runtime.bindPty('session-a', 7);

      expect(() => runtime.bindPty('session-a', 8)).toThrow(
        'Codex 已绑定到其他终端，这次启动结果已失效。',
      );
      expect(runtime.isBoundToPty('session-a', 7)).toBe(true);
      expect(runtime.writeTerminal('session-a', 7, 'start\r')).toBe(true);
      expect(writeToTerminal).toHaveBeenCalledWith('session-a', 7, 'start\r');

      expect(runtime.writeTerminal('session-a', 6, 'stale\r')).toBe(false);
      expect(writeToTerminal).toHaveBeenCalledTimes(1);
    } finally {
      runtime.dispose();
    }
  });

  it('clears stale launch ownership and ignores output or cleanup from the old PTY', async () => {
    const { runtime, writeToTerminal } = createRuntime();
    try {
      const first = await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      const firstMarker = markerFromLaunchCommand(first.command);
      expect(first.predecessorPtyGeneration).toBeUndefined();
      runtime.bindPty('session-a', 1);

      const second = await runtime.prepareLaunch('session-a', 'D:\\Project', 'continue');
      const secondMarker = markerFromLaunchCommand(second.command);
      expect(second.predecessorPtyGeneration).toBe(1);
      expect(runtime.isBoundToPty('session-a', 1)).toBe(false);
      runtime.bindPty('session-a', 2);

      expect(runtime.setInactive('session-a', 1)).toBe(false);
      expect(runtime.isActive('session-a')).toBe(true);
      expect(runtime.consumeTerminalOutput('session-a', 1, `old${firstMarker}`)).toBe(
        `old${firstMarker}`,
      );
      expect(runtime.isActive('session-a')).toBe(true);
      expect(runtime.writeTerminal('session-a', 1, 'late\r')).toBe(false);
      expect(writeToTerminal).not.toHaveBeenCalled();

      expect(runtime.consumeTerminalOutput('session-a', 2, `before${secondMarker}after`)).toBe(
        'beforeafter',
      );
      expect(runtime.isActive('session-a')).toBe(false);
      expect(runtime.isBoundToPty('session-a', 2)).toBe(false);
    } finally {
      runtime.dispose();
    }
  });

  it('separates prepared cleanup from exact-generation deactivation', async () => {
    const { runtime } = createRuntime();
    try {
      await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      expect(Reflect.apply(runtime.setInactive, runtime, ['session-a'])).toBe(false);
      expect(runtime.isActive('session-a')).toBe(true);
      expect(runtime.cleanupPreparedLaunch('session-a')).toBe(true);
      expect(runtime.isActive('session-a')).toBe(false);

      await runtime.prepareLaunch('session-a', 'D:\\Project', 'new');
      runtime.bindPty('session-a', 5);
      expect(Reflect.apply(runtime.setInactive, runtime, ['session-a'])).toBe(false);
      expect(runtime.cleanupPreparedLaunch('session-a')).toBe(false);
      expect(runtime.setInactive('session-a', 4)).toBe(false);
      expect(runtime.isBoundToPty('session-a', 5)).toBe(true);
      expect(runtime.setInactive('session-a', 5)).toBe(true);
      expect(runtime.isActive('session-a')).toBe(false);
      expect(runtime.isBoundToPty('session-a', 5)).toBe(false);
      expect(runtime.setInactive('session-a', 5)).toBe(false);
    } finally {
      runtime.dispose();
    }
  });
});
