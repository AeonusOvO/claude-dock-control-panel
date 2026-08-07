import path from 'node:path';

export type RuntimeProfileId = 'production' | 'isolated';
export type ConversationAdapterMode = 'production' | 'fake';

export interface AppPaths {
  readonly home: string;
  readonly projects: string;
  readonly sessionData: string;
  readonly userData: string;
}

export interface RuntimeEffects {
  readonly allowApplicationUpdates: boolean;
  readonly allowExternalRoutingWrites: boolean;
  readonly allowPluginMutations: boolean;
  readonly allowRealRuntimes: boolean;
  readonly restoreWorkspace: boolean;
  readonly singleInstanceLock: boolean;
  readonly tray: boolean;
}

export interface RuntimeProfile {
  readonly adapterMode: ConversationAdapterMode;
  readonly effects: RuntimeEffects;
  readonly id: RuntimeProfileId;
  readonly paths: AppPaths;
}

export interface RuntimeProfileInput {
  readonly argv?: readonly string[];
  readonly defaultHome: string;
  readonly defaultUserData: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const PROFILE_ARGUMENT = '--claudedock-runtime-profile=';
const USER_DATA_ARGUMENT = '--claudedock-user-data=';
const HOME_ARGUMENT = '--claudedock-home=';
const PROJECTS_ARGUMENT = '--claudedock-projects=';
const ADAPTER_ARGUMENT = '--claudedock-conversation-adapter=';

const argumentValue = (argv: readonly string[], prefix: string): string | undefined => {
  const match = argv.find((argument) => argument.startsWith(prefix));
  return match?.slice(prefix.length).trim() || undefined;
};

const explicitAbsolutePath = (value: string | undefined, label: string): string => {
  if (!value) {
    throw new Error(`隔离运行配置缺少 ${label}。`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`隔离运行配置的 ${label} 必须是绝对路径。`);
  }
  return path.resolve(value);
};

const childPath = (root: string, ...children: string[]): string => path.join(root, ...children);

/**
 * Resolves every application-owned path before Electron stores or locks are created. Isolated mode
 * is deliberately fail-closed: it requires an explicit userData root and never falls back to the
 * production home. This keeps visual fixtures and integration tests away from real conversations,
 * credentials, plugins and updater state.
 */
export const resolveRuntimeProfile = ({
  argv = process.argv,
  defaultHome,
  defaultUserData,
  env = process.env,
}: RuntimeProfileInput): RuntimeProfile => {
  const requestedProfile =
    argumentValue(argv, PROFILE_ARGUMENT) ?? env.CLAUDEDOCK_RUNTIME_PROFILE ?? 'production';
  if (requestedProfile !== 'production' && requestedProfile !== 'isolated') {
    throw new Error(`不支持的 ClaudeDock 运行配置：${requestedProfile}`);
  }

  if (requestedProfile === 'production') {
    const home = path.resolve(defaultHome);
    const userData = path.resolve(defaultUserData);
    return {
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
      paths: {
        home,
        projects: childPath(home, '.claude', 'projects'),
        sessionData: childPath(userData, 'chromium-session'),
        userData,
      },
    };
  }

  const userData = explicitAbsolutePath(
    argumentValue(argv, USER_DATA_ARGUMENT) ?? env.CLAUDEDOCK_ISOLATED_USER_DATA,
    'userData',
  );
  const home = explicitAbsolutePath(
    argumentValue(argv, HOME_ARGUMENT) ??
      env.CLAUDEDOCK_ISOLATED_HOME ??
      childPath(userData, 'home'),
    'home',
  );
  const projects = explicitAbsolutePath(
    argumentValue(argv, PROJECTS_ARGUMENT) ??
      env.CLAUDEDOCK_ISOLATED_PROJECTS ??
      childPath(userData, 'projects'),
    'projects',
  );
  const requestedAdapter =
    argumentValue(argv, ADAPTER_ARGUMENT) ?? env.CLAUDEDOCK_CONVERSATION_ADAPTER ?? 'fake';
  if (requestedAdapter !== 'fake' && requestedAdapter !== 'production') {
    throw new Error(`不支持的对话适配器：${requestedAdapter}`);
  }
  const allowRealRuntimes =
    requestedAdapter === 'production' && env.CLAUDEDOCK_ISOLATED_ALLOW_REAL_RUNTIME === '1';

  return {
    adapterMode: allowRealRuntimes ? 'production' : 'fake',
    effects: {
      allowApplicationUpdates: false,
      allowExternalRoutingWrites: false,
      allowPluginMutations: false,
      allowRealRuntimes,
      restoreWorkspace: false,
      singleInstanceLock: false,
      tray: false,
    },
    id: 'isolated',
    paths: {
      home,
      projects,
      sessionData: childPath(userData, 'chromium-session'),
      userData,
    },
  };
};
