import type {
  ConversationContentBlock,
  ConversationEvent,
  ConversationMessageView,
  ConversationSnapshot,
} from './native-conversation';

const cloneBlock = (block: ConversationContentBlock): ConversationContentBlock => ({ ...block });
const cloneMessage = (message: ConversationMessageView): ConversationMessageView => ({
  ...message,
  blocks: message.blocks.map(cloneBlock),
});

export const createConversationSnapshot = (
  event: Extract<ConversationEvent, { type: 'conversation.started' }>,
): ConversationSnapshot => ({
  commands: [],
  conversationId: event.conversationId,
  interactions: [],
  messages: [],
  ownerKind: event.ownerKind,
  phase: 'starting',
  projectPath: event.projectPath,
  revision: event.revision,
  runtime: event.runtime,
  sequence: event.sequence,
  tasks: [],
  usage: {},
});

/**
 * Reduces adapter events without guessing at missing frames. Sequence is authoritative inside one
 * adapter revision; a newer revision replaces control metadata atomically, while delayed events
 * from an older process generation are ignored.
 */
export const reduceConversationEvent = (
  current: ConversationSnapshot | undefined,
  event: ConversationEvent,
): ConversationSnapshot | undefined => {
  if (!current) {
    return event.type === 'conversation.started' ? createConversationSnapshot(event) : undefined;
  }
  if (
    current.runtime !== event.runtime ||
    current.conversationId !== event.conversationId ||
    current.projectPath !== event.projectPath ||
    event.revision < current.revision ||
    (event.revision === current.revision && event.sequence <= current.sequence)
  ) {
    return current;
  }

  const next: ConversationSnapshot = {
    ...current,
    interactions: [...current.interactions],
    messages: current.messages.map(cloneMessage),
    revision: event.revision,
    sequence: event.sequence,
    tasks: current.tasks.map((task) => ({ ...task })),
    usage: { ...current.usage },
  };

  switch (event.type) {
    case 'conversation.started':
      next.ownerKind = event.ownerKind;
      next.phase = 'starting';
      delete next.error;
      break;
    case 'conversation.phase':
      next.phase = event.phase;
      break;
    case 'message.upsert': {
      const index = next.messages.findIndex((message) => message.id === event.message.id);
      if (index >= 0) next.messages[index] = cloneMessage(event.message);
      else next.messages.push(cloneMessage(event.message));
      break;
    }
    case 'message.delta': {
      let message = next.messages.find((candidate) => candidate.id === event.messageId);
      if (!message) {
        message = {
          blocks: [],
          createdAt: event.emittedAt,
          id: event.messageId,
          role: 'assistant',
          status: 'streaming',
        };
        next.messages.push(message);
      }
      const block = message.blocks.find((candidate) => candidate.id === event.blockId);
      if (block && (block.type === 'text' || block.type === 'thinking')) {
        block.text += event.delta;
      } else {
        message.blocks.push({ id: event.blockId, text: event.delta, type: event.blockType });
      }
      break;
    }
    case 'tool.updated': {
      const message = next.messages.find((candidate) => candidate.id === event.messageId);
      if (!message) break;
      const index = message.blocks.findIndex((block) => block.id === event.block.id);
      if (index >= 0) message.blocks[index] = cloneBlock(event.block);
      else message.blocks.push(cloneBlock(event.block));
      break;
    }
    case 'interaction.requested':
      next.interactions = [
        ...next.interactions.filter(({ id }) => id !== event.interaction.id),
        { ...event.interaction },
      ];
      next.phase = 'requires-action';
      break;
    case 'interaction.resolved':
      next.interactions = next.interactions.filter(({ id }) => id !== event.interactionId);
      if (next.interactions.length === 0 && next.phase === 'requires-action')
        next.phase = 'running';
      break;
    case 'tasks.reconciled':
      next.tasks = event.tasks.map((task) => ({ ...task }));
      break;
    case 'usage.updated':
      next.usage = { ...next.usage, ...event.usage };
      break;
    case 'submission.transcript-confirmed':
      break;
    case 'capabilities.updated':
      if (!next.capabilities || event.capabilities.revision >= next.capabilities.revision) {
        next.capabilities = {
          ...event.capabilities,
          attachments: { ...event.capabilities.attachments },
          effort: { ...event.capabilities.effort, options: [...event.capabilities.effort.options] },
          fast: { ...event.capabilities.fast },
          permissionModes: [...event.capabilities.permissionModes],
        };
      }
      break;
    case 'commands.updated':
      next.commands = event.commands.map((command) => ({
        ...command,
        aliases: [...command.aliases],
      }));
      break;
    case 'conversation.error':
      next.error = event.message;
      next.phase = 'failed';
      break;
  }
  return next;
};
