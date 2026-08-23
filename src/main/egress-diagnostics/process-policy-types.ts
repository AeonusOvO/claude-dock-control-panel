export const EGRESS_PROCESS_POLICY_SCHEMA_VERSION = 1 as const;
export const EGRESS_PROCESS_POLICY_MAX_BYTES = 32 * 1024;
export const EGRESS_PROCESS_POLICY_MAX_LANGUAGES = 16;
export const EGRESS_PROCESS_POLICY_MAX_LANGUAGE_BYTES = 128;
export const EGRESS_PROCESS_POLICY_MAX_LANGUAGE_LIST_BYTES = 1_024;
export const EGRESS_PROCESS_POLICY_MAX_TIMEZONE_BYTES = 128;

export const EGRESS_WEB_RTC_HANDLING_VALUES = [
  'platform-default',
  'public-interface-only',
  'disable-non-proxied-udp',
] as const;

/**
 * Product-level WebRTC routing choices. They are inputs for future ClaudeDock-managed WebContents
 * only. None of these values changes, promises to change, or disguises the machine's public IP.
 */
export type EgressWebRtcHandling = (typeof EGRESS_WEB_RTC_HANDLING_VALUES)[number];

export const EGRESS_REPAIR_ACTIVATIONS = [
  'future-process-starts',
  'application-restart',
  'future-web-contents',
  'diagnostic-window-only',
] as const;

export type EgressRepairActivation = (typeof EGRESS_REPAIR_ACTIVATIONS)[number];

export type EgressInheritedSetting = Readonly<{ mode: 'inherit' }>;
export type EgressRemovedSetting = Readonly<{ mode: 'remove' }>;
export type EgressValueSetting<T> = Readonly<{ mode: 'set'; value: T }>;

/**
 * `inherit` leaves a future process input untouched. `remove` explicitly deletes the named input.
 * The distinction is retained so later environment composition never has to infer intent.
 */
export type EgressEnvironmentSetting<T> =
  EgressInheritedSetting | EgressRemovedSetting | EgressValueSetting<T>;

export type EgressWebRtcSetting = EgressInheritedSetting | EgressValueSetting<EgressWebRtcHandling>;

export interface EgressProcessPolicy {
  readonly applicationLanguages: EgressEnvironmentSetting<readonly string[]>;
  readonly requestLanguages: EgressEnvironmentSetting<readonly string[]>;
  readonly timezone: EgressEnvironmentSetting<string>;
  readonly version: typeof EGRESS_PROCESS_POLICY_SCHEMA_VERSION;
  readonly webRtc: EgressWebRtcSetting;
}

export type EgressEnvironmentPolicyEdit<T> =
  | Readonly<{ operation: 'inherit' }>
  | Readonly<{ operation: 'remove' }>
  | Readonly<{ operation: 'set'; value: T }>;

export type EgressWebRtcPolicyEdit =
  Readonly<{ operation: 'inherit' }> | Readonly<{ operation: 'set'; value: EgressWebRtcHandling }>;

/** Typed, field-level policy intent. No path, write list, environment map, or Electron switch exists. */
export interface EgressProcessPolicyEdits {
  readonly applicationLanguages?: EgressEnvironmentPolicyEdit<readonly string[]>;
  readonly requestLanguages?: EgressEnvironmentPolicyEdit<readonly string[]>;
  readonly timezone?: EgressEnvironmentPolicyEdit<string>;
  readonly webRtc?: EgressWebRtcPolicyEdit;
}

export type EgressProcessPolicyField =
  'timezone' | 'request-languages' | 'application-languages' | 'web-rtc';

export type EgressProcessPolicyFieldValue =
  | EgressEnvironmentSetting<string>
  | EgressEnvironmentSetting<readonly string[]>
  | EgressWebRtcSetting;

export interface EgressRepairChange {
  readonly activationRequirements: readonly EgressRepairActivation[];
  readonly after: EgressProcessPolicyFieldValue;
  readonly before: EgressProcessPolicyFieldValue;
  readonly field: EgressProcessPolicyField;
}

export interface EgressProcessEnvironmentDirective<T> {
  readonly input: 'TZ' | 'CLAUDEDOCK_REQUEST_LANGUAGES' | 'CLAUDEDOCK_APPLICATION_LANGUAGES';
  readonly mode: 'inherit' | 'remove' | 'set';
  readonly value?: T;
}

