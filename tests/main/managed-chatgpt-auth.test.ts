import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectManagedGatewayAuthentication,
  inspectManagedGatewayCodexArtifact,
  managedGatewayAuthenticationDirectoryIsOwned,
  parseManagedGatewayLoginArtifactPath,
} from '../../src/main/claude/managed-chatgpt-auth';

const validCodexArtifact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: 'access-secret',
  account_id: '',
  disabled: false,
  email: 'account@example.com',
  expired: '2020-01-01T00:00:00Z',
  id_token: 'identity-secret',
  last_refresh: '2026-08-20T12:34:56.123+00:00',
  refresh_token: 'refresh-secret',
  type: 'codex',
  ...overrides,
});

describe('managed ChatGPT authentication artifacts', () => {
  it('accepts only complete direct Codex artifacts and persists no account identity', () => {
    const authDirectory = mkdtempSync(path.join(tmpdir(), 'claudedock-codex-auth-'));
    const validPath = path.join(authDirectory, 'codex-account@example.com-plus.json');
    try {
      writeFileSync(path.join(authDirectory, 'claude-account.json'), '{}', 'utf8');
      writeFileSync(path.join(authDirectory, 'codex-partial.json'), '{', 'utf8');
      writeFileSync(
        validPath,
        JSON.stringify(validCodexArtifact({ note: 'unknown metadata is allowed' })),
        'utf8',
      );
      const nestedDirectory = path.join(authDirectory, 'nested');
      mkdirSync(nestedDirectory);
      writeFileSync(
        path.join(nestedDirectory, 'codex-nested.json'),
        JSON.stringify(validCodexArtifact()),
        'utf8',
      );

      const inspection = inspectManagedGatewayAuthentication(authDirectory, 1234);
      expect(inspection?.artifacts).toHaveLength(1);
      expect(inspection?.artifacts[0]?.filePath).toBe(validPath);
      expect(inspection?.artifacts[0]?.email).toBe('account@example.com');
      expect(inspection?.manifest).toMatchObject({
        artifactCount: 1,
        provider: 'openai-codex',
        validatedAt: 1234,
        version: 1,
      });
      const persisted = JSON.stringify(inspection?.manifest);
      expect(persisted).not.toMatch(
        /account@example\.com|access-secret|identity-secret|refresh-secret|plus\.json/i,
      );
    } finally {
      rmSync(authDirectory, { force: true, recursive: true });
    }
  });

  it('rejects empty, disabled, malformed, oversized, and unrelated authentication files', () => {
    const authDirectory = mkdtempSync(path.join(tmpdir(), 'claudedock-invalid-codex-auth-'));
    try {
      const cases: Array<[string, unknown]> = [
        ['codex-empty.json', ''],
        ['codex-disabled.json', validCodexArtifact({ disabled: true })],
        ['codex-missing-disabled.json', validCodexArtifact({ disabled: undefined })],
        ['codex-missing-token.json', validCodexArtifact({ access_token: '' })],
        ['codex-wrong-account.json', validCodexArtifact({ account_id: null })],
        ['codex-bad-expiry.json', validCodexArtifact({ expired: 'tomorrow' })],
        ['codex-array.json', [validCodexArtifact()]],
        ['codex-other-provider.json', validCodexArtifact({ type: 'claude' })],
      ];
      for (const [name, value] of cases) {
        const candidatePath = path.join(authDirectory, name);
        writeFileSync(
          candidatePath,
          typeof value === 'string' ? value : JSON.stringify(value),
          'utf8',
        );
        expect(inspectManagedGatewayCodexArtifact(authDirectory, candidatePath)).toBeUndefined();
      }
      const oversizedPath = path.join(authDirectory, 'codex-oversized.json');
      writeFileSync(oversizedPath, 'x'.repeat(1024 * 1024 + 1), 'utf8');
      expect(inspectManagedGatewayCodexArtifact(authDirectory, oversizedPath)).toBeUndefined();
      const unrelatedPath = path.join(authDirectory, 'openai-valid.json');
      writeFileSync(unrelatedPath, JSON.stringify(validCodexArtifact()), 'utf8');
      expect(inspectManagedGatewayCodexArtifact(authDirectory, unrelatedPath)).toBeUndefined();
      expect(inspectManagedGatewayAuthentication(authDirectory)).toBeUndefined();
    } finally {
      rmSync(authDirectory, { force: true, recursive: true });
    }
  });

  it('requires the exact final login marker and one absolute reported artifact path', () => {
    const artifactPath = path.resolve('C:\\Users\\Tester\\ClaudeDock\\auth\\codex-user.json');
    expect(
      parseManagedGatewayLoginArtifactPath(
        `Authentication saved to ${artifactPath}\nCodex authentication successful!\n`,
      ),
    ).toBe(artifactPath);
    expect(
      parseManagedGatewayLoginArtifactPath(
        `Authentication saved to ${artifactPath}\nCodex authentication successful\n`,
      ),
    ).toBeUndefined();
    expect(
      parseManagedGatewayLoginArtifactPath(
        'Authentication saved to codex-user.json\nCodex authentication successful!\n',
      ),
    ).toBeUndefined();
    expect(
      parseManagedGatewayLoginArtifactPath(
        `Authentication saved to ${artifactPath}\nAuthentication saved to ${artifactPath}\nCodex authentication successful!\n`,
      ),
    ).toBeUndefined();
    expect(
      parseManagedGatewayLoginArtifactPath(
        `Authentication saved to ${artifactPath}\nCodex authentication successful!\nfatal: credential registration failed\n`,
      ),
    ).toBeUndefined();
  });

  it('rejects an authorization directory redirected through a symlink or junction', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-auth-directory-owner-'));
    const managedRoot = path.join(root, 'managed');
    const redirectedRoot = path.join(root, 'redirected');
    const authDirectory = path.join(managedRoot, 'auth');
    mkdirSync(managedRoot);
    mkdirSync(redirectedRoot);
    writeFileSync(
      path.join(redirectedRoot, 'codex-redirected.json'),
      JSON.stringify(validCodexArtifact()),
      'utf8',
    );
    try {
      symlinkSync(redirectedRoot, authDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      expect(managedGatewayAuthenticationDirectoryIsOwned(authDirectory)).toBe(false);
      expect(inspectManagedGatewayAuthentication(authDirectory)).toBeUndefined();
      expect(
        inspectManagedGatewayCodexArtifact(
          authDirectory,
          path.join(authDirectory, 'codex-redirected.json'),
        ),
      ).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
