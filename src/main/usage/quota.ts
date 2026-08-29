import type { ResourceUsageView } from '../../shared/contracts';

/** Main-only quota coordination metadata. These fields are never copied into renderer snapshots. */
export interface ModelQuotaResult extends ResourceUsageView {
  accountKey?: string;
  clearPrevious?: boolean;
  retryWhenGatewayStable?: boolean;
}
