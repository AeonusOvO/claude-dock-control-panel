import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ProxyCredentialInput,
  ProxyIpMode,
  ProxyProfileInput,
  ProxyProfileView,
  ProxyProtocol,
  ProxyRuntimeStatus,
  ProxyScopeSettings,
  ProxySecurity,
  ProxyStoreView,
  ProxyStoredState,
  ProxySubscriptionInput,
  ProxySubscriptionView,
  ProxyTransport,
} from '../../shared/contracts';
import { normalizeBootstrapProxyUrl } from './proxy-environment';
import { normalizeMirrorHost } from './xray-core-sources';

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
  subscriptions?: Array<Omit<ProxySubscriptionView, 'profileCount'>>;
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
const SECURITIES = new Set<ProxySecurity>(['none', 'reality', 'tls']);
const RUNTIME_STATUSES = new Set<ProxyRuntimeStatus>([
  'error',
  'ready',
  'starting',
  'stopped',
  'stopping',
]);
const IP_MODES = new Set<ProxyIpMode>(['dual_stack', 'ipv4_only', 'prefer_ipv6']);
const DEFAULT_SCOPE: ProxyScopeSettings = {
  application: false,
  cli: true,
  conversation: false,
  ipMode: 'ipv4_only',
};
const DEFAULT_STATE: ProxyStoredState = { runtimeStatus: 'stopped' };
const MAX_EXTRA_CORE_SOURCES = 16;

/**
 * The two optional fields are dropped rather than stored empty, so a profile written by an older
 * build and one where the user cleared the field read back identically.
 */
