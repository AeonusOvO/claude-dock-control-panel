import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_AUTH_ARTIFACT_BYTES = 1024 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CODEX_AUTH_SUCCESS_MARKER = 'Codex authentication successful!';
const CODEX_AUTH_SAVED_PREFIX = 'Authentication saved to ';

export interface ManagedGatewayAuthenticationManifest {
  artifactCount: number;
  fingerprint: string;
  provider: 'openai-codex';
  validatedAt: number;
  version: 1;
}

export interface ManagedGatewayAuthenticationArtifact {
  changedAt: number;
  email?: string;
  filePath: string;
  size: number;
}

export interface ManagedGatewayAuthenticationInspection {
  artifacts: ManagedGatewayAuthenticationArtifact[];
  manifest: ManagedGatewayAuthenticationManifest;
}

export const managedGatewayPublicState = (
  inspection: ManagedGatewayAuthenticationInspection | undefined,
): { accountEmail?: string; authenticated: boolean } => {
  const accountEmail = inspection
    ? [...inspection.artifacts].sort((left, right) => right.changedAt - left.changedAt)[0]?.email
    : undefined;
  return {
    ...(accountEmail ? { accountEmail } : {}),
    authenticated: Boolean(inspection),
  };
};

export type ManagedGatewayAuthenticationCandidates = Map<
  string,
  Pick<ManagedGatewayAuthenticationArtifact, 'changedAt' | 'size'>
>;

export const managedGatewayAuthenticationCandidateKey = (candidatePath: string): string => {
  const resolved = path.resolve(candidatePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isRfc3339 = (value: unknown): value is string =>
  typeof value === 'string' && RFC3339.test(value) && Number.isFinite(Date.parse(value));

export const isManagedGatewayAuthenticationManifest = (
  value: unknown,
): value is ManagedGatewayAuthenticationManifest =>
  isRecord(value) &&
  value.version === 1 &&
  value.provider === 'openai-codex' &&
  Number.isInteger(value.artifactCount) &&
  (value.artifactCount as number) > 0 &&
  typeof value.fingerprint === 'string' &&
  /^[0-9a-f]{64}$/.test(value.fingerprint) &&
  typeof value.validatedAt === 'number' &&
  Number.isFinite(value.validatedAt) &&
  value.validatedAt > 0;

const isValidCodexPayload = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    value.type === 'codex' &&
    value.disabled === false &&
    isNonEmptyString(value.email) &&
    typeof value.account_id === 'string' &&
    isNonEmptyString(value.access_token) &&
    isNonEmptyString(value.refresh_token) &&
    isNonEmptyString(value.id_token) &&
    isRfc3339(value.expired) &&
    isRfc3339(value.last_refresh)
  );
};

export const managedGatewayAuthenticationDirectoryIsOwned = (authDirectory: string): boolean => {
  try {
    const resolvedDirectory = path.resolve(authDirectory);
    const resolvedParent = path.dirname(resolvedDirectory);
    const directory = lstatSync(resolvedDirectory);
    const parent = lstatSync(resolvedParent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !parent.isDirectory() ||
      parent.isSymbolicLink()
    ) {
      return false;
    }
    return (
      managedGatewayAuthenticationCandidateKey(path.dirname(realpathSync(resolvedDirectory))) ===
      managedGatewayAuthenticationCandidateKey(realpathSync(resolvedParent))
    );
  } catch {
    return false;
  }
};

const directOwnedArtifactPath = (
  authDirectory: string,
  candidatePath: string,
): string | undefined => {
  try {
    const resolvedDirectory = path.resolve(authDirectory);
    if (!managedGatewayAuthenticationDirectoryIsOwned(resolvedDirectory)) {
      return undefined;
    }
    const resolvedCandidate = path.resolve(candidatePath);
    if (
      managedGatewayAuthenticationCandidateKey(path.dirname(resolvedCandidate)) !==
        managedGatewayAuthenticationCandidateKey(resolvedDirectory) ||
      !/^codex-.+\.json$/i.test(path.basename(resolvedCandidate))
    ) {
      return undefined;
    }
    const candidate = lstatSync(resolvedCandidate);
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      return undefined;
    }
    const realDirectory = realpathSync(resolvedDirectory);
    const realCandidate = realpathSync(resolvedCandidate);
    if (
      managedGatewayAuthenticationCandidateKey(path.dirname(realCandidate)) !==
      managedGatewayAuthenticationCandidateKey(realDirectory)
    ) {
      return undefined;
    }
    return resolvedCandidate;
  } catch {
    return undefined;
  }
};