/** Closed environment-composition shape: only TZ and two ClaudeDock-owned language inputs exist. */
export interface EgressProcessEnvironmentPlan {
  readonly applicationLanguages: EgressProcessEnvironmentDirective<readonly string[]>;
  readonly requestLanguages: EgressProcessEnvironmentDirective<readonly string[]>;
  readonly timezone: EgressProcessEnvironmentDirective<string>;
}

export class EgressProcessPolicyValidationError extends Error {
  public constructor(message = '进程策略格式无效。') {
    super(message);
    this.name = 'EgressProcessPolicyValidationError';
  }
}

const freezeActivations = (
  ...values: EgressRepairActivation[]
): readonly EgressRepairActivation[] => Object.freeze(values);

const FIELD_ACTIVATIONS: Readonly<
  Record<EgressProcessPolicyField, readonly EgressRepairActivation[]>
> = Object.freeze({
  'application-languages': freezeActivations('application-restart', 'future-process-starts'),
  'request-languages': freezeActivations('diagnostic-window-only'),
  timezone: freezeActivations('future-process-starts'),
  'web-rtc': freezeActivations('future-web-contents'),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const boundedText = (value: unknown, maximumBytes: number, message: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    /[\0\r\n]/.test(value)
  ) {
    throw new EgressProcessPolicyValidationError(message);
  }
  return value;
};

export const normalizeEgressProcessTimezone = (value: unknown): string => {
  const timezone = boundedText(
    value,
    EGRESS_PROCESS_POLICY_MAX_TIMEZONE_BYTES,
    '进程时区必须是有效且长度受限的 IANA 标识。',
  );
  if (!/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(timezone)) {
    throw new EgressProcessPolicyValidationError('进程时区必须是有效的 IANA 标识。');
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions()
      .timeZone;
    if (
      !canonical ||
      Buffer.byteLength(canonical, 'utf8') > EGRESS_PROCESS_POLICY_MAX_TIMEZONE_BYTES
    ) {
      throw new Error('invalid timezone');
    }
    return canonical;
  } catch {
    throw new EgressProcessPolicyValidationError('进程时区必须是有效的 IANA 标识。');
  }
};

export const normalizeEgressProcessLanguages = (value: unknown): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > EGRESS_PROCESS_POLICY_MAX_LANGUAGES
  ) {
    throw new EgressProcessPolicyValidationError('语言列表数量无效。');
  }
  const canonical: string[] = [];
  let totalBytes = 0;
  for (const candidate of value) {
    const language = boundedText(
      candidate,
      EGRESS_PROCESS_POLICY_MAX_LANGUAGE_BYTES,
      '语言标识必须是长度受限的 BCP-47 标签。',
    );
    let normalized: string;
    try {
      const result = Intl.getCanonicalLocales(language);
      if (result.length !== 1 || !result[0]) throw new Error('invalid language');
      normalized = result[0];
    } catch {
      throw new EgressProcessPolicyValidationError('语言标识必须是有效的 BCP-47 标签。');
    }
    totalBytes += Buffer.byteLength(normalized, 'utf8');
    if (totalBytes > EGRESS_PROCESS_POLICY_MAX_LANGUAGE_LIST_BYTES) {
      throw new EgressProcessPolicyValidationError('语言列表超过大小上限。');
    }
    if (canonical.includes(normalized)) {
      throw new EgressProcessPolicyValidationError('语言列表不能包含重复标签。');
    }
    canonical.push(normalized);
  }
  return Object.freeze(canonical);
};

const normalizeEnvironmentSetting = <T>(
  value: unknown,
  normalizeValue: (candidate: unknown) => T,
): EgressEnvironmentSetting<T> => {
  if (!isRecord(value)) throw new EgressProcessPolicyValidationError();
  if (value.mode === 'inherit' && exactKeys(value, ['mode'])) {
    return Object.freeze({ mode: 'inherit' as const });
  }
  if (value.mode === 'remove' && exactKeys(value, ['mode'])) {
    return Object.freeze({ mode: 'remove' as const });
  }
  if (value.mode === 'set' && exactKeys(value, ['mode', 'value'])) {
    return Object.freeze({ mode: 'set' as const, value: normalizeValue(value.value) });
  }
  throw new EgressProcessPolicyValidationError();
};

