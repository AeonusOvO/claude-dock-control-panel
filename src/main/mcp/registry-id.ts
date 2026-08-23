import { createHash } from 'node:crypto';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const canonicalContent = (value: unknown, omitGeneratedIds: boolean): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Stable IDs require finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalContent(item, omitGeneratedIds));
    return `[${items.join(',')}]`;
  }
  if (isRecord(value)) {
    const fields = Object.keys(value)
      .filter((key) => (!omitGeneratedIds || key !== 'id') && value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalContent(value[key], omitGeneratedIds)}`);
    return `{${fields.join(',')}}`;
  }
  throw new TypeError('Stable IDs require JSON-compatible canonical content.');
};

export const canonicalRegistryContent = (value: unknown, omitGeneratedIds = true): string =>
  canonicalContent(value, omitGeneratedIds);

export const registryContentDigest = (value: unknown): string =>
  createHash('sha256').update(canonicalContent(value, true)).digest('hex');

export const assignRegistryIds = <T extends object>(
  prefix: string,
  values: T[],
): (T & { id: string })[] => {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const digest = registryContentDigest(value);
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    return { ...value, id: `${prefix}:${digest}:${occurrence}` };
  });
};
