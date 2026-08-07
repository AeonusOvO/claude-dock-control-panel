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
  NativeConversationDraftResult,
  NativeConversationOperationResult,
  NativeConversationStartResult,
  NativeConversationTerminalTransferResult,
} from '../shared/native-conversation';
import { reduceConversationEvent } from '../shared/conversation-reducer';
import {
  ConversationOwnerRegistry,
  type ConversationOwner,
  type ConversationTransfer,
} from './conversation-owner-registry';
import {
  ConversationRecoveryStore,
  recoveryConfigFingerprint,
  type ConversationRecoveryView,
  type RecoveryLaunchSnapshot,
} from './conversation-recovery-store';

interface ActiveConversation {
  confirmedSubmissions: Set<string>;
  launch: RecoveryLaunchSnapshot;
  owner: ConversationOwner;
  pendingAttachmentIds: Map<string, string[]>;
  snapshot?: ConversationSnapshot;
  startInput: ConversationStartInput;
  transfer?: ConversationTransfer;
}

export interface NativeConversationServiceOptions {
  adapter: ConversationAdapter;
  onSnapshot: (snapshot: ConversationSnapshot) => void;
  onSubmissionConfirmed?: (conversationId: string, attachmentIds: string[]) => void | Promise<void>;
  ownerRegistry: ConversationOwnerRegistry;
  recoveryStore: ConversationRecoveryStore;
  runtime: ConversationRuntime;
}

export interface NativeConversationLaunchInput {
  conversationId?: string;
  launch?: Omit<RecoveryLaunchSnapshot, 'configFingerprint'> & {
    configFingerprintSource?: unknown;
  };
  model?: string;
  permissionMode?: string;
  projectPath: string;
  resume?: boolean;
}

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
    this.options.recoveryStore.reserve({
      conversationId,
      launch: launchSnapshot,
      ownerKind: 'native',
      projectPath: input.projectPath,
      runtime: this.options.runtime,
    });
    const startInput: ConversationStartInput = {
      cliVersion: launch.cliVersion,
      conversationId,
      endpointIdentity: launch.endpointIdentity,
      model: input.model,
      ownerKind: 'native',
      permissionMode: input.permissionMode,
      projectPath: input.projectPath,
      resume: input.resume === true,
    };
    this.active.set(conversationId, {
      confirmedSubmissions: new Set(),
      launch: launchSnapshot,
      owner,
      pendingAttachmentIds: new Map(),
      startInput,
    });
    try {
      await this.options.adapter.start(startInput);
      this.options.ownerRegistry.updatePhase(owner, owner.ownerId, generation, 'active');
      return {
        conversationId,
        ok: true,
        reused: false,
        snapshot: this.active.get(conversationId)?.snapshot,
      };
    } catch (error) {
      this.active.delete(conversationId);
      this.options.ownerRegistry.release(owner, owner.ownerId, generation);
      // A failed brand-new launch has no Claude transcript or useful recovery state. Keeping the
      // just-reserved row would turn a startup error into a false "interrupted conversation" card
      // on the next render. Exact resumes keep their existing recovery entry so the user can retry.
      if (!input.resume) {
        this.options.recoveryStore.discard(this.options.runtime, input.projectPath, conversationId);
      }
      return {
        conversationId,
        message: error instanceof Error ? error.message : 'Claude 原生会话启动失败。',
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
        message: error instanceof Error ? error.message : '无法安全保存本次输入，内容尚未发送。',
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
        message: error instanceof Error ? error.message : '本次输入未能交给 Claude。',
        ok: false,
        snapshot: current.snapshot,
      };
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
        message: error instanceof Error ? error.message : '交互响应失败。',
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
        message: error instanceof Error ? error.message : '无法中断当前轮次。',
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
        message: error instanceof Error ? error.message : '无法停止后台任务。',
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
        message: error instanceof Error ? error.message : '无法更新当前模型控制项。',
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
        message: error instanceof Error ? error.message : '无法关闭原生会话。',
        ok: false,
        snapshot: current.snapshot,
      };
    }
  }

  public async closeAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((conversationId) => this.close(conversationId)));
  }

  public async transferToTerminal(
    conversationId: string,
    draft: ConversationSubmitInput | undefined,
    startTerminal: (identity: {
      conversationId: string;
      projectPath: string;
    }) => Promise<{ owner: ConversationOwner; terminalSessionId: string }>,
  ): Promise<NativeConversationTerminalTransferResult> {
    const current = this.requireActive(conversationId);
    if (current.transfer) {
      return { message: '该对话正在切换界面。', ok: false, snapshot: current.snapshot };
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
          message:
            error instanceof Error ? error.message : '无法安全保存当前草稿，尚未切换到高级终端。',
          ok: false,
          snapshot: current.snapshot,
        };
      }
    }
    const transfer = this.options.ownerRegistry.beginTransfer(current.owner, current.owner.ownerId);
    current.transfer = transfer;
    try {
      await this.options.adapter.close(conversationId);
      const terminal = await startTerminal({
        conversationId,
        projectPath: current.owner.projectPath,
      });
      this.options.ownerRegistry.commitTransfer(transfer, terminal.owner);
      this.options.recoveryStore.reserve({
        conversationId,
        launch: current.launch,
        ownerKind: 'terminal',
        projectPath: current.owner.projectPath,
        runtime: this.options.runtime,
      });
      this.active.delete(conversationId);
      return {
        message: draft ? '已保存草稿并切换到高级终端。' : '已切换到高级终端。',
        ok: true,
        snapshot: current.snapshot,
        terminalSessionId: terminal.terminalSessionId,
      };
    } catch (error) {
      try {
        await this.options.adapter.start({ ...current.startInput, resume: true });
        this.options.ownerRegistry.rollbackTransfer(transfer);
        current.transfer = undefined;
      } catch {
        this.options.ownerRegistry.rollbackTransfer(transfer);
        this.release(current);
      }
      return {
        message:
          error instanceof Error
            ? `${error.message}；已尝试恢复原生界面。`
            : '高级终端启动失败；已尝试恢复原生界面。',
        ok: false,
        snapshot: current.snapshot,
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
        message: error instanceof Error ? error.message : '无法恢复草稿。',
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
    current.snapshot = reduceConversationEvent(current.snapshot, event);
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
    if (event.type === 'conversation.phase' && ['failed', 'stopped'].includes(event.phase)) {
      this.release(current);
    }
  }

  private release(current: ActiveConversation): void {
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
