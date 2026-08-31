import { randomUUID } from 'node:crypto';
import type {
  ConversationAdapter,
  ConversationControlUpdate,
  ConversationEvent,
  ConversationInteractionResponse,
  ConversationRuntime,
  ConversationSnapshot,
  ConversationStartInput,
  ConversationSubmitInput,
  NativeConversationAdoptResult,
  NativeConversationDraftResult,
  NativeConversationOperationResult,
  NativeConversationStartResult,
  NativeConversationTerminalTransferResult,
} from '../../shared/conversation/native';
import { reduceConversationEvent } from '../../shared/conversation/reducer';
import { nativeConversationHasRunningWork } from '../../shared/conversation/surface-switch';
import { createFailureReporter } from '../infra/logger';
import {
  ConversationOwnerRegistry,
  type ConversationOwner,
  type ConversationTransfer,
} from './owner-registry';
import {
  ConversationRecoveryStore,
  recoveryConfigFingerprint,
  type ConversationRecoveryView,
  type RecoveryLaunchSnapshot,
} from './recovery-store';

interface NativeTurnCompletion {
  readonly clientSubmissionId: string;
  readonly completed: Promise<void>;
  resolveCompleted: () => void;
  started: boolean;
}

interface ActiveConversation {
  confirmedSubmissions: Set<string>;
  launch: RecoveryLaunchSnapshot;
  owner: ConversationOwner;
  pendingAttachmentIds: Map<string, string[]>;
  snapshot?: ConversationSnapshot;
  startInput: ConversationStartInput;
  transfer?: ConversationTransfer;
  turnCompletion?: NativeTurnCompletion;
}

export interface NativeConversationServiceOptions {
  adapter: ConversationAdapter;
  /** Main-owned shutdown fence, checked at every adapter or terminal launch boundary. */
  assertLaunchAdmissionAllowed?: () => void;
  onSnapshot: (snapshot: ConversationSnapshot) => void;
  onUsageReported?: (conversationId: string, projectPath: string) => void;
  onSubmissionConfirmed?: (conversationId: string, attachmentIds: string[]) => void | Promise<void>;
  ownerRegistry: ConversationOwnerRegistry;
  recoveryStore: ConversationRecoveryStore;
  runtime: ConversationRuntime;
}

export interface NativeConversationLaunchInput {
  allowBypassPermissions?: boolean;
  conversationId?: string;
  launch?: Omit<RecoveryLaunchSnapshot, 'configFingerprint'> & {
    configFingerprintSource?: unknown;
  };
  model?: string;
  /** Launch-only model understood by Claude Code; never persisted into recovery metadata. */
  runtimeModel?: string;
  /** Launch-only, non-secret settings environment; never persisted into recovery metadata. */
  settingsEnvironment?: Record<string, string>;
  permissionMode?: string;
  projectPath: string;
  resume?: boolean;
}

const reportConversationFailure = createFailureReporter('conversation');

const parseDraft = (value: string): ConversationSubmitInput => {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('恢复草稿格式无效。');
  const candidate = parsed as Partial<ConversationSubmitInput>;
  if (typeof candidate.clientSubmissionId !== 'string' || !Array.isArray(candidate.blocks)) {
    throw new Error('恢复草稿格式无效。');
  }
  return { blocks: candidate.blocks, clientSubmissionId: candidate.clientSubmissionId };
};

export class NativeConversationService {
  private readonly active = new Map<string, ActiveConversation>();
  private readonly generations = new Map<string, number>();
  private readonly unsubscribe: () => void;

  public constructor(private readonly options: NativeConversationServiceOptions) {
    this.unsubscribe = options.adapter.subscribe((event) => this.consume(event));
  }

  public recoverInterrupted(): ConversationRecoveryView[] {
    return this.options.recoveryStore.markInterrupted();
  }

  public listRecoveries(): ConversationRecoveryView[] {
    return this.options.recoveryStore.list();
  }

