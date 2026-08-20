import type {
  ConversationContentBlock,
  ConversationEvent,
  ConversationMessageView,
  ConversationSnapshot,
} from './native';

const cloneBlock = (block: ConversationContentBlock): ConversationContentBlock => ({ ...block });
const cloneMessage = (message: ConversationMessageView): ConversationMessageView => ({
  ...message,
  blocks: message.blocks.map(cloneBlock),
});

/**
 * Copy one message, bump its version, and swap it into a fresh array. Every other message keeps
 * its identity, so a token delta allocates two objects instead of one per message in the
 * transcript — the difference between O(1) and O(N) work per streamed token.
 */
const withMessage = (
  messages: ConversationMessageView[],
  index: number,
  mutate: (message: ConversationMessageView) => void,
): ConversationMessageView[] => {
  const next = [...messages];
  const message = cloneMessage(next[index]!);
  mutate(message);
  message.version = (message.version ?? 0) + 1;
  next[index] = message;
  return next;
};

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

  // Structural sharing on purpose: only the arrays and objects an event actually touches are
  // copied. Deep-cloning the transcript here ran once per streamed token and dominated both main
  // process CPU and the structured-clone cost of shipping the snapshot to the renderer.
  const next: ConversationSnapshot = {
    ...current,
    revision: event.revision,
    sequence: event.sequence,
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
      const incoming = cloneMessage(event.message);
      if (index >= 0) {
        incoming.version = (next.messages[index]?.version ?? 0) + 1;
        next.messages = [...next.messages];
        next.messages[index] = incoming;
      } else {
        incoming.version = 1;
        next.messages = [...next.messages, incoming];
      }
      break;
    }
    case 'message.delta': {
      const index = next.messages.findIndex((candidate) => candidate.id === event.messageId);
      if (index < 0) {
        next.messages = [
          ...next.messages,
          {
            blocks: [{ id: event.blockId, text: event.delta, type: event.blockType }],
            createdAt: event.emittedAt,
            id: event.messageId,
            role: 'assistant',
            status: 'streaming',
            version: 1,
          },
        ];
        break;
      }
      next.messages = withMessage(next.messages, index, (message) => {
        const blockIndex = message.blocks.findIndex((candidate) => candidate.id === event.blockId);
        const block = blockIndex >= 0 ? message.blocks[blockIndex] : undefined;
        if (block && (block.type === 'text' || block.type === 'thinking')) {
          message.blocks[blockIndex] = { ...block, text: block.text + event.delta };
        } else {
          message.blocks.push({ id: event.blockId, text: event.delta, type: event.blockType });
        }
      });
      break;
    }
    case 'tool.updated': {
      const index = next.messages.findIndex((candidate) => candidate.id === event.messageId);
      if (index < 0) break;
      next.messages = withMessage(next.messages, index, (message) => {
        const blockIndex = message.blocks.findIndex((block) => block.id === event.block.id);
        if (blockIndex >= 0) message.blocks[blockIndex] = cloneBlock(event.block);
        else message.blocks.push(cloneBlock(event.block));
      });
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
