import { describe, expect, it } from 'vitest';
import {
  buildTerminalSubmission,
  MAX_SUBMISSION_LENGTH,
  normalizePastedText,
} from '../src/shared/composer-input';

describe('composer submissions', () => {
  it('sends a single line as one command', () => {
    expect(buildTerminalSubmission('Get-ChildItem')).toBe('Get-ChildItem\r');
  });

  it('keeps a multi-line prompt as ONE command using the PSReadLine newline', () => {
    // `\x0a` is what the Ctrl+j binding inserts; a `\r` here would run each line separately.
    expect(buildTerminalSubmission('请解释这段代码：\nfunction add(a, b) {\n  return a + b;\n}')).toBe(
      '请解释这段代码：\x0afunction add(a, b) {\x0a  return a + b;\x0a}\r',
    );
  });

  it('normalizes Windows and old-Mac line endings before splitting', () => {
    expect(buildTerminalSubmission('first\r\nsecond\rthird')).toBe('first\x0asecond\x0athird\r');
  });

  it('drops trailing blank lines so a stray Enter does not add an empty continuation', () => {
    expect(buildTerminalSubmission('build\n\n\n')).toBe('build\r');
  });

  it('treats an empty composer as a bare Enter', () => {
    expect(buildTerminalSubmission('')).toBe('\r');
    expect(buildTerminalSubmission('\n\n')).toBe('\r');
  });

  it('preserves interior blank lines, which are meaningful inside a prompt', () => {
    expect(buildTerminalSubmission('段落一\n\n段落二')).toBe('段落一\x0a\x0a段落二\r');
  });

  it('refuses a paste large enough to jam the PTY', () => {
    expect(() => buildTerminalSubmission('x'.repeat(MAX_SUBMISSION_LENGTH + 1))).toThrow(
      '一次最多发送',
    );
    expect(buildTerminalSubmission('x'.repeat(MAX_SUBMISSION_LENGTH))).toHaveLength(
      MAX_SUBMISSION_LENGTH + 1,
    );
  });

  it('normalizes pasted text for the textarea', () => {
    expect(normalizePastedText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});
