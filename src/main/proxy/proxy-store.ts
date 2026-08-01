import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ProxyCredentialInput,
  ProxyProfileInput,
  ProxyProfileView,
  ProxyProtocol,
  ProxyRuntimeStatus,
  ProxyScopeSettings,
  ProxyStoreView,
  ProxyStoredState,
  ProxyTransport,
} from '../../shared/contracts';

export interface ProxySecretStorage {
  decryptString(value: Buffer): string;
  encryptString(value: string): Buffer;
  isEncryptionAvailable(): boolean;
}

interface StoredProfile extends Omit<ProxyProfileView, 'hasCredentials'> {
  credentialRef?: string;
}

interface StoredProfiles {
  profiles: StoredProfile[];
  scope: ProxyScopeSettings;
  state: ProxyStoredState;
  version: 1;
}

interface StoredCredentials {
  entries: Record<string, string>;
  version: 1;
}

const PROTOCOLS = new Set<ProxyProtocol>([
  'http',
  'shadowsocks',
  'socks',
  'trojan',
  'vless',
  'vmess',
]);
const TRANSPORTS = new Set<ProxyTransport>(['grpc', 'http', 'tcp', 'ws']);
const RUNTIME_STATUSES = new Set<ProxyRuntimeStatus>([
  'error',
  'ready',
  'starting',
  'stopped',
  'stopping',
]);
const DEFAULT_SCOPE: ProxyScopeSettings = { application: false, cli: true };
const DEFAULT_STATE: ProxyStoredState = { runtimeStatus: 'stopped' };

