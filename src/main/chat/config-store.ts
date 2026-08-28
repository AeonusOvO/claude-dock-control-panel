import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type {
  ChatAuthMode,
  ChatConfigView,
  ChatProtocol,
  SaveChatConfigInput,
} from '../../shared/contracts';
import { normalizeConnectionAddress } from '../../shared/router/connection-endpoint';
import { sameConnectionCredentialScope } from '../../shared/router/automatic-connection';
import { assertChatApiAccess } from '../../shared/claude/chat-providers';

interface StoredChatConfig {
  authMode: ChatAuthMode;
  baseUrl: string;
  encryptedCredential?: string;
  model: string;
  protocol: ChatProtocol;
  preset?: string;
}

export interface ChatRuntimeConfig {
  authMode: ChatAuthMode;
  baseUrl: string;
  credential?: string;
  model: string;
  protocol: ChatProtocol;
}

export type ChatRuntimeSnapshot = Readonly<ChatRuntimeConfig>;

interface StoredChatConfigFile {
  config: StoredChatConfig;
  version: 1;
}

const DEFAULT_CHAT_CONFIG: StoredChatConfig = {
  authMode: 'apiKey',
  baseUrl: 'https://api.anthropic.com',
  model: '',
  protocol: 'anthropic',
};

export const normalizeChatBaseUrl = normalizeConnectionAddress;

const normalizeModel = (value: string): string => {
  const model = value.trim();
  const hasControlCharacter = [...model].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!model || model.length > 256 || hasControlCharacter) {
    throw new Error('模型名称不能为空、不能包含控制字符，且长度不能超过 256 个字符。');
  }
  return model;
};

const isStoredConfig = (value: unknown): value is StoredChatConfig => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.protocol === 'anthropic' ||
      record.protocol === 'openai' ||
      record.protocol === 'openai-responses') &&
    (record.authMode === 'apiKey' || record.authMode === 'bearer' || record.authMode === 'none') &&
    typeof record.baseUrl === 'string' &&
    typeof record.model === 'string' &&
    (record.encryptedCredential === undefined || typeof record.encryptedCredential === 'string')
  );
};

const validateInput = (
  input: SaveChatConfigInput,
): Omit<StoredChatConfig, 'encryptedCredential'> => {
  if (
    input.protocol !== 'anthropic' &&
    input.protocol !== 'openai' &&
    input.protocol !== 'openai-responses'
  ) {
    throw new Error('对话接口协议无效。');
  }
  if (input.authMode !== 'apiKey' && input.authMode !== 'bearer' && input.authMode !== 'none') {
    throw new Error('对话接口认证方式无效。');
  }
  if (
    input.credentialAction !== 'clear' &&
    input.credentialAction !== 'keep' &&
    input.credentialAction !== 'replace'
  ) {
    throw new Error('对话接口凭据操作无效。');
  }
  return {
    authMode: input.authMode,
    baseUrl: normalizeChatBaseUrl(input.baseUrl),
    model: normalizeModel(input.model),
    protocol: input.protocol,
    ...(typeof input.preset === 'string' ? { preset: input.preset } : {}),
  };
};

export class ChatConfigStore {
  private readonly storageDirectory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.storageDirectory = path.join(userDataPath, 'claude');
    this.storagePath = path.join(this.storageDirectory, 'chat-profile.json');
  }

  public getView(): ChatConfigView {
    const config = this.load().config;
    return {
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      credentialConfigured: Boolean(config.encryptedCredential),
      model: config.model,
      protocol: config.protocol,
      ...(config.preset ? { preset: config.preset } : {}),
    };
  }

  public getRuntimeConfig(): ChatRuntimeConfig {
    const config = this.load().config;
    return {
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      credential: this.decryptCredential(config.encryptedCredential),
      model: config.model,
      protocol: config.protocol,
    };
  }

  public resolveRuntimeConfig(input: SaveChatConfigInput): ChatRuntimeConfig {
    const normalized = validateInput(input);
    const credential = this.resolveCredential(input, normalized.baseUrl);
    assertChatApiAccess(normalized.baseUrl, credential);
    return { ...normalized, credential };
  }

  public resolveCredential(input: SaveChatConfigInput, address: string): string | undefined {
    const current = this.load().config;
    let credential: string | undefined;
    if (input.authMode !== 'none' && input.credentialAction !== 'clear') {
      if (input.credentialAction === 'replace') {
        credential = input.credential?.trim();
        if (!credential || credential.length > 4096 || /[\r\n]/.test(credential)) {
          throw new Error('接口凭据不能为空、不能换行，且长度不能超过 4096 个字符。');
        }
      } else {
        if (
          current.encryptedCredential &&
          !sameConnectionCredentialScope(address, current.baseUrl)
        ) {
          throw new Error('网址已更换，请重新填写密钥。');
        }
        credential = this.decryptCredential(current.encryptedCredential);
      }
    }
    return credential;
  }

  public save(input: SaveChatConfigInput): ChatConfigView {
    const normalized = validateInput(input);
    assertChatApiAccess(normalized.baseUrl, this.resolveCredential(input, normalized.baseUrl));

    const current = this.load().config;
    let encryptedCredential = current.encryptedCredential;
    if (input.credentialAction === 'replace') {
      const credential = input.credential?.trim() ?? '';
      if (!credential || credential.length > 4096 || /[\r\n]/.test(credential)) {
        throw new Error('接口凭据不能为空、不能换行，且长度不能超过 4096 个字符。');
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows 安全存储当前不可用，拒绝以明文保存接口凭据。');
      }
      encryptedCredential = safeStorage.encryptString(credential).toString('base64');
    } else if (input.credentialAction === 'clear' || input.authMode === 'none') {
      encryptedCredential = undefined;
    }

    const store: StoredChatConfigFile = {
      config: {
        authMode: normalized.authMode,
        baseUrl: normalized.baseUrl,
        encryptedCredential,
        model: normalized.model,
        protocol: normalized.protocol,
        ...(normalized.preset ? { preset: normalized.preset } : {}),
      },
      version: 1,
    };
    this.persist(store);
    return this.getView();
  }

  private decryptCredential(encryptedCredential: string | undefined): string | undefined {
    if (!encryptedCredential) {
      return undefined;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储当前不可用，无法解密对话接口凭据。');
    }
    try {
      return safeStorage.decryptString(Buffer.from(encryptedCredential, 'base64'));
    } catch {
      throw new Error('对话接口凭据无法解密，请在对话页重新填写。');
    }
  }

  private load(): StoredChatConfigFile {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        config?: unknown;
        version?: unknown;
      };
      if (parsed.version !== 1 || !isStoredConfig(parsed.config)) {
        return { config: { ...DEFAULT_CHAT_CONFIG }, version: 1 };
      }
      return { config: parsed.config, version: 1 };
    } catch {
      return { config: { ...DEFAULT_CHAT_CONFIG }, version: 1 };
    }
  }

  private persist(store: StoredChatConfigFile): void {
    mkdirSync(this.storageDirectory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
  }
}
