import { describe, expect, it } from 'vitest';
import {
  createComposerHistory,
  MAX_HISTORY_ENTRIES,
  rememberSubmission,
  resetBrowsing,
  stepBack,
  stepForward,
} from '../../src/shared/conversation/composer-history';

describe('composer history', () => {
  it('stores newest first and collapses an immediate repeat', () => {
    let state = createComposerHistory();
    state = rememberSubmission(state, 'first');
    state = rememberSubmission(state, 'second');
    state = rememberSubmission(state, 'second');

    expect(state.entries).toEqual(['second', 'first']);
  });

  it('ignores blank submissions', () => {
    const state = rememberSubmission(createComposerHistory(['kept']), '   \n ');
    expect(state.entries).toEqual(['kept']);
  });

  it('walks back through entries and restores the draft on the way down', () => {
    const history = createComposerHistory(['newest', 'older']);

    const first = stepBack(history, '写到一半的内容');
    expect(first.text).toBe('newest');

    const second = stepBack(first.state, 'ignored once browsing');
    expect(second.text).toBe('older');

    const back = stepForward(second.state);
    expect(back.text).toBe('newest');

    const draft = stepForward(back.state);
    expect(draft.text).toBe('写到一半的内容');
    expect(draft.state.cursor).toBe(-1);
  });

  it('stops at the oldest entry instead of clearing the composer', () => {
    const walked = stepBack(createComposerHistory(['only']), '');
    expect(stepBack(walked.state, '').text).toBeUndefined();
  });

  it('does nothing on ↓ when not browsing', () => {
    expect(stepForward(createComposerHistory(['a'])).text).toBeUndefined();
  });

  it('does nothing on ↑ when the history is empty', () => {
    expect(stepBack(createComposerHistory(), 'draft').text).toBeUndefined();
  });

  it('restarts browsing after the user edits the text', () => {
    const walked = stepBack(createComposerHistory(['a', 'b']), '');
    expect(resetBrowsing(walked.state).cursor).toBe(-1);
  });

  it('caps the stored history so localStorage cannot grow without bound', () => {
    let state = createComposerHistory(
      Array.from({ length: MAX_HISTORY_ENTRIES + 40 }, (_, index) => `entry-${index}`),
    );
    expect(state.entries).toHaveLength(MAX_HISTORY_ENTRIES);

    state = rememberSubmission(state, 'newest');
    expect(state.entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(state.entries[0]).toBe('newest');
  });
});
