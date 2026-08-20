import type {
  NetworkPreflightAction,
  NetworkPreflightResult,
  NetworkProviderId,
} from '../../shared/contracts';
import { NetworkPreflightService } from './preflight-service';

export class ProviderAccessBlockedError extends Error {
  public constructor(public readonly result: NetworkPreflightResult) {
    const recommendation = result.reasons.find((reason) => reason.startsWith('建议：'));
    super(
      `${result.summary}${result.reasons[0] ? ` ${result.reasons[0]}` : ''}${
        recommendation ? ` ${recommendation}` : ''
      } 请在网络预检详情中重新检查。`,
    );
    this.name = 'ProviderAccessBlockedError';
  }
}

export class ProviderAccessGuard {
  public constructor(private readonly service: NetworkPreflightService) {}

  public async assertAllowed(
    provider: NetworkProviderId,
    action: NetworkPreflightAction,
    cwd?: string,
  ): Promise<NetworkPreflightResult> {
    const result = await this.service.run({ action, cwd, provider });
    const access = result.featureAccess.find((candidate) => candidate.action === action);
    if (!access?.allowed || result.status === 'blocked') {
      throw new ProviderAccessBlockedError(result);
    }
    return result;
  }
}
