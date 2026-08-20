import type { PtyGeneration } from './terminal';

export type RuntimeActivityPhase =
  'stopped' | 'cli-idle' | 'foreground-running' | 'waiting-background' | 'resuming' | 'failed';

export type RuntimeTaskKind =
  'subagent' | 'shell' | 'monitor' | 'workflow' | 'teammate' | 'mcp' | 'cron' | 'web';

export type RuntimeTaskStatus =
  'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'orphaned';

export type RuntimeTriState = boolean | 'unknown';

export interface RuntimeTaskView {
  agentType?: string;
  description: string;
  id: string;
  kind: RuntimeTaskKind;
  status: RuntimeTaskStatus;
  tokenUse: 'likely' | 'none' | 'unknown';
  updatedAt: number;
  willWakeParent: RuntimeTriState;
}

export interface RuntimeWebProcessView {
  commandSummary: string;
  exposureWarning?: string;
  name: string;
  pid: number;
  ports: number[];
  processKey: string;
  startedAt: number;
  status: 'running' | 'stopping';
  urls: Array<{ confirmed: boolean; url: string }>;
}

export interface RuntimeActivitySnapshot {
  launchGeneration: number;
  observedAt: number;
  phase: RuntimeActivityPhase;
  ptyGeneration: PtyGeneration;
  sessionId: string;
  subagentCount: number;
  tasks: RuntimeTaskView[];
  webProcesses: RuntimeWebProcessView[];
  willResumeConversation: RuntimeTriState;
}
