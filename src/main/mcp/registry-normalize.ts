import { isDeepStrictEqual } from 'node:util';
import { parsePackageAlternative, parseRemoteAlternative } from './registry-descriptors';
import { registryError } from './registry-errors';
import { assignRegistryIds, canonicalRegistryContent } from './registry-id';
import {
  assertRegistryKeys,
  cloneRegistryJsonObject,
  optionalRegistryArray,
  optionalRegistryBoolean,
  optionalRegistryEnum,
  optionalRegistryRecord,
  optionalRegistryString,
  requiredRegistryString,
  requireRegistryRecord,
} from './registry-parse';
import type {
  McpRegistryIcon,
  McpRegistryOfficialMetadata,
  McpRegistryRecord,
  McpRegistryRepository,
} from './registry-types';

const SERVER_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const ICON_SIZE = /^(?:\d+x\d+|any)$/;
const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';
const OFFICIAL_KEYS = new Set([
  'isLatest',
  'publishedAt',
  'status',
  'statusChangedAt',
  'statusMessage',
  'updatedAt',
]);
const ICON_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/svg+xml',
  'image/webp',
] as const;
const ICON_THEMES = ['dark', 'light'] as const;
const STATUSES = ['active', 'deleted', 'deprecated'] as const;

const malformed = (message: string, cause?: unknown): never => {
  throw registryError('normalize', 'malformed-record', message, cause);
};

const optionalTimestamp = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined => {
  const value = optionalRegistryString(record, key, label);
  if (value !== undefined && (!RFC3339.test(value) || Number.isNaN(Date.parse(value)))) {
    return malformed(`${label}.${key} must be an RFC3339 timestamp.`);
  }
  return value;
};

const parseOfficialMetadata = (
  wrapperMetadata: Record<string, unknown> | undefined,
): McpRegistryOfficialMetadata => {
  const value = wrapperMetadata?.[OFFICIAL_META_KEY];
  if (value === undefined) return {};
  const record = requireRegistryRecord(value, `wrapper._meta.${OFFICIAL_META_KEY}`);
  assertRegistryKeys(record, OFFICIAL_KEYS, `wrapper._meta.${OFFICIAL_META_KEY}`);
  const status = optionalRegistryEnum(record, 'status', 'official metadata', STATUSES);
  const statusMessage = optionalRegistryString(record, 'statusMessage', 'official metadata', {
    max: 500,
  });
  if (status === 'active' && statusMessage !== undefined) {
    return malformed('Active Registry records cannot carry a statusMessage.');
  }
  return {
    isLatest: optionalRegistryBoolean(record, 'isLatest', 'official metadata'),
    publishedAt: optionalTimestamp(record, 'publishedAt', 'official metadata'),
    status,
    statusChangedAt: optionalTimestamp(record, 'statusChangedAt', 'official metadata'),
    statusMessage,
    updatedAt: optionalTimestamp(record, 'updatedAt', 'official metadata'),
  };
};

const parseRegistryExtensions = (
  wrapperMetadata: Record<string, unknown> | undefined,
): { [key: string]: import('./registry-types').McpRegistryJsonValue } | undefined => {
  if (!wrapperMetadata) return undefined;
  const cloned = cloneRegistryJsonObject(wrapperMetadata);
  delete cloned[OFFICIAL_META_KEY];
  return Object.keys(cloned).length > 0 ? cloned : undefined;
};

const parseRepository = (server: Record<string, unknown>): McpRegistryRepository | undefined => {
  const value = optionalRegistryRecord(server, 'repository', 'server');
  if (!value) return undefined;
  return {
    id: optionalRegistryString(value, 'id', 'server.repository'),
    source: requiredRegistryString(value, 'source', 'server.repository', { min: 1 }),
    subfolder: optionalRegistryString(value, 'subfolder', 'server.repository'),
    url: requiredRegistryString(value, 'url', 'server.repository', { min: 1 }),
  };
};

