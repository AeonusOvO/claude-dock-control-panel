import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  managedGatewayAuthenticationCandidateKey,
  managedGatewayAuthenticationDirectoryIsOwned,
  snapshotManagedGatewayAuthenticationCandidates,
} from './managed-chatgpt-auth';

const TRANSACTION_DIRECTORY = /^\.quarantine-[0-9a-f]{32}$/;
const QUARANTINED_ARTIFACT = /^oauth-artifact-[0-9a-f]{32}\.bin$/;
const PHASES = [
  'active',
  'committed',
  'discarding',
  'preparing',
  'restoring',
  'restoring-keep',
] as const;
type TransactionPhase = (typeof PHASES)[number];

const randomName = (prefix: string, extension: string): string =>
  `${prefix}-${randomBytes(16).toString('hex')}${extension}`;

const phaseName = (phase: TransactionPhase): string => `.phase-${phase}`;

const transactionDirectories = (authDirectory: string): string[] =>
  readdirSync(authDirectory, { withFileTypes: true })
    .filter((entry) => TRANSACTION_DIRECTORY.test(entry.name))
    .map((entry) => path.join(authDirectory, entry.name));

const transactionPhase = (directory: string): TransactionPhase | undefined => {
  const names = readdirSync(directory);
  const phases = PHASES.filter((phase) => names.includes(phaseName(phase)));
  if (phases.length === 1) return phases[0];
  // Transactions created by an older interrupted build had no marker and were already active.
  return phases.length === 0 ? 'active' : undefined;
};

const quarantinedArtifacts = (directory: string): string[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  const unexpected = entries.some((entry) => {
    const knownPhase = PHASES.some((phase) => entry.name === phaseName(phase));
    if (knownPhase) return !entry.isFile() || entry.isSymbolicLink();
    return !(entry.isFile() && !entry.isSymbolicLink() && QUARANTINED_ARTIFACT.test(entry.name));
  });
  if (unexpected) throw new Error('托管网关授权事务目录包含未知内容。');
  return entries
    .filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink() && QUARANTINED_ARTIFACT.test(entry.name),
    )
    .map((entry) => path.join(directory, entry.name));
};

const validateTransactionDirectory = (authDirectory: string, directory: string): void => {
  const resolvedAuth = path.resolve(authDirectory);
  const resolvedDirectory = path.resolve(directory);
  const stats = lstatSync(resolvedDirectory);
  if (
    path.dirname(resolvedDirectory) !== resolvedAuth ||
    !TRANSACTION_DIRECTORY.test(path.basename(resolvedDirectory)) ||
    !stats.isDirectory() ||
    stats.isSymbolicLink()
  ) {
    throw new Error('托管网关授权事务目录不安全。');
  }
};

const restoreArtifacts = (authDirectory: string, directory: string): void => {
  for (const quarantinedPath of quarantinedArtifacts(directory)) {
    if (!existsSync(quarantinedPath)) continue;
    renameSync(quarantinedPath, path.join(authDirectory, randomName('codex-recovered', '.json')));
  }
  rmSync(directory, { force: true, recursive: true });
};

/** Keeps prior OAuth artifacts isolated until the replacement account reaches gateway readiness. */
export class ManagedGatewayAuthenticationTransaction {
  private finalized = false;
  private readonly quarantined: string[] = [];
  private readonly quarantineDirectory: string;

  public static hasPending(
    authDirectory: string,
    inspectedTransaction?: ManagedGatewayAuthenticationTransaction,
  ): boolean {
    if (!managedGatewayAuthenticationDirectoryIsOwned(authDirectory)) return true;
    try {
      let pending = false;
      const inspectedDirectory =
        inspectedTransaction &&
        !inspectedTransaction.finalized &&
        managedGatewayAuthenticationCandidateKey(inspectedTransaction.authDirectory) ===
          managedGatewayAuthenticationCandidateKey(authDirectory)
          ? managedGatewayAuthenticationCandidateKey(inspectedTransaction.quarantineDirectory)
          : undefined;
      let inspectedTransactionFound = inspectedTransaction === undefined;
      for (const directory of transactionDirectories(authDirectory)) {
        validateTransactionDirectory(authDirectory, directory);
        quarantinedArtifacts(directory);
        const phase = transactionPhase(directory);
        if (!phase) return true;
        if (phase === 'committed') {
          try {
            rmSync(directory, { force: true, recursive: true });
          } catch {
            // A committed directory contains obsolete artifacts only and is safe to retry later.
          }
        } else if (
          phase === 'active' &&
          existsSync(path.join(directory, phaseName('active'))) &&
          inspectedDirectory === managedGatewayAuthenticationCandidateKey(directory)
        ) {
          inspectedTransactionFound = true;
        } else {
          pending = true;
        }
      }
      return pending || !inspectedTransactionFound;
    } catch {
      return true;
    }
  }

