import { link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManagedQuotaCredential } from '../../src/main/claude/managed-chatgpt-quota-auth';
import { createManagedQuotaFixture, managedQuotaAuth } from '../helpers/managed-quota-fixture';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const result = await createManagedQuotaFixture();
  roots.push(result.root);
  return result;
};
const read = (auth: string) => readManagedQuotaCredential(auth, new AbortController().signal);

describe('managed subscription quota credential ownership', () => {
  it('reads an owned credential asynchronously from a relocated Unicode directory without rewriting it', async () => {
    const { authDirectory, file } = await fixture();
    const before = await readFile(file);
    const credential = await read(authDirectory);
    expect(credential).toEqual({
      accessToken: 'managed-access-secret',
      accountId: 'account-managed',
      accountKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(credential)).not.toMatch(/managed-refresh|managed-id|managed@example/);
    expect(await readFile(file)).toEqual(before);
  });

  it('changes the opaque account identity when the workspace changes, even with the same email', async () => {
    const { authDirectory, write } = await fixture();
    const first = await read(authDirectory);
    await write({ access_token: 'rotated-token', email: 'MANAGED@example.com' });
    expect((await read(authDirectory)).accountKey).toBe(first.accountKey);
    await write({ account_id: 'another-workspace' });
    expect((await read(authDirectory)).accountKey).not.toBe(first.accountKey);
  });

  it.each([
    { account_id: '' },
    { account_id: 'account\r\nAuthorization: another' },
    { access_token: 'token\r\nHeader: value' },
    { email: '' },
    { expired: 'not-a-date' },
    { last_refresh: 'not-a-date' },
    { id_token: '' },
    { refresh_token: '' },
    { type: 'unrelated' },
  ])(
    'rejects incomplete or header-injecting auth without exposing its contents: %j',
    async (overrides) => {
      const { authDirectory, write } = await fixture();
      await write(overrides);
      await expect(read(authDirectory)).rejects.toMatchObject({ kind: 'invalid-auth' });
    },
  );

  it('does not choose a different account by the newest file or email', async () => {
    const { authDirectory } = await fixture();
    await writeFile(
      path.join(authDirectory, 'codex-another.json'),
      JSON.stringify(
        managedQuotaAuth({
          account_id: 'another-workspace',
        }),
      ),
    );
    await expect(read(authDirectory)).rejects.toMatchObject({ kind: 'ambiguous-account' });
  });

  it('ignores explicitly disabled artifacts and reports a signed-out gateway', async () => {
    const { authDirectory, write } = await fixture();
    await writeFile(
      path.join(authDirectory, 'codex-disabled.json'),
      JSON.stringify(
        managedQuotaAuth({
          disabled: true,
        }),
      ),
    );
    expect((await read(authDirectory)).accountId).toBe('account-managed');
    await write({ disabled: true });
    await expect(read(authDirectory)).rejects.toMatchObject({ kind: 'not-authorized' });
  });

  it('does not recover, remove, or read quarantined credentials during an incomplete login', async () => {
    const { authDirectory } = await fixture();
    const transaction = path.join(authDirectory, `.quarantine-${'a'.repeat(32)}`);
    await mkdir(transaction);
    await writeFile(path.join(transaction, '.phase-active'), '');
    await expect(read(authDirectory)).rejects.toMatchObject({ kind: 'account-changing' });
    expect(await readFile(path.join(transaction, '.phase-active'), 'utf8')).toBe('');
    await rename(
      path.join(transaction, '.phase-active'),
      path.join(transaction, '.phase-committed'),
    );
    expect((await read(authDirectory)).accountId).toBe('account-managed');
    expect(await readFile(path.join(transaction, '.phase-committed'), 'utf8')).toBe('');
  });

  it('rejects linked auth directories and hard-linked credential files', async () => {
    const { authDirectory, root, file } = await fixture();
    const alias = path.join(root, 'auth-alias');
    await symlink(authDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(read(alias)).rejects.toMatchObject({ kind: 'unsafe-auth' });
    await link(file, path.join(root, 'hard-link.json'));
    await expect(read(authDirectory)).rejects.toMatchObject({ kind: 'unsafe-auth' });
  });

  it('bounds directory enumeration and credential bytes, and never leaks malformed JSON', async () => {
    const { authDirectory, file, write } = await fixture();
    await writeFile(file, '{"access_token":"must-not-escape",');
    await expect(read(authDirectory)).rejects.toMatchObject({ message: 'invalid-auth' });
    await writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await expect(read(authDirectory)).rejects.toMatchObject({ kind: 'unsafe-auth' });
    await write();
    for (let index = 0; index < 65; index++)
      await writeFile(path.join(authDirectory, `unused-${index}`), '');
    await expect(read(authDirectory)).rejects.toMatchObject({ kind: 'unsafe-auth' });
  });

  it('respects cancellation before touching credentials', async () => {
    const { authDirectory } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readManagedQuotaCredential(authDirectory, controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
