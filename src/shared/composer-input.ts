/**
 * Turns what the user typed in the HTML composer into the exact bytes PowerShell should receive.
 *
 * A multi-line prompt has to arrive as ONE command, not as one command per line. PSReadLine is
 * configured (see `terminal-session.ts`) so that `Ctrl+j` inserts a literal newline into the current
 * input buffer instead of submitting it, which is why every interior line break is sent as `\x0a`
 * and only the final submit is a carriage return.
 *
 * The body and that final carriage return are deliberately handed to the PTY as TWO separate
 * writes. Claude Code's TUI classifies a large single chunk as a bracketed paste and swallows a
 * carriage return sitting at its tail, so a prompt of a couple of hundred characters would land in
 * its input box and just sit there unsent. Measured against Claude Code 2.1.220: a 200-character
 * prompt sent as one `body + \r` chunk submitted 0/3 times, and 3/3 once the return was written on
 * its own. PowerShell is unaffected — a multi-line command still runs as one command either way.
 */
const NEWLINE_IN_BUFFER = '\x0a';
const SUBMIT = '\r';

/** Guards against a stray paste of megabytes of text jamming the PTY. */
export const MAX_SUBMISSION_LENGTH = 64_000;

/**
 * The two writes a submit is made of. `body` is empty when the composer was blank, which still
 * sends a bare `submit` so Enter behaves the way it does in a shell.
 */
export interface TerminalSubmission {
  body: string;
  submit: string;
}

export const buildTerminalSubmission = (text: string): TerminalSubmission => {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (normalized.length === 0) {
    return { body: '', submit: SUBMIT };
  }
  if (normalized.length > MAX_SUBMISSION_LENGTH) {
    throw new Error(
      `一次最多发送 ${MAX_SUBMISSION_LENGTH.toLocaleString('zh-CN')} 个字符；请拆分后再发送。`,
    );
  }
  return {
    body: normalized.split('\n').join(NEWLINE_IN_BUFFER),
    submit: SUBMIT,
  };
};

/**
 * How long to wait between the body and the return. Long enough for the TUI to finish treating the
 * body as a paste, short enough that sending still feels instant.
 */
export const SUBMIT_DELAY_MS = 40;

/** Text dropped straight into the composer, with the line endings the textarea expects. */
export const normalizePastedText = (text: string): string => text.replace(/\r\n?/g, '\n');
