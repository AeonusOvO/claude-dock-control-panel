import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdvancedSettings, ChatIdleTimeoutMinutes } from '../../shared/contracts';

/**
 * Relay compatibility workarounds stay off by default. The independent network safety checks stay
 * on by default and only add advisory preflight work before a new session or provider login.
 */
const DEFAULT_SETTINGS: AdvancedSettings = {
  chatIdleTimeoutMinutes: 0,
  networkPreflight: {
    checkOnNewSession: true,
    checkOnProviderLogin: true,
  },
  webResearchIsolation: false,
};

const isChatIdleTimeoutMinutes = (value: unknown): value is ChatIdleTimeoutMinutes =>
  value === 0 || value === 5 || value === 10 || value === 30;

export class AdvancedSettingsStore {
  private readonly directory: string;
  private readonly storagePath: string;

  public constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'advanced');
    this.storagePath = path.join(this.directory, 'settings.json');
  }

  public get(): AdvancedSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        chatIdleTimeoutMinutes?: unknown;
        networkPreflight?: unknown;
        version?: unknown;
        webResearchIsolation?: unknown;
      };
      if (
        (parsed.version === 1 || parsed.version === 2) &&
        typeof parsed.webResearchIsolation === 'boolean'
      ) {
        const networkPreflight = normalizeNetworkPreflightPreferences(parsed.networkPreflight);
        return {
          chatIdleTimeoutMinutes: isChatIdleTimeoutMinutes(parsed.chatIdleTimeoutMinutes)
            ? parsed.chatIdleTimeoutMinutes
            : 0,
          networkPreflight,
          webResearchIsolation: parsed.webResearchIsolation,
        };
      }
    } catch {
      // Missing or malformed settings fall back to the documented defaults.
    }
    return { ...DEFAULT_SETTINGS, networkPreflight: { ...DEFAULT_SETTINGS.networkPreflight } };
  }

  public set(settings: AdvancedSettings): AdvancedSettings {
    if (
      !isChatIdleTimeoutMinutes(settings.chatIdleTimeoutMinutes) ||
      !isNetworkPreflightPreferences(settings.networkPreflight) ||
      typeof settings.webResearchIsolation !== 'boolean'
    ) {
      throw new Error('高级设置无效。');
    }
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ ...settings, version: 2 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.storagePath);
    return { ...settings, networkPreflight: { ...settings.networkPreflight } };
  }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 8 &&
  value.every((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 64) return false;
    try {
      return Intl.getCanonicalLocales(item).length === 1;
    } catch {
      return false;
    }
  });

const isTimezone = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  try {
    return Boolean(
      new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone,
    );
  } catch {
    return false;
  }
};

const isNetworkPreflightPreferences = (
  value: unknown,
): value is AdvancedSettings['networkPreflight'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.checkOnNewSession === 'boolean' &&
    typeof record.checkOnProviderLogin === 'boolean' &&
    (record.cliTimezone === undefined || isTimezone(record.cliTimezone)) &&
    (record.cliLanguages === undefined || isStringArray(record.cliLanguages))
  );
};

const normalizeNetworkPreflightPreferences = (
  value: unknown,
): AdvancedSettings['networkPreflight'] => {
  if (!isNetworkPreflightPreferences(value)) {
    return { ...DEFAULT_SETTINGS.networkPreflight };
  }
  return {
    checkOnNewSession: value.checkOnNewSession,
    checkOnProviderLogin: value.checkOnProviderLogin,
    ...(value.cliTimezone ? { cliTimezone: value.cliTimezone } : {}),
    ...(value.cliLanguages ? { cliLanguages: [...value.cliLanguages] } : {}),
  };
};

export const networkPreflightProcessEnvironment = (
  settings: AdvancedSettings,
): Record<string, string> => {
  const networkPreflight = settings.networkPreflight ?? DEFAULT_SETTINGS.networkPreflight;
  const primaryLanguage = networkPreflight.cliLanguages?.[0];
  const posixLocale = primaryLanguage ? `${primaryLanguage.replace('-', '_')}.UTF-8` : undefined;
  return {
    ...(networkPreflight.cliTimezone ? { TZ: networkPreflight.cliTimezone } : {}),
    ...(networkPreflight.cliLanguages
      ? {
          CLAUDEDOCK_APPLICATION_LANGUAGES: networkPreflight.cliLanguages.join(','),
          CLAUDEDOCK_REQUEST_LANGUAGES: networkPreflight.cliLanguages.join(','),
          ...(posixLocale ? { LANG: posixLocale, LC_ALL: posixLocale } : {}),
        }
      : {}),
  };
};
