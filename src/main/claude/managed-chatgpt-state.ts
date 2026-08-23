import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isManagedGatewayAuthenticationManifest } from './managed-chatgpt-auth';
import type { ManagedGatewayProcessBirthIdentity } from './managed-chatgpt-process-identity';
import type { ManagedGatewayAuthenticationManifest } from './managed-chatgpt-auth';
import { DEFAULT_PORT, LAST_PORT } from './managed-chatgpt-config';

export interface ManagedGatewaySafeStorage {
  decryptString: (encrypted: Buffer) => string;
  encryptString: (plainText: string) => Buffer;
  isEncryptionAvailable: () => boolean;
}

export interface ManagedGatewayStateFileSystem {
  mkdir: typeof mkdirSync;
  readFile: typeof readFileSync;
  rename: typeof renameSync;
  writeFile: typeof writeFileSync;
}

const defaultStateFileSystem: ManagedGatewayStateFileSystem = {
  mkdir: mkdirSync,
  readFile: readFileSync,
  rename: renameSync,
  writeFile: writeFileSync,
};

export interface PersistedGatewayProcessOwnership {
  identity: ManagedGatewayProcessBirthIdentity;
  phase: 'ready' | 'starting';
  processId: number;
  version: 1;
}

export interface PersistedGatewayState {
  authorization?: ManagedGatewayAuthenticationManifest;
  encryptedClientKey: string;
  encryptedManagementKey?: string;
  executableRelativePath: string;
  executableSha256: string;
  installedVersion: string;
  port: number;
  process?: PersistedGatewayProcessOwnership;
  releaseDigest: string;
  version: 1;
}

export const sha256File = (filePath: string): string =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const processOwnership = (value: unknown): PersistedGatewayProcessOwnership | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.phase !== 'starting' && value.phase !== 'ready') ||
    !Number.isInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    !isRecord(value.identity) ||
    value.identity.version !== 1 ||
    typeof value.identity.startedAtTicks !== 'string' ||
    !/^\d{10,20}$/.test(value.identity.startedAtTicks)
  ) {
    return undefined;
  }
  return {
    identity: {
      startedAtTicks: value.identity.startedAtTicks,
      version: 1,
    },
    phase: value.phase,
    processId: value.processId as number,
    version: 1,
  };
};

export class ManagedGatewayStateStore {
  public constructor(
    private readonly rootDirectory: string,
    private readonly statePath: string,
    private readonly versionsDirectory: string,
    private readonly safeStorage: ManagedGatewaySafeStorage,
    private readonly fileSystem: ManagedGatewayStateFileSystem = defaultStateFileSystem,
  ) {}

  public load(): PersistedGatewayState | undefined {
    const current = this.loadAt(this.statePath);
    const recoveryPath = `${this.statePath}.tmp`;
    const recovery = this.loadAt(recoveryPath);
    if (!recovery?.process) return current;
    try {
      this.fileSystem.rename(recoveryPath, this.statePath);
    } catch {
      // The complete exact process record remains recoverable from the temporary state file.
    }
    return recovery;
  }

  private loadAt(filePath: string): PersistedGatewayState | undefined {
    try {
      const parsed = JSON.parse(this.fileSystem.readFile(filePath, 'utf8') as string) as unknown;
      if (
        !isRecord(parsed) ||
        parsed.version !== 1 ||
        (parsed.authorization !== undefined &&
          !isManagedGatewayAuthenticationManifest(parsed.authorization)) ||
        typeof parsed.encryptedClientKey !== 'string' ||
        (parsed.encryptedManagementKey !== undefined &&
          typeof parsed.encryptedManagementKey !== 'string') ||
        typeof parsed.executableRelativePath !== 'string' ||
        !/^[0-9a-f]{64}$/.test(String(parsed.executableSha256 ?? '')) ||
        !/^\d+\.\d+\.\d+$/.test(String(parsed.installedVersion ?? '')) ||
        !/^[0-9a-f]{64}$/.test(String(parsed.releaseDigest ?? '')) ||
        !Number.isInteger(parsed.port) ||
        (parsed.port !== 0 &&
          ((parsed.port as number) < DEFAULT_PORT || (parsed.port as number) > LAST_PORT))
      ) {
        return undefined;
      }
      const ownedProcess = processOwnership(parsed.process);
      const candidate: PersistedGatewayState = {
        ...(parsed.authorization === undefined ? {} : { authorization: parsed.authorization }),
        encryptedClientKey: parsed.encryptedClientKey,
        ...(parsed.encryptedManagementKey === undefined
          ? {}
          : { encryptedManagementKey: parsed.encryptedManagementKey }),
        executableRelativePath: parsed.executableRelativePath,
        executableSha256: parsed.executableSha256 as string,
        installedVersion: parsed.installedVersion as string,
        port: parsed.port as number,
        ...(ownedProcess ? { process: ownedProcess } : {}),
        releaseDigest: parsed.releaseDigest as string,
        version: 1,
      };
      this.executablePath(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }

  public persist(state: PersistedGatewayState): void {
    this.fileSystem.mkdir(this.rootDirectory, { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    this.fileSystem.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    this.fileSystem.rename(temporary, this.statePath);
  }

  public decryptClientKey(state: PersistedGatewayState): string | undefined {
    if (!state.encryptedClientKey || !this.safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      const value = this.safeStorage.decryptString(Buffer.from(state.encryptedClientKey, 'base64'));
      return /^sk-claudedock-[A-Za-z0-9_-]{32,}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  public decryptManagementKey(state: PersistedGatewayState): string | undefined {
    if (!state.encryptedManagementKey || !this.safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      const value = this.safeStorage.decryptString(
        Buffer.from(state.encryptedManagementKey, 'base64'),
      );
      return /^mgmt-claudedock-[A-Za-z0-9_-]{32,}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  public executablePath(state: PersistedGatewayState): string {
    const resolved = path.resolve(this.rootDirectory, state.executableRelativePath);
    const versionsRoot = path.resolve(this.versionsDirectory);
    if (
      !resolved.toLowerCase().startsWith(`${versionsRoot.toLowerCase()}${path.sep}`) ||
      path.basename(resolved).toLowerCase() !== 'cli-proxy-api.exe'
    ) {
      throw new Error('托管网关可执行文件路径无效。');
    }
    return resolved;
  }

  public executableIsValid(state: PersistedGatewayState): boolean {
    try {
      const executable = this.executablePath(state);
      return (
        existsSync(executable) &&
        lstatSync(executable).isFile() &&
        sha256File(executable) === state.executableSha256
      );
    } catch {
      return false;
    }
  }
}
