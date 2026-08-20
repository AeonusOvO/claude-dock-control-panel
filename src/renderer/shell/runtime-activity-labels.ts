import type { RuntimeActivitySnapshot, RuntimeTaskView } from '../../shared/contracts';
import type { ConversationSnapshot } from '../../shared/conversation/native';

export const RUNTIME_PHASE_LABELS: Record<RuntimeActivitySnapshot['phase'], string> = {
  'cli-idle': 'CLI 空闲',
  failed: '需要处理',
  'foreground-running': '前台响应中',
  resuming: '正在恢复对话',
  stopped: '已停止',
  'waiting-background': '等待后台唤醒',
};

export const runtimeTaskIsUnfinished = (task: RuntimeTaskView): boolean =>
  task.status === 'queued' || task.status === 'running' || task.status === 'waiting';

export type RuntimeSummaryIconKind =
  | 'background'
  | 'empty'
  | 'foreground'
  | 'interface'
  | 'model'
  | 'process'
  | 'project'
  | 'source'
  | 'subagent'
  | 'web'
  | 'workflow';

export const RUNTIME_SUMMARY_ICON_PATHS: Record<RuntimeSummaryIconKind, string[]> = {
  background: ['M12 4v8l5 3', 'M4.8 17.2a9 9 0 1 0 .3-10.7'],
  empty: ['M12 8v4', 'M12 16h.01', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'],
  foreground: ['M12 3a9 9 0 1 0 9 9', 'M12 7v5l3 2'],
  interface: ['M4 5h16v11H4z', 'M8 20h8', 'M12 16v4'],
  model: ['M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3', 'M8.5 8.5h7v7h-7z'],
  process: ['M4 5h16v14H4z', 'm7 10 2 2-2 2', 'M13 14h4'],
  project: ['M3.5 7h6l2 2h9v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z'],
  source: [
    'M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M7.7 6.1 16.3 17.9',
  ],
  subagent: [
    'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M16 13a2.5 2.5 0 1 0 0-5',
    'M3.5 20c.5-4 8.5-4 9 0',
    'M13 17c2.8-1.4 6.8-.5 7.5 2.5',
  ],
  web: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M3 12h18',
    'M12 3c2.5 2.4 3.7 5.4 3.7 9S14.5 18.6 12 21',
    'M12 3C9.5 5.4 8.3 8.4 8.3 12S9.5 18.6 12 21',
  ],
  workflow: [
    'M6 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M18 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M6 23a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M8 3h3a4 4 0 0 1 4 4v4',
    'M15 13v4a4 4 0 0 1-4 4H8',
  ],
};

export const RUNTIME_TASK_KIND_LABELS: Record<RuntimeTaskView['kind'], string> = {
  cron: '定时任务',
  mcp: 'MCP 任务',
  monitor: '监控任务',
  shell: '本地命令',
  subagent: '子智能体',
  teammate: '协作智能体',
  web: 'Web 任务',
  workflow: '工作流',
};

export const RUNTIME_TASK_STATUS_LABELS: Record<RuntimeTaskView['status'], string> = {
  completed: '已完成',
  failed: '失败',
  orphaned: '状态待确认',
  queued: '排队中',
  running: '运行中',
  waiting: '等待中',
};

export const NATIVE_TASK_KIND_LABELS: Record<
  ConversationSnapshot['tasks'][number]['kind'],
  string
> = {
  background: '后台任务',
  subagent: '子智能体',
  web: 'Web 任务',
  workflow: '工作流',
};

export const NATIVE_TASK_STATUS_LABELS: Record<
  ConversationSnapshot['tasks'][number]['status'],
  string
> = {
  completed: '已完成',
  failed: '失败',
  lost: '状态待确认',
  queued: '排队中',
  running: '运行中',
  stopped: '已停止',
  waiting: '等待中',
};

export const runtimeSummaryTaskIcon = (
  kind: RuntimeTaskView['kind'] | ConversationSnapshot['tasks'][number]['kind'],
): RuntimeSummaryIconKind => {
  if (kind === 'subagent' || kind === 'teammate') return 'subagent';
  if (kind === 'web') return 'web';
  if (kind === 'workflow') return 'workflow';
  return 'background';
};
