import { describe, expect, it } from 'vitest';
import { ConversationOwnerRegistry } from '../src/main/conversation-owner-registry';

const base = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
  ownerId: 'native-1',
  ownerKind: 'native' as const,
  phase: 'starting' as const,
  projectPath: 'D:\\Projects\\Example',
  runtime: 'claude' as const,
};

describe('conversation owner registry', () => {
  it('reuses the same owner and rejects a second owner for the same canonical identity', () => {
    const registry = new ConversationOwnerRegistry();
    expect(registry.claim(base).status).toBe('acquired');
    expect(registry.claim(base).status).toBe('reused');
    expect(
      registry.claim({
        ...base,
        conversationId: base.conversationId.toUpperCase(),
        ownerId: 'terminal-2',
        ownerKind: 'terminal',
        projectPath: 'd:/projects/example/',
      }),
    ).toMatchObject({ status: 'conflict', owner: { ownerId: 'native-1' } });
  });

  it('does not let a stale generation update or release the new owner', () => {
    const registry = new ConversationOwnerRegistry();
    registry.claim(base);
    expect(registry.release(base, base.ownerId, 0)).toBe(false);
    expect(registry.updatePhase(base, base.ownerId, 0, 'active')).toBe(false);
    expect(registry.updatePhase(base, base.ownerId, 1, 'active')).toBe(true);
    expect(registry.ownerFor(base)?.phase).toBe('active');
  });

  it('filters history only for currently owned UUIDs', () => {
    const registry = new ConversationOwnerRegistry();
    registry.claim(base);
    expect(registry.activeConversationIds('claude', 'd:/projects/example')).toEqual(
      new Set([base.conversationId]),
    );
    registry.release(base, base.ownerId, base.generation);
    expect(registry.activeConversationIds('claude', base.projectPath).size).toBe(0);
  });

  it('serializes target-unknown launches without blocking exact UUID launches', () => {
    const registry = new ConversationOwnerRegistry();
    expect(registry.reserveUnknownProject(base).status).toBe('acquired');
    expect(
      registry.reserveUnknownProject({ ...base, generation: 2, ownerId: 'picker-2' }).status,
    ).toBe('conflict');
    expect(
      registry.claim({
        ...base,
        conversationId: '22222222-2222-4222-8222-222222222222',
        ownerId: 'exact-2',
      }).status,
    ).toBe('acquired');
  });

  it('rolls a failed native-to-terminal transfer back to the original owner', () => {
    const registry = new ConversationOwnerRegistry();
    registry.claim({ ...base, phase: 'active' });
    const transfer = registry.beginTransfer(base, base.ownerId);
    expect(registry.ownerFor(base)?.phase).toBe('stopping');
    expect(registry.rollbackTransfer(transfer)).toBe(true);
    expect(registry.ownerFor(base)).toMatchObject({ ownerId: base.ownerId, phase: 'active' });
  });

  it('commits a successful owner transfer without opening a duplicate', () => {
    const registry = new ConversationOwnerRegistry();
    registry.claim({ ...base, phase: 'active' });
    const transfer = registry.beginTransfer(base, base.ownerId);
    registry.commitTransfer(transfer, {
      ...base,
      generation: 2,
      ownerId: 'terminal-2',
      ownerKind: 'terminal',
      phase: 'active',
    });
    expect(registry.ownerFor(base)).toMatchObject({
      generation: 2,
      ownerId: 'terminal-2',
      ownerKind: 'terminal',
    });
  });
});
