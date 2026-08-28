/** Display-only account text; never accept token-shaped values or invisible control characters. */
export const sanitizeAccountIdentity = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (
    !text ||
    text.length > 160 ||
    /[\p{Cc}\p{Cf}]/u.test(text) ||
    /(?:^|\s)(?:bearer\s|sk[-_]|eyJ[a-zA-Z0-9_-]*\.)/i.test(text)
  )
    return undefined;
  return text;
};