const normalizeScope = (scope: ProxyScopeSettings): ProxyScopeSettings => {
  const bootstrapProxyUrl = normalizeBootstrapProxyUrl(scope.bootstrapProxyUrl);
  const extraCoreSources = [
    ...new Set(
      (Array.isArray(scope.extraCoreSources) ? scope.extraCoreSources : [])
        .map((entry) => (typeof entry === 'string' ? normalizeMirrorHost(entry) : undefined))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ].slice(0, MAX_EXTRA_CORE_SOURCES);
  return {
    application: scope.application,
    cli: scope.cli,
    conversation: scope.conversation === true,
    ipMode: IP_MODES.has(scope.ipMode as ProxyIpMode) ? scope.ipMode : 'ipv4_only',
    ...(bootstrapProxyUrl ? { bootstrapProxyUrl } : {}),
    ...(extraCoreSources.length > 0 ? { extraCoreSources } : {}),
  };
};

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

/**
 * Profiles saved before REALITY support recorded only the `tls` boolean. Reading them back through
 * this keeps `security` authoritative everywhere else, so no call site has to branch on "old shape".
 */
const hydrateProfile = (profile: StoredProfile): StoredProfile => ({
  ...profile,
  security: SECURITIES.has(profile.security) ? profile.security : profile.tls ? 'tls' : 'none',
});

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
  // `security` wins when present; `tls` is the legacy spelling of `security: 'tls'`.
  const security = input.security ?? (input.tls === true ? 'tls' : 'none');
  if (!SECURITIES.has(security)) {
    throw new Error('代理传输安全模式不受支持。');
  }
  const publicKey = optionalText(input.publicKey, 'REALITY 公钥', 128);
  if (security === 'reality' && !publicKey) {
    throw new Error('REALITY 节点缺少公钥（pbk）。');
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
      allowInsecure: input.allowInsecure === true ? true : undefined,
      alpn: optionalText(input.alpn, 'ALPN', 64),
      credentialRef,
      encryption: optionalText(input.encryption, '加密方式', 64),
      fingerprint: optionalText(input.fingerprint, 'TLS 指纹', 64),
      flow: optionalText(input.flow, '流控方式', 64),
      headerType: optionalText(input.headerType, '伪装类型', 64),
      host: optionalText(input.host, '伪装域名', 1024),
      id,
      port: input.port,
      protocol: input.protocol,
      publicKey,
      remark: optionalText(input.remark, '备注', 256) ?? `${input.protocol} · ${address}`,
      security,
      serverName: optionalText(input.serverName, 'SNI', 253),
      shortId: optionalText(input.shortId, 'REALITY Short ID', 128),
      spiderX: optionalText(input.spiderX, 'REALITY SpiderX', 1024),
      subscriptionId: optionalText(input.subscriptionId, '订阅标识', 128),
      tls: security !== 'none',
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
      subscriptions: (store.subscriptions ?? []).map((subscription) => ({
        ...subscription,
        profileCount: store.profiles.filter(
          ({ subscriptionId }) => subscriptionId === subscription.id,
        ).length,
      })),
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

  public replaceSubscription(
    subscription: ProxySubscriptionInput,
    inputs: ProxyProfileInput[],
  ): ProxyStoreView {
    if (!this.secretStorage.isEncryptionAvailable()) {
      throw new Error('Windows 凭据加密当前不可用，未保存代理订阅。');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(subscription.id)) {
      throw new Error('代理订阅标识无效。');
    }
    const url = new URL(subscription.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.toString().length > 2048) {
      throw new Error('订阅地址必须是无内嵌凭据的 HTTPS URL。');
    }
    const label = requiredText(subscription.label, '订阅名称', 128);
    const normalized = inputs.map((input) =>
      normalizeProxyProfile({ ...input, subscriptionId: subscription.id }),
    );
    if (normalized.length === 0 || normalized.length > 100) {
      throw new Error('代理订阅必须包含 1–100 个有效节点。');
    }
    const store = this.loadProfiles();
    const credentials = this.loadCredentials();
    const removed = store.profiles.filter(
      ({ subscriptionId }) => subscriptionId === subscription.id,
    );
    for (const profile of removed) {
      if (profile.credentialRef) delete credentials.entries[profile.credentialRef];
    }
    store.profiles = store.profiles.filter(
      ({ subscriptionId }) => subscriptionId !== subscription.id,
    );
    for (const entry of normalized) {
      store.profiles.push(entry.profile);
      if (entry.profile.credentialRef && entry.credentials) {
        credentials.entries[entry.profile.credentialRef] = this.encryptJson(entry.credentials);
      }
    }
    credentials.entries[`proxy-subscription:${subscription.id}`] = this.encryptJson({
      url: url.toString(),
    });
    store.subscriptions = [
      ...(store.subscriptions ?? []).filter(({ id }) => id !== subscription.id),
      {
        host: url.hostname,
        id: subscription.id,
        label,
        updatedAt: Date.now(),
      },
    ];
    if (
      !store.state.selectedProfileId ||
      !store.profiles.some(({ id }) => id === store.state.selectedProfileId)
    ) {
      store.state.selectedProfileId = normalized[0]?.profile.id;
    }
    this.persistCredentials(credentials);
    this.persistProfiles(store);
    return this.getView();
  }

  public getSubscriptionSources(): ProxySubscriptionInput[] {
    const store = this.loadProfiles();
    return (store.subscriptions ?? []).flatMap((subscription) => {
      const secret = this.readJson<{ url?: unknown }>(`proxy-subscription:${subscription.id}`);
      return typeof secret?.url === 'string'
        ? [{ id: subscription.id, label: subscription.label, url: secret.url }]
        : [];
    });
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
    if (
      typeof scope.cli !== 'boolean' ||
      typeof scope.application !== 'boolean' ||
      typeof scope.conversation !== 'boolean' ||
      (scope.ipMode !== undefined && !IP_MODES.has(scope.ipMode))
    ) {
      throw new Error('代理作用域设置无效。');
    }
    const store = this.loadProfiles();
    store.scope = normalizeScope(scope);
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
        profiles: parsed.profiles.map(hydrateProfile),
        scope: normalizeScope(parsed.scope),
        state: { ...parsed.state, runtimeStatus: 'stopped' },
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        version: 1,
      };
    } catch {
      return {
        profiles: [],
        scope: { ...DEFAULT_SCOPE },
        state: { ...DEFAULT_STATE },
        subscriptions: [],
        version: 1,
      };
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
    return this.readJson<ProxyCredentialInput>(reference);
  }

  private readJson<T>(reference: string): T | undefined {
    const encrypted = this.loadCredentials().entries[reference];
    if (!encrypted || !this.secretStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      return JSON.parse(this.secretStorage.decryptString(Buffer.from(encrypted, 'base64'))) as T;
    } catch {
      return undefined;
    }
  }

  private writeCredential(reference: string, credential: ProxyCredentialInput): void {
    if (!this.secretStorage.isEncryptionAvailable()) {
      throw new Error('Windows 凭据加密当前不可用，未保存代理节点。');
    }
    const store = this.loadCredentials();
    store.entries[reference] = this.encryptJson(credential);
    this.persistCredentials(store);
  }

  private encryptJson(value: unknown): string {
    return this.secretStorage.encryptString(JSON.stringify(value)).toString('base64');
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
