import type { ClaudePermissionMode } from './contracts';

/**
 * Permission badges painted by Claude Code's TUI. The status-line JSON does not expose this value,
 * so callers read it from either a complete xterm viewport or a full raw repaint.
 */
const PERMISSION_MODE_BADGES: ReadonlyArray<readonly [RegExp, ClaudePermissionMode]> = [
  [/\bbypass\s+permissions\s+on\b/i, 'bypassPermissions'],
  [/\baccept\s+edits\s+on\b/i, 'acceptEdits'],
  [/\bdon'?t\s+ask\s+on\b/i, 'dontAsk'],
  [/\bauto\s+mode\s+on\b/i, 'auto'],
  [/\bplan\s+mode\s+on\b/i, 'plan'],
  [/\bmanual\s+mode\s+on\b/i, 'default'],
];

const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);

/**
 * ANSI CSI / OSC control sequences emitted by the terminal renderer. Assembled from character
 * codes so the source stays readable instead of a wall of escapes.
 */
const ANSI_SEQUENCE_PATTERN = new RegExp(
  [
    ESCAPE_CHARACTER,
    '(?:',
    // OSC: ESC ] ... BEL  or  ESC ] ... ESC \
    `\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
    '|',
    // CSI: ESC [ params intermediates final
    '\\[[0-?]*[ -/]*[@-~]',
    ')',
  ].join(''),
  'g',
);

/**
 * Reads the last complete badge in a terminal snapshot. Prefer an xterm viewport: Claude Code
 * often repaints only the changed cells, so stripping cursor movement from a raw delta can leave
 * fragments such as "ccept edits on" even though the visible screen contains the full badge.
 */
export const parseClaudePermissionMode = (snapshot: string): ClaudePermissionMode | undefined => {
  const plain = snapshot.replace(ANSI_SEQUENCE_PATTERN, '').replace(/\s+/g, ' ');

  let latest: ClaudePermissionMode | undefined;
  let latestIndex = -1;
  for (const [pattern, mode] of PERMISSION_MODE_BADGES) {
    const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
    let match: RegExpExecArray | null = globalPattern.exec(plain);
    while (match) {
      if (match.index > latestIndex) {
        latestIndex = match.index;
        latest = mode;
      }
      match = globalPattern.exec(plain);
    }
  }

  return latest;
};
