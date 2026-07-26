/**
 * The composer's ↑/↓ history, kept as a plain data structure so its cursor rules are testable
 * without a DOM. Behaves like a shell history: newest first, duplicates of the previous entry
 * collapse, and walking past the newest entry returns to the draft the user was typing.
 */
export const MAX_HISTORY_ENTRIES = 200;

export interface ComposerHistoryState {
  /** `-1` means "not browsing"; 0 is the newest entry. */
  cursor: number;
  /** What was in the composer when browsing started, restored on the way back down. */
  draft: string;
  entries: string[];
}

export const createComposerHistory = (entries: string[] = []): ComposerHistoryState => ({
  cursor: -1,
  draft: '',
  entries: entries.filter((entry) => entry.trim().length > 0).slice(0, MAX_HISTORY_ENTRIES),
});

/** Records a submitted prompt and leaves browsing mode. */
export const rememberSubmission = (
  state: ComposerHistoryState,
  text: string,
): ComposerHistoryState => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ...state, cursor: -1, draft: '' };
  }
  const entries = state.entries[0] === trimmed ? state.entries : [trimmed, ...state.entries];
  return { cursor: -1, draft: '', entries: entries.slice(0, MAX_HISTORY_ENTRIES) };
};

export interface HistoryStep {
  state: ComposerHistoryState;
  /** `undefined` means the caller should leave the composer untouched. */
  text: string | undefined;
}

/** ↑: walks toward older entries, remembering the live draft on the first step. */
export const stepBack = (state: ComposerHistoryState, draft: string): HistoryStep => {
  if (state.entries.length === 0 || state.cursor >= state.entries.length - 1) {
    return { state, text: undefined };
  }
  const cursor = state.cursor + 1;
  return {
    state: { ...state, cursor, draft: state.cursor === -1 ? draft : state.draft },
    text: state.entries[cursor],
  };
};

/** ↓: walks back toward the draft, and past the newest entry restores it verbatim. */
export const stepForward = (state: ComposerHistoryState): HistoryStep => {
  if (state.cursor < 0) {
    return { state, text: undefined };
  }
  const cursor = state.cursor - 1;
  return {
    state: { ...state, cursor },
    text: cursor < 0 ? state.draft : state.entries[cursor],
  };
};

/** Called whenever the user edits the text, so ↑/↓ restart from the new draft. */
export const resetBrowsing = (state: ComposerHistoryState): ComposerHistoryState =>
  state.cursor === -1 ? state : { ...state, cursor: -1 };
