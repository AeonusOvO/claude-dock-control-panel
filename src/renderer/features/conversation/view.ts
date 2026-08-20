import type {
  ConversationContentBlock,
  ConversationMessageView,
  ConversationSnapshot,
  ModelCapabilityProfile,
} from '../../../shared/conversation/native';
import type { MarkdownDomRenderer } from '../../platform/markdown';
import type { ConversationState } from './state';

const nativeRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const nativeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
};

export const nativePhaseLabel = (phase: ConversationSnapshot['phase']): string =>
  ({
    failed: '需要处理',
    idle: '可以继续对话',
    'requires-action': '等待你的确认',
    running: 'Claude 正在处理',
    starting: '正在启动 Claude',
    stopped: '会话已停止',
    stopping: '正在停止',
  })[phase];

const nativeToolStatusLabel = (
  status: Extract<ConversationContentBlock, { type: 'tool' }>['status'],
): string =>
  ({
    cancelled: '已取消',
    failed: '失败',
    pending: '等待中',
    running: '运行中',
    succeeded: '已完成',
  })[status];

const appendNativeTool = (
  container: HTMLElement,
  block: Extract<ConversationContentBlock, { type: 'tool' }>,
): void => {
  const details = document.createElement('details');
  details.className = 'native-tool';
  details.dataset.status = block.status;
  details.open =
    block.status === 'pending' ||
    block.status === 'running' ||
    block.status === 'failed' ||
    ['Bash', 'Edit', 'Write', 'NotebookEdit'].includes(block.name);
  const summary = document.createElement('summary');
  const state = document.createElement('span');
  state.className = 'native-tool__state';
  state.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'native-tool__name';
  name.textContent = block.summary || block.name;
  const status = document.createElement('span');
  status.className = 'native-tool__status';
  status.textContent = nativeToolStatusLabel(block.status);
  summary.append(state, name, status);
  const payload = document.createElement('div');
  payload.className = 'native-tool__details';
  const input = document.createElement('pre');
  input.textContent = nativeJson(block.input);
  payload.append(input);
  if (block.output !== undefined) {
    const output = document.createElement('pre');
    output.textContent = nativeJson(block.output);
    payload.append(output);
  }
  details.append(summary, payload);
  container.append(details);
};

/**
 * O(1) change probe. The reducer bumps `version` on every mutation, so this is enough to decide
 * whether a message's DOM needs rebuilding. It used to be `JSON.stringify(message)`, which
 * serialized the entire transcript — including full tool inputs and outputs — on every animation
 * frame of a stream, and was the single largest cause of the long-session freeze.
 *
 * The fallback keeps snapshots produced before `version` existed (or by a fake adapter that builds
 * message views directly) from being treated as permanently unchanged.
 */
export const nativeMessageRenderKey = (message: ConversationMessageView): string =>
  message.version === undefined
    ? `${message.id}:nover:${message.status}:${message.blocks
        .map((block) =>
          block.type === 'tool'
            ? `${block.id}~${block.status}~${block.summary ?? ''}`
            : 'text' in block
              ? `${block.id}~${block.text.length}`
              : block.id,
        )
        .join('|')}`
    : `${message.id}:${message.version}`;

/**
 * Rendered markdown, keyed by block id, per message element. A tool progress tick arrives roughly
 * once a second and changes only a status string, but it rebuilds the whole message — without this
 * every sibling text block would be re-lexed and re-highlighted through Shiki each time.
 */
const nativeRenderedMarkdown = new WeakMap<
  HTMLElement,
  Map<string, { node: HTMLElement; text: string }>
>();

export const nativeInteractionButton = (
  label: string,
  primary: boolean,
  action: () => void,
): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = primary ? 'button button--compact button--primary' : 'button button--compact';
  button.addEventListener('click', action);
  return button;
};

