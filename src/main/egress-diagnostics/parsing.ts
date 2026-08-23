export class EgressParseError extends Error {
  public constructor(message = 'The provider response did not match its documented shape.') {
    super(message);
    this.name = 'EgressParseError';
  }
}

export type UnknownRecord = Record<string, unknown>;

export const isUnknownRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseJsonObject = (bytes: Uint8Array): UnknownRecord => {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EgressParseError('The provider response was not valid UTF-8.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new EgressParseError('The provider response was not valid JSON.');
  }
  if (!isUnknownRecord(parsed)) {
    throw new EgressParseError();
  }
  return parsed;
};

export const hasOwn = (record: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

export const requiredObject = (record: UnknownRecord, key: string): UnknownRecord => {
  const value = record[key];
  if (!hasOwn(record, key) || !isUnknownRecord(value)) {
    throw new EgressParseError();
  }
  return value;
};

export const optionalObject = (record: UnknownRecord, key: string): UnknownRecord | undefined => {
  const value = record[key];
  if (!hasOwn(record, key) || value === null || value === undefined) return undefined;
  if (!isUnknownRecord(value)) throw new EgressParseError();
  return value;
};

export const requiredString = (
  record: UnknownRecord,
  key: string,
  maximumLength: number,
): string => {
  const value = record[key];
  if (
    !hasOwn(record, key) ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new EgressParseError();
  }
  return value;
};

export const optionalString = (
  record: UnknownRecord,
  key: string,
  maximumLength: number,
): string | undefined => {
  const value = record[key];
  if (!hasOwn(record, key) || value === null || value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new EgressParseError();
  }
  return value;
};

export const requiredBoolean = (record: UnknownRecord, key: string): boolean => {
  const value = record[key];
  if (!hasOwn(record, key) || typeof value !== 'boolean') {
    throw new EgressParseError();
  }
  return value;
};

export const optionalBoolean = (record: UnknownRecord, key: string): boolean | undefined => {
  const value = record[key];
  if (!hasOwn(record, key) || value === null || value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new EgressParseError();
  return value;
};

export const requiredInteger = (
  record: UnknownRecord,
  key: string,
  minimum: number,
  maximum: number,
): number => {
  const value = record[key];
  if (
    !hasOwn(record, key) ||
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new EgressParseError();
  }
  return value;
};

export const optionalInteger = (
  record: UnknownRecord,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined => {
  const value = record[key];
  if (!hasOwn(record, key) || value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new EgressParseError();
  }
  return value;
};

export const optionalNumber = (
  record: UnknownRecord,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined => {
  const value = record[key];
  if (!hasOwn(record, key) || value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new EgressParseError();
  }
  return value;
};

export const dateOnlyEpoch = (value: string): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const epochMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  return epochMs;
};

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export const isoTimestampEpoch = (value: string): number | undefined => {
  if (value.length > 35) return undefined;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match;
  const calendar = new Date(0);
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number((fraction ?? '').padEnd(3, '0'));
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second ||
    calendar.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }
  const offsetHours = zone === 'Z' ? 0 : Number(match[10]);
  const offsetMinutes = zone === 'Z' ? 0 : Number(match[11]);
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  const offsetSign = zone === 'Z' || match[9] === '+' ? 1 : -1;
  const epochMs = calendar.getTime() - offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return Number.isFinite(epochMs) ? epochMs : undefined;
};
