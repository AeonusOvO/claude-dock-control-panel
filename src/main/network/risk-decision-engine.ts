import type {
  NetworkFeatureAccess,
  NetworkPreflightAction,
  NetworkPreflightResult,
  NetworkRiskSignal,
} from '../../shared/contracts';
import { getProviderProfile } from '../../shared/router/provider-profiles';
import type { ConnectivityObservation } from './provider-connectivity-probe';

const ACTIONS: NetworkPreflightAction[] = [
  'background',
  'provider-switch',
  'login',
  'cli-launch',
  'first-request',
  'cloud-task',
];

const labelForAction = (action: NetworkPreflightAction): string => {
  switch (action) {
    case 'background':
      return '后台检查';
    case 'provider-switch':
      return '切换官方服务';
    case 'login':
      return '官方登录';
    case 'cli-launch':
      return '启动 CLI';
    case 'first-request':
      return '首次请求';
    case 'cloud-task':
      return '云端任务';
  }
};

const isTlsFailure = (detail: string): boolean => /TLS|证书|certificate|ssl/i.test(detail);
const isRedirectFailure = (detail: string): boolean => /重定向|redirect/i.test(detail);
const isCaptivePortalFailure = (detail: string): boolean =>
  /门户|劫持|captive|私有地址|DNS 重写/i.test(detail);

const addSignal = (
  signals: NetworkRiskSignal[],
  checkedAt: number,
  id: string,
  label: string,
  detail: string,
  score: number,
  severity: NetworkRiskSignal['severity'],
  confidence: NetworkRiskSignal['confidence'],
  source: string,
): void => {
  signals.push({
    confidence,
    detail,
    id,
    label,
    observedAt: checkedAt,
    score,
    severity,
    source,
  });
};