  public async start(input: NativeConversationLaunchInput): Promise<NativeConversationStartResult> {
    this.options.assertLaunchAdmissionAllowed?.();
    const conversationId = (input.conversationId ?? randomUUID()).toLowerCase();
    const generation = (this.generations.get(conversationId) ?? 0) + 1;
    this.generations.set(conversationId, generation);
    const owner: ConversationOwner = {
      conversationId,
      generation,
      ownerId: `native:${conversationId}:${generation}`,
      ownerKind: 'native',
      phase: 'starting',
      projectPath: input.projectPath,
      runtime: this.options.runtime,
    };
    const claim = this.options.ownerRegistry.claim(owner);
    if (claim.status === 'conflict') {
      return {
        conversationId,
        existingOwnerKind: claim.owner.ownerKind,
        message:
          claim.owner.ownerKind === 'native'
            ? '该对话已在原生界面运行，已复用现有会话。'
            : '该对话正在高级终端运行，请先切换到现有终端。',
        ok: true,
        reused: true,
        snapshot: this.active.get(conversationId)?.snapshot,
      };
    }
    if (claim.status === 'reused') {
      return {
        conversationId,
        existingOwnerKind: owner.ownerKind,
        ok: true,
        reused: true,
        snapshot: this.active.get(conversationId)?.snapshot,
      };
    }

    const { launchSnapshot, startInput } = this.buildLaunch(conversationId, input);
    this.options.recoveryStore.reserve({
      conversationId,
      launch: launchSnapshot,
      ownerKind: 'native',
      projectPath: input.projectPath,
      runtime: this.options.runtime,
    });
    const current: ActiveConversation = {
      confirmedSubmissions: new Set(),
      launch: launchSnapshot,
      owner,
      pendingAttachmentIds: new Map(),
      startInput,
    };
    this.active.set(conversationId, current);
    try {
      this.options.assertLaunchAdmissionAllowed?.();
      await this.options.adapter.start(startInput);
      this.options.assertLaunchAdmissionAllowed?.();
      if (this.active.get(conversationId) !== current) {
        throw new Error('Claude 原生会话启动已取消。');
      }
      if (!this.options.ownerRegistry.updatePhase(owner, owner.ownerId, generation, 'active')) {
        throw new Error('Claude 原生会话 owner 已变化，启动已取消。');
      }
      return {
        conversationId,
        ok: true,
        reused: false,
        snapshot: current.snapshot,
      };
    } catch (error) {
      if (this.active.get(conversationId) === current) {
        try {
          await this.options.adapter.close(conversationId);
        } catch {
          // The exact owner is still released below even if adapter teardown reports a failure.
        }
        this.release(current);
      }
      // A failed brand-new launch has no Claude transcript or useful recovery state. Keeping the
      // just-reserved row would turn a startup error into a false "interrupted conversation" card
      // on the next render. Exact resumes keep their existing recovery entry so the user can retry.
      if (
        !input.resume &&
        this.generations.get(conversationId) === generation &&
        !this.active.has(conversationId)
      ) {
        this.options.recoveryStore.discard(this.options.runtime, input.projectPath, conversationId);
      }
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : 'Claude 原生会话启动失败。',
          error,
        ),
        conversationId,
        ok: false,
        reused: false,
      };
    }
  }

  public async submit(
    conversationId: string,
    input: ConversationSubmitInput,
  ): Promise<NativeConversationOperationResult> {
    const current = this.requireActive(conversationId);
    const serialized = JSON.stringify(input);
    try {
      this.options.recoveryStore.preparePrompt(
        this.options.runtime,
        current.owner.projectPath,
        conversationId,
        input.clientSubmissionId,
        serialized,
      );
    } catch (error) {
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '无法安全保存本次输入，内容尚未发送。',
          error,
        ),
        ok: false,
        snapshot: current.snapshot,
      };
    }
    try {
      current.pendingAttachmentIds.set(
        input.clientSubmissionId,
        input.blocks.filter((block) => block.type === 'image').map((block) => block.attachment.id),
      );
      await this.options.adapter.submit(conversationId, input);
      this.options.recoveryStore.markSubmission(
        this.options.runtime,
        current.owner.projectPath,
        conversationId,
        input.clientSubmissionId,
        'dispatched',
      );
      if (current.confirmedSubmissions.has(input.clientSubmissionId)) {
        this.options.recoveryStore.markSubmission(
          this.options.runtime,
          current.owner.projectPath,
          conversationId,
          input.clientSubmissionId,
          'transcript-confirmed',
        );
      }
      return { ok: true, snapshot: current.snapshot };
    } catch (error) {
      current.pendingAttachmentIds.delete(input.clientSubmissionId);
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '本次输入未能交给 Claude。',
          error,
        ),
        ok: false,
        snapshot: current.snapshot,
      };
    }
  }

  /**
   * Keeps the caller's route lease alive from prompt admission through the exact foreground turn and
   * any background work it spawned. The ordinary `submit` method remains the service-level enqueue
   * primitive for tests and adapters that do not own network authority.
   */
  public async submitAndWaitForTurn(
    conversationId: string,
    input: ConversationSubmitInput,
  ): Promise<NativeConversationOperationResult> {
    const current = this.requireActive(conversationId);
    if (current.turnCompletion) {
      return {
        ...reportConversationFailure('user-input', '当前回复仍在运行，请等待完成后再发送。'),
        ok: false,
        snapshot: current.snapshot,
      };
    }
    let resolveCompleted!: () => void;
    const completion: NativeTurnCompletion = {
      clientSubmissionId: input.clientSubmissionId,
      completed: new Promise<void>((resolve) => {
        resolveCompleted = resolve;
      }),
      resolveCompleted: () => resolveCompleted(),
      started: false,
    };
    current.turnCompletion = completion;
    try {
      const result = await this.submit(conversationId, input);
      if (!result.ok) {
        this.finishTurn(current, completion);
        return result;
      }
      await completion.completed;
      return { ...result, snapshot: current.snapshot };
    } finally {
      this.finishTurn(current, completion);
    }
  }

  public async respond(
    conversationId: string,
    interactionId: string,
    response: ConversationInteractionResponse,
  ): Promise<NativeConversationOperationResult> {
    const current = this.requireActive(conversationId);
    try {
      await this.options.adapter.respond(conversationId, interactionId, response);
      return { ok: true, snapshot: current.snapshot };
    } catch (error) {
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '交互响应失败。',
          error,
        ),
        ok: false,
        snapshot: current.snapshot,
      };
    }
  }

  public async interrupt(conversationId: string): Promise<NativeConversationOperationResult> {
    const current = this.requireActive(conversationId);
    try {
      await this.options.adapter.interrupt(conversationId);
      return { ok: true, snapshot: current.snapshot };
    } catch (error) {
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '无法中断当前轮次。',
          error,
        ),
        ok: false,
        snapshot: current.snapshot,
      };
    }
  }

  public async stopTask(
    conversationId: string,
    taskId: string,
  ): Promise<NativeConversationOperationResult> {
    const current = this.requireActive(conversationId);
    try {
      await this.options.adapter.stopTask(conversationId, taskId);
      return { ok: true, snapshot: current.snapshot };
    } catch (error) {
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '无法停止后台任务。',
          error,
        ),
        ok: false,
        snapshot: current.snapshot,
      };
    }
  }

  public async updateControls(
    conversationId: string,
    update: ConversationControlUpdate,
  ): Promise<NativeConversationOperationResult> {
    const current = this.requireActive(conversationId);
    try {
      await this.options.adapter.updateControls(conversationId, update);
      return { ok: true, snapshot: current.snapshot };
    } catch (error) {
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '无法更新当前模型控制项。',
          error,
        ),
        ok: false,
        snapshot: current.snapshot,
      };
    }
  }

  public async close(conversationId: string): Promise<NativeConversationOperationResult> {
    const current = this.requireActive(conversationId);
    try {
      await this.options.adapter.close(conversationId);
      try {
        this.options.recoveryStore.markClean(
          this.options.runtime,
          current.owner.projectPath,
          conversationId,
        );
      } catch {
        // Ambiguous submissions intentionally keep the recovery card after a normal close.
      }
      this.release(current);
      return { ok: true, snapshot: current.snapshot };
    } catch (error) {
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '无法关闭原生会话。',
          error,
        ),
        ok: false,
        snapshot: current.snapshot,
      };
    }
  }

  public async closeAll(): Promise<void> {
    const results = await Promise.all(
      [...this.active.keys()].map((conversationId) => this.close(conversationId)),
    );
    const failedCount = results.filter(({ ok }) => !ok).length;
    if (failedCount > 0) {
      throw new Error(`无法关闭 ${failedCount} 个原生会话。`);
    }
  }

  // eslint-disable-next-line max-lines-per-function -- transfer coordinates two writer lifecycles and recovery.
  public async transferToTerminal(
    conversationId: string,
    draft: ConversationSubmitInput | undefined,
    startTerminal: (identity: { conversationId: string; projectPath: string }) => Promise<{
      owner: ConversationOwner;
      /** Resolves false when the exact terminal writer could not be confirmed stopped. */
      stop?: () => Promise<boolean | void> | boolean | void;
      terminalSessionId: string;
    }>,
    allowInterrupt = false,
    authorizeTerminalLaunch?: <T>(
      identity: {
        conversationId: string;
        projectPath: string;
      },
      operation: () => Promise<T>,
    ) => Promise<T>,
  ): Promise<NativeConversationTerminalTransferResult> {
    const current = this.requireActive(conversationId);
    const transferInProgress = (): NativeConversationTerminalTransferResult => ({
      ...reportConversationFailure('internal', '该对话正在切换界面。'),
      ok: false,
      snapshot: current.snapshot,
    });
    const requiresConfirmation = (): NativeConversationTerminalTransferResult => ({
      ...reportConversationFailure('user-input', '原生对话仍有正在运行的回复或后台任务。'),
      ok: false,
      requiresConfirmation: true,
      snapshot: current.snapshot,
    });
    if (current.transfer) return transferInProgress();
    if (!allowInterrupt && nativeConversationHasRunningWork(current.snapshot)) {
      return requiresConfirmation();
    }

    const identity = {
      conversationId,
      projectPath: current.owner.projectPath,
    };
    const performTransfer = async (): Promise<NativeConversationTerminalTransferResult> => {
      this.options.assertLaunchAdmissionAllowed?.();
      if (this.active.get(conversationId) !== current) {
        throw new Error('原生对话状态已经变化，请重新切换。');
      }
      if (current.transfer) return transferInProgress();
      if (!allowInterrupt && nativeConversationHasRunningWork(current.snapshot)) {
        return requiresConfirmation();
      }
      if (draft && draft.blocks.length > 0) {
        const serialized = JSON.stringify(draft);
        try {
          this.options.recoveryStore.preparePrompt(
            this.options.runtime,
            current.owner.projectPath,
            conversationId,
            draft.clientSubmissionId,
            serialized,
          );
          this.options.recoveryStore.preserveUnsentDraft(
            this.options.runtime,
            current.owner.projectPath,
            conversationId,
            draft.clientSubmissionId,
          );
        } catch (error) {
          return {
            ...reportConversationFailure(
              'environment',
              error instanceof Error ? error.message : '无法安全保存当前草稿，尚未切换到高级终端。',
              error,
            ),
            ok: false,
            snapshot: current.snapshot,
          };
        }
      }
      const transfer = this.options.ownerRegistry.beginTransfer(
        current.owner,
        current.owner.ownerId,
      );
      current.transfer = transfer;
      let terminal:
        | {
            owner: ConversationOwner;
            /** Resolves false when the exact terminal writer could not be confirmed stopped. */
            stop?: () => Promise<boolean | void> | boolean | void;
            terminalSessionId: string;
          }
        | undefined;
      let terminalRecoveryReserved = false;
      try {
        await this.options.adapter.close(conversationId);
        this.options.assertLaunchAdmissionAllowed?.();
        terminal = await startTerminal({
          conversationId,
          projectPath: current.owner.projectPath,
        });
        // Keep commitTransfer as the final fallible state mutation. If persistence fails, the new
        // terminal must be stopped while the transfer token still lets us restore the native owner.
        this.options.recoveryStore.reserve({
          conversationId,
          launch: current.launch,
          ownerKind: 'terminal',
          projectPath: current.owner.projectPath,
          runtime: this.options.runtime,
        });
        terminalRecoveryReserved = true;
        this.options.ownerRegistry.commitTransfer(transfer, terminal.owner);
        if (current.turnCompletion) this.finishTurn(current, current.turnCompletion);
        this.active.delete(conversationId);
        return {
          message: draft ? '已保存草稿并切换到高级终端。' : '已切换到高级终端。',
          ok: true,
          snapshot: current.snapshot,
          terminalSessionId: terminal.terminalSessionId,
        };
      } catch (error) {
        let terminalStopError: unknown;
        if (terminal) {
          if (!terminal.stop) {
            terminalStopError = new Error('高级终端没有提供安全清理句柄。');
          } else {
            try {
              const stopped = await terminal.stop();
              if (stopped === false) {
                throw new Error('高级终端未能确认已停止。', { cause: error });
              }
            } catch (stopError) {
              terminalStopError = stopError;
            }
          }
        }
        if (terminalStopError && terminal) {
          // Never start the native writer while the terminal writer may still be alive. If it cannot
          // be stopped, make the terminal owner authoritative instead of creating duplicate writers.
          try {
            this.options.ownerRegistry.commitTransfer(transfer, {
              ...terminal.owner,
              phase: 'active',
            });
            if (current.turnCompletion) this.finishTurn(current, current.turnCompletion);
            this.active.delete(conversationId);
            current.transfer = undefined;
            if (!terminalRecoveryReserved) {
              try {
                this.options.recoveryStore.reserve({
                  conversationId,
                  launch: current.launch,
                  ownerKind: 'terminal',
                  projectPath: current.owner.projectPath,
                  runtime: this.options.runtime,
                });
              } catch {
                // The terminal remains the safer owner even if its recovery row cannot be refreshed.
              }
            }
            return {
              ...reportConversationFailure(
                'environment',
                `${error instanceof Error ? error.message : '高级终端切换失败'}；高级终端未能停止，已保留高级终端。`,
                error,
              ),
              ok: false,
              snapshot: current.snapshot,
              terminalSessionId: terminal.terminalSessionId,
            };
          } catch {
            this.options.ownerRegistry.rollbackTransfer(transfer);
            this.release(current);
          }
        }

        let nativeStartAttempted = false;
        let nativeCloseError: unknown;
        try {
          this.options.assertLaunchAdmissionAllowed?.();
          // Persist the native owner before starting its writer. This makes persistence failure
          // recoverable without ever leaving a live adapter whose owner row still says terminal.
          if (terminalRecoveryReserved) {
            this.options.recoveryStore.reserve({
              conversationId,
              launch: current.launch,
              ownerKind: 'native',
              projectPath: current.owner.projectPath,
              runtime: this.options.runtime,
            });
          }
          nativeStartAttempted = true;
          await this.options.adapter.start({ ...current.startInput, resume: true });
          if (!this.options.ownerRegistry.rollbackTransfer(transfer)) {
            throw new Error('原生会话 owner 已变化，恢复已取消。', { cause: error });
          }
          current.transfer = undefined;
        } catch (recoveryError) {
          // `start()` may reject after creating a writer. Always close after an attempted start;
          // otherwise a partial adapter can race the next terminal or native owner.
          if (nativeStartAttempted) {
            try {
              await this.options.adapter.close(conversationId);
            } catch (closeError) {
              nativeCloseError = closeError;
            }
          }
          if (nativeCloseError !== undefined) {
            // The adapter may still be writing, so retain the native side rather than restoring a
            // terminal writer. The owner is intentionally conservative until manual recovery.
            try {
              this.options.ownerRegistry.commitTransfer(transfer, {
                ...current.owner,
                phase: 'active',
              });
              current.transfer = undefined;
            } catch {
              // Leave the transfer fenced; releasing either side could create duplicate writers.
            }
          } else {
            const rolledBack = this.options.ownerRegistry.rollbackTransfer(transfer);
            if (rolledBack) {
              current.transfer = undefined;
              this.release(current);
            }
          }
          return {
            ...reportConversationFailure(
              'environment',
              error instanceof Error
                ? `${error.message}；已尝试恢复原生界面。`
                : '高级终端启动失败；已尝试恢复原生界面。',
              recoveryError,
            ),
            ok: false,
            snapshot: current.snapshot,
          };
        }
        return {
          ...reportConversationFailure(
            'environment',
            error instanceof Error
              ? `${error.message}；已尝试恢复原生界面。`
              : '高级终端启动失败；已尝试恢复原生界面。',
            error,
          ),
          ok: false,
          snapshot: current.snapshot,
        };
      }
    };

    return authorizeTerminalLaunch
      ? authorizeTerminalLaunch(identity, performTransfer)
      : performTransfer();
  }

  /**
   * Takes over a conversation that a terminal session currently owns, without minting a new UUID.
   * Mirrors {@link transferToTerminal} in the opposite direction: stop the Claude process inside the
   * PTY, resume that exact transcript under the SDK, then commit the owner swap. The workspace tab
   * itself stays open — only the process inside it is stopped — so switching back is the forward
   * transfer running on the very same tab.
   *
   * `beginTransfer` leaves the terminal owner registered (phase `'stopping'`), so this deliberately
   * does not delegate to {@link start}: that path would `claim()` the same identity key and get a
   * `'conflict'`. The native owner is minted here and handed to `commitTransfer`, exactly like
   * `transferToTerminal` hands over the owner produced by its `startTerminal` callback.
   */
  public async adoptFromTerminal(
    input: NativeConversationLaunchInput & { conversationId: string },
    stopTerminal: () => Promise<boolean | void>,
    restoreTerminal: () => Promise<boolean | void>,
  ): Promise<NativeConversationAdoptResult> {
    this.options.assertLaunchAdmissionAllowed?.();
    const conversationId = input.conversationId.toLowerCase();
    const alreadyNative = this.active.get(conversationId);
    if (alreadyNative) {
      return {
        conversationId,
        message: '该对话已经在原生界面运行。',
        ok: true,
        snapshot: alreadyNative.snapshot,
      };
    }
    const identity = {
      conversationId,
      projectPath: input.projectPath,
      runtime: this.options.runtime,
    };
    let terminalOwner: ConversationOwner | undefined;
    try {
      terminalOwner = this.options.ownerRegistry.ownerFor(identity);
    } catch (error) {
      return {
        ...reportConversationFailure(
          'user-input',
          error instanceof Error ? error.message : '对话标识无效，无法接管。',
          error,
        ),
        conversationId,
        ok: false,
      };
    }
    if (!terminalOwner) {
      return {
        ...reportConversationFailure('internal', '当前终端尚未持有这段对话，无法切换到原生对话。'),
        conversationId,
        ok: false,
      };
    }
    if (terminalOwner.ownerKind !== 'terminal') {
      return {
        ...reportConversationFailure('internal', '这段对话不由安全终端持有，无法接管。'),
        conversationId,
        ok: false,
      };
    }

    const generation = (this.generations.get(conversationId) ?? 0) + 1;
    this.generations.set(conversationId, generation);
    const owner: ConversationOwner = {
      conversationId,
      generation,
      ownerId: `native:${conversationId}:${generation}`,
      ownerKind: 'native',
      phase: 'starting',
      projectPath: input.projectPath,
      runtime: this.options.runtime,
    };
    // Adoption is always an exact-UUID resume: the JSONL the terminal just stopped writing is the
    // whole point. A fresh launch here would silently fork the conversation the user is looking at.
    const { launchSnapshot, startInput } = this.buildLaunch(conversationId, {
      ...input,
      resume: true,
    });
    const transfer = this.options.ownerRegistry.beginTransfer(terminalOwner, terminalOwner.ownerId);
    const adopted: ActiveConversation = {
      confirmedSubmissions: new Set(),
      launch: launchSnapshot,
      owner,
      pendingAttachmentIds: new Map(),
      startInput,
      transfer,
    };
    this.active.set(conversationId, adopted);
    let terminalStopped = false;
    let nativeStartAttempted = false;
    let nativeRecoveryReserved = false;
    const activeNativeOwner: ConversationOwner = { ...owner, phase: 'active' };
    const activeTerminalOwner: ConversationOwner = { ...terminalOwner, phase: 'active' };
    const retainNativeOwner = (): void => {
      this.options.ownerRegistry.commitTransfer(transfer, activeNativeOwner);
      adopted.owner = activeNativeOwner;
      adopted.transfer = undefined;
    };
    const retainTerminalOwner = (): void => {
      this.options.ownerRegistry.commitTransfer(transfer, activeTerminalOwner);
      if (nativeRecoveryReserved) {
        try {
          this.options.recoveryStore.reserve({
            conversationId,
            launch: launchSnapshot,
            ownerKind: 'terminal',
            projectPath: input.projectPath,
            runtime: this.options.runtime,
          });
        } catch {
          // The terminal remains the safer owner even if its recovery row cannot be refreshed.
        }
      }
      if (adopted.transfer) adopted.transfer = undefined;
      this.active.delete(conversationId);
    };
    const releaseWithoutWriter = (): void => {
      if (this.options.ownerRegistry.rollbackTransfer(transfer)) {
        adopted.transfer = undefined;
        this.options.ownerRegistry.release(
          transfer.current,
          transfer.current.ownerId,
          transfer.current.generation,
        );
        this.active.delete(conversationId);
      }
    };
    try {
      const stopped = await stopTerminal();
      if (stopped === false) throw new Error('安全终端未能确认已停止。');
      terminalStopped = true;
      this.options.assertLaunchAdmissionAllowed?.();
      // Persist the native owner before starting its writer. If this fails, the terminal can be
      // restored without ever having a live native adapter whose journal row says terminal.
      this.options.recoveryStore.reserve({
        conversationId,
        launch: launchSnapshot,
        ownerKind: 'native',
        projectPath: input.projectPath,
        runtime: this.options.runtime,
      });
      nativeRecoveryReserved = true;
      nativeStartAttempted = true;
      await this.options.adapter.start(startInput);
      this.options.ownerRegistry.commitTransfer(transfer, activeNativeOwner);
      adopted.owner = activeNativeOwner;
      adopted.transfer = undefined;
      return {
        conversationId,
        message: '已切换到原生对话。',
        ok: true,
        snapshot: this.active.get(conversationId)?.snapshot,
      };
    } catch (error) {
      let nativeCloseError: unknown;
      // `start()` may reject after creating a writer. Always close after an attempted start before
      // allowing the terminal owner to be restored.
      if (nativeStartAttempted) {
        try {
          await this.options.adapter.close(conversationId);
        } catch (closeError) {
          nativeCloseError = closeError;
        }
      }

      if (nativeCloseError !== undefined) {
        // The native writer may still be alive. Keep it authoritative and never restart the terminal
        // on top of an unknown adapter state.
        try {
          retainNativeOwner();
        } catch {
          // Leave the transfer fenced; releasing either owner could create duplicate writers.
        }
      } else if (!terminalStopped) {
        // A failed/ambiguous stop means the terminal may still be writing the transcript.
        try {
          retainTerminalOwner();
        } catch {
          // Leave the transfer fenced rather than claiming that either writer is safe.
        }
      } else {
        let restoreUncertain = false;
        let restoreRejected = false;
        let restored = false;
        try {
          this.options.assertLaunchAdmissionAllowed?.();
          const restoredResult = await restoreTerminal();
          if (restoredResult !== false) {
            restored = true;
            retainTerminalOwner();
          } else {
            restoreRejected = true;
          }
        } catch {
          restoreUncertain = true;
        }
        if (!restored) {
          if (restoreUncertain) {
            // A thrown restore is ambiguous: its cleanup may have left a terminal writer alive. Keep
            // the terminal owner fenced instead of starting a second native writer later.
            try {
              retainTerminalOwner();
            } catch {
              // Leave the transfer fenced if ownership changed concurrently.
            }
          } else if (restoreRejected) {
            // An explicit false is a confirmed no-writer result; release the transaction cleanly.
            releaseWithoutWriter();
          }
        }
      }
      const reason = error instanceof Error ? error.message : '原生会话启动失败';
      return {
        ...reportConversationFailure(
          'environment',
          nativeCloseError !== undefined
            ? `${reason}；无法确认原生会话已关闭，已保留原生会话。`
            : terminalStopped
              ? `${reason}；安全终端未能安全恢复，请手动重新启动该会话。`
              : `${reason}；安全终端未能安全停止，已保留安全终端。`,
          error,
        ),
        conversationId,
        ok: false,
      };
    }
  }

  public restoreDraft(
    conversationId: string,
    clientSubmissionId: string,
    projectPath: string,
  ): NativeConversationDraftResult {
    try {
      const serialized = this.options.recoveryStore.readDraft(
        this.options.runtime,
        projectPath,
        conversationId,
        clientSubmissionId,
      );
      const draft = parseDraft(serialized);
      return {
        draft: { ...draft, clientSubmissionId: randomUUID() },
        message: '已恢复为未发送草稿，请核对后手动发送。',
        ok: true,
      };
    } catch (error) {
      return {
        ...reportConversationFailure(
          'environment',
          error instanceof Error ? error.message : '无法恢复草稿。',
          error,
        ),
        ok: false,
      };
    }
  }

  public discardRecovery(conversationId: string, projectPath: string): boolean {
    return this.options.recoveryStore.discard(this.options.runtime, projectPath, conversationId);
  }

  public activeConversationIds(projectPath: string): Set<string> {
    return this.options.ownerRegistry.activeConversationIds(this.options.runtime, projectPath);
  }

  public activeIds(): string[] {
    return [...this.active.keys()];
  }

  public getSnapshot(conversationId: string): ConversationSnapshot | undefined {
    return this.active.get(conversationId)?.snapshot;
  }

  /** Main-owned identity for authorizing a live turn; no renderer field participates. */
  public projectPathForActiveConversation(conversationId: string): string {
    return this.requireActive(conversationId).owner.projectPath;
  }

  public dispose(): void {
    this.unsubscribe();
  }

  private consume(event: ConversationEvent): void {
    if (event.runtime !== this.options.runtime) return;
    const current = this.active.get(event.conversationId);
    if (!current) return;
    if (
      current.transfer &&
      event.type === 'conversation.phase' &&
      (event.phase === 'stopped' || event.phase === 'stopping')
    ) {
      return;
    }
    const previousSnapshot = current.snapshot;
    const nextSnapshot = reduceConversationEvent(previousSnapshot, event);
    if (nextSnapshot === previousSnapshot) return;
    current.snapshot = nextSnapshot;
    if (event.type === 'usage.updated') {
      this.options.onUsageReported?.(event.conversationId, current.owner.projectPath);
    }
    if (
      event.type === 'conversation.phase' &&
      (event.phase === 'running' || event.phase === 'requires-action') &&
      current.turnCompletion
    ) {
      current.turnCompletion.started = true;
    }
    if (event.type === 'submission.transcript-confirmed') {
      current.confirmedSubmissions.add(event.clientSubmissionId);
      try {
        this.options.recoveryStore.markSubmission(
          this.options.runtime,
          current.owner.projectPath,
          event.conversationId,
          event.clientSubmissionId,
          'transcript-confirmed',
        );
      } catch {
        // A stale or already reconciled receipt cannot resurrect a removed draft.
      }
      const attachmentIds = current.pendingAttachmentIds.get(event.clientSubmissionId) ?? [];
      current.pendingAttachmentIds.delete(event.clientSubmissionId);
      if (attachmentIds.length > 0) {
        void this.options.onSubmissionConfirmed?.(event.conversationId, attachmentIds);
      }
    }
    if (current.snapshot) this.options.onSnapshot(current.snapshot);
    this.settleTurnIfComplete(current);
    if (
      event.type === 'conversation.error' ||
      (event.type === 'conversation.phase' && ['failed', 'stopped'].includes(event.phase))
    ) {
      this.release(current);
    }
  }

  private buildLaunch(
    conversationId: string,
    input: NativeConversationLaunchInput,
  ): { launchSnapshot: RecoveryLaunchSnapshot; startInput: ConversationStartInput } {
    const launch = input.launch ?? {};
    const launchSnapshot: RecoveryLaunchSnapshot = {
      ...launch,
      configFingerprint: recoveryConfigFingerprint(
        launch.configFingerprintSource ?? {
          effort: launch.effort,
          endpointIdentity: launch.endpointIdentity,
          model: input.model ?? launch.model,
          permissionMode: input.permissionMode ?? launch.permissionMode,
          speed: launch.speed,
        },
      ),
      model: input.model ?? launch.model,
      permissionMode: input.permissionMode ?? launch.permissionMode,
    };
    delete (launchSnapshot as RecoveryLaunchSnapshot & { configFingerprintSource?: unknown })
      .configFingerprintSource;
    const startInput: ConversationStartInput = {
      allowBypassPermissions: input.allowBypassPermissions,
      cliVersion: launch.cliVersion,
      conversationId,
      endpointIdentity: launch.endpointIdentity,
      model: input.model,
      runtimeModel: input.runtimeModel,
      settingsEnvironment: input.settingsEnvironment,
      ownerKind: 'native',
      permissionMode: input.permissionMode,
      projectPath: input.projectPath,
      resume: input.resume === true,
    };
    return { launchSnapshot, startInput };
  }

  private settleTurnIfComplete(current: ActiveConversation): void {
    const completion = current.turnCompletion;
    if (
      completion?.started &&
      current.snapshot &&
      !nativeConversationHasRunningWork(current.snapshot)
    ) {
      this.finishTurn(current, completion);
    }
  }

  private finishTurn(current: ActiveConversation, completion: NativeTurnCompletion): void {
    if (current.turnCompletion === completion) current.turnCompletion = undefined;
    completion.resolveCompleted();
  }

  private release(current: ActiveConversation): void {
    if (this.active.get(current.owner.conversationId) !== current) return;
    if (current.turnCompletion) this.finishTurn(current, current.turnCompletion);
    this.options.ownerRegistry.release(
      current.owner,
      current.owner.ownerId,
      current.owner.generation,
    );
    this.active.delete(current.owner.conversationId);
  }

  private requireActive(conversationId: string): ActiveConversation {
    const current = this.active.get(conversationId);
    if (!current) throw new Error('原生会话不存在或已结束。');
    return current;
  }
}
