import { describe, expect, it } from 'vitest';
import { claudeStateOwnershipIsCurrent } from '../../src/shared/claude/state-ownership';

describe('Claude state ownership', () => {
  it('rejects a delayed state from a replaced PTY generation', () => {
    expect(claudeStateOwnershipIsCurrent({ ptyGeneration: 4, stateRevision: 12 }, 11, 5)).toBe(
      false,
    );
  });

  it('rejects an older revision even when PTY ownership still matches', () => {
    expect(claudeStateOwnershipIsCurrent({ ptyGeneration: 5, stateRevision: 10 }, 11, 5)).toBe(
      false,
    );
  });

  it('accepts current active state and newer inactive state', () => {
    expect(claudeStateOwnershipIsCurrent({ ptyGeneration: 5, stateRevision: 12 }, 11, 5)).toBe(
      true,
    );
    expect(claudeStateOwnershipIsCurrent({ stateRevision: 13 }, 12, 5)).toBe(true);
  });
});
