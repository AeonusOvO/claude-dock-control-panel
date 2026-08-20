import type { ChatContentBlock, ChatMessage, ChatTokenUsage } from '../contracts';

/**
 * A deliberately conservative fallback for gateways that omit usage metadata. CJK characters tend
 * to occupy about one token each, while Latin text averages closer to four characters per token.
 * The UI labels this result as estimated; provider-reported usage always replaces it.
 */
export const estimateTextTokens = (value: string): number => {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) {
      asciiCharacters += 1;
    } else {
      nonAsciiCharacters += 1;
    }
  }
  return Math.max(0, Math.ceil(asciiCharacters / 4 + nonAsciiCharacters));
};

export const chatMessageText = (message: ChatMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter(
          (block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text',
        )
        .map((block) => block.text)
        .join('\n');

export const estimateChatUsage = (
  inputMessages: ChatMessage[],
  activeOutput = '',
): ChatTokenUsage => {
  const inputTokens = inputMessages.reduce(
    (total, message) => total + estimateTextTokens(chatMessageText(message)) + 4,
    0,
  );
  const outputTokens = estimateTextTokens(activeOutput);
  return {
    inputTokens,
    outputTokens,
    source: 'estimated',
    totalTokens: inputTokens + outputTokens,
  };
};