const parseIcon = (value: unknown, index: number): McpRegistryIcon => {
  const label = `server.icons[${index}]`;
  const record = requireRegistryRecord(value, label);
  const sizes = optionalRegistryArray(record, 'sizes', label);
  if (
    sizes !== undefined &&
    sizes.some((size) => typeof size !== 'string' || !ICON_SIZE.test(size))
  ) {
    return malformed(`${label}.sizes is invalid.`);
  }
  return {
    mimeType: optionalRegistryEnum(record, 'mimeType', label, ICON_MIME_TYPES),
    sizes: sizes as string[] | undefined,
    src: requiredRegistryString(record, 'src', label, { max: 255, min: 1 }),
    theme: optionalRegistryEnum(record, 'theme', label, ICON_THEMES),
  };
};

const parseIcons = (server: Record<string, unknown>): McpRegistryIcon[] | undefined =>
  optionalRegistryArray(server, 'icons', 'server')?.map(parseIcon);

const parseServerRecord = (wrapperValue: unknown): McpRegistryRecord => {
  const wrapper = requireRegistryRecord(wrapperValue, 'Registry wrapper');
  const server = requireRegistryRecord(wrapper.server, 'Registry wrapper.server');
  const wrapperMetadata = optionalRegistryRecord(wrapper, '_meta', 'Registry wrapper');
  const name = requiredRegistryString(server, 'name', 'server', { max: 200, min: 3 });
  if (!SERVER_NAME.test(name)) return malformed('server.name is not canonical.');
  const version = requiredRegistryString(server, 'version', 'server', { max: 255, min: 1 });
  const packages = optionalRegistryArray(server, 'packages', 'server');
  const remotes = optionalRegistryArray(server, 'remotes', 'server');
  const catalogMetadata = optionalRegistryRecord(server, '_meta', 'server');
  return {
    catalogMetadata: catalogMetadata ? cloneRegistryJsonObject(catalogMetadata) : undefined,
    description: requiredRegistryString(server, 'description', 'server', { max: 100, min: 1 }),
    icons: parseIcons(server),
    identity: [name, version].join(String.fromCharCode(0)),
    name,
    official: parseOfficialMetadata(wrapperMetadata),
    packages:
      packages === undefined
        ? undefined
        : assignRegistryIds('package', packages.map(parsePackageAlternative)),
    registryExtensions: parseRegistryExtensions(wrapperMetadata),
    remotes:
      remotes === undefined
        ? undefined
        : assignRegistryIds('remote', remotes.map(parseRemoteAlternative)),
    repository: parseRepository(server),
    schemaUrl: optionalRegistryString(server, '$schema', 'server', { min: 1 }),
    title: optionalRegistryString(server, 'title', 'server', { max: 100, min: 1 }),
    version,
    websiteUrl: optionalRegistryString(server, 'websiteUrl', 'server', { min: 1 }),
  };
};

const canonicalWrapper = (value: unknown): string => {
  try {
    return canonicalRegistryContent(value, false);
  } catch (error) {
    return malformed('Registry wrapper contains non-JSON canonical content.', error);
  }
};

const compareIdentity = (left: McpRegistryRecord, right: McpRegistryRecord): number =>
  left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0;

const registryTimestamp = (value: string | undefined): number =>
  value === undefined ? Number.NEGATIVE_INFINITY : Date.parse(value);

const registryStatusRank = (record: McpRegistryRecord): number =>
  record.official.status === 'deleted' ? 2 : record.official.status === 'deprecated' ? 1 : 0;

const registryRevision = (record: McpRegistryRecord): readonly number[] => {
  const statusChangedAt = registryTimestamp(record.official.statusChangedAt);
  const updatedAt = registryTimestamp(record.official.updatedAt);
  return [Math.max(statusChangedAt, updatedAt), updatedAt, statusChangedAt];
};

const compareNumericTuples = (left: readonly number[], right: readonly number[]): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? Number.NEGATIVE_INFINITY;
    const rightValue = right[index] ?? Number.NEGATIVE_INFINITY;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
};

const sameRevisionContent = (left: McpRegistryRecord, right: McpRegistryRecord): boolean => {
  const { isLatest: omittedLeftLatest, ...leftOfficial } = left.official;
  const { isLatest: omittedRightLatest, ...rightOfficial } = right.official;
  void omittedLeftLatest;
  void omittedRightLatest;
  return isDeepStrictEqual(
    { ...left, official: leftOfficial },
    { ...right, official: rightOfficial },
  );
};