export const appendNativeQuestionFields = (
  form: HTMLFormElement,
  questions: unknown[],
): (() => Record<string, unknown>) => {
  const answerFields: Array<{
    multi: boolean;
    name: string;
    question: string;
  }> = [];
  for (const [index, rawQuestion] of questions.entries()) {
    const question = nativeRecord(rawQuestion);
    if (!question) continue;
    const prompt = typeof question.question === 'string' ? question.question : `问题 ${index + 1}`;
    const header = typeof question.header === 'string' ? question.header : prompt;
    const multi = question.multiSelect === true;
    const name = `native-question-${index}`;
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'native-interaction__options';
    const legend = document.createElement('legend');
    legend.textContent = header;
    fieldset.append(legend);
    const options = Array.isArray(question.options) ? question.options : [];
    for (const [optionIndex, rawOption] of options.entries()) {
      const option = nativeRecord(rawOption);
      if (!option) continue;
      const labelText = typeof option.label === 'string' ? option.label : `选项 ${optionIndex + 1}`;
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = multi ? 'checkbox' : 'radio';
      input.name = name;
      input.value = labelText;
      input.required = !multi;
      const copy = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = labelText;
      copy.append(strong);
      if (typeof option.description === 'string' && option.description) {
        const description = document.createElement('small');
        description.textContent = option.description;
        copy.append(description);
      }
      row.append(input, copy);
      fieldset.append(row);
    }
    form.append(fieldset);
    answerFields.push({ multi, name, question: prompt });
  }
  return () => {
    const answers: Record<string, string | string[]> = {};
    for (const field of answerFields) {
      const selected = [
        ...form.querySelectorAll<HTMLInputElement>(`[name="${field.name}"]:checked`),
      ].map((input) => input.value);
      answers[field.question] = field.multi ? selected : (selected[0] ?? '');
    }
    return { answers };
  };
};

export const appendNativeMcpFields = (
  form: HTMLFormElement,
  schema: Record<string, unknown> | undefined,
): (() => Record<string, unknown>) => {
  const properties = nativeRecord(schema?.properties) ?? {};
  const fields: Array<{ key: string; input: HTMLInputElement }> = [];
  for (const [key, rawDefinition] of Object.entries(properties)) {
    const definition = nativeRecord(rawDefinition);
    const label = document.createElement('label');
    label.className = 'native-interaction__field';
    const caption = document.createElement('span');
    caption.textContent = typeof definition?.title === 'string' ? definition.title : key;
    const input = document.createElement('input');
    input.type =
      definition?.type === 'number' || definition?.type === 'integer' ? 'number' : 'text';
    input.name = key;
    input.required = Array.isArray(schema?.required) && schema.required.includes(key);
    if (typeof definition?.description === 'string') input.placeholder = definition.description;
    label.append(caption, input);
    form.append(label);
    fields.push({ input, key });
  }
  return () =>
    Object.fromEntries(
      fields.map(({ input, key }) => [
        key,
        input.type === 'number' && input.value ? Number(input.value) : input.value,
      ]),
    );
};

export const nativeEffortLabel = (effort: string): string =>
  ({
    auto: '跟随模型',
    high: '均衡',
    low: '最低',
    max: '最大',
    medium: '较低',
    ultracode: 'Ultra Code',
    xhigh: '更深 · X-High',
  })[effort] ?? effort;

export const nativePermissionLabel = (mode: string): string =>
  ({
    acceptEdits: '自动接受修改',
    auto: '智能权限',
    bypassPermissions: '完全允许',
    default: '逐项确认',
    dontAsk: '仅预批准',
    plan: '规划模式',
  })[mode] ?? mode;

export const nativePermissionDescription = (mode: string): string =>
  ({
    acceptEdits: '文件修改自动通过，其余动作仍按规则确认。',
    auto: '由 Claude Code 的权限分类器判断是否放行动作。',
    bypassPermissions: '跳过工具权限确认；仅在项目已开启高风险预置时提供。',
    default: '未预先批准的动作逐项显示权限确认。',
    dontAsk: '未预先批准的动作直接拒绝；你明确要求选项时仍可显示结构化选择题。',
    plan: '只读探索并先给出计划，不直接修改项目。',
  })[mode] ?? mode;

const nativeFastLabel = (state: ModelCapabilityProfile['fast']['state']): string =>
  ({
    confirmed: 'Fast 已确认',
    fallback: 'Fast 已回退',
    off: 'Fast 关闭',
    requested: 'Fast 已请求',
    unavailable: 'Fast 不可用',
  })[state];

/**
 * Fast is reported in five states because "requested" and "confirmed" are genuinely different
 * claims: ClaudeDock only ever says confirmed when the adapter saw a structured acknowledgement.
 */
