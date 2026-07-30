import type { ClaudeEffortLevel, ClaudeEffortRequest } from './contracts';

/**
 * Everything `/effort` accepts, in ascending depth. `low`…`max` are model effort levels; `auto`
 * hands the choice back to the active model's default, and `ultracode` is a Claude Code setting
 * that sends `xhigh` and additionally has Claude orchestrate workflows.
 *
 * `persists` records what survives the session: `low`…`xhigh` are written to the effort setting
 * when chosen interactively, while `max` and `ultracode` apply to the current session only.
 */
export interface ClaudeEffortOption {
  detail: string;
  id: ClaudeEffortRequest;
  label: string;
  persists: boolean;
}

export const CLAUDE_EFFORT_OPTIONS: readonly ClaudeEffortOption[] = [
  {
    detail: '交回模型自己的默认档位，多数模型是「均衡」。',
    id: 'auto',
    label: '跟随模型默认',
    persists: true,
  },
  {
    detail: '最快最省，只适合短小、不吃智力的任务。',
    id: 'low',
    label: '最低',
    persists: true,
  },
  {
    detail: '省令牌，愿意用一点智力换成本。',
    id: 'medium',
    label: '较低',
    persists: true,
  },
  {
    detail: '令牌与智力的平衡点，绝大多数模型的默认档。',
    id: 'high',
    label: '均衡',
    persists: true,
  },
  {
    detail: '更深的推理，令牌开销也更高。',
    id: 'xhigh',
    label: '更深',
    persists: true,
  },
  {
    detail: '最深推理，难题可能更好，也可能想过头；只作用于本次会话。',
    id: 'max',
    label: '最深',
    persists: false,
  },
  {
    detail: 'Claude Code 自身设置：按最深档推理，并为较大任务编排工作流；只作用于本次会话。',
    id: 'ultracode',
    label: '最深 + 工作流',
    persists: false,
  },
];

/** The levels a model can actually report back through the status line. */
export const CLAUDE_EFFORT_LEVELS: ReadonlySet<ClaudeEffortLevel> = new Set<ClaudeEffortLevel>([
  'high',
  'low',
  'max',
  'medium',
  'xhigh',
]);

export const CLAUDE_EFFORT_REQUESTS: ReadonlySet<ClaudeEffortRequest> = new Set(
  CLAUDE_EFFORT_OPTIONS.map((option) => option.id),
);

/**
 * The API error for a request with thinking disabled explicitly permits `high` or below. `auto`
 * cannot be treated as safe because the active model may resolve it back to `xhigh` or `max`.
 */
export const isClaudeEffortSafeAfterThinkingDisabledError = (
  effort: ClaudeEffortRequest,
): boolean => effort === 'low' || effort === 'medium' || effort === 'high';

export const claudeEffortLabel = (effort?: ClaudeEffortRequest): string =>
  CLAUDE_EFFORT_OPTIONS.find((option) => option.id === effort)?.label ?? '—';