export const parseManagedGatewayLoginArtifactPath = (output: string): string | undefined => {
  const lines = output.split(/\r?\n/);
  while (lines.length > 0 && !lines.at(-1)?.trim()) {
    lines.pop();
  }
  const successIndices = lines
    .map((line, index) => (line === CODEX_AUTH_SUCCESS_MARKER ? index : -1))
    .filter((index) => index >= 0);
  const savedEntries = lines
    .map((line, index) => ({
      index,
      value: line.startsWith(CODEX_AUTH_SAVED_PREFIX)
        ? line.slice(CODEX_AUTH_SAVED_PREFIX.length).trim()
        : '',
    }))
    .filter(({ value }) => value.length > 0);
  if (
    successIndices.length !== 1 ||
    successIndices[0] !== lines.length - 1 ||
    savedEntries.length !== 1 ||
    successIndices[0]! <= savedEntries[0]!.index ||
    !path.isAbsolute(savedEntries[0]!.value)
  ) {
    return undefined;
  }
  return savedEntries[0]!.value;
};

export const snapshotManagedGatewayAuthenticationCandidates = (
  authDirectory: string,
): ManagedGatewayAuthenticationCandidates => {
  const candidates: ManagedGatewayAuthenticationCandidates = new Map();
  if (!managedGatewayAuthenticationDirectoryIsOwned(authDirectory)) {
    return candidates;
  }
  let candidateNames: string[];
  try {
    candidateNames = readdirSync(authDirectory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && !entry.isSymbolicLink() && /^codex-.+\.json$/i.test(entry.name),
      )
      .map((entry) => entry.name);
  } catch {
    return candidates;
  }
  for (const name of candidateNames) {
    const filePath = directOwnedArtifactPath(authDirectory, path.join(authDirectory, name));
    if (!filePath) continue;
    try {
      const stats = lstatSync(filePath);
      candidates.set(managedGatewayAuthenticationCandidateKey(filePath), {
        changedAt: Math.max(stats.ctimeMs, stats.mtimeMs),
        size: stats.size,
      });
    } catch {
      // A concurrent direct rewrite is handled by the post-login validation retry.
    }
  }
  return candidates;
};

export const inspectManagedGatewayCodexArtifact = (
  authDirectory: string,
  candidatePath: string,
): ManagedGatewayAuthenticationArtifact | undefined => {
  const filePath = directOwnedArtifactPath(authDirectory, candidatePath);
  if (!filePath) return undefined;
  try {
    const before = lstatSync(filePath);
    if (before.size <= 0 || before.size > MAX_AUTH_ARTIFACT_BYTES) {
      return undefined;
    }
    const payload = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const after = lstatSync(filePath);
    if (
      before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !isValidCodexPayload(payload)
    ) {
      return undefined;
    }
    return {
      changedAt: Math.max(after.ctimeMs, after.mtimeMs),
      email: (payload as { email: string }).email.trim().slice(0, 320),
      filePath,
      size: after.size,
    };
  } catch {
    return undefined;
  }
};

export const inspectManagedGatewayAuthentication = (
  authDirectory: string,
  now = Date.now(),
): ManagedGatewayAuthenticationInspection | undefined => {
  if (!managedGatewayAuthenticationDirectoryIsOwned(authDirectory)) {
    return undefined;
  }
  let candidateNames: string[];
  try {
    candidateNames = readdirSync(authDirectory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && !entry.isSymbolicLink() && /^codex-.+\.json$/i.test(entry.name),
      )
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  const artifacts = candidateNames
    .map((name) =>
      inspectManagedGatewayCodexArtifact(authDirectory, path.join(authDirectory, name)),
    )
    .filter((artifact): artifact is ManagedGatewayAuthenticationArtifact => artifact !== undefined);
  if (artifacts.length === 0) return undefined;

  const fingerprintMaterial = artifacts
    .map(({ changedAt, size }) => [Math.trunc(changedAt), size] as const)
    .sort(([leftChangedAt, leftSize], [rightChangedAt, rightSize]) =>
      leftChangedAt === rightChangedAt ? leftSize - rightSize : leftChangedAt - rightChangedAt,
    );
  return {
    artifacts,
    manifest: {
      artifactCount: artifacts.length,
      fingerprint: createHash('sha256').update(JSON.stringify(fingerprintMaterial)).digest('hex'),
      provider: 'openai-codex',
      validatedAt: now,
      version: 1,
    },
  };
};
