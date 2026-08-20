import { requiredElement } from '../platform/dom';
import { projectNameFromPath, resultFailureMessage } from '../platform/format';
import type { RuntimeActivitySnapshot, TerminalStatus } from '../../shared/contracts';
import type { ConversationSnapshot } from '../../shared/conversation/native';
import {
  NATIVE_TASK_KIND_LABELS,
  NATIVE_TASK_STATUS_LABELS,
  RUNTIME_PHASE_LABELS,
  RUNTIME_TASK_KIND_LABELS,
  RUNTIME_TASK_STATUS_LABELS,
  runtimeSummaryTaskIcon,
  type RuntimeSummaryIconKind,
} from './runtime-activity-labels';
import { createRuntimeSummaryEmpty, createRuntimeSummaryRow } from './runtime-activity-rows';
import type { RuntimeActivityShellDeps } from './runtime-activity-dependencies';

const runtimeEnvironmentList = requiredElement<HTMLUListElement>('#runtime-environment-list');
const runtimeTaskList = requiredElement<HTMLUListElement>('#runtime-task-list');
const runtimeSourceMeta = requiredElement<HTMLElement>('#runtime-source-meta');
const runtimeSourceList = requiredElement<HTMLUListElement>('#runtime-source-list');
const runtimeProcessList = requiredElement<HTMLUListElement>('#runtime-process-list');

export interface RuntimeActivityListsInput {
  active: TerminalStatus | undefined;
  nativeSnapshot: ConversationSnapshot | undefined;
  nativeTasks: ConversationSnapshot['tasks'];
  state: RuntimeActivitySnapshot | undefined;
  webProcesses: RuntimeActivitySnapshot['webProcesses'];
}

export interface RuntimeActivityListsActions {
  renderRuntimeActivityLists: (input: RuntimeActivityListsInput) => void;
}

