import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const managedQuotaAuth = (overrides: Record<string, unknown> = {}) => ({
  type: 'codex',
  disabled: false,
  email: 'managed@example.com',
  account_id: 'account-managed',
  access_token: 'managed-access-secret',
  refresh_token: 'managed-refresh-secret',
  id_token: 'managed-id-secret',
  expired: '2099-01-01T00:00:00Z',
  last_refresh: '2026-08-28T00:00:00Z',
  ...overrides,
});

export const createManagedQuotaFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudedock-quota-'));
  const userData = path.join(root, '用户 设置');
  const authDirectory = path.join(userData, 'managed-gateways', 'cliproxyapi', 'auth');
  const file = path.join(authDirectory, 'codex-owned.json');
  await mkdir(authDirectory, { recursive: true });
  const write = async (overrides: Record<string, unknown> = {}) => {
    await writeFile(file, JSON.stringify(managedQuotaAuth(overrides)));
  };
  await write();
  return { root, userData, authDirectory, file, write };
};

export const quotaPayload = () => ({
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_at: 2000000000 },
    secondary_window: { used_percent: 62.5, limit_window_seconds: 604800, reset_at: 2000600000 },
  },
});
