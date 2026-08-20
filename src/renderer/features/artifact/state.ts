import type { ArtifactNetworkState } from '../../../shared/contracts';

export interface ArtifactState {
  network: ArtifactNetworkState;
}

export const createArtifactState = (): ArtifactState => ({
  network: { allowed: true, entries: [] },
});