const optionalText = (value: unknown, field: string, maximum = 256): string | undefined => {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} 格式无效。`);
  }
  return value.trim() || undefined;
};

const requiredText = (value: unknown, field: string, maximum = 256): string => {
  const normalized = optionalText(value, field, maximum);
  if (!normalized) {
    throw new Error(`${field} 不能为空。`);
  }
  return normalized;
};

const normalizeCredentials = (
  protocol: ProxyProtocol,
  input?: ProxyCredentialInput,
): ProxyCredentialInput | undefined => {
  const credentials: ProxyCredentialInput = {
    alterId:
      Number.isInteger(input?.alterId) && (input?.alterId ?? -1) >= 0 ? input?.alterId : undefined,
    method: optionalText(input?.method, '加密方式', 64),
    password: optionalText(input?.password, '密码', 4096),
    username: optionalText(input?.username, '用户名', 256),
    uuid: optionalText(input?.uuid, 'UUID', 128),
  };
  if ((protocol === 'vmess' || protocol === 'vless') && !credentials.uuid) {
    throw new Error(`${protocol} 节点缺少 UUID。`);
  }
  if ((protocol === 'trojan' || protocol === 'shadowsocks') && !credentials.password) {
    throw new Error(`${protocol} 节点缺少密码。`);
  }
  if (protocol === 'shadowsocks' && !credentials.method) {
    throw new Error('shadowsocks 节点缺少加密方式。');
  }
  return Object.values(credentials).some(Boolean) ? credentials : undefined;
};

export const normalizeProxyProfile = (
  input: ProxyProfileInput,
  now = Date.now(),
): { credentials?: ProxyCredentialInput; profile: StoredProfile } => {
  if (!PROTOCOLS.has(input.protocol)) {
    throw new Error('代理协议不受支持。');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error('代理端口必须是 1–65535 的整数。');
  }
  const address = requiredText(input.address, '服务器地址', 253);
  if (/\s/.test(address) || /^(?:0\.0\.0\.0|::)$/i.test(address)) {
    throw new Error('服务器地址格式无效。');
  }
  const transport = input.transport ?? 'tcp';
  if (!TRANSPORTS.has(transport)) {
    throw new Error('代理传输层不受支持。');
  }
  const id = input.id ? requiredText(input.id, '节点标识', 128) : randomUUID();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) {
    throw new Error('节点标识格式无效。');
  }
  const credentials = normalizeCredentials(input.protocol, input.credentials);
  const credentialRef = credentials ? `proxy:${id}` : undefined;
  return {
    credentials,
    profile: {
      address,
      credentialRef,
      id,
      port: input.port,
      protocol: input.protocol,
      remark: optionalText(input.remark, '备注', 256) ?? `${input.protocol} · ${address}`,
      serverName: optionalText(input.serverName, 'SNI', 253),
      subscriptionId: optionalText(input.subscriptionId, '订阅标识', 128),
      tls: input.tls === true,
      transport,
      transportPath: optionalText(input.transportPath, '传输路径', 1024),
      updatedAt: now,
    },
  };
};

export class ProxyStore {
  private readonly directory: string;
  private readonly credentialsPath: string;
  private readonly profilesPath: string;

  public constructor(
    userDataPath: string,
    private readonly secretStorage: ProxySecretStorage,
  ) {
    this.directory = path.join(userDataPath, 'proxy');
    this.profilesPath = path.join(this.directory, 'profiles.json');
    this.credentialsPath = path.join(this.directory, 'credentials.json');
  }

  public getView(): ProxyStoreView {
    const store = this.loadProfiles();
    return {
      profiles: store.profiles.map(({ credentialRef, ...profile }) => ({
        ...profile,
        hasCredentials: Boolean(credentialRef),
      })),
      scope: { ...store.scope },
      state: { ...store.state, runtimeStatus: 'stopped' },
    };
  }

  public getProfile(
    id: string,
  ): (ProxyProfileView & { credentials?: ProxyCredentialInput }) | undefined {
    const profile = this.loadProfiles().profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      return undefined;
    }
    const { credentialRef, ...view } = profile;
    return {
      ...view,
      credentials: credentialRef ? this.readCredential(credentialRef) : undefined,
      hasCredentials: Boolean(credentialRef),
    };
  }

  public saveProfile(input: ProxyProfileInput): ProxyStoreView {
    const normalized = normalizeProxyProfile(input);
    const store = this.loadProfiles();
    const existingIndex = store.profiles.findIndex(({ id }) => id === normalized.profile.id);
    if (existingIndex >= 0) {
      store.profiles[existingIndex] = normalized.profile;
    } else {
      store.profiles.push(normalized.profile);
    }
    if (normalized.profile.credentialRef && normalized.credentials) {
      this.writeCredential(normalized.profile.credentialRef, normalized.credentials);
    }
    store.state.selectedProfileId ??= normalized.profile.id;
    this.persistProfiles(store);
    return this.getView();
  }

  public removeProfile(id: string): ProxyStoreView {
    const store = this.loadProfiles();
    const profile = store.profiles.find((candidate) => candidate.id === id);
    store.profiles = store.profiles.filter((candidate) => candidate.id !== id);
    if (profile?.credentialRef) {
      const credentials = this.loadCredentials();
      delete credentials.entries[profile.credentialRef];
      this.persistCredentials(credentials);
    }
    if (store.state.selectedProfileId === id) {
      store.state.selectedProfileId = store.profiles[0]?.id;
    }
    this.persistProfiles(store);
    return this.getView();
  }

  public setScope(scope: ProxyScopeSettings): ProxyStoreView {
    if (typeof scope.cli !== 'boolean' || typeof scope.application !== 'boolean') {
      throw new Error('代理作用域设置无效。');
    }
    const store = this.loadProfiles();
    store.scope = { ...scope };
    this.persistProfiles(store);
    return this.getView();
  }

  public setState(state: Partial<ProxyStoredState>): ProxyStoreView {
    const store = this.loadProfiles();
    if (state.runtimeStatus !== undefined && !RUNTIME_STATUSES.has(state.runtimeStatus)) {
      throw new Error('代理运行状态无效。');
    }
    if (
      state.selectedProfileId !== undefined &&
      !store.profiles.some(({ id }) => id === state.selectedProfileId)
    ) {
      throw new Error('所选代理节点不存在。');
    }
    store.state = { ...store.state, ...state };
    this.persistProfiles(store);
    return this.getView();
  }

  private loadProfiles(): StoredProfiles {
    try {
      const parsed = JSON.parse(readFileSync(this.profilesPath, 'utf8')) as StoredProfiles;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.profiles) ||
        typeof parsed.scope?.cli !== 'boolean' ||
        typeof parsed.scope?.application !== 'boolean'
      ) {
        throw new Error('invalid');
      }
      return {
        profiles: parsed.profiles,
        scope: parsed.scope,
        state: { ...parsed.state, runtimeStatus: 'stopped' },
        version: 1,
      };
    } catch {
      return { profiles: [], scope: { ...DEFAULT_SCOPE }, state: { ...DEFAULT_STATE }, version: 1 };
    }
  }

  private loadCredentials(): StoredCredentials {
    try {
      const parsed = JSON.parse(readFileSync(this.credentialsPath, 'utf8')) as StoredCredentials;
      return parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object'
        ? parsed
        : { entries: {}, version: 1 };
    } catch {
      return { entries: {}, version: 1 };
    }
  }

  private readCredential(reference: string): ProxyCredentialInput | undefined {
    const encrypted = this.loadCredentials().entries[reference];
    if (!encrypted || !this.secretStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      return JSON.parse(
        this.secretStorage.decryptString(Buffer.from(encrypted, 'base64')),
      ) as ProxyCredentialInput;
    } catch {
      return undefined;
    }
  }

  private writeCredential(reference: string, credential: ProxyCredentialInput): void {
    if (!this.secretStorage.isEncryptionAvailable()) {
      throw new Error('Windows 凭据加密当前不可用，未保存代理节点。');
    }
    const store = this.loadCredentials();
    store.entries[reference] = this.secretStorage
      .encryptString(JSON.stringify(credential))
      .toString('base64');
    this.persistCredentials(store);
  }

  private persistProfiles(store: StoredProfiles): void {
    this.atomicWrite(this.profilesPath, store);
  }

  private persistCredentials(store: StoredCredentials): void {
    this.atomicWrite(this.credentialsPath, store);
  }

  private atomicWrite(targetPath: string, value: unknown): void {
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${targetPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, targetPath);
  }
}
