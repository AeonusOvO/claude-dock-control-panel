import type { ResourceUsageView } from '../../shared/contracts';

/** Main-only account fencing metadata. Neither field is copied into renderer snapshots. */
export interface ModelQuotaResult extends ResourceUsageView {
  accountKey?: string;
  clearPrevious?: boolean;
}
