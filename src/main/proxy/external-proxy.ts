import type { ProxyExternalEnvironmentView } from '../../shared/contracts';
import { runProcess } from '../windows-command';

interface ProcessEntry {
  Id?: unknown;
  ProcessName?: unknown;
}

export interface ExternalProxyEnvironmentInput {
  checkedAt?: number;
  externalProcesses: string[];
  resolvedSystemProxy?: string;
  virtualInterfaces: string[];
}

const PROCESS_QUERY = [
  "$pattern = '^(v2rayn|clash|clash-verge|clash-verge-service|verge-mihomo|mihomo|sing-box|nekoray|hiddify)$'",
  'Get-Process -ErrorAction SilentlyContinue |',
  'Where-Object { $_.ProcessName -match $pattern } |',
  'Select-Object Id,ProcessName | ConvertTo-Json -Compress',
].join(' ');

const safeResolvedProxy = (value: string | undefined): string | undefined => {
  const normalized = value
    ?.replace(/[\r\n\0]/g, ' ')
    .trim()
    .slice(0, 512);
  if (!normalized || normalized.toUpperCase() === 'DIRECT') return undefined;
  // `resolveProxy` normally returns "PROXY host:port; DIRECT". Drop anything that resembles inline
  // credentials before this reaches the renderer or an audit record.
  return /@|:\/\/[^\s;]*:[^\s;]*@/.test(normalized) ? '检测到已配置代理（地址已隐藏）' : normalized;
};

export const evaluateExternalProxyEnvironment = (
  input: ExternalProxyEnvironmentInput,
): ProxyExternalEnvironmentView => {
  const externalProcesses = [...new Set(input.externalProcesses.map((name) => name.trim()))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const virtualInterfaces = [...new Set(input.virtualInterfaces)].sort();
  const resolvedSystemProxy = safeResolvedProxy(input.resolvedSystemProxy);
  const tunnelActive = virtualInterfaces.includes('VPN / 隧道接口');
  if (tunnelActive) {
    return {
      advice:
        '建议先关闭外部软件的 TUN 模式，或确认后继续形成链式代理；ClaudeDock 不会代替你结束进程或改系统代理。',
      checkedAt: input.checkedAt ?? Date.now(),
      externalProcesses,
      mode: 'chain-risk',
      resolvedSystemProxy,
      summary: `检测到${externalProcesses.length > 0 ? ` ${externalProcesses.join('、')} 与` : ''} TUN/VPN 接口；随机本地端口不会冲突，但内置 Xray 的出口可能再次经过外部隧道，形成链式代理。`,
      virtualInterfaces,
    };
  }
  if (externalProcesses.length > 0 || resolvedSystemProxy) {
    return {
      advice:
        '可以并行：ClaudeDock 使用随机回环端口且只覆盖所选作用域，Windows 系统代理继续服务其他软件。',
      checkedAt: input.checkedAt ?? Date.now(),
      externalProcesses,
      mode: 'parallel-safe',
      resolvedSystemProxy,
      summary: `检测到外部代理${externalProcesses.length > 0 ? `（${externalProcesses.join('、')}）` : ''}，当前未发现 TUN 接管证据。`,
      virtualInterfaces,
    };
  }
  return {
    advice: '无需处理；启动内置代理不会修改 Windows 系统代理。',
    checkedAt: input.checkedAt ?? Date.now(),
    externalProcesses,
    mode: 'none',
    summary: '未检测到常见外部代理进程、显式系统代理或 TUN/VPN 接口。',
    virtualInterfaces,
  };
};

export const detectExternalProxyProcesses = async (): Promise<string[]> => {
  if (process.platform !== 'win32') return [];
  try {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = await runProcess(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY],
      environment,
      { maxBuffer: 128 * 1024, timeout: 5_000 },
    );
    if (!result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout) as ProcessEntry | ProcessEntry[];
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) =>
      typeof entry?.ProcessName === 'string' ? [entry.ProcessName] : [],
    );
  } catch {
    return [];
  }
};
