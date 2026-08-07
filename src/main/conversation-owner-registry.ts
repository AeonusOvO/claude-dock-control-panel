import path from 'node:path';
import type { ConversationOwnerKind, ConversationRuntime } from '../shared/native-conversation';

export type ConversationOwnerPhase = 'starting' | 'active' | 'stopping';

export interface ConversationIdentity {
  conversationId: string;
  projectPath: string;
  runtime: ConversationRuntime;
}

export interface ConversationOwner extends ConversationIdentity {
  generation: number;
  ownerId: string;
  ownerKind: ConversationOwnerKind;
  phase: ConversationOwnerPhase;
}

export type ConversationOwnerClaim =
  | { status: 'acquired'; owner: ConversationOwner }
  | { status: 'reused'; owner: ConversationOwner }
  | { status: 'conflict'; owner: ConversationOwner };

export interface ConversationTransfer {
  current: ConversationOwner;
  token: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const normalizeConversationProject = (projectPath: string): string =>
  path
    .resolve(projectPath)
    .replace(/[\\/]+$/, '')
    .toLocaleLowerCase('en-US');

export const conversationIdentityKey = ({
  conversationId,
  projectPath,
  runtime,
}: ConversationIdentity): string => {
  if (!UUID.test(conversationId)) throw new Error('对话 UUID 无效。');
  return `${runtime}\u0000${normalizeConversationProject(projectPath)}\u0000${conversationId.toLowerCase()}`;
};

const cloneOwner = (owner: ConversationOwner): ConversationOwner => ({ ...owner });

/** Enforces one active/starting owner for each runtime + project + canonical transcript UUID. */
export class ConversationOwnerRegistry {
  private readonly owners = new Map<string, ConversationOwner>();
  private readonly projectReservations = new Map<string, ConversationOwner>();
  private readonly transfers = new Map<string, ConversationOwner>();
  private nextTransferId = 1;

  public claim(owner: ConversationOwner): ConversationOwnerClaim {
    const key = conversationIdentityKey(owner);
    const existing = this.owners.get(key);
    if (existing) {
      return {
        owner: cloneOwner(existing),
        status:
          existing.ownerId === owner.ownerId && existing.generation === owner.generation
            ? 'reused'
            : 'conflict',
      };
    }
    const normalized = { ...owner, conversationId: owner.conversationId.toLowerCase() };
    this.owners.set(key, normalized);
    return { owner: cloneOwner(normalized), status: 'acquired' };
  }

  public ownerFor(identity: ConversationIdentity): ConversationOwner | undefined {
    const owner = this.owners.get(conversationIdentityKey(identity));
    return owner ? cloneOwner(owner) : undefined;
  }

  public updatePhase(
    identity: ConversationIdentity,
    ownerId: string,
    generation: number,
    phase: ConversationOwnerPhase,
  ): boolean {
    const key = conversationIdentityKey(identity);
    const current = this.owners.get(key);
    if (!current || current.ownerId !== ownerId || current.generation !== generation) return false;
    this.owners.set(key, { ...current, phase });
    return true;
  }

  public release(identity: ConversationIdentity, ownerId: string, generation: number): boolean {
    const key = conversationIdentityKey(identity);
    const current = this.owners.get(key);
    if (!current || current.ownerId !== ownerId || current.generation !== generation) return false;
    this.owners.delete(key);
    return true;
  }

  public activeConversationIds(runtime: ConversationRuntime, projectPath: string): Set<string> {
    const normalizedProject = normalizeConversationProject(projectPath);
    return new Set(
      [...this.owners.values()]
        .filter(
          (owner) =>
            owner.runtime === runtime &&
            normalizeConversationProject(owner.projectPath) === normalizedProject,
        )
        .map((owner) => owner.conversationId),
    );
  }

  /**
   * Serializes target-unknown native picker/continue launches per project until status metadata
   * reveals the UUID. Exact UUID launches remain independently claimable.
   */
  public reserveUnknownProject(owner: ConversationOwner): ConversationOwnerClaim {
    const key = `${owner.runtime}\u0000${normalizeConversationProject(owner.projectPath)}`;
    const existing = this.projectReservations.get(key);
    if (existing) {
      return {
        owner: cloneOwner(existing),
        status:
          existing.ownerId === owner.ownerId && existing.generation === owner.generation
            ? 'reused'
            : 'conflict',
      };
    }
    this.projectReservations.set(key, { ...owner });
    return { owner: cloneOwner(owner), status: 'acquired' };
  }

  public releaseUnknownProject(owner: ConversationOwner): boolean {
    const key = `${owner.runtime}\u0000${normalizeConversationProject(owner.projectPath)}`;
    const current = this.projectReservations.get(key);
    if (!current || current.ownerId !== owner.ownerId || current.generation !== owner.generation) {
      return false;
    }
    this.projectReservations.delete(key);
    return true;
  }

  public beginTransfer(identity: ConversationIdentity, ownerId: string): ConversationTransfer {
    const key = conversationIdentityKey(identity);
    const current = this.owners.get(key);
    if (!current || current.ownerId !== ownerId) throw new Error('原会话 owner 已变化，无法切换。');
    const token = `transfer-${this.nextTransferId++}`;
    const stopping = { ...current, phase: 'stopping' as const };
    this.owners.set(key, stopping);
    this.transfers.set(token, current);
    return { current: cloneOwner(current), token };
  }

  public commitTransfer(transfer: ConversationTransfer, nextOwner: ConversationOwner): void {
    const previous = this.transfers.get(transfer.token);
    if (!previous) throw new Error('会话切换事务已结束。');
    const key = conversationIdentityKey(previous);
    const current = this.owners.get(key);
    if (
      !current ||
      current.ownerId !== previous.ownerId ||
      current.generation !== previous.generation
    ) {
      throw new Error('会话 owner 在切换期间发生变化。');
    }
    if (conversationIdentityKey(nextOwner) !== key) throw new Error('切换后的会话身份不一致。');
    this.owners.set(key, { ...nextOwner });
    this.transfers.delete(transfer.token);
  }

  public rollbackTransfer(transfer: ConversationTransfer): boolean {
    const previous = this.transfers.get(transfer.token);
    if (!previous) return false;
    const key = conversationIdentityKey(previous);
    const current = this.owners.get(key);
    if (
      !current ||
      current.ownerId !== previous.ownerId ||
      current.generation !== previous.generation
    ) {
      return false;
    }
    this.owners.set(key, previous);
    this.transfers.delete(transfer.token);
    return true;
  }
}
