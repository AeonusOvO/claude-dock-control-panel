import type {
  NetworkAdvisoryEvidenceAssessment,
  NetworkFeatureAccess,
  NetworkPathView,
  NetworkPreflightAction,
  NetworkPreflightResult,
  NetworkProbeResult,
  NetworkProviderConnectivityAssessment,
  NetworkRiskSignal,
} from '../../shared/contracts';
import { getProviderProfile } from '../../shared/router/provider-profiles';
import type { ConnectivityObservation } from './provider-connectivity-probe';

export type NetworkRiskDecision = Omit<
  NetworkPreflightResult,
  'action' | 'canonicalCwd' | 'configurationRevision' | 'generation' | 'mainRunId' | 'networkScope'
>;

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
  paths: NetworkPathView[],
  checkedAt: number,
): NetworkRiskSignal[] => {
  const signals: NetworkRiskSignal[] = [];
  const add = (
    ...args: Parameters<typeof addSignal> extends [unknown, unknown, ...infer Rest] ? Rest : never
  ): void => addSignal(signals, checkedAt, ...args);
  if (paths.length === 0) {
    add(
      'path-evidence-unavailable',
      '可见代理路径证据不可用',
      '本次未收集到应用或 CLI 的显式代理决策。该辅助证据缺失不覆盖已完成的提供商端点连接结果。',
      20,
      'warning',
      'medium',
      'local-network',
    );
  }
  const virtualInterfaces = new Set(paths.flatMap((path) => path.virtualInterfaces));
  if (virtualInterfaces.size > 0) {
    add(
      'virtual-interface-present',
      '检测到虚拟网络接口',
      `检测到 ${[...virtualInterfaces].join('、')}。这只是一条本机路径提示，不证明提供商端点经过或绕过该接口。`,
      8,
      'notice',
      'low',
      'local-network',
    );
  }
  if (
    paths.some((path) => path.globalIpv6Available) &&
    paths.some(
      (path) =>
        (path.process === 'application' ||
          path.process === 'claude-cli' ||
          path.process === 'codex-cli') &&
        path.proxyKind === 'direct',
    )
  ) {
    add(
      'global-ipv6-path-unconfirmed',
      '全局 IPv6 路径未确认',
      '本机存在可路由 IPv6，且至少一个相关进程未发现显式代理。DIRECT 只表示未发现 HTTP/SOCKS/PAC 代理；TUN、透明代理、软路由或目标分流仍可能接管。',
      6,
      'notice',
      'medium',
      'local-network',
    );
  }
  if (paths.some((path) => path.proxyConfigured)) {
    add(
      'proxy-present',
      '检测到显式代理配置',
      '应用或 CLI 路径配置了显式代理。代理存在本身不影响已通过的提供商端点结论。',
      8,
      'notice',
      'low',
      'local-network',
    );
  }
  const applicationPath = paths.find((path) => path.process === 'application');
  const cliPath = paths.find(
    (path) => path.process === (provider === 'anthropic-claude' ? 'claude-cli' : 'codex-cli'),
  );
  if (
    applicationPath &&
    cliPath &&
    applicationPath.proxyKind !== 'unknown' &&
    cliPath.proxyKind !== 'unknown' &&
    (applicationPath.proxyConfigured !== cliPath.proxyConfigured ||
      applicationPath.proxyKind !== cliPath.proxyKind)
  ) {
    add(
      'process-paths-differ',
      '应用与 CLI 的显式代理决策不同',
      'Electron 应用与目标 CLI 使用了不同的可见代理来源。该差异不证明两者的物理路由或公网地址不同，最终连接结论以各自提供商端点实测为准。',
      12,
      'notice',
      'high',
      'local-network',
    );
  }
  if (cliPath?.proxyKind === 'application-proxy') {
    add(
      'external-application-proxy',
      'CLI 使用 ClaudeDock 配置的代理',
      'CLI 使用用户明确填写的 HTTP 代理；ClaudeDock 只把它作为连接参数传给所选进程。',
      0,
      'info',
      'high',
      'application-proxy',
    );
  }
  if (paths.some((path) => path.proxyKind === 'unknown')) {
    add(
      'proxy-resolution-unknown',
      '显式代理解析状态未知',
      'Electron 未能读取显式系统代理解析结果；这不等于提供商端点不可达。',
      20,
      'warning',
      'medium',
      'local-network',
    );
  }
  if (paths.length > 0 && !paths.some((path) => path.ipv4Available || path.ipv6Available)) {
    add(
      'local-interface-offline',
      '本机接口观察未发现活动地址',
      '本机接口快照没有活动的非回环 IPv4 或 IPv6 地址。该快照是辅助证据，不能覆盖已完成的提供商端点连接结果。',
      70,
      'warning',
      'high',
      'local-network',
    );
  }
  return signals;
};

