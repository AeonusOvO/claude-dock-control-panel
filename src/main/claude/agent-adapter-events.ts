import { mergeRuntimeClaudeCommands } from '../../shared/claude/native-commands';
import type {
  ConversationContentBlock,
  ConversationTaskView,
} from '../../shared/conversation/native';
import type { AgentEventEmit, AgentSession } from './agent-adapter-types';
import {
  arrayValue,
  commandRecords,
  isRecord,
  stringValue,
  truncateToolOutput,
} from './agent-adapter-values';

const publishTasks = (session: AgentSession, emit: AgentEventEmit): void => {
  emit(session, { tasks: [...session.tasks.values()], type: 'tasks.reconciled' });
};

const consumeAssistant = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const message = isRecord(value.message) ? value.message : {};
  const streamLane = stringValue(value.parent_tool_use_id) ?? 'foreground';
  const messageId =
    session.assistantStreams.get(streamLane) ??
    stringValue(value.uuid) ??
    stringValue(message.id) ??
    `assistant-${session.revision}-${++session.assistantStreamSequence}`;
  const blocks: ConversationContentBlock[] = [];
  for (const [index, raw] of arrayValue(message.content).entries()) {
    if (!isRecord(raw)) continue;
    const type = stringValue(raw.type);
    const id = stringValue(raw.id) ?? `${messageId}:${index}`;
    if (type === 'text') {
      blocks.push({ id, text: stringValue(raw.text) ?? '', type: 'text' });
      continue;
    }
    if (type === 'thinking') {
      blocks.push({ id, text: stringValue(raw.thinking) ?? '', type: 'thinking' });
      continue;
    }
    if (type === 'tool_use' || type === 'server_tool_use') {
      const block: Extract<ConversationContentBlock, { type: 'tool' }> = {
        id,
        input: truncateToolOutput(raw.input),
        name: stringValue(raw.name) ?? 'unknown-tool',
        parentToolUseId: stringValue(value.parent_tool_use_id),
        status: 'running',
        type: 'tool',
      };
      session.tools.set(id, { block, messageId });
      blocks.push(block);
    }
  }
  emit(session, {
    message: {
      blocks,
      createdAt: Date.parse(stringValue(value.timestamp) ?? '') || Date.now(),
      id: messageId,
      parentToolUseId: stringValue(value.parent_tool_use_id),
      role: 'assistant',
      status: value.aborted === true ? 'aborted' : value.error ? 'failed' : 'complete',
    },
    type: 'message.upsert',
  });
  session.assistantStreams.delete(streamLane);
};

const consumeStreamEvent = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const event = isRecord(value.event) ? value.event : {};
  const streamLane = stringValue(value.parent_tool_use_id) ?? 'foreground';
  if (event.type === 'message_start') {
    const message = isRecord(event.message) ? event.message : {};
    session.assistantStreams.set(
      streamLane,
      stringValue(value.uuid) ??
        stringValue(message.id) ??
        `assistant-stream-${session.revision}-${++session.assistantStreamSequence}`,
    );
    return;
  }
  if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return;
  const index = typeof event.index === 'number' ? event.index : 0;
  const deltaType = stringValue(event.delta.type);
  const text =
    deltaType === 'text_delta'
      ? stringValue(event.delta.text)
      : deltaType === 'thinking_delta'
        ? stringValue(event.delta.thinking)
        : undefined;
  if (text === undefined) return;
  let messageId = session.assistantStreams.get(streamLane);
  if (!messageId) {
    messageId =
      stringValue(value.uuid) ??
      `assistant-stream-${session.revision}-${++session.assistantStreamSequence}`;
    session.assistantStreams.set(streamLane, messageId);
  }
  emit(session, {
    blockId: `${messageId}:${index}`,
    blockType: deltaType === 'thinking_delta' ? 'thinking' : 'text',
    delta: text,
    messageId,
    type: 'message.delta',
  });
};

const consumeToolResults = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const message = isRecord(value.message) ? value.message : {};
  for (const raw of arrayValue(message.content)) {
    if (!isRecord(raw) || raw.type !== 'tool_result') continue;
    const toolUseId = stringValue(raw.tool_use_id);
    const location = toolUseId ? session.tools.get(toolUseId) : undefined;
    if (!location) continue;
    const block = {
      ...location.block,
      output: truncateToolOutput(value.tool_use_result ?? raw.content),
      status: raw.is_error === true ? ('failed' as const) : ('succeeded' as const),
    };
    location.block = block;
    emit(session, { block, messageId: location.messageId, type: 'tool.updated' });
  }
};

const consumeToolProgress = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const toolUseId = stringValue(value.tool_use_id);
  const location = toolUseId ? session.tools.get(toolUseId) : undefined;
  if (!location) return;
  const elapsed = typeof value.elapsed_time_seconds === 'number' ? value.elapsed_time_seconds : 0;
  const block = {
    ...location.block,
    status: 'running' as const,
    summary: `已运行 ${elapsed.toFixed(1)} 秒`,
  };
  location.block = block;
  emit(session, { block, messageId: location.messageId, type: 'tool.updated' });
};

const consumeToolSummary = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const summary = stringValue(value.summary);
  if (!summary) return;
  for (const id of arrayValue(value.preceding_tool_use_ids)) {
    if (typeof id !== 'string') continue;
    const location = session.tools.get(id);
    if (!location) continue;
    const block = { ...location.block, summary };
    location.block = block;
    emit(session, { block, messageId: location.messageId, type: 'tool.updated' });
  }
};

