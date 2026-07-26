/**
 * Turns what the user typed in the HTML composer into the exact bytes PowerShell should receive.
 *
 * A multi-line prompt has to arrive as ONE command, not as one command per line. PSReadLine is
 * configured (see `terminal-session.ts`) so that `Ctrl+j` inserts a literal newline into the current
 * input buffer instead of submitting it, which is why every interior line break is sent as `\x0a`
 * and only the final submit is a carriage return.
 */
const NEWLINE_IN_BUFFER = '\x0a';
const SUBMIT = '\r';

/** Guards against a stray paste of megabytes of text jamming the PTY. */
export const MAX_SUBMISSION_LENGTH = 64_000;

export const buildTerminalSubmission = (text: string): string => {
  // A blank composer still sends a bare Enter, matching what pressing Enter in a shell does.
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (normalized.length === 0) {
    return SUBMIT;
  }
  if (normalized.length > MAX_SUBMISSION_LENGTH) {
    throw new Error(
      `一次最多发送 ${MAX_SUBMISSION_LENGTH.toLocaleString('zh-CN')} 个字符；请拆分后再发送。`,
    );
  }
  return `${normalized.split('\n').join(NEWLINE_IN_BUFFER)}${SUBMIT}`;
};

/** Text dropped straight into the composer, with the line endings the textarea expects. */
export const normalizePastedText = (text: string): string => text.replace(/\r\n?/g, '\n');