const providerTransportRiskSignals = (
  provider: NetworkPreflightResult['provider'],
  action: NetworkPreflightAction,
  paths: NetworkPathView[],
  checkedAt: number,
): NetworkRiskSignal[] => {
  const signals: NetworkRiskSignal[] = [];
  const claudeCliPath = paths.find((path) => path.process === 'claude-cli');
  if (
    provider === 'anthropic-claude' &&
    action === 'cli-launch' &&
    (claudeCliPath?.proxyKind === 'socks' || claudeCliPath?.proxyKind === 'socks5h')
  ) {
    addSignal(
      signals,
      checkedAt,
      'unsupported-cli-proxy',
      'Claude Code 不支持 SOCKS 代理',
      'Claude Code 官方仅支持 HTTP/HTTPS 代理；当前 CLI 显式配置指向 SOCKS。curl 端点探测可达不能证明 Claude Code 能使用该传输。',
      90,
      'critical',
      'high',
      'official-network-policy',
    );
  }
  return signals;
};

const probeRiskSignals = (probes: NetworkProbeResult[], checkedAt: number): NetworkRiskSignal[] => {
  const signals: NetworkRiskSignal[] = [];
  for (const probe of probes) {
    if (probe.status !== 'failed') continue;
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
  return signals;
};

const requiredProbeUnavailable = (probe: NetworkProbeResult): boolean =>
  probe.required &&
  (probe.status === 'failed' ||
    probe.status === 'unknown' ||
    probe.status === 'skipped' ||
    (probe.kind === 'websocket' && probe.status === 'warning'));

const featureAccessFor = (
  action: NetworkPreflightAction,
  endpointProbes: NetworkProbeResult[],
  compatibilityProbes: NetworkProbeResult[],
  transportSignals: NetworkRiskSignal[],
): NetworkFeatureAccess[] => {
  const unsupportedTransport = transportSignals.some(
    (signal) => signal.id === 'unsupported-cli-proxy',
  );
  const requiredEndpoints = endpointProbes.filter((probe) => probe.required);
  const incompatibleClient = compatibilityProbes.find(
    (probe) => probe.required && requiredProbeUnavailable(probe),
  );
  const allowed =
    requiredEndpoints.length > 0 &&
    !requiredEndpoints.some(requiredProbeUnavailable) &&
    !unsupportedTransport &&
    !incompatibleClient;
  return [
    {
      action,
      allowed,
      reason: allowed
        ? undefined
        : unsupportedTransport
          ? 'Claude Code 不能使用当前显式 SOCKS 代理；请改用 HTTP/HTTPS 代理或可用直连/TUN 路径。'
          : incompatibleClient
            ? `当前 CLI 兼容性检查未通过：${incompatibleClient.detail}`
            : requiredEndpoints.length === 0
              ? `${labelForAction(action)}没有可用的必需提供商端点证据。`
              : `${labelForAction(action)}所需的提供商端点能力未通过。`,
    },
  ];
};

const providerReasons = (signals: NetworkRiskSignal[], probes: NetworkProbeResult[]): string[] => {
  const recommendations = new Set<string>();
  for (const signal of signals) {
    if (signal.id === 'unsupported-cli-proxy') {
      recommendations.add('建议：为 Claude Code 改用受信任的 HTTP/HTTPS 代理或可用直连/TUN 路径。');
    } else if (signal.id.startsWith('tls-invalid:')) {
      recommendations.add('建议：核对系统时间、企业根 CA 和 TLS 检查策略，不要关闭证书校验。');
    } else if (
      signal.id.startsWith('unexpected-redirect:') ||
      signal.id.startsWith('captive-portal:')
    ) {
      recommendations.add('建议：先完成网络门户认证，再检查 DNS/防火墙是否改写提供商域名内容。');
    } else if (signal.id.startsWith('probe-failed:version:')) {
      recommendations.add('建议：通过官方发布渠道更新对应 CLI，再重新检测。');
    } else if (signal.id.startsWith('probe-failed:')) {
      recommendations.add('建议：按失败进程核对提供商域名白名单、DNS 和对应代理配置。');
    }
  }
  const incomplete = probes
    .filter(
      (probe) =>
        probe.required &&
        (probe.status === 'unknown' ||
          probe.status === 'skipped' ||
          (probe.kind === 'websocket' && probe.status === 'warning')),
    )
    .map((probe) => probe.detail);
  return [
    ...signals.filter((signal) => signal.severity !== 'info').map((signal) => signal.detail),
    ...incomplete,
    ...recommendations,
  ].slice(0, 12);
};

const providerConnectivityFor = (
  provider: NetworkPreflightResult['provider'],
  action: NetworkPreflightAction,
  observation: ConnectivityObservation,
  checkedAt: number,
): NetworkProviderConnectivityAssessment => {
  const profile = getProviderProfile(provider);
  const transportSignals = providerTransportRiskSignals(
    provider,
    action,
    observation.paths,
    checkedAt,
  );
  const endpointProbes = observation.probes.filter((probe) => probe.kind !== 'version');
  const compatibilityProbes = observation.probes.filter((probe) => probe.kind === 'version');
  const requiredEndpointProbes = endpointProbes.filter((probe) => probe.required);
  const signals = [...probeRiskSignals(endpointProbes, checkedAt), ...transportSignals];
  const featureAccess = featureAccessFor(
    action,
    endpointProbes,
    compatibilityProbes,
    transportSignals,
  );
  const unsupportedTransport = transportSignals.some(
    (signal) => signal.id === 'unsupported-cli-proxy',
  );
  const websocketUnavailable = endpointProbes.some(
    (probe) => probe.kind === 'websocket' && requiredProbeUnavailable(probe),
  );
  const nonWebsocketRequiredFailure = endpointProbes.some(
    (probe) => probe.kind !== 'websocket' && requiredProbeUnavailable(probe),
  );
  const optionalNotice = endpointProbes.some(
    (probe) => !probe.required && (probe.status === 'failed' || probe.status === 'warning'),
  );
  const requiredNotice = endpointProbes.some(
    (probe) => probe.required && probe.kind !== 'websocket' && probe.status === 'warning',
  );
  const status: NetworkProviderConnectivityAssessment['status'] =
    endpointProbes.length === 0 || requiredEndpointProbes.length === 0
      ? 'degraded'
      : unsupportedTransport || nonWebsocketRequiredFailure
        ? 'blocked'
        : websocketUnavailable
          ? 'partially_available'
          : optionalNotice || requiredNotice
            ? 'allowed_with_notice'
            : 'allowed';
  const reasons = providerReasons(signals, endpointProbes);
  const summary =
    status === 'blocked'
      ? unsupportedTransport
        ? `${profile.displayName} 的端点可由探测工具访问，但当前 Claude Code CLI 传输配置不可用。`
        : `${profile.displayName} 的${labelForAction(action)}所需端点连接未通过。`
      : status === 'partially_available'
        ? `${profile.displayName} 的基础端点可达，但当前动作所需的 WebSocket 能力未确认。`
        : status === 'degraded'
          ? `${profile.displayName} 的提供商端点证据不完整。`
          : status === 'allowed_with_notice'
            ? `${profile.displayName} 的必需端点可达，另有非阻断端点说明。`
            : `${profile.displayName} 的必需提供商端点连接正常。`;
  return { featureAccess, probes: observation.probes, reasons, signals, status, summary };
};

const advisoryEvidenceFor = (
  provider: NetworkPreflightResult['provider'],
  observation: ConnectivityObservation,
  checkedAt: number,
): NetworkAdvisoryEvidenceAssessment => {
  const signals = pathRiskSignals(provider, observation.paths, checkedAt);
  const environmentScore =
    observation.environment?.riskLevel === 'high'
      ? 80
      : observation.environment?.riskLevel === 'medium'
        ? 40
        : observation.environment?.riskLevel === 'unknown'
          ? 25
          : 0;
  const riskScore = Math.min(
    100,
    Math.max(
      environmentScore,
      signals.reduce((total, signal) => total + signal.score, 0),
    ),
  );
  const riskLevel: NetworkAdvisoryEvidenceAssessment['riskLevel'] =
    observation.environment?.riskLevel === 'high' || riskScore >= 75
      ? 'high'
      : observation.environment?.riskLevel === 'medium' || riskScore >= 35
        ? 'medium'
        : observation.paths.length === 0 ||
            observation.environment?.riskLevel === 'unknown' ||
            observation.environment?.evidenceStatus === 'partial' ||
            observation.environment?.evidenceStatus === 'unavailable'
          ? 'unknown'
          : 'low';
  const reasons = [
    ...signals.filter((signal) => signal.severity !== 'info').map((signal) => signal.detail),
    ...(observation.environment?.issues.map((issue) => issue.detail) ?? []),
  ].slice(0, 12);
  const pathSummary =
    observation.paths.length > 0
      ? '已收集显式代理与本机接口辅助证据；DIRECT 不证明物理直连。'
      : '本次未收集到应用或 CLI 的可见代理路径证据。';
  const summary = observation.environment
    ? `${pathSummary} 已收集目标限定的公网地址与环境辅助证据；这些信息不授予或拒绝提供商访问。${observation.environment.summary}`
    : `${pathSummary} 辅助证据不授予或拒绝提供商访问。`;
  return {
    ...(observation.environment ? { environment: observation.environment } : {}),
    paths: observation.paths,
    reasons,
    riskLevel,
    riskScore,
    signals,
    summary,
  };
};

const compatibilityStatus = (
  providerConnectivity: NetworkProviderConnectivityAssessment,
  advisoryEvidence: NetworkAdvisoryEvidenceAssessment,
): NetworkPreflightResult['status'] =>
  providerConnectivity.status === 'allowed' &&
  (advisoryEvidence.signals.length > 0 || advisoryEvidence.environment !== undefined)
    ? 'allowed_with_notice'
    : providerConnectivity.status;

export class RiskDecisionEngine {
  public evaluate(
    provider: NetworkPreflightResult['provider'],
    action: NetworkPreflightAction,
    observation: ConnectivityObservation,
    startedAt: number,
    checkedAt: number,
  ): NetworkRiskDecision {
    const profile = getProviderProfile(provider);
    const providerConnectivity = providerConnectivityFor(provider, action, observation, checkedAt);
    const advisoryEvidence = advisoryEvidenceFor(provider, observation, checkedAt);
    const status = compatibilityStatus(providerConnectivity, advisoryEvidence);
    return {
      advisoryEvidence,
      cacheExpiresAt: checkedAt + profile.cacheTtlMs,
      checkedAt,
      featureAccess: providerConnectivity.featureAccess,
      ...(observation.environment ? { environment: observation.environment } : {}),
      paths: advisoryEvidence.paths,
      probes: providerConnectivity.probes,
      provider,
      providerConnectivity,
      providerLabel: profile.displayName,
      reasons: providerConnectivity.reasons,
      riskLevel: advisoryEvidence.riskLevel,
      riskScore: advisoryEvidence.riskScore,
      schemaVersion: 2,
      signals: [...providerConnectivity.signals, ...advisoryEvidence.signals],
      startedAt,
      status,
      summary: providerConnectivity.summary,
    };
  }
}