  public static recoverAbandoned(authDirectory: string): void {
    if (!managedGatewayAuthenticationDirectoryIsOwned(authDirectory)) {
      throw new Error('托管网关授权目录不安全，无法恢复登录事务。');
    }
    for (const directory of transactionDirectories(authDirectory)) {
      validateTransactionDirectory(authDirectory, directory);
      let phase = transactionPhase(directory);
      if (!phase) throw new Error('托管网关授权事务状态无效。');
      quarantinedArtifacts(directory);
      if (phase === 'committed') {
        rmSync(directory, { force: true, recursive: true });
        continue;
      }
      if (phase === 'preparing') {
        renameSync(
          path.join(directory, phaseName('preparing')),
          path.join(directory, phaseName('restoring-keep')),
        );
        phase = 'restoring-keep';
      } else if (phase === 'active') {
        const activeMarker = path.join(directory, phaseName('active'));
        if (existsSync(activeMarker)) {
          renameSync(activeMarker, path.join(directory, phaseName('discarding')));
        } else {
          writeFileSync(path.join(directory, phaseName('discarding')), '', { mode: 0o600 });
        }
        phase = 'discarding';
      }
      if (phase === 'discarding') {
        for (const currentPath of snapshotManagedGatewayAuthenticationCandidates(
          authDirectory,
        ).keys()) {
          rmSync(currentPath, { force: true });
        }
        renameSync(
          path.join(directory, phaseName('discarding')),
          path.join(directory, phaseName('restoring')),
        );
      }
      restoreArtifacts(authDirectory, directory);
    }
  }

  public constructor(private readonly authDirectory: string) {
    if (!managedGatewayAuthenticationDirectoryIsOwned(authDirectory)) {
      throw new Error('托管网关授权目录不安全，无法开始登录事务。');
    }
    this.quarantineDirectory = path.join(authDirectory, randomName('.quarantine', ''));
    mkdirSync(this.quarantineDirectory, { mode: 0o700 });
    writeFileSync(path.join(this.quarantineDirectory, phaseName('preparing')), '', { mode: 0o600 });
    try {
      for (const candidatePath of snapshotManagedGatewayAuthenticationCandidates(
        authDirectory,
      ).keys()) {
        const destination = path.join(
          this.quarantineDirectory,
          randomName('oauth-artifact', '.bin'),
        );
        renameSync(candidatePath, destination);
        this.quarantined.push(destination);
      }
      renameSync(
        path.join(this.quarantineDirectory, phaseName('preparing')),
        path.join(this.quarantineDirectory, phaseName('active')),
      );
    } catch (error) {
      for (const quarantinedPath of this.quarantined) {
        if (!existsSync(quarantinedPath)) continue;
        renameSync(
          quarantinedPath,
          path.join(this.authDirectory, randomName('codex-recovered', '.json')),
        );
      }
      rmSync(this.quarantineDirectory, { force: true, recursive: true });
      this.finalized = true;
      throw error;
    }
  }

  public commit(): void {
    if (this.finalized) return;
    renameSync(
      path.join(this.quarantineDirectory, phaseName('active')),
      path.join(this.quarantineDirectory, phaseName('committed')),
    );
    this.finalized = true;
    try {
      rmSync(this.quarantineDirectory, { force: true, recursive: true });
    } catch {
      // The committed marker makes a later cleanup safe without rolling back the active account.
    }
  }

  public rollback(): void {
    if (this.finalized) return;
    const activeMarker = path.join(this.quarantineDirectory, phaseName('active'));
    if (existsSync(activeMarker)) {
      renameSync(activeMarker, path.join(this.quarantineDirectory, phaseName('discarding')));
    }
    for (const currentPath of snapshotManagedGatewayAuthenticationCandidates(
      this.authDirectory,
    ).keys()) {
      rmSync(currentPath, { force: true });
    }
    const discardingMarker = path.join(this.quarantineDirectory, phaseName('discarding'));
    if (existsSync(discardingMarker)) {
      renameSync(discardingMarker, path.join(this.quarantineDirectory, phaseName('restoring')));
    }
    restoreArtifacts(this.authDirectory, this.quarantineDirectory);
    this.finalized = true;
  }
}
