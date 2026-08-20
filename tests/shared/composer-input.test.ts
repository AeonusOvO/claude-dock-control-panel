import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTerminalSubmission,
  MAX_SUBMISSION_LENGTH,
  normalizePastedText,
  SUBMIT_DELAY_MS,
  writeTerminalSubmission,
} from '../../src/shared/conversation/composer-input';

describe('composer submissions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a single line as one command', () => {
    expect(buildTerminalSubmission('Get-ChildItem')).toEqual({
      body: 'Get-ChildItem',
      submit: '\r',
    });
  });

  it('keeps a multi-line prompt as ONE command using the PSReadLine newline', () => {
    // `\x0a` is what the Ctrl+j binding inserts; a `\r` here would run each line separately.
    expect(
      buildTerminalSubmission('请解释这段代码：\nfunction add(a, b) {\n  return a + b;\n}'),
    ).toEqual({
      body: '请解释这段代码：\x0afunction add(a, b) {\x0a  return a + b;\x0a}',
      submit: '\r',
    });
  });

  it('keeps the submitting return out of the body', () => {
    // Claude Code's TUI reads one large chunk as a paste and swallows a trailing return, so the
    // body must never carry it. Measured on 2.1.220: combined 0/3 submitted, split 3/3.
    const { body, submit } = buildTerminalSubmission('x'.repeat(200));
    expect(body).not.toContain('\r');
    expect(submit).toBe('\r');
  });

  it('waits between the two writes without making sending feel slow', () => {
    expect(SUBMIT_DELAY_MS).toBeGreaterThan(0);
    expect(SUBMIT_DELAY_MS).toBeLessThanOrEqual(100);
  });

  it('physically writes the body and return as two ordered PTY events', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const pending = writeTerminalSubmission(
      buildTerminalSubmission('/model claude-sonnet-4-6'),
      (data) => writes.push(data),
    );

    expect(writes).toEqual(['/model claude-sonnet-4-6']);
    await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS - 1);
    expect(writes).toEqual(['/model claude-sonnet-4-6']);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(true);
    expect(writes).toEqual(['/model claude-sonnet-4-6', '\r']);
  });

  it('drops a late return when the target session changed during the gap', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let active = true;
    const pending = writeTerminalSubmission(
      buildTerminalSubmission('/model claude-opus-4-7'),
      (data) => writes.push(data),
      () => active,
    );

    active = false;
    await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);

    await expect(pending).resolves.toBe(false);
    expect(writes).toEqual(['/model claude-opus-4-7']);
  });

  it('normalizes Windows and old-Mac line endings before splitting', () => {
    expect(buildTerminalSubmission('first\r\nsecond\rthird')).toEqual({
      body: 'first\x0asecond\x0athird',
      submit: '\r',
    });
  });

  it('drops trailing blank lines so a stray Enter does not add an empty continuation', () => {
    expect(buildTerminalSubmission('build\n\n\n')).toEqual({ body: 'build', submit: '\r' });
  });

  it('treats an empty composer as a bare Enter', () => {
    expect(buildTerminalSubmission('')).toEqual({ body: '', submit: '\r' });
    expect(buildTerminalSubmission('\n\n')).toEqual({ body: '', submit: '\r' });
  });

  it('preserves interior blank lines, which are meaningful inside a prompt', () => {
    expect(buildTerminalSubmission('段落一\n\n段落二')).toEqual({
      body: '段落一\x0a\x0a段落二',
      submit: '\r',
    });
  });

  it('refuses a paste large enough to jam the PTY', () => {
    expect(() => buildTerminalSubmission('x'.repeat(MAX_SUBMISSION_LENGTH + 1))).toThrow(
      '一次最多发送',
    );
    expect(buildTerminalSubmission('x'.repeat(MAX_SUBMISSION_LENGTH)).body).toHaveLength(
      MAX_SUBMISSION_LENGTH,
    );
  });

  it('normalizes pasted text for the textarea', () => {
    expect(normalizePastedText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});