const pathRiskSignals = (
  provider: NetworkPreflightResult['provider'],
  observation: ConnectivityObservation,
  checkedAt: number,
): NetworkRiskSignal[] => {
  const signals: NetworkRiskSignal[] = [];
  const add = (
    ...args: Parameters<typeof addSignal> extends [unknown, unknown, ...infer Rest] ? Rest : never
  ): void => addSignal(signals, checkedAt, ...args);
  const virtualInterfaces = new Set(observation.paths.flatMap((path) => path.virtualInterfaces));
  if (virtualInterfaces.size > 0) {
    add(
      'virtual-interface-present',
      '检测到虚拟网络接口',
      `检测到 ${[...virtualInterfaces].join('、')}。这只是一条路径提示，不会单独阻止使用。`,
      8,
      'notice',
      'low',
      'local-network',
    );
  }
  if (
    observation.paths.some((path) => path.globalIpv6Available) &&
    observation.paths.some(
      (path) =>
        (path.process === 'application' ||
          path.process === 'claude-cli' ||
          path.process === 'codex-cli') &&
        !path.proxyConfigured,
    )
  ) {
    add(
      'global-ipv6-path-unconfirmed',
      '全局 IPv6 路径未确认',
      '本机存在可路由 IPv6，且至少一个模型相关进程未发现显式代理；TUN、透明代理或网关仍可能接管，但本机信息不能证明 IPv6 与预期代理使用同一路径。',
      6,
      'notice',
      'medium',
      'local-network',
    );
  }
  if (observation.paths.some((path) => path.proxyConfigured)) {
    add(
      'proxy-present',
      '检测到代理路径',
      '应用或 CLI 路径配置了代理。代理存在本身不是封锁条件。',
      8,
      'notice',
      'low',
      'local-network',
    );
  }
  const applicationPath = observation.paths.find((path) => path.process === 'application');
  const cliPath = observation.paths.find(
    (path) => path.process === (provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli'),
  );
  if (
    applicationPath &&
    cliPath &&
    (applicationPath.proxyConfigured !== cliPath.proxyConfigured ||
      applicationPath.proxyKind !== cliPath.proxyKind)
  ) {
    add(
      'process-paths-differ',
      '应用与 CLI 网络路径不一致',
      'Electron 应用与目标 CLI 使用了不同的代理来源；最终判定以各自实测结果为准。',
      12,
      'notice',
      'high',
      'local-network',
    );
  }
  if (provider === 'anthropic-claude' && cliPath?.proxyKind === 'socks') {
    add(
      'unsupported-cli-proxy',
      'Claude Code 不支持 SOCKS 代理',
      'Claude Code 官方仅支持 HTTP/HTTPS 代理；当前 CLI 环境指向 SOCKS。',
      90,
      'critical',
      'high',
      'official-network-policy',
    );
  }
  if (cliPath?.proxyKind === 'application-proxy') {
    add(
      'external-application-proxy',
      'CLI 使用外部应用代理',
      'CLI 使用用户明确填写的 HTTP 代理；ClaudeDock 只把它作为连接参数传给所选进程。',
      0,
      'info',
      'high',
      'application-proxy',
    );
  }
  if (observation.paths.some((path) => path.proxyKind === 'unknown')) {
    add(
      'proxy-resolution-unknown',
      '系统代理状态未知',
      'Electron 未能读取系统代理解析结果。',
      20,
      'warning',
      'medium',
      'local-network',
    );
  }
  if (observation.paths.every((path) => !path.ipv4Available && !path.ipv6Available)) {
    add(
      'offline',
      '未检测到可用网络',
      '当前没有活动的非回环 IPv4 或 IPv6 接口。',
      100,
      'critical',
      'high',
      'local-network',
    );
  }
  return signals;
};

const addProbeRiskSignals = (
  signals: NetworkRiskSignal[],
  observation: ConnectivityObservation,
  checkedAt: number,
): void => {
  for (const probe of observation.probes) {
    if (probe.status !== 'failed') {
      continue;
    }
    const tls = isTlsFailure(probe.detail);
    const redirect = isRedirectFailure(probe.detail);
    const captivePortal = isCaptivePortalFailure(probe.detail);
    const critical = probe.required;
    addSignal(
      signals,
      checkedAt,
      tls
        ? `tls-invalid:${probe.id}`
        : redirect
          ? `unexpected-redirect:${probe.id}`
          : captivePortal
            ? `captive-portal:${probe.id}`
            : `probe-failed:${probe.id}`,
      `${probe.label}失败`,
      probe.detail,
      critical ? 90 : probe.kind === 'websocket' ? 45 : 35,
      critical ? 'critical' : 'warning',
      'high',
      probe.process,
    );
  }
};

const featureAccessFor = (
  profile: ReturnType<typeof getProviderProfile>,
  observation: ConnectivityObservation,
  signals: NetworkRiskSignal[],
): NetworkFeatureAccess[] =>
  ACTIONS.map((candidateAction) => {
    const requiredEndpointIds = new Set(
      profile.endpoints
        .filter((endpoint) => endpoint.requiredFor.includes(candidateAction))
        .map((endpoint) => endpoint.id),
    );
    const requiredFailure = observation.probes.some(
      (probe) =>
        probe.required &&
        (probe.status === 'failed' ||
          probe.status === 'unknown' ||
          probe.status === 'skipped' ||
          (probe.kind === 'websocket' && probe.status === 'warning')) &&
        (probe.id.startsWith('dns:') ||
          [...requiredEndpointIds].some((endpointId) => probe.id.endsWith(endpointId))),
    );
    const globalBlock = signals.some(
      (signal) =>
        signal.id === 'offline' ||
        signal.id === 'unsupported-cli-proxy' ||
        (signal.severity === 'critical' &&
          (signal.id.startsWith('tls-invalid:') || signal.id.startsWith('unexpected-redirect:'))),
    );
    const allowed = !requiredFailure && !globalBlock;
    return {
      action: candidateAction,
      allowed,
      reason: allowed ? undefined : `${labelForAction(candidateAction)}所需的官方网络路径未通过。`,
    };
  });

interface RiskStatusEvaluation {
  critical: boolean;
  status: NetworkPreflightResult['status'];
  websocketUnavailable: boolean;
}

const evaluateStatus = (
  action: NetworkPreflightAction,
  observation: ConnectivityObservation,
  signals: NetworkRiskSignal[],
  featureAccess: NetworkFeatureAccess[],
): RiskStatusEvaluation => {
  const selectedAccess = featureAccess.find((access) => access.action === action);
  const critical = signals.some((signal) => signal.severity === 'critical');
  const websocketUnavailable = observation.probes.some(
    (probe) => probe.kind === 'websocket' && probe.status !== 'passed',
  );
  const unknown = observation.probes.some(
    (probe) => probe.required && (probe.status === 'unknown' || probe.status === 'skipped'),
  );
  let status: NetworkPreflightResult['status'];
  if (!selectedAccess?.allowed || critical) {
    status = 'blocked';
  } else if (websocketUnavailable) {
    status = 'partially_available';
  } else if (unknown) {
    status = 'degraded';
  } else if (signals.some((signal) => signal.severity === 'warning')) {
    status = 'warning';
  } else if (signals.length > 0) {
    status = 'allowed_with_notice';
  } else {
    status = 'allowed';
  }
  return { critical, status, websocketUnavailable };
};

const reasonsFor = (signals: NetworkRiskSignal[], websocketUnavailable: boolean): string[] => {
  const recommendations = new Set<string>();
  for (const signal of signals) {
    if (signal.id === 'unsupported-cli-proxy') {
      recommendations.add('建议：为 Claude Code 改用受信任的 HTTP/HTTPS 代理或直连。');
    } else if (signal.id.startsWith('tls-invalid:')) {
      recommendations.add('建议：核对系统时间、企业根 CA 和 TLS 检查策略，不要关闭证书校验。');
    } else if (
      signal.id.startsWith('unexpected-redirect:') ||
      signal.id.startsWith('captive-portal:')
    ) {
      recommendations.add('建议：先完成网络门户认证，再检查 DNS/防火墙是否改写官方域名内容。');
    } else if (signal.id.startsWith('probe-failed:version:')) {
      recommendations.add('建议：通过官方发布渠道更新对应 CLI，再重新检测。');
    } else if (signal.id.startsWith('probe-failed:')) {
      recommendations.add('建议：按详情中的失败进程核对官方域名白名单、DNS 和对应代理路径。');
    }
  }
  if (websocketUnavailable) {
    recommendations.add('建议：允许 chatgpt.com 的 TCP 443 WebSocket Upgrade 与长连接。');
  }
  return [
    ...signals
      .filter((signal) => signal.severity !== 'info')
      .map((signal) => signal.detail)
      .slice(0, 8),
    ...recommendations,
  ].slice(0, 12);
};

export class RiskDecisionEngine {
  public evaluate(
    provider: NetworkPreflightResult['provider'],
    action: NetworkPreflightAction,
    observation: ConnectivityObservation,
    startedAt: number,
    checkedAt: number,
  ): NetworkPreflightResult {
    const profile = getProviderProfile(provider);
    const signals = pathRiskSignals(provider, observation, checkedAt);
    addProbeRiskSignals(signals, observation, checkedAt);
    const featureAccess = featureAccessFor(profile, observation, signals);
    const riskScore = Math.min(
      100,
      signals.reduce((total, signal) => total + signal.score, 0),
    );
    const { critical, status, websocketUnavailable } = evaluateStatus(
      action,
      observation,
      signals,
      featureAccess,
    );
    const reasons = reasonsFor(signals, websocketUnavailable);
    const summary =
      status === 'blocked'
        ? `${profile.displayName} 的${labelForAction(action)}已阻止。`
        : status === 'partially_available'
          ? `${profile.displayName} 基础连接可用，但云端 WebSocket 功能受限。`
          : status === 'degraded' || status === 'warning'
            ? `${profile.displayName} 可用，但有未确认的网络风险。`
            : `${profile.displayName} 官方网络预检通过。`;

    return {
      cacheExpiresAt: checkedAt + profile.cacheTtlMs,
      checkedAt,
      featureAccess,
      paths: observation.paths,
      probes: observation.probes,
      provider,
      providerLabel: profile.displayName,
      reasons,
      riskLevel: critical
        ? 'critical'
        : riskScore >= profile.riskThresholds.blocked
          ? 'high'
          : riskScore >= profile.riskThresholds.warning
            ? 'medium'
            : 'low',
      riskScore,
      signals,
      startedAt,
      status,
      summary,
    };
  }
}
