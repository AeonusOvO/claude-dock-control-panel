import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SUBSCRIPTION_PROVIDERS } from '../../shared/claude/subscriptions';
import type { SubscriptionCredential } from './catalog';
import { hasControlCharacters, SubscriptionError } from './http';

export interface SubscriptionEncryption {
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
  isEncryptionAvailable: () => boolean;
}

const token = z
  .string()
  .min(1)
  .max(16384)
  .refine((value) => !hasControlCharacters(value));
const slotSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  clientKey: z.string().regex(/^[a-f0-9]{64}$/),
  credential: z.object({
    provider: z.enum(SUBSCRIPTION_PROVIDERS),
    accessToken: token,
    refreshToken: token.optional(),
    expiresAt: z.number().positive().finite(),
    deviceId: z.string().uuid().optional(),
  }),
});
const vaultSchema = z
  .object({
    version: z.literal(1),
    port: z.number().int().min(18520).max(18540).optional(),
    slots: z.array(slotSchema).max(128),
  })
  .refine((value) => new Set(value.slots.map((slot) => slot.id)).size === value.slots.length);

export interface SubscriptionSlot {
  id: string;
  clientKey: string;
  credential: SubscriptionCredential;
}
type Vault = z.infer<typeof vaultSchema>;

/** One Electron main process owns this vault. Its complete payload is protected by Windows DPAPI. */
export class SubscriptionVault {
  private value: Vault | undefined;
  private readonly directory: string;
  private readonly file: string;

  public constructor(
    userData: string,
    private readonly encryption: SubscriptionEncryption,
  ) {
    this.directory = path.join(userData, 'managed-subscriptions');
    this.file = path.join(this.directory, 'credentials.enc');
  }

  public load(): Vault {
    if (this.value) return structuredClone(this.value);
    if (!this.encryption.isEncryptionAvailable())
      throw new SubscriptionError('Windows 凭据加密不可用，无法连接订阅。');
    try {
      if (existsSync(this.directory) && !lstatSync(this.directory).isDirectory()) throw new Error();
      if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink())
        throw new Error();
      if (!existsSync(this.file)) this.value = { version: 1, slots: [] };
      else {
        const stat = lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
          throw new Error();
        this.value = vaultSchema.parse(
          JSON.parse(this.encryption.decryptString(readFileSync(this.file))) as unknown,
        );
      }
      return structuredClone(this.value);
    } catch {
      throw new SubscriptionError('无法读取订阅凭据，请检查 Windows 账号和数据目录。');
    }
  }

  private save(next: Vault): void {
    if (!this.encryption.isEncryptionAvailable())
      throw new SubscriptionError('Windows 凭据加密不可用。');
    const value = vaultSchema.parse(next);
    const temp = path.join(this.directory, `credentials-${randomBytes(16).toString('hex')}.tmp`);
    try {
      mkdirSync(this.directory, { recursive: true });
      if (lstatSync(this.directory).isSymbolicLink()) throw new Error();
      writeFileSync(temp, this.encryption.encryptString(JSON.stringify(value)), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      renameSync(temp, this.file);
      this.value = value;
    } catch {
      throw new SubscriptionError('无法保存加密订阅凭据，原配置保持不变。');
    } finally {
      rmSync(temp, { force: true });
    }
  }

  public setPort(port: number): void {
    this.save({ ...this.load(), port });
  }

  public put(slot: SubscriptionSlot): void {
    const current = this.load();
    this.save({
      ...current,
      slots: [...current.slots.filter((entry) => entry.id !== slot.id), structuredClone(slot)],
    });
  }
}
