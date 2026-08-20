import {
  claudeModelIdsMatch,
  hasClaudeOneMillionContextSuffix,
  stripClaudeContextWindowSuffix,
} from '../../shared/claude/model-id';
import type { ConversationSubmitInput } from '../../shared/conversation/native';
import type { AgentSession } from './agent-adapter-types';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
export const arrayValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * A tool result stays in the block, so it is re-sent inside every later snapshot and re-serialized
 * by the renderer on every repaint of that message. One `Read` of a large file is otherwise enough
 * to make each subsequent frame megabytes of work, which is how long sessions used to freeze.
 * The transcript on disk keeps the full text; this cap only bounds what the UI carries.
 */
const TOOL_OUTPUT_CHARACTER_LIMIT = 32_000;

export const truncateToolOutput = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return value.length <= TOOL_OUTPUT_CHARACTER_LIMIT
      ? value
      : `${value.slice(0, TOOL_OUTPUT_CHARACTER_LIMIT)}\n…（已省略 ${
          value.length - TOOL_OUTPUT_CHARACTER_LIMIT
        } 个字符，完整内容见对话记录）`;
  }
  if (value === undefined || value === null || typeof value !== 'object') return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    return '（工具输出无法序列化）';
  }
  if (serialized.length <= TOOL_OUTPUT_CHARACTER_LIMIT) return value;
  return `${serialized.slice(0, TOOL_OUTPUT_CHARACTER_LIMIT)}\n…（已省略 ${
    serialized.length - TOOL_OUTPUT_CHARACTER_LIMIT
  } 个字符，完整内容见对话记录）`;
};

export const commandRecords = (
  value: unknown,
): Array<{
  aliases?: readonly string[];
  argumentHint?: string;
  description?: string;
  name: string;
}> =>
  arrayValue(value).flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return [];
    return [
      {
        aliases: Array.isArray(item.aliases)
          ? item.aliases.filter((alias): alias is string => typeof alias === 'string')
          : undefined,
        argumentHint: stringValue(item.argumentHint),
        description: stringValue(item.description),
        name: item.name,
      },
    ];
  });

export const normalizedPermissionMode = (value: string | undefined): string =>
  ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(value ?? '')
    ? value!
    : 'default';

// Upstream `dontAsk` denies AskUserQuestion before the SDK's canUseTool callback, even when the
// user explicitly asked for a choice card. ClaudeDock keeps the same deny-by-default policy in its
// callback while running the SDK permission engine in `default`, then makes a narrow exception for
// an explicitly requested structured question.
export const sdkPermissionMode = (value: string): string =>
  value === 'dontAsk' ? 'default' : value;

const EXPLICIT_QUESTION_REQUESTS = [
  /AskUserQuestion|(?:帮我|给我|让我|供我|我来).{0,16}(?:选择题|选项|选择|选)|(?:列出|展示|显示|生成|出).{0,12}(?:选择题|选项|方案).{0,12}(?:选择|选)?/iu,
  /\b(?:multiple[- ]choice|give me (?:some )?(?:options|choices)|let me choose|ask me (?:a |some )?questions?|present (?:me )?with (?:options|choices))\b/iu,
];
const EXPLICIT_QUESTION_REJECTIONS = [
  /(?:不要|不用|无需|别).{0,12}(?:选择题|选项|提问|问我|询问)/u,
  /\b(?:do not|don't|no need to).{0,24}(?:ask|options|choices|questions)\b/iu,
];

export const explicitlyRequestsQuestionInteraction = (input: ConversationSubmitInput): boolean =>
  input.blocks.some(
    (block) =>
      block.type === 'text' &&
      !EXPLICIT_QUESTION_REJECTIONS.some((pattern) => pattern.test(block.text)) &&
      EXPLICIT_QUESTION_REQUESTS.some((pattern) => pattern.test(block.text)),
  );

export const modelRecordMatches = (
  model: Record<string, unknown>,
  selectedModel: string | undefined,
): boolean => {
  if (!selectedModel) return false;
  return [stringValue(model.value), stringValue(model.resolvedModel)].some(
    (candidate) => candidate !== undefined && claudeModelIdsMatch(candidate, selectedModel),
  );
};

export const modelHasOneMillionContext = (model: string | undefined): boolean =>
  model !== undefined && hasClaudeOneMillionContextSuffix(model);

const runtimeAddsOneMillionContext = (session: AgentSession): boolean =>
  modelHasOneMillionContext(session.runtimeModel) &&
  !modelHasOneMillionContext(session.input.model);

export const canonicalModelForSession = (session: AgentSession, model: string): string =>
  runtimeAddsOneMillionContext(session) ? stripClaudeContextWindowSuffix(model) : model;