const normalizeWebRtcSetting = (value: unknown): EgressWebRtcSetting => {
  if (!isRecord(value)) throw new EgressProcessPolicyValidationError();
  if (value.mode === 'inherit' && exactKeys(value, ['mode'])) {
    return Object.freeze({ mode: 'inherit' as const });
  }
  if (
    value.mode === 'set' &&
    exactKeys(value, ['mode', 'value']) &&
    typeof value.value === 'string' &&
    EGRESS_WEB_RTC_HANDLING_VALUES.includes(value.value as EgressWebRtcHandling)
  ) {
    return Object.freeze({ mode: 'set' as const, value: value.value as EgressWebRtcHandling });
  }
  throw new EgressProcessPolicyValidationError('WebRTC 处理方式无效。');
};

export const normalizeEgressProcessPolicy = (value: unknown): EgressProcessPolicy => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['applicationLanguages', 'requestLanguages', 'timezone', 'version', 'webRtc'])
  ) {
    throw new EgressProcessPolicyValidationError();
  }
  if (value.version !== EGRESS_PROCESS_POLICY_SCHEMA_VERSION) {
    throw new EgressProcessPolicyValidationError('进程策略版本不受支持。');
  }
  return Object.freeze({
    applicationLanguages: normalizeEnvironmentSetting(
      value.applicationLanguages,
      normalizeEgressProcessLanguages,
    ),
    requestLanguages: normalizeEnvironmentSetting(
      value.requestLanguages,
      normalizeEgressProcessLanguages,
    ),
    timezone: normalizeEnvironmentSetting(value.timezone, normalizeEgressProcessTimezone),
    version: EGRESS_PROCESS_POLICY_SCHEMA_VERSION,
    webRtc: normalizeWebRtcSetting(value.webRtc),
  });
};

export const defaultEgressProcessPolicy = (): EgressProcessPolicy =>
  normalizeEgressProcessPolicy({
    applicationLanguages: { mode: 'inherit' },
    requestLanguages: { mode: 'inherit' },
    timezone: { mode: 'inherit' },
    version: EGRESS_PROCESS_POLICY_SCHEMA_VERSION,
    webRtc: { mode: 'inherit' },
  });

export const cloneEgressProcessPolicy = (policy: EgressProcessPolicy): EgressProcessPolicy =>
  normalizeEgressProcessPolicy(structuredClone(policy));

export const serializeEgressProcessPolicyCanonical = (policy: EgressProcessPolicy): string =>
  JSON.stringify(normalizeEgressProcessPolicy(policy));

export const egressProcessPoliciesEqual = (
  first: EgressProcessPolicy,
  second: EgressProcessPolicy,
): boolean =>
  serializeEgressProcessPolicyCanonical(first) === serializeEgressProcessPolicyCanonical(second);

const normalizeEnvironmentEdit = <T>(
  value: unknown,
  normalizeValue: (candidate: unknown) => T,
): EgressEnvironmentPolicyEdit<T> => {
  if (!isRecord(value)) throw new EgressProcessPolicyValidationError('进程策略编辑无效。');
  if (value.operation === 'inherit' && exactKeys(value, ['operation'])) {
    return Object.freeze({ operation: 'inherit' as const });
  }
  if (value.operation === 'remove' && exactKeys(value, ['operation'])) {
    return Object.freeze({ operation: 'remove' as const });
  }
  if (value.operation === 'set' && exactKeys(value, ['operation', 'value'])) {
    return Object.freeze({ operation: 'set' as const, value: normalizeValue(value.value) });
  }
  throw new EgressProcessPolicyValidationError('进程策略编辑无效。');
};

