import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeProfile } from '../src/main/runtime-profile';

describe('runtime profile', () => {
  it('preserves all production capabilities and paths by default', () => {
    const profile = resolveRuntimeProfile({
      argv: ['electron', '.'],
      defaultHome: 'C:\\Users\\Example',
      defaultUserData: 'C:\\Users\\Example\\AppData\\ClaudeDock',
      env: {},
    });

    expect(profile).toMatchObject({
      adapterMode: 'production',
      effects: {
        allowApplicationUpdates: true,
        allowExternalRoutingWrites: true,
        allowPluginMutations: true,
        allowRealRuntimes: true,
        restoreWorkspace: true,
        singleInstanceLock: true,
        tray: true,
      },
      id: 'production',
    });
    expect(profile.paths.projects).toBe(path.join(profile.paths.home, '.claude', 'projects'));
  });

  it('fails closed when isolated userData was not supplied', () => {
    expect(() =>
      resolveRuntimeProfile({
        argv: ['electron', '.', '--claudedock-runtime-profile=isolated'],
        defaultHome: 'C:\\Users\\Real',
        defaultUserData: 'C:\\Users\\Real\\AppData\\ClaudeDock',
        env: {},
      }),
    ).toThrow(/userData/);
  });

  it('isolates every path and disables production side effects', () => {
    const root = path.resolve('D:\\Temp\\claudedock-visual-fixture');
    const profile = resolveRuntimeProfile({
      argv: [
        'electron',
        '.',
        '--claudedock-runtime-profile=isolated',
        `--claudedock-user-data=${root}`,
      ],
      defaultHome: 'C:\\Users\\Real',
      defaultUserData: 'C:\\Users\\Real\\AppData\\ClaudeDock',
      env: {},
    });

    expect(profile.id).toBe('isolated');
    expect(profile.adapterMode).toBe('fake');
    expect(profile.paths).toEqual({
      home: path.join(root, 'home'),
      projects: path.join(root, 'projects'),
      sessionData: path.join(root, 'chromium-session'),
      userData: root,
    });
    expect(Object.values(profile.effects).every((enabled) => enabled === false)).toBe(true);
  });

  it('requires both an explicit opt-in and a production adapter for isolated real CLI smoke', () => {
    const base = {
      argv: ['electron', '.', '--claudedock-runtime-profile=isolated'],
      defaultHome: 'C:\\Users\\Real',
      defaultUserData: 'C:\\Users\\Real\\AppData\\ClaudeDock',
    } as const;
    const env = {
      CLAUDEDOCK_CONVERSATION_ADAPTER: 'production',
      CLAUDEDOCK_ISOLATED_ALLOW_REAL_RUNTIME: '1',
      CLAUDEDOCK_ISOLATED_USER_DATA: 'D:\\Temp\\claudedock-real-cli-smoke',
    };

    expect(resolveRuntimeProfile({ ...base, env }).effects.allowRealRuntimes).toBe(true);
    expect(
      resolveRuntimeProfile({
        ...base,
        env: { ...env, CLAUDEDOCK_ISOLATED_ALLOW_REAL_RUNTIME: undefined },
      }).adapterMode,
    ).toBe('fake');
  });

  it('rejects unsupported profiles and relative isolated paths', () => {
    expect(() =>
      resolveRuntimeProfile({
        argv: ['electron', '.', '--claudedock-runtime-profile=preview'],
        defaultHome: 'C:\\Users\\Real',
        defaultUserData: 'C:\\Users\\Real\\AppData\\ClaudeDock',
        env: {},
      }),
    ).toThrow(/不支持/);
    expect(() =>
      resolveRuntimeProfile({
        argv: [
          'electron',
          '.',
          '--claudedock-runtime-profile=isolated',
          '--claudedock-user-data=.\\fixture',
        ],
        defaultHome: 'C:\\Users\\Real',
        defaultUserData: 'C:\\Users\\Real\\AppData\\ClaudeDock',
        env: {},
      }),
    ).toThrow(/绝对路径/);
  });
});
