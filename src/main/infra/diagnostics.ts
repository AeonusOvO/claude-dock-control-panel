import type { DiagnosticsQuery, DiagnosticsView } from '../../shared/contracts';
import type { ClaudeStreamDiagnosticsStore } from '../claude/stream-diagnostics-store';
import type { NetworkDiagnosticsStore } from '../network/diagnostics-store';
import type { RuntimeActivityRegistry } from '../runtime/activity-registry';
import type { Logger } from './logger';

export interface MainDiagnosticsSources {
  claudeStream: Pick<ClaudeStreamDiagnosticsStore, 'list'>;
  logger: Pick<Logger, 'query'>;
  network: Pick<NetworkDiagnosticsStore, 'getView'>;
  runtimeActivity: Pick<RuntimeActivityRegistry, 'list'>;
}

export class MainDiagnostics {
  public constructor(private readonly sources: MainDiagnosticsSources) {}

  public query(query: DiagnosticsQuery = {}): DiagnosticsView {
    return {
      claudeStreamFailures: this.sources.claudeStream.list(),
      logs: this.sources.logger.query(query),
      networkHistory: this.sources.network.getView(),
      runtimeActivities: this.sources.runtimeActivity.list(query.sessionId),
    };
  }
}
