const nonChatModel = /(?:audio|embedding|image|moderation|realtime|speech|transcri|tts|whisper)/i;

/** One recommendation policy shared by gateway persistence and the model picker. */
export const recommendedChatModel = (models: readonly string[]): string => {
  if (models.length === 0) {
    throw new Error('网关没有返回可用模型。');
  }
  const preferred = ['gpt-5.6-sol', 'gpt-5.6', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'];
  return (
    preferred.find((candidate) => models.includes(candidate)) ??
    models.find((candidate) => !nonChatModel.test(candidate) && !/mini|nano/i.test(candidate)) ??
    models.find((candidate) => !nonChatModel.test(candidate)) ??
    models[0]!
  );
};

export const recommendedFastModel = (models: readonly string[], fallback: string): string =>
  models.find((candidate) => !nonChatModel.test(candidate) && /mini|nano|flash/i.test(candidate)) ??
  fallback;