export const normalizeEgressProcessPolicyEdits = (value: unknown): EgressProcessPolicyEdits => {
  if (!isRecord(value)) throw new EgressProcessPolicyValidationError('进程策略编辑无效。');
  const allowed = ['applicationLanguages', 'requestLanguages', 'timezone', 'webRtc'] as const;
  if (Object.keys(value).some((key) => !allowed.includes(key as (typeof allowed)[number]))) {
    throw new EgressProcessPolicyValidationError('进程策略编辑包含未知字段。');
  }
  const normalized: EgressProcessPolicyEdits = {
    ...(value.applicationLanguages === undefined
      ? {}
      : {
          applicationLanguages: normalizeEnvironmentEdit(
            value.applicationLanguages,
            normalizeEgressProcessLanguages,
          ),
        }),
    ...(value.requestLanguages === undefined
      ? {}
      : {
          requestLanguages: normalizeEnvironmentEdit(
            value.requestLanguages,
            normalizeEgressProcessLanguages,
          ),
        }),
    ...(value.timezone === undefined
      ? {}
      : { timezone: normalizeEnvironmentEdit(value.timezone, normalizeEgressProcessTimezone) }),
    ...(value.webRtc === undefined ? {} : { webRtc: normalizeWebRtcEdit(value.webRtc) }),
  };
  return Object.freeze(normalized);
};

const normalizeWebRtcEdit = (value: unknown): EgressWebRtcPolicyEdit => {
  if (!isRecord(value)) throw new EgressProcessPolicyValidationError('WebRTC 策略编辑无效。');
  if (value.operation === 'inherit' && exactKeys(value, ['operation'])) {
    return Object.freeze({ operation: 'inherit' as const });
  }
  if (
    value.operation === 'set' &&
    exactKeys(value, ['operation', 'value']) &&
    typeof value.value === 'string' &&
    EGRESS_WEB_RTC_HANDLING_VALUES.includes(value.value as EgressWebRtcHandling)
  ) {
    return Object.freeze({
      operation: 'set' as const,
      value: value.value as EgressWebRtcHandling,
    });
  }
  throw new EgressProcessPolicyValidationError('WebRTC 策略编辑无效。');
};

const settingFromEnvironmentEdit = <T>(
  edit: EgressEnvironmentPolicyEdit<T>,
): EgressEnvironmentSetting<T> => {
  if (edit.operation === 'set') return Object.freeze({ mode: 'set' as const, value: edit.value });
  return Object.freeze({ mode: edit.operation });
};

export const applyEgressProcessPolicyEdits = (
  current: EgressProcessPolicy,
  edits: EgressProcessPolicyEdits,
): EgressProcessPolicy => {
  const base = normalizeEgressProcessPolicy(current);
  const requested = normalizeEgressProcessPolicyEdits(edits);
  return normalizeEgressProcessPolicy({
    applicationLanguages: requested.applicationLanguages
      ? settingFromEnvironmentEdit(requested.applicationLanguages)
      : base.applicationLanguages,
    requestLanguages: requested.requestLanguages
      ? settingFromEnvironmentEdit(requested.requestLanguages)
      : base.requestLanguages,
    timezone: requested.timezone ? settingFromEnvironmentEdit(requested.timezone) : base.timezone,
    version: EGRESS_PROCESS_POLICY_SCHEMA_VERSION,
    webRtc: requested.webRtc
      ? requested.webRtc.operation === 'set'
        ? { mode: 'set', value: requested.webRtc.value }
        : { mode: 'inherit' }
      : base.webRtc,
  });
};

export const egressRepairActivationsForField = (
  field: EgressProcessPolicyField,
): readonly EgressRepairActivation[] => FIELD_ACTIVATIONS[field];

const environmentDirective = <T>(
  input: EgressProcessEnvironmentDirective<T>['input'],
  setting: EgressEnvironmentSetting<T>,
): EgressProcessEnvironmentDirective<T> =>
  Object.freeze(
    setting.mode === 'set'
      ? { input, mode: 'set' as const, value: setting.value }
      : { input, mode: setting.mode },
  );

export const buildEgressProcessEnvironmentPlan = (
  policy: EgressProcessPolicy,
): EgressProcessEnvironmentPlan => {
  const normalized = normalizeEgressProcessPolicy(policy);
  return Object.freeze({
    applicationLanguages: environmentDirective(
      'CLAUDEDOCK_APPLICATION_LANGUAGES',
      normalized.applicationLanguages,
    ),
    requestLanguages: environmentDirective(
      'CLAUDEDOCK_REQUEST_LANGUAGES',
      normalized.requestLanguages,
    ),
    timezone: environmentDirective('TZ', normalized.timezone),
  });
};
