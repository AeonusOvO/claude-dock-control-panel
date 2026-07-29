import { describe, expect, it } from 'vitest';
import { estimateChatUsage, estimateTextTokens } from '../src/shared/chat-usage';

describe('chat token usage fallback', () => {
  it('counts CJK more conservatively than Latin text', () => {
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(estimateTextTokens('你好世界')).toBe(4);
  });

  it('keeps input and active output separate for the live context indicator', () => {
    expect(
      estimateChatUsage(
        [
          { content: 'hello', role: 'user' },
          { content: 'world', role: 'assistant' },
        ],
        '你好',
      ),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 2,
      source: 'estimated',
      totalTokens: 14,
    });
  });

  it('counts only text blocks while keeping attachment messages in the per-message estimate', () => {
    expect(
      estimateChatUsage([
        {
          content: [
            {
              mediaType: 'image/png',
              source: {
                attachmentId: '8f9aa605-adb6-4e2b-a25a-607e14bad666',
                type: 'local',
              },
              type: 'image',
            },
            { text: '你好', type: 'text' },
          ],
          role: 'user',
        },
      ]),
    ).toMatchObject({ inputTokens: 6, outputTokens: 0, totalTokens: 6 });
  });
});
