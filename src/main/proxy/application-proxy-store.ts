import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import type {
  ApplicationProxyProtocol,
  ApplicationProxyScope,
  ApplicationProxyView,
  SaveApplicationProxyInput,
} from '../../shared/contracts';

export interface ApplicationProxySecretStorage {
  decryptString(value: Buffer): string;
  encryptString(value: string): Buffer;
  isEncryptionAvailable(): boolean;
}

interface StoredApplicationProxy {
  enabled: boolean;
  encryptedPassword?: string;
  host: string;
  port?: number;
  protocol: ApplicationProxyProtocol;
  scope: ApplicationProxyScope;
  updatedAt?: number;
  username: string;
  version: 1;
}

export interface ApplicationProxyCredentials {
  password: string;
  username: string;
}

const DEFAULT_SCOPE: ApplicationProxyScope = {
  application: false,
  cli: true,
  conversation: false,
};
const DEFAULT_STATE: StoredApplicationProxy = {
  enabled: false,
  host: '',
  protocol: 'http',
  scope: DEFAULT_SCOPE,
  username: '',
  version: 1,
};
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)$/i;

const cleanText = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string' || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error('代理文本字段格式无效。');
  }
  return value.trim();
};

const cleanSecret = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new Error('代理密码格式无效。');
  }
  return value;
};

export const normalizeApplicationProxyHost = (value: unknown): string => {
  const host = cleanText(value, 253).replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!host) return '';
  if (isIP(host) !== 0 || HOSTNAME_PATTERN.test(host)) return host;
  throw new Error('代理地址只能填写主机名或 IP，不能带协议、端口、路径。');
};

const normalizePort = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('代理端口必须是 1–65535 的整数。');
  }
  return port;
};

const normalizeScope = (value: unknown): ApplicationProxyScope => {
  const scope = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    application: scope.application === true,
    cli: scope.cli !== false,
    conversation: scope.conversation === true,
  };
};

const toView = (stored: StoredApplicationProxy): ApplicationProxyView => ({
  enabled: stored.enabled,
  host: stored.host,
  passwordConfigured: Boolean(stored.encryptedPassword),
  port: stored.port,
  protocol: stored.protocol,
  scope: { ...stored.scope },
  updatedAt: stored.updatedAt,
  username: stored.username,
});

export class ApplicationProxyStore {
  private readonly filePath: string;
  private stored: StoredApplicationProxy;

  public constructor(
    userDataPath: string,
    private readonly secretStorage: ApplicationProxySecretStorage,
  ) {
    const directory = path.join(userDataPath, 'proxy');
    mkdirSync(directory, { recursive: true });
    this.filePath = path.join(directory, 'application-proxy.json');
    this.stored = this.load();
  }

  public getView(): ApplicationProxyView {
    return toView(this.stored);
  }

  public save(input: SaveApplicationProxyInput): ApplicationProxyView {
    if (!input || typeof input !== 'object') throw new Error('代理配置无效。');
    if (input.protocol !== 'http' && input.protocol !== 'socks5') {
      throw new Error('仅支持 HTTP 或 SOCKS5 应用代理。');
    }
    const enabled = input.enabled === true;
    const host = normalizeApplicationProxyHost(input.host);
    const port = normalizePort(input.port);
    const username = cleanText(input.username ?? '', 256);
    const password = input.password === undefined ? undefined : cleanSecret(input.password);
    const scope = normalizeScope(input.scope);
    if (enabled && (!host || !port)) {
      throw new Error('启用代理前必须填写地址和端口。');
    }
    if (input.protocol === 'socks5' && scope.cli) {
      throw new Error(
        'Claude Code CLI 不支持 SOCKS；请改用代理软件提供的 HTTP 端口，或关闭 CLI 作用域。',
      );
    }
    if (password && !username) throw new Error('填写代理密码时必须同时填写账号。');

    let encryptedPassword = username ? this.stored.encryptedPassword : undefined;
    if (password) {
      if (!this.secretStorage.isEncryptionAvailable()) {
        throw new Error('Windows 安全存储不可用，代理密码不会降级为明文保存。');
      }
      encryptedPassword = this.secretStorage.encryptString(password).toString('base64');
    }
    this.stored = {
      enabled,
      encryptedPassword,
      host,
      port,
      protocol: input.protocol,
      scope,
      updatedAt: Date.now(),
      username,
      version: 1,
    };
    this.persist();
    return this.getView();
  }

  public getCredentials(): ApplicationProxyCredentials | undefined {
    const { encryptedPassword, username } = this.stored;
    if (!username || !encryptedPassword || !this.secretStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      return {
        password: this.secretStorage.decryptString(Buffer.from(encryptedPassword, 'base64')),
        username,
      };
    } catch {
      return undefined;
    }
  }

  private load(): StoredApplicationProxy {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      if (parsed.version !== 1) return { ...DEFAULT_STATE, scope: { ...DEFAULT_SCOPE } };
      const protocol = parsed.protocol === 'socks5' ? 'socks5' : 'http';
      const host = normalizeApplicationProxyHost(parsed.host ?? '');
      const port = normalizePort(parsed.port);
      const username = cleanText(parsed.username ?? '', 256);
      const encryptedPassword =
        username &&
        typeof parsed.encryptedPassword === 'string' &&
        parsed.encryptedPassword.length <= 16_384
          ? parsed.encryptedPassword
          : undefined;
      const enabled = parsed.enabled === true && Boolean(host && port);
      const scope = normalizeScope(parsed.scope);
      if (protocol === 'socks5') scope.cli = false;
      return {
        enabled,
        encryptedPassword,
        host,
        port,
        protocol,
        scope,
        updatedAt:
          typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
            ? parsed.updatedAt
            : undefined,
        username,
        version: 1,
      };
    } catch {
      return { ...DEFAULT_STATE, scope: { ...DEFAULT_SCOPE } };
    }
  }

  private persist(): void {
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.stored, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }
}