export const nativeFastDetail = (fast: ModelCapabilityProfile['fast']): string => {
  const mechanism = fast.mechanism ? ` · ${fast.mechanism}` : '';
  if (fast.state === 'unavailable') return '当前模型没有声明支持 Fast。';
  if (fast.state === 'off') return '点击请求 Fast；额度消耗或计价可能更高。';
  if (fast.state === 'requested') {
    return `已向上游请求 Fast${mechanism}；上游返回结构化确认前不会显示为已确认。`;
  }
  if (fast.state === 'confirmed') return `上游已确认 Fast${mechanism}；点击可关闭。`;
  return `Fast 请求已回退到标准档${mechanism}；点击可重新请求。`;
};

export interface ConversationViewDependencies {
  footerEffort: HTMLButtonElement;
  footerMode: HTMLButtonElement;
  footerModel: HTMLButtonElement;
  footerSpeed: HTMLButtonElement;
  getMarkdownRenderer: () => MarkdownDomRenderer;
}

export interface ConversationView {
  nativeActivePermissionMode: (snapshot: ConversationSnapshot) => string | undefined;
  renderNativeFooter: (snapshot: ConversationSnapshot) => void;
  renderNativeMessage: (message: ConversationMessageView) => HTMLElement;
  updateNativeMessage: (
    article: HTMLElement,
    message: ConversationMessageView,
    renderKey?: string,
  ) => void;
}