export const createRuntimeActivityListsActions = (
  deps: Pick<RuntimeActivityShellDeps, 'nativePhaseLabel' | 'openExternal' | 'showToast'>,
  renderRuntimeActivity: (snapshot?: RuntimeActivitySnapshot) => void,
): RuntimeActivityListsActions => {
  const { nativePhaseLabel, openExternal, showToast } = deps;

  const renderRuntimeActivityLists = ({
    active,
    nativeSnapshot,
    nativeTasks,
    state,
    webProcesses,
  }: RuntimeActivityListsInput): void => {
    const environmentRows: Array<[RuntimeSummaryIconKind, string, string]> = [
      ['project', '项目', active ? projectNameFromPath(active.cwd) : '未打开'],
      ['interface', '界面', nativeSnapshot ? '原生对话 · Agent SDK' : '安全终端 · ConPTY'],
      ['model', '模型', nativeSnapshot?.capabilities?.model ?? '等待运行时上报'],
      [
        'foreground',
        '前台',
        nativeSnapshot
          ? nativePhaseLabel(nativeSnapshot.phase)
          : state
            ? RUNTIME_PHASE_LABELS[state.phase]
            : '未运行',
      ],
    ];
    runtimeEnvironmentList.replaceChildren(
      ...environmentRows.map(([icon, title, detail]) =>
        createRuntimeSummaryRow({ detail, environment: true, icon, title }),
      ),
    );

    runtimeTaskList.replaceChildren(
      ...(state?.tasks ?? []).map((task) => {
        const details = [
          RUNTIME_TASK_KIND_LABELS[task.kind],
          task.agentType,
          task.tokenUse === 'likely' ? '持续使用模型' : undefined,
          task.tokenUse === 'none' ? '本地执行' : undefined,
          task.willWakeParent === true ? '完成后返回主对话' : undefined,
        ].filter((part): part is string => Boolean(part));
        return createRuntimeSummaryRow({
          detail: details.join(' · '),
          icon: runtimeSummaryTaskIcon(task.kind),
          status: task.status,
          statusLabel: RUNTIME_TASK_STATUS_LABELS[task.status],
          title: task.description,
        });
      }),
      ...nativeTasks.map((task) => {
        let stop: HTMLButtonElement | undefined;
        if (task.cancellable && ['queued', 'running', 'waiting'].includes(task.status)) {
          stop = document.createElement('button');
          stop.className = 'button button--compact button--quiet runtime-summary-row__action';
          stop.type = 'button';
          stop.textContent = '停止';
          stop.addEventListener('click', () => {
            stop!.disabled = true;
            stop!.textContent = '停止中…';
            void window.controlPanel
              .stopNativeConversationTask(nativeSnapshot!.conversationId, task.id)
              .then((result) => {
                if (!result.ok)
                  showToast(resultFailureMessage(result, '无法停止这项任务。'), 'error');
              })
              .catch(() => showToast('无法停止这项任务。', 'error'));
          });
        }
        return createRuntimeSummaryRow({
          action: stop,
          detail: [NATIVE_TASK_KIND_LABELS[task.kind], task.summary]
            .filter((part): part is string => Boolean(part))
            .join(' · '),
          icon: runtimeSummaryTaskIcon(task.kind),
          status: task.status,
          statusLabel: NATIVE_TASK_STATUS_LABELS[task.status],
          title: task.description,
        });
      }),
    );
    if ((state?.tasks.length ?? 0) + nativeTasks.length === 0) {
      runtimeTaskList.append(createRuntimeSummaryEmpty('本轮没有检测到子智能体或后台任务'));
    }

    runtimeProcessList.replaceChildren(
      ...webProcesses.map((process) => {
        const terminate = document.createElement('button');
        terminate.className = 'button button--compact button--quiet runtime-summary-row__action';
        terminate.type = 'button';
        terminate.textContent = process.status === 'stopping' ? '结束中…' : '结束';
        terminate.disabled = process.status === 'stopping';
        const item = createRuntimeSummaryRow({
          action: terminate,
          detail: process.commandSummary,
          icon: 'process',
          status: process.status === 'stopping' ? 'waiting' : 'running',
          statusLabel: process.status === 'stopping' ? '正在结束' : `PID ${process.pid}`,
          title: process.name,
        });
        const copy = item.querySelector<HTMLElement>('.runtime-summary-row__copy')!;
        for (const target of process.urls) {
          const link = document.createElement('a');
          link.href = target.url;
          link.textContent = `${target.url}（${target.confirmed ? '已确认' : '由监听端口推断'}）`;
          link.addEventListener('click', (event) => {
            event.preventDefault();
            void openExternal(target.url);
          });
          copy.append(link);
        }
        if (process.exposureWarning) {
          const warning = document.createElement('span');
          warning.textContent = process.exposureWarning;
          copy.append(warning);
        }
        terminate.addEventListener('click', () => {
          terminate.disabled = true;
          terminate.textContent = '结束中…';
          void window.controlPanel
            .terminateRuntimeProcess(state!.sessionId, process.processKey)
            .then(renderRuntimeActivity)
            .catch(() => showToast('无法结束该 Web 进程；所有权可能已经变化。', 'error'));
        });
        return item;
      }),
    );
    const sources = [
      nativeSnapshot ? 'Claude Agent SDK' : undefined,
      nativeSnapshot ? '本机 Claude Code CLI' : state ? 'Claude Code 运行事件' : undefined,
    ].filter((source): source is string => Boolean(source));
    runtimeSourceMeta.textContent = `${sources.length + webProcesses.length} 项`;
    runtimeSourceList.replaceChildren(
      ...sources.map((source) => createRuntimeSummaryRow({ icon: 'source', title: source })),
    );
    if (sources.length === 0 && webProcesses.length === 0) {
      runtimeSourceList.append(createRuntimeSummaryEmpty('暂无活动来源'));
    }
  };

  return { renderRuntimeActivityLists };
};
