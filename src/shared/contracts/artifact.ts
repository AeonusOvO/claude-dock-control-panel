export interface ArtifactNetworkLogEntry {
  artifactId: string;
  blocked: boolean;
  completedAt?: number;
  error?: string;
  id: string;
  method: string;
  /** Best-effort Content-Length; absent when Chromium cannot report a reliable size. */
  responseBytes?: number;
  startedAt: number;
  status?: number;
  url: string;
}

export interface ArtifactNetworkState {
  allowed: boolean;
  entries: ArtifactNetworkLogEntry[];
}

export interface ArtifactCreateResult {
  artifactId: string;
  url: string;
}
