import { CHANNELS } from '../../shared/ipc/channels';
import type { ClaudeProjectState } from '../../shared/contracts';
import { claudeStateOwnershipIsCurrent } from '../../shared/claude/state-ownership';
import type { ConversationOwner, ConversationOwnerRegistry } from '../conversation/owner-registry';
import type { Registry } from '../infra/registry';
import { CLAUDE_RUNTIME, MAIN_WINDOW } from '../infra/service-tokens';
import type { TerminalWorkspace } from '../terminal/workspace';
import { isValidClaudeSessionId } from './session-manager';

export interface ClaudeStatePublisherDependencies {
  conversationOwnerRegistry: ConversationOwnerRegistry;
  /* Last revision broadcast per session, so a stale runtime report cannot overwrite a newer one. */
  publishedClaudeStateRevisions: Map<string, number>;
  releaseTerminalConversationOwner: (sessionId: string) => void;
  services: Registry;
  terminalConversationOwners: Map<string, ConversationOwner>;
  terminalTransferSessions: Set<string>;
  workspace: TerminalWorkspace;
}

export interface ClaudeStatePublisher {
  /** False when the report lost the ownership check and was therefore not sent to the renderer. */
  publishClaudeProjectState: (state: ClaudeProjectState) => boolean;
  publishRestoredClaudeProjectState: (state: ClaudeProjectState) => void;
}

export const createClaudeStatePublisher = ({
  conversationOwnerRegistry,
  publishedClaudeStateRevisions,
  releaseTerminalConversationOwner,
  services,
  terminalConversationOwners,
  terminalTransferSessions,
  workspace,
}: ClaudeStatePublisherDependencies): ClaudeStatePublisher => {
  const publishClaudeProjectState = (state: ClaudeProjectState): boolean => {
    if (!workspace.hasSession(state.sessionId)) {
      return false;
    }
    const status = workspace.getStatus(state.sessionId);
    const currentRevision = publishedClaudeStateRevisions.get(state.sessionId);
    if (!claudeStateOwnershipIsCurrent(state, currentRevision, status.ptyGeneration)) {
      return false;
    }
    publishedClaudeStateRevisions.set(state.sessionId, state.stateRevision);
    if (!state.active) {
      if (!terminalTransferSessions.has(state.sessionId)) {
        releaseTerminalConversationOwner(state.sessionId);
      }
    } else {
      const conversationId = state.metrics?.sessionId?.toLowerCase();
      const generation = Number(state.ptyGeneration ?? 0);
      if (
        conversationId &&
        isValidClaudeSessionId(conversationId) &&
        generation > 0 &&
        !terminalTransferSessions.has(state.sessionId)
      ) {
        const previous = terminalConversationOwners.get(state.sessionId);
        if (
          previous &&
          (previous.conversationId !== conversationId || previous.generation !== generation)
        ) {
          releaseTerminalConversationOwner(state.sessionId);
        }
        const owner: ConversationOwner = {
          conversationId,
          generation,
          ownerId: `terminal:${state.sessionId}`,
          ownerKind: 'terminal',
          phase: 'active',
          projectPath: state.cwd,
          runtime: 'claude',
        };
        const claim = conversationOwnerRegistry.claim(owner);
        if (claim.status === 'conflict') {
          services
            .resolve(MAIN_WINDOW)
            .current?.webContents.send(CHANNELS.CONVERSATION_OWNER_CONFLICT, {
              conversationId,
              existingOwnerKind: claim.owner.ownerKind,
              existingSessionId:
                claim.owner.ownerKind === 'terminal'
                  ? claim.owner.ownerId.replace(/^terminal:/, '')
                  : undefined,
              sessionId: state.sessionId,
            });
          // A raw `/resume` is only identifiable after Claude reports its UUID. Stop the late owner
          // immediately so two runtimes cannot continue against one transcript; the renderer explains
          // that the already-stable owner was retained.
          queueMicrotask(() => {
            if (!workspace.hasSession(state.sessionId)) return;
            const status = workspace.getStatus(state.sessionId);
            if (status.ptyGeneration !== state.ptyGeneration) return;
            workspace.stop(state.sessionId);
            services.resolve(CLAUDE_RUNTIME).setInactive(state.sessionId, status.ptyGeneration);
          });
        } else {
          terminalConversationOwners.set(state.sessionId, claim.owner);
        }
      }
    }
    const claudeTitle = state.metrics?.sessionName;
    if (claudeTitle) {
      try {
        workspace.syncClaudeSessionTitle(state.sessionId, claudeTitle);
      } catch {
        // Ignore malformed or oversized names from a future Claude Code status-line schema.
      }
    }
    services.resolve(MAIN_WINDOW).current?.webContents.send(CHANNELS.CLAUDE_STATE, state);
    return true;
  };

  const publishRestoredClaudeProjectState = (state: ClaudeProjectState): void => {
    publishClaudeProjectState(state);
  };

  return { publishClaudeProjectState, publishRestoredClaudeProjectState };
};
