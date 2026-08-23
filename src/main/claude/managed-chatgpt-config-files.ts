import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { protectManagedGatewayConfig } from './managed-chatgpt-security';

export interface GatewayConfigTransaction {
  backupPath?: string;
  committed: boolean;
}

export class ManagedGatewayConfigFiles {
  public constructor(
    private readonly rootDirectory: string,
    private readonly configPath: string,
  ) {}

  public async stage(config: string): Promise<string> {
    mkdirSync(this.rootDirectory, { recursive: true });
    const pendingConfigPath = path.join(
      this.rootDirectory,
      `config-${randomBytes(12).toString('hex')}.pending.yaml`,
    );
    try {
      writeFileSync(pendingConfigPath, config, { encoding: 'utf8', mode: 0o600 });
      await protectManagedGatewayConfig(pendingConfigPath);
      return pendingConfigPath;
    } catch (error) {
      this.removeStaged(pendingConfigPath);
      throw error;
    }
  }

  public removeStaged(pendingConfigPath: string): void {
    const resolved = path.resolve(pendingConfigPath);
    if (
      path.dirname(resolved).toLowerCase() !== path.resolve(this.rootDirectory).toLowerCase() ||
      !/^config-[0-9a-f]{24}\.pending\.yaml$/i.test(path.basename(resolved))
    ) {
      throw new Error('拒绝清理不属于托管网关的临时配置文件。');
    }
    rmSync(resolved, { force: true });
  }

  public async activate(pendingConfigPath: string): Promise<GatewayConfigTransaction> {
    const backupPath = path.join(
      this.rootDirectory,
      `config-${randomBytes(12).toString('hex')}.previous.yaml`,
    );
    const transaction: GatewayConfigTransaction = { committed: false };
    try {
      if (existsSync(this.configPath)) {
        renameSync(this.configPath, backupPath);
        transaction.backupPath = backupPath;
      }
      renameSync(pendingConfigPath, this.configPath);
      await protectManagedGatewayConfig(this.configPath);
      return transaction;
    } catch (error) {
      this.rollback(transaction);
      throw error;
    }
  }

  public commit(transaction: GatewayConfigTransaction): void {
    transaction.committed = true;
    if (transaction.backupPath) {
      try {
        rmSync(transaction.backupPath, { force: true });
      } catch {
        // A stale protected backup is safe to clean on a later launch; readiness remains authoritative.
      }
    }
  }

  public rollback(transaction: GatewayConfigTransaction): void {
    if (transaction.committed) return;
    rmSync(this.configPath, { force: true });
    if (transaction.backupPath && existsSync(transaction.backupPath)) {
      renameSync(transaction.backupPath, this.configPath);
    }
  }
}
