import {
  exactPluginIdentityKey,
  type PluginRecommendationTier,
  type PluginSourceKind,
} from './source-types';

export interface RecommendationSubject {
  canonicalPluginId: string;
  canonicalSourceId: string;
  sourceKind: PluginSourceKind;
}

export interface PluginRecommendation {
  rank?: number;
  reason?: string;
  tier: PluginRecommendationTier;
}

interface ProductRecommendation {
  rank: number;
  reason: string;
}

/**
 * Exact product-owned copy and ranking. Remote prose, labels, stars and download counts never enter
 * this table or the decision function.
 */
const EXACT_PRODUCT_RECOMMENDATIONS = new Map<string, ProductRecommendation>([
  [
    exactPluginIdentityKey('github:anthropics/claude-plugins-official', 'frontend-design'),
    {
      rank: 10,
      reason: 'ClaudeDock highlights this verified Anthropic marketplace entry for interface work.',
    },
  ],
  [
    exactPluginIdentityKey('bundled:claudedock/community-examples', 'community-workflow-example'),
    {
      rank: 100,
      reason: 'ClaudeDock bundles this inert community example for offline catalog presentation.',
    },
  ],
  [
    exactPluginIdentityKey('bundled:claudedock/demo', 'hello-claudedock'),
    {
      rank: 100,
      reason: 'ClaudeDock bundles this inert demo to explain plugin review and consent.',
    },
  ],
]);

const defaultRecommendation = (sourceKind: PluginSourceKind): PluginRecommendation => {
  switch (sourceKind) {
    case 'official':
      return {
        rank: 1_000,
        reason:
          'ClaudeDock verified the exact source as the Anthropic official plugin marketplace.',
        tier: 'official',
      };
    case 'community':
      return {
        rank: 2_000,
        reason:
          'ClaudeDock includes this app-owned community catalog record for offline discovery.',
        tier: 'community',
      };
    case 'demo':
      return {
        rank: 3_000,
        reason: 'ClaudeDock includes this app-owned inert demo record.',
        tier: 'demo',
      };
    case 'unknown':
    case 'user-marketplace':
      return { tier: 'none' };
  }
};

export const recommendPlugin = (subject: RecommendationSubject): PluginRecommendation => {
  const baseline = defaultRecommendation(subject.sourceKind);
  if (baseline.tier === 'none') {
    return baseline;
  }
  const exact = EXACT_PRODUCT_RECOMMENDATIONS.get(
    exactPluginIdentityKey(subject.canonicalSourceId, subject.canonicalPluginId),
  );
  return exact ? { ...exact, tier: baseline.tier } : baseline;
};
