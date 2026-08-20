import type {
  ClaudeConnectionTestResult,
  ClaudeRouteHealth,
  ClaudeRouterManagementState,
} from '../../shared/contracts';
import type { NormalizedClaudeConfig } from './configuration';
import { routerBlockingDetail, usesDefaultClaudeRouter } from './runtime-connection';
import type { RuntimeSession } from './runtime-types';

/**
 * The router state is read through a callback because only the runtime owns the refresh cache, and
 * the two reads stay lazy so a healthy project never pays for a router probe it does not display.
 */
export const claudeRouteHealth = async (input: {
  config: NormalizedClaudeConfig;
  fingerprint: string;
  lastApiError: RuntimeSession['lastApiError'];
  launchedConfigFingerprint: string | undefined;
  matchingCheck: ClaudeConnectionTestResult | undefined;
  readRouterHealth: () => Promise<ClaudeRouterManagementState>;
}): Promise<ClaudeRouteHealth | undefined> => {
  const { config, fingerprint, lastApiError, launchedConfigFingerprint, matchingCheck } = input;

  if (usesDefaultClaudeRouter(config)) {
    const router = await input.readRouterHealth();
    const blockingDetail = routerBlockingDetail(config, router);
    if (blockingDetail) {
      return {
        blocking: true,
        checkedAt: router.checkedAt,
        detail: blockingDetail,
        headline: '当前路由器无法接收 Claude Code 请求',
        source: 'router',
        tone: 'error',
      };
    }
  }

  if (lastApiError && launchedConfigFingerprint === fingerprint) {
    const contextWindowExceeded = lastApiError.category === 'context-window-exceeded';
    return {
      blocking: false,
      checkedAt: lastApiError.detectedAt,
      detail: matchingCheck?.ok
        ? `${lastApiError.detail} 此配置此前的单令牌测试通过，但真实 Claude Code 会话随后失败；测试成功不代表端点会持续可用或完整支持 Claude Code。`
        : lastApiError.detail,
      headline: contextWindowExceeded
        ? '当前对话已超过上下文上限'
        : 'Claude Code 的真实对话请求失败',
      source: 'runtime',
      tone: 'error',
    };
  }

  if (matchingCheck) {
    return {
      blocking: matchingCheck.tone === 'error',
      checkedAt: matchingCheck.testedAt,
      detail: matchingCheck.message,
      headline:
        matchingCheck.tone === 'success'
          ? '当前配置已通过单令牌测试'
          : matchingCheck.tone === 'warning'
            ? '当前配置只通过了部分测试'
            : '当前配置的连接测试失败',
      source: 'connection-test',
      tone: matchingCheck.tone,
    };
  }

  if (usesDefaultClaudeRouter(config)) {
    const router = await input.readRouterHealth();
    return {
      blocking: false,
      checkedAt: router.checkedAt,
      detail: `CCR 模型网关正在运行，当前可见 ${router.providers.length} 个服务提供方。仍建议执行单令牌真实测试。`,
      headline: '当前路由器基础状态正常',
      source: 'router',
      tone: 'success',
    };
  }
  return undefined;
};
