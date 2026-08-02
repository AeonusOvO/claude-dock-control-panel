import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WindowsIpv6View } from '../shared/contracts';
import { runProcess } from './windows-command';

interface AdapterBinding {
  Enabled: boolean;
  Name: string;
}

interface ManagedState {
  adapters: string[];
  version: 1;
}

const QUERY =
  'Get-NetAdapterBinding -ComponentID ms_tcpip6 -ErrorAction Stop | Select-Object Name,Enabled | ConvertTo-Json -Compress';
const ADAPTERS_ENV = 'CLAUDEDOCK_IPV6_ADAPTERS';
const PAYLOAD_ENV = 'CLAUDEDOCK_IPV6_PAYLOAD';

const powershellEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
};

const encodePowerShell = (source: string): string =>
  Buffer.from(source, 'utf16le').toString('base64');

export class WindowsIpv6Service {
  private readonly statePath: string;

  public constructor(userDataPath: string) {
    this.statePath = path.join(userDataPath, 'network', 'ipv6-managed.json');
  }

  public async getState(): Promise<WindowsIpv6View> {
    if (process.platform !== 'win32') {
      return {
        available: false,
        disabled: false,
        disabledAdapters: [],
        enabledAdapters: [],
        message: 'IPv6 网卡开关仅支持 Windows。',
      };
    }
    try {
      const result = await runProcess(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', QUERY],
        powershellEnvironment(),
        { maxBuffer: 256 * 1024, timeout: 10_000 },
      );
      const parsed = JSON.parse(result.stdout || '[]') as AdapterBinding | AdapterBinding[];
      const bindings = (Array.isArray(parsed) ? parsed : [parsed]).filter(
        (entry) => entry && typeof entry.Name === 'string' && typeof entry.Enabled === 'boolean',
      );
      const enabledAdapters = bindings.filter(({ Enabled }) => Enabled).map(({ Name }) => Name);
      const disabledAdapters = bindings.filter(({ Enabled }) => !Enabled).map(({ Name }) => Name);
      return {
        available: bindings.length > 0,
        disabled: bindings.length > 0 && enabledAdapters.length === 0,
        disabledAdapters,
        enabledAdapters,
        message:
          bindings.length === 0
            ? '未找到可管理的 IPv6 网卡绑定。'
            : enabledAdapters.length === 0
              ? 'IPv6 已在所有网卡绑定上禁用。'
              : `IPv6 当前在 ${enabledAdapters.length} 个网卡绑定上启用。`,
      };
    } catch (error) {
      return {
        available: false,
        disabled: false,
        disabledAdapters: [],
        enabledAdapters: [],
        message:
          error instanceof Error ? `无法读取 IPv6 状态：${error.message}` : '无法读取 IPv6 状态。',
      };
    }
  }

  public async setDisabled(disabled: boolean): Promise<WindowsIpv6View> {
    const current = await this.getState();
    if (!current.available) throw new Error(current.message);
    const managed = this.loadManaged();
    const adapters = disabled ? current.enabledAdapters : managed.adapters;
    const nextManagedAdapters = disabled
      ? [...new Set([...managed.adapters, ...current.enabledAdapters])]
      : [];
    if (adapters.length === 0) {
      if (disabled && current.disabled) return current;
      throw new Error('没有由 ClaudeDock 禁用且可安全恢复的 IPv6 网卡绑定。');
    }
    const verb = disabled ? 'Disable-NetAdapterBinding' : 'Enable-NetAdapterBinding';
    const payload = [
      `$names = ConvertFrom-Json $env:${ADAPTERS_ENV}`,
      `Get-NetAdapterBinding -ComponentID ms_tcpip6 -ErrorAction Stop | Where-Object { $names -contains $_.Name } | ${verb} -Confirm:$false -ErrorAction Stop`,
    ].join('; ');
    const environment = {
      ...powershellEnvironment(),
      [ADAPTERS_ENV]: JSON.stringify(adapters),
      [PAYLOAD_ENV]: encodePowerShell(payload),
    };
    const elevate = `$process = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$env:${PAYLOAD_ENV}) -Wait -PassThru; exit $process.ExitCode`;
    try {
      await runProcess(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', elevate],
        environment,
        { maxBuffer: 256 * 1024, timeout: 120_000 },
      );
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `IPv6 设置未完成；请确认已允许 Windows 管理员授权。${error.message}`
          : 'IPv6 设置未完成。',
        { cause: error },
      );
    }
    this.persistManaged({ adapters: nextManagedAdapters, version: 1 });
    return this.getState();
  }

  private loadManaged(): ManagedState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as ManagedState;
      return parsed.version === 1 && Array.isArray(parsed.adapters)
        ? { adapters: parsed.adapters.filter((entry) => typeof entry === 'string'), version: 1 }
        : { adapters: [], version: 1 };
    } catch {
      return { adapters: [], version: 1 };
    }
  }

  private persistManaged(state: ManagedState): void {
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.statePath);
  }
}