const mergeRegistryRecord = (
  previous: McpRegistryRecord,
  update: McpRegistryRecord,
): McpRegistryRecord => {
  const previousStatus = registryStatusRank(previous);
  const updateStatus = registryStatusRank(update);
  if (updateStatus < previousStatus) return previous;

  const previousRevision = registryRevision(previous);
  const updateRevision = registryRevision(update);
  const effectiveRevisionOrder = compareNumericTuples(
    updateRevision.slice(0, 1),
    previousRevision.slice(0, 1),
  );
  if (effectiveRevisionOrder < 0) return previous;
  if (effectiveRevisionOrder > 0) return update;
  if (updateStatus > previousStatus) return update;

  const revisionOrder = compareNumericTuples(updateRevision, previousRevision);
  if (revisionOrder < 0) return previous;
  if (revisionOrder > 0) return update;
  if (sameRevisionContent(previous, update)) return update;

  throw registryError(
    'normalize',
    'canonical-collision',
    `Registry identity ${update.identity} changed without an ordered revision.`,
  );
};

const narrowLatestCandidates = (
  candidates: readonly McpRegistryRecord[],
  value: (record: McpRegistryRecord) => number,
): McpRegistryRecord[] => {
  const maximum = Math.max(...candidates.map(value));
  return candidates.filter((record) => value(record) === maximum);
};

const selectLatestCandidate = (
  records: readonly McpRegistryRecord[],
): McpRegistryRecord | undefined => {
  const eligible = records.filter((record) => record.official.status !== 'deleted');
  if (eligible.length === 0) return undefined;
  const explicit = eligible.filter((record) => record.official.isLatest === true);
  let candidates = explicit.length > 0 ? explicit : eligible;
  if (candidates.length === 1) return candidates[0];

  candidates = narrowLatestCandidates(candidates, (record) =>
    registryTimestamp(record.official.publishedAt),
  );
  if (candidates.length === 1) return candidates[0];
  candidates = narrowLatestCandidates(candidates, registryStatusRank);
  if (candidates.length === 1) return candidates[0];
  candidates = narrowLatestCandidates(candidates, (record) => registryRevision(record)[0]!);
  return candidates.length === 1 ? candidates[0] : undefined;
};

export const mergeMcpRegistryRecords = (
  previous: readonly McpRegistryRecord[],
  updates: readonly McpRegistryRecord[],
): McpRegistryRecord[] => {
  const merged = new Map(previous.map((record) => [record.identity, record]));
  for (const update of updates) {
    const existing = merged.get(update.identity);
    merged.set(update.identity, existing ? mergeRegistryRecord(existing, update) : update);
  }
  return [...merged.values()].sort(compareIdentity);
};

export const reconcileMcpRegistryLatest = (
  records: readonly McpRegistryRecord[],
): McpRegistryRecord[] => {
  const grouped = new Map<string, McpRegistryRecord[]>();
  for (const record of records) {
    const siblings = grouped.get(record.name) ?? [];
    siblings.push(record);
    grouped.set(record.name, siblings);
  }

  const reconciled: McpRegistryRecord[] = [];
  for (const siblings of grouped.values()) {
    const latest = selectLatestCandidate(siblings);
    for (const record of siblings) {
      const isLatest = latest?.identity === record.identity;
      reconciled.push(
        record.official.isLatest === isLatest
          ? record
          : { ...record, official: { ...record.official, isLatest } },
      );
    }
  }
  return reconciled.sort(compareIdentity);
};

export const normalizeMcpRegistryPages = (
  pages: readonly (readonly unknown[])[],
): McpRegistryRecord[] => {
  const candidates = new Map<string, { canonical: string; record: McpRegistryRecord }>();
  for (const page of pages) {
    for (const wrapper of page) {
      const record = parseServerRecord(wrapper);
      const canonical = canonicalWrapper(wrapper);
      const existing = candidates.get(record.identity);
      if (existing && existing.canonical !== canonical) {
        throw registryError(
          'normalize',
          'canonical-collision',
          `Registry identity collision for ${record.identity}.`,
        );
      }
      if (!existing) candidates.set(record.identity, { canonical, record });
    }
  }
  return [...candidates.values()].map(({ record }) => record).sort(compareIdentity);
};