const consumeResult = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  session.allowQuestionInteraction = false;
  const confirmedSubmissionId = stringValue(value.user_message_uuid);
  if (confirmedSubmissionId) {
    emit(session, {
      clientSubmissionId: confirmedSubmissionId,
      type: 'submission.transcript-confirmed',
    });
  }
  const usage = isRecord(value.usage) ? value.usage : {};
  emit(session, {
    type: 'usage.updated',
    usage: {
      costUsd: typeof value.total_cost_usd === 'number' ? value.total_cost_usd : undefined,
      durationMs: typeof value.duration_ms === 'number' ? value.duration_ms : undefined,
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
      timeToFirstTokenMs: typeof value.ttft_ms === 'number' ? value.ttft_ms : undefined,
    },
  });
  if (value.is_error === true) {
    const errors = arrayValue(value.errors).filter(
      (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate),
    );
    const detail = (errors[0] ?? stringValue(value.result) ?? 'Claude 未能完成本轮请求。').slice(
      0,
      4_000,
    );
    const messageId = `turn-error-${confirmedSubmissionId ?? stringValue(value.uuid) ?? session.sequence + 1}`;
    emit(session, {
      message: {
        blocks: [{ id: `${messageId}:0`, text: detail, type: 'text' }],
        createdAt: Date.now(),
        id: messageId,
        role: 'system',
        status: 'failed',
      },
      type: 'message.upsert',
    });
  }
  emit(session, {
    // An SDK result error belongs to this turn. The streaming process remains reusable, so return
    // to idle and let the user correct or retry instead of stranding a live session as failed.
    phase: 'idle',
    type: 'conversation.phase',
  });
};

const consumeTaskEdge = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const id = stringValue(value.task_id);
  if (!id) return;
  const existing = session.tasks.get(id);
  const patch = isRecord(value.patch) ? value.patch : {};
  const rawStatus = stringValue(patch.status);
  const status: ConversationTaskView['status'] =
    rawStatus === 'pending'
      ? 'queued'
      : rawStatus === 'completed'
        ? 'completed'
        : rawStatus === 'failed'
          ? 'failed'
          : rawStatus === 'killed'
            ? 'stopped'
            : rawStatus === 'paused'
              ? 'waiting'
              : 'running';
  session.tasks.set(id, {
    cancellable: !['completed', 'failed', 'stopped'].includes(status),
    description:
      stringValue(value.description) ??
      stringValue(patch.description) ??
      existing?.description ??
      '子智能体任务',
    id,
    kind: stringValue(value.task_type) === 'local_workflow' ? 'workflow' : 'subagent',
    status,
    summary: stringValue(value.summary),
    updatedAt: Date.now(),
  });
  publishTasks(session, emit);
};

const consumeTaskNotification = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const id = stringValue(value.task_id);
  if (!id) return;
  const existing = session.tasks.get(id);
  const rawStatus = stringValue(value.status);
  session.tasks.set(id, {
    cancellable: false,
    description: existing?.description ?? '后台任务',
    id,
    kind: existing?.kind ?? 'background',
    status:
      rawStatus === 'completed' ? 'completed' : rawStatus === 'stopped' ? 'stopped' : 'failed',
    summary: stringValue(value.summary),
    updatedAt: Date.now(),
  });
  publishTasks(session, emit);
};

const consumeSystem = (
  session: AgentSession,
  value: Record<string, unknown>,
  emit: AgentEventEmit,
): void => {
  const subtype = stringValue(value.subtype);
  if (subtype === 'session_state_changed') {
    const state = stringValue(value.state);
    const phase =
      state === 'idle'
        ? 'idle'
        : state === 'requires_action'
          ? 'requires-action'
          : state === 'running'
            ? 'running'
            : undefined;
    // Keep an unknown SDK state from clobbering a known idle/result snapshot into a permanently
    // busy phase. New SDK states must be explicitly mapped before they affect turn completion.
    if (phase) emit(session, { phase, type: 'conversation.phase' });
    return;
  }
  if (subtype === 'commands_changed') {
    session.commands = mergeRuntimeClaudeCommands(commandRecords(value.commands));
    emit(session, { commands: session.commands, type: 'commands.updated' });
    return;
  }
  if (subtype === 'background_tasks_changed') {
    const liveIds = new Set<string>();
    for (const raw of arrayValue(value.tasks)) {
      if (!isRecord(raw) || typeof raw.task_id !== 'string') continue;
      liveIds.add(raw.task_id);
      const existing = session.tasks.get(raw.task_id);
      session.tasks.set(raw.task_id, {
        cancellable: true,
        description: stringValue(raw.description) ?? existing?.description ?? '后台任务',
        id: raw.task_id,
        kind: stringValue(raw.task_type) === 'web' ? 'web' : 'background',
        status: 'running',
        updatedAt: Date.now(),
      });
    }
    for (const [id, task] of session.tasks) {
      if (!liveIds.has(id) && ['queued', 'running', 'waiting'].includes(task.status)) {
        session.tasks.set(id, { ...task, status: 'lost', updatedAt: Date.now() });
      }
    }
    publishTasks(session, emit);
    return;
  }
  if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated') {
    consumeTaskEdge(session, value, emit);
    return;
  }
  if (subtype === 'task_notification') consumeTaskNotification(session, value, emit);
};

export const consumeMessage = (
  session: AgentSession,
  value: unknown,
  emit: AgentEventEmit,
): void => {
  if (!isRecord(value)) return;
  const type = stringValue(value.type);
  if (type === 'assistant') consumeAssistant(session, value, emit);
  else if (type === 'user') consumeToolResults(session, value, emit);
  else if (type === 'stream_event') consumeStreamEvent(session, value, emit);
  else if (type === 'tool_progress') consumeToolProgress(session, value, emit);
  else if (type === 'result') consumeResult(session, value, emit);
  else if (type === 'system') consumeSystem(session, value, emit);
  else if (type === 'tool_use_summary') consumeToolSummary(session, value, emit);
};
