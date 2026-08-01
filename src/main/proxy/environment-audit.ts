import type { ProxyAuditItem } from '../../shared/contracts';
import { PROXY_ENVIRONMENT_KEYS } from '../network-path-resolver';

const expectedZoneRegion = (countryCode?: string): 'america' | 'asia' | 'europe' | undefined => {
  if (!countryCode) {
    return undefined;
  }
  if (['CN', 'HK', 'JP', 'KR', 'MO', 'SG', 'TW'].includes(countryCode)) {
    return 'asia';
  }
  if (['CA', 'MX', 'US'].includes(countryCode)) {
    return 'america';
  }
  if (
    [
      'AT',
      'BE',
      'CH',
      'CZ',
      'DE',
      'DK',
      'ES',
      'FI',
      'FR',
      'GB',
      'IE',
      'IT',
      'NL',
      'NO',
      'PL',
      'PT',
      'SE',
    ].includes(countryCode)
  ) {
    return 'europe';
  }
  return undefined;
};

export interface EnvironmentAuditInput {
  builtInProxyUrl?: string;
  countryCode?: string;
  environment?: NodeJS.ProcessEnv;
  locale?: string;
  timeZone?: string;
  virtualInterfaces: string[];
}

export const evaluateEnvironment = (input: EnvironmentAuditInput): ProxyAuditItem[] => {
  const environment = input.environment ?? process.env;
  const proxyEntries = PROXY_ENVIRONMENT_KEYS.flatMap((key) => {
    const value = environment[key]?.trim();
    return value ? [`${key}=${value}`] : [];
  });
  const conflicts = proxyEntries.filter(
    (entry) => !input.builtInProxyUrl || !entry.endsWith(input.builtInProxyUrl),
  );
  const items: ProxyAuditItem[] = [
    {
      advice:
        conflicts.length > 0
          ? '移除冲突的外部代理变量，或确认它们不会覆盖 ClaudeDock 的本地 HTTP 入站。'
          : '无需调整；ClaudeDock 不会写入用户或系统级环境变量。',
      evidence: proxyEntries.length > 0 ? proxyEntries : ['未发现外部代理环境变量'],
      explanation:
        conflicts.length > 0
          ? '启动 ClaudeDock 前已经存在的代理变量可能让不同进程走不同链路。内置代理只在子进程 env 中覆盖，不使用 setx，也不修改注册表。'
          : '没有发现会与内置代理冲突的继承变量。',
      name: '代理环境变量残留',
      verdict: conflicts.length > 0 ? 'warning' : 'passed',
    },
    {
      advice:
        input.virtualInterfaces.length > 0
          ? '确认这些接口是否仍在接管默认路由；停用不用的 VPN/TUN 后重新体检。'
          : '切换 VPN、TUN、WSL 或容器网络后重新检测。',
      evidence:
        input.virtualInterfaces.length > 0
          ? input.virtualInterfaces
          : ['未发现已知 VPN / TUN / 覆盖网络 / 虚拟机接口'],
      explanation:
        input.virtualInterfaces.length > 0
          ? '虚拟接口意味着还有其他链路可能在 HTTP 代理之外接管流量；仅凭接口存在不能断言泄露。'
          : '当前没有发现已知类别的虚拟网络接口。',
      name: '虚拟网络接口',
      verdict: input.virtualInterfaces.length > 0 ? 'warning' : 'passed',
    },
  ];
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = input.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  const expected = expectedZoneRegion(input.countryCode);
  const actual = timeZone.split('/', 1)[0]?.toLowerCase();
  const mismatch = Boolean(expected && actual && expected !== actual);
  items.push({
    advice: mismatch
      ? '这是启发式提示；如业务允许，可让系统时区/语言与长期使用的出口地区保持一致。'
      : '无需仅为此项修改系统设置。',
    evidence: [
      `出口国家：${input.countryCode ?? '未知'}`,
      `系统时区：${timeZone}`,
      `系统语言：${locale}`,
    ],
    explanation: mismatch
      ? '系统时区与出口国家所属大区不一致，某些风控可能把它作为辅助信号；这不是网络泄露，也不是确定错误。'
      : '没有发现明显的时区大区不一致；该判据是启发式，不能证明环境一定安全。',
    name: '时区 / 语言一致性',
    verdict: mismatch ? 'warning' : 'passed',
  });
  items.push({
    advice: '如需要完全避免与 Anthropic 域名通信，应在接入前评估 Claude Code 官方行为与网络策略。',
    evidence: ['Claude Code 官方运行时可能访问 api.anthropic.com'],
    explanation:
      '即使 ANTHROPIC_BASE_URL 指向第三方，Claude Code 仍可能访问 api.anthropic.com 检查快速模式可用性与 WebFetch 域名安全。',
    name: 'Anthropic 官方域名访问',
    verdict: 'warning',
  });
  return items;
};