export const createConversationView = (
  state: ConversationState,
  dependencies: ConversationViewDependencies,
): ConversationView => {
  /**
   * Which permission mode ClaudeDock last dispatched, per conversation. `ModelCapabilityProfile`
   * enumerates the modes a model supports; it does not report which one is active, so the requested
   * value is the only record of what the user chose.
   */
  const nativeActivePermissionMode = (snapshot: ConversationSnapshot): string | undefined =>
    state.nativePermissionModes.get(snapshot.conversationId) ??
    snapshot.capabilities?.permissionModes[0];

  const updateNativeMessage = (
    article: HTMLElement,
    message: ConversationMessageView,
    renderKey = nativeMessageRenderKey(message),
  ): void => {
    article.className = `native-message native-message--${message.role}`;
    article.dataset.nativeMessageId = message.id;
    article.classList.toggle('native-message--streaming', message.status === 'streaming');
    article.setAttribute('aria-busy', String(message.status === 'streaming'));
    const label = document.createElement('strong');
    label.className = 'native-message__label';
    if (message.role === 'assistant') {
      const terminalMark = document.createElement('span');
      terminalMark.className = 'native-message__terminal-mark';
      terminalMark.setAttribute('aria-hidden', 'true');
      terminalMark.textContent = '>_';
      label.append(terminalMark, document.createTextNode(' Claude'));
    } else {
      label.textContent = message.role === 'user' ? '你' : '系统';
    }
    const body = document.createElement('div');
    body.className = 'native-message__body';
    const cached = nativeRenderedMarkdown.get(article);
    const rendered = new Map<string, { node: HTMLElement; text: string }>();
    let streamingTextMount: HTMLElement | undefined;
    for (const block of message.blocks) {
      if (block.type === 'text') {
        if (message.role === 'assistant' && message.status !== 'streaming') {
          const reusable = cached?.get(block.id);
          if (reusable && reusable.text === block.text) {
            body.append(reusable.node);
            rendered.set(block.id, reusable);
            continue;
          }
          const mount = document.createElement('div');
          mount.className = 'chat-message__markdown';
          body.append(mount);
          rendered.set(block.id, { node: mount, text: block.text });
          void dependencies.getMarkdownRenderer().renderInto(mount, block.text);
          continue;
        }
        const mount = document.createElement('div');
        mount.className = 'chat-message__markdown';
        body.append(mount);
        if (message.role === 'assistant') {
          mount.classList.add('native-message__stream-text');
          streamingTextMount = mount;
        }
        mount.textContent = block.text;
        continue;
      }
      if (block.type === 'thinking') {
        const thinking = document.createElement('div');
        thinking.className = 'native-thinking';
        thinking.textContent = block.text;
        body.append(thinking);
        continue;
      }
      if (block.type === 'tool') {
        appendNativeTool(body, block);
        continue;
      }
      const image = document.createElement('div');
      image.className = 'chat-attachment-card chat-attachment-card--image';
      image.textContent = block.name;
      body.append(image);
    }
    if (message.status === 'streaming') {
      const caret = document.createElement('span');
      caret.className = 'native-message__stream-caret';
      caret.setAttribute('aria-hidden', 'true');
      (streamingTextMount ?? body).append(caret);
    }
    article.replaceChildren(label, body);
    nativeRenderedMarkdown.set(article, rendered);
    state.nativeMessageRenderKeys.set(article, renderKey);
  };

  const renderNativeMessage = (message: ConversationMessageView): HTMLElement => {
    const article = document.createElement('article');
    updateNativeMessage(article, message);
    return article;
  };

  /**
   * Renders the four footer chips from an Agent SDK snapshot. Native mode has no PowerShell status
   * line, so `capabilities` is the only truth available; the terminal-side renderer is suppressed
   * wholesale while this runs, otherwise the chips flicker between two different sources of truth.
   */
  const renderNativeFooter = (snapshot: ConversationSnapshot): void => {
    const capability = snapshot.capabilities;
    const busy = state.nativeControlsUpdating;
    for (const chip of [
      dependencies.footerModel,
      dependencies.footerSpeed,
      dependencies.footerMode,
      dependencies.footerEffort,
    ]) {
      chip.setAttribute('aria-busy', String(busy));
    }
    if (!capability) {
      const pending = '原生会话尚未上报可用能力，请稍候。';
      dependencies.footerModel.textContent = '模型 —';
      dependencies.footerSpeed.textContent = 'Fast —';
      dependencies.footerMode.textContent = '模式 —';
      dependencies.footerEffort.textContent = '思考 —';
      delete dependencies.footerSpeed.dataset.state;
      for (const chip of [
        dependencies.footerModel,
        dependencies.footerSpeed,
        dependencies.footerMode,
        dependencies.footerEffort,
      ]) {
        chip.disabled = true;
        chip.title = pending;
      }
      return;
    }
    const modelLabel =
      capability.models?.find((model) => model.id === capability.model)?.label ?? capability.model;
    dependencies.footerModel.textContent = `模型 ${modelLabel}`;
    dependencies.footerModel.disabled = busy || (capability.models?.length ?? 1) < 2;
    dependencies.footerModel.title =
      (capability.models?.length ?? 1) < 2
        ? '当前接入只暴露了一个模型。'
        : '点击切换模型；切换会在同一段对话内生效。';

    dependencies.footerSpeed.textContent = nativeFastLabel(capability.fast.state);
    dependencies.footerSpeed.dataset.state = capability.fast.state;
    dependencies.footerSpeed.disabled = busy || capability.fast.state === 'unavailable';
    dependencies.footerSpeed.title = nativeFastDetail(capability.fast);

    const permissionMode = snapshot.capabilities?.permissionModes[0];
    const activePermissionMode = nativeActivePermissionMode(snapshot) ?? permissionMode;
    dependencies.footerMode.textContent = `模式 ${activePermissionMode ? nativePermissionLabel(activePermissionMode) : '—'}`;
    dependencies.footerMode.dataset.mode = activePermissionMode ?? 'unknown';
    dependencies.footerMode.disabled = busy || capability.permissionModes.length === 0;
    dependencies.footerMode.title = activePermissionMode
      ? nativePermissionDescription(activePermissionMode)
      : '当前会话没有上报可用的权限模式。';

    // The requested level is what the user asked for; `applied` is what Claude Code actually ran at
    // and can sit lower when the model caps it. Showing only one of them would be dishonest.
    const requestedEffort = capability.effort.requested;
    const appliedEffort = capability.effort.applied;
    const shownEffort = requestedEffort ?? appliedEffort;
    dependencies.footerEffort.textContent = `思考 ${shownEffort ? nativeEffortLabel(shownEffort) : '—'}`;
    dependencies.footerEffort.dataset.effort = shownEffort ?? 'unknown';
    dependencies.footerEffort.dataset.requestedEffort = requestedEffort ?? 'unknown';
    dependencies.footerEffort.dataset.appliedEffort = appliedEffort ?? 'unknown';
    dependencies.footerEffort.disabled = busy || capability.effort.options.length === 0;
    const effortDescription =
      shownEffort === 'ultracode'
        ? '工作流编排；实际思考档位为 X-High，仅作用于当前会话。'
        : requestedEffort && appliedEffort && requestedEffort !== appliedEffort
          ? `请求：${nativeEffortLabel(requestedEffort)} · 实际：${nativeEffortLabel(appliedEffort)}；点击调整思考程度。`
          : '选择当前模型支持的思考档位。';
    dependencies.footerEffort.title = effortDescription;
    dependencies.footerEffort.setAttribute('aria-description', effortDescription);
  };

  return {
    nativeActivePermissionMode,
    renderNativeFooter,
    renderNativeMessage,
    updateNativeMessage,
  };
};
