import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedGatewayAuthenticationTransaction } from '../../src/main/claude/managed-chatgpt-auth-transaction';

const roots = new Set<string>();

const authFixture = (): { authDirectory: string; root: string } => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-auth-transaction-'));
  roots.add(root);
  const authDirectory = path.join(root, 'gateway', 'auth');
  mkdirSync(authDirectory, { recursive: true });
  return { authDirectory, root };
};

const writeAccount = (filePath: string, account: string): void => {
  writeFileSync(filePath, JSON.stringify({ account }), { encoding: 'utf8', mode: 0o600 });
};

const accountFiles = (authDirectory: string): string[] =>
  readdirSync(authDirectory)
    .filter((name) => /^codex-.+\.json$/i.test(name))
    .sort();

const accountValues = (authDirectory: string): string[] =>
  accountFiles(authDirectory)
    .map(
      (name) =>
        JSON.parse(readFileSync(path.join(authDirectory, name), 'utf8')) as { account: string },
    )
    .map(({ account }) => account)
    .sort();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

describe('managed gateway OAuth artifact transaction', () => {
  it('rolls back a failed account B attempt without retaining its filename or artifact', () => {
    const { authDirectory } = authFixture();
    const accountAPath = path.join(authDirectory, 'codex-account-a@example.com.json');
    writeAccount(accountAPath, 'account-a');
    const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
    const transactionDirectory = readdirSync(authDirectory).find((name) =>
      name.startsWith('.quarantine-'),
    );
    expect(transactionDirectory).toMatch(/^\.quarantine-[0-9a-f]{32}$/);
    expect(readdirSync(path.join(authDirectory, transactionDirectory!)).join(' ')).not.toContain(
      path.basename(accountAPath),
    );
    writeAccount(path.join(authDirectory, 'codex-account-b@example.com.json'), 'account-b');

    transaction.rollback();
    transaction.rollback();

    expect(accountValues(authDirectory)).toEqual(['account-a']);
    expect(readdirSync(authDirectory).some((name) => name.startsWith('.quarantine-'))).toBe(false);
    expect(readdirSync(authDirectory)).not.toContain('codex-account-b@example.com.json');
  });

  it('deletes quarantined account A only after account B is explicitly committed', () => {
    const { authDirectory } = authFixture();
    writeAccount(path.join(authDirectory, 'codex-account-a.json'), 'account-a');
    const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
    writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(true);
    expect(accountValues(authDirectory)).toEqual(['account-b']);
    transaction.commit();
    transaction.commit();

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(false);
    expect(accountValues(authDirectory)).toEqual(['account-b']);
    expect(readdirSync(authDirectory).some((name) => name.startsWith('.quarantine-'))).toBe(false);
  });

  it('permits inspection only for the exact active replacement transaction', () => {
    const { authDirectory } = authFixture();
    writeAccount(path.join(authDirectory, 'codex-account-a.json'), 'account-a');
    const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
    writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');
    const { authDirectory: otherAuthDirectory } = authFixture();
    const otherTransaction = new ManagedGatewayAuthenticationTransaction(otherAuthDirectory);

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(true);
    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory, transaction)).toBe(
      false,
    );
    expect(
      ManagedGatewayAuthenticationTransaction.hasPending(authDirectory, otherTransaction),
    ).toBe(true);

    transaction.commit();
    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory, transaction)).toBe(
      true,
    );
    otherTransaction.rollback();
  });

  it('does not ignore a second pending transaction while inspecting the owned transaction', () => {
    const { authDirectory } = authFixture();
    const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
    const secondDirectory = path.join(authDirectory, `.quarantine-${'f'.repeat(32)}`);
    mkdirSync(secondDirectory);
    writeFileSync(path.join(secondDirectory, '.phase-active'), '', 'utf8');

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory, transaction)).toBe(
      true,
    );
  });

  it('fails closed on unknown contents inside the inspected transaction', () => {
    const { authDirectory } = authFixture();
    const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
    const transactionDirectory = readdirSync(authDirectory).find((name) =>
      name.startsWith('.quarantine-'),
    );
    writeFileSync(
      path.join(authDirectory, transactionDirectory!, 'unexpected-secret-name.json'),
      '{}',
      'utf8',
    );

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory, transaction)).toBe(
      true,
    );
  });

  it('does not treat a markerless legacy directory as the active inspected transaction', () => {
    const { authDirectory } = authFixture();
    const transaction = new ManagedGatewayAuthenticationTransaction(authDirectory);
    const transactionDirectory = readdirSync(authDirectory).find((name) =>
      name.startsWith('.quarantine-'),
    );
    rmSync(path.join(authDirectory, transactionDirectory!, '.phase-active'));

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory, transaction)).toBe(
      true,
    );
  });

  it('recovers an abandoned active transaction by deleting unready account B and restoring A', () => {
    const { authDirectory } = authFixture();
    writeAccount(path.join(authDirectory, 'codex-account-a.json'), 'account-a');
    new ManagedGatewayAuthenticationTransaction(authDirectory);
    writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(true);
    ManagedGatewayAuthenticationTransaction.recoverAbandoned(authDirectory);

    expect(accountValues(authDirectory)).toEqual(['account-a']);
    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(false);
  });

  it('recovers a crash during quarantine preparation without deleting unmoved old artifacts', () => {
    const { authDirectory } = authFixture();
    const first = path.join(authDirectory, 'codex-account-a.json');
    const second = path.join(authDirectory, 'codex-account-a-secondary.json');
    writeAccount(first, 'account-a-primary');
    writeAccount(second, 'account-a-secondary');
    const transactionDirectory = path.join(authDirectory, `.quarantine-${'a'.repeat(32)}`);
    mkdirSync(transactionDirectory);
    writeFileSync(path.join(transactionDirectory, '.phase-preparing'), '', 'utf8');
    renameSync(first, path.join(transactionDirectory, `oauth-artifact-${'b'.repeat(32)}.bin`));

    ManagedGatewayAuthenticationTransaction.recoverAbandoned(authDirectory);

    expect(accountValues(authDirectory)).toEqual(['account-a-primary', 'account-a-secondary']);
    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(false);
  });

  it('cleans a committed crash residue without rolling back the active account', () => {
    const { authDirectory } = authFixture();
    writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');
    const transactionDirectory = path.join(authDirectory, `.quarantine-${'c'.repeat(32)}`);
    mkdirSync(transactionDirectory);
    writeFileSync(path.join(transactionDirectory, '.phase-committed'), '', 'utf8');
    writeAccount(
      path.join(transactionDirectory, `oauth-artifact-${'d'.repeat(32)}.bin`),
      'account-a',
    );

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(false);
    expect(accountValues(authDirectory)).toEqual(['account-b']);
    expect(readdirSync(authDirectory)).not.toContain(path.basename(transactionDirectory));
  });

  it('fails closed on unknown quarantine contents before deleting active artifacts', () => {
    const { authDirectory } = authFixture();
    writeAccount(path.join(authDirectory, 'codex-account-b.json'), 'account-b');
    const transactionDirectory = path.join(authDirectory, `.quarantine-${'e'.repeat(32)}`);
    mkdirSync(transactionDirectory);
    writeFileSync(path.join(transactionDirectory, '.phase-active'), '', 'utf8');
    writeFileSync(path.join(transactionDirectory, 'unexpected-secret-name.json'), '{}', 'utf8');

    expect(ManagedGatewayAuthenticationTransaction.hasPending(authDirectory)).toBe(true);
    expect(() => ManagedGatewayAuthenticationTransaction.recoverAbandoned(authDirectory)).toThrow(
      '未知内容',
    );
    expect(accountValues(authDirectory)).toEqual(['account-b']);
  });
});
