import { sanitizeAccountIdentity } from '../../shared/claude/account-identity';
import { record } from './http';

const tokenClaims = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string' || value.length > 16384) return {};
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return {};
  try {
    return record(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown);
  } catch {
    return {};
  }
};

/**
 * Only called with an official, consented authorization response. JWT claims are display metadata,
 * not authentication evidence; the actual route still has to pass the connection transaction.
 */
export const subscriptionAccountIdentity = (
  body: Record<string, unknown>,
  secrets: readonly (string | undefined)[] = [],
): string | undefined => {
  const values = [
    record(body.user),
    record(body.profile),
    record(body.user_info),
    body,
    tokenClaims(body.id_token),
    tokenClaims(body.access_token),
  ];
  const secretValues = [
    ...secrets,
    body.access_token,
    body.refresh_token,
    body.id_token,
    body.device_code,
    body.user_code,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const safe = (value: unknown): string | undefined => {
    const text = sanitizeAccountIdentity(value);
    return text && !secretValues.some((secret) => text.includes(secret)) ? text : undefined;
  };
  for (const key of ['email', 'preferred_username', 'name', 'nickname']) {
    for (const value of values) {
      const identity = safe(value[key]);
      if (identity) return identity;
    }
  }
  for (const key of ['user_id', 'userId', 'sub', 'UserID', 'SubjectID']) {
    for (const value of values) {
      const id = value[key];
      const identity = safe(typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id);
      if (identity && identity.length <= 156) return 'ID ' + identity;
    }
  }
  return undefined;
};
