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

interface NativeTextBlockDomState {
  id: string;
  markdownGeneration: number;
  markdownMessageStatus: ConversationMessageView['status'] | undefined;
  markdownSource: string | undefined;
  markdownState: 'failed' | 'pending' | 'plain' | 'rendered';
  mount: HTMLElement;
  source: string;
  text: Text;
  type: 'text';
}

interface NativeThinkingBlockDomState {
  id: string;
  mount: HTMLElement;
  source: string;
  text: Text;
  type: 'thinking';
}

interface NativeToolBlockDomState {
  id: string;
  input: HTMLElement;
  inputText: string;
  mount: HTMLDetailsElement;
  name: HTMLElement;
  nameText: string;
  output: HTMLElement | undefined;
  outputText: string | undefined;
  payload: HTMLElement;
  status: HTMLElement;
  statusValue: Extract<ConversationContentBlock, { type: 'tool' }>['status'];
  toolName: string;
  type: 'tool';
}

interface NativeImageBlockDomState {
  id: string;
  mount: HTMLElement;
  name: string;
  type: 'image';
}

type NativeBlockDomState =
  | NativeImageBlockDomState
  | NativeTextBlockDomState
  | NativeThinkingBlockDomState
  | NativeToolBlockDomState;

interface NativeMessageDomState {
  blocks: Map<string, NativeBlockDomState>;
  body: HTMLElement;
  caret: HTMLElement;
  label: HTMLElement;
  role: ConversationMessageView['role'] | undefined;
  status: ConversationMessageView['status'];
}

const updateNativeTextNode = (text: Text, previous: string, next: string): void => {
  if (previous === next) return;
  if (next.startsWith(previous)) {
    text.appendData(next.slice(previous.length));
    return;
  }
  text.data = next;
};

const nativeToolStartsOpen = (
  block: Extract<ConversationContentBlock, { type: 'tool' }>,
): boolean =>
  block.status === 'pending' ||
  block.status === 'running' ||
  block.status === 'failed' ||
  ['Bash', 'Edit', 'Write', 'NotebookEdit'].includes(block.name);

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
    ? JSON.stringify([
        message.id,
        message.role,
        message.status,
        message.blocks.map((block) =>
          block.type === 'tool'
            ? [
                block.id,
                block.type,
                block.name,
                block.status,
                block.summary,
                block.output !== undefined,
              ]
            : block.type === 'image'
              ? [block.id, block.type, block.name]
              : [block.id, block.type, block.text],
        ),
      ])
    : `${message.id}:${message.version}`;

interface NativeMessageRenderer {
  render: (message: ConversationMessageView) => HTMLElement;
  update: (article: HTMLElement, message: ConversationMessageView, renderKey?: string) => void;
}

interface NativeMessageRenderContext {
  domStates: WeakMap<HTMLElement, NativeMessageDomState>;
  getMarkdownRenderer: () => MarkdownDomRenderer;
}

const createNativeBlockDomState = (block: ConversationContentBlock): NativeBlockDomState => {
  if (block.type === 'text') {
    const mount = document.createElement('div');
    mount.className = 'chat-message__markdown';
    const text = document.createTextNode('');
    mount.append(text);
    return {
      id: block.id,
      markdownGeneration: 0,
      markdownMessageStatus: undefined,
      markdownSource: undefined,
      markdownState: 'plain',
      mount,
      source: '',
      text,
      type: 'text',
    };
  }
  if (block.type === 'thinking') {
    const mount = document.createElement('div');
    mount.className = 'native-thinking';
    const text = document.createTextNode('');
    mount.append(text);
    return { id: block.id, mount, source: '', text, type: 'thinking' };
  }
  if (block.type === 'image') {
    const mount = document.createElement('div');
    mount.className = 'chat-attachment-card chat-attachment-card--image';
    mount.textContent = block.name;
    return { id: block.id, mount, name: block.name, type: 'image' };
  }

  const mount = document.createElement('details');
  mount.className = 'native-tool';
  mount.dataset.status = block.status;
  mount.open = nativeToolStartsOpen(block);
  const summary = document.createElement('summary');
  const state = document.createElement('span');
  state.className = 'native-tool__state';
  state.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'native-tool__name';
  const nameText = block.summary || block.name;
  name.textContent = nameText;
  const status = document.createElement('span');
  status.className = 'native-tool__status';
  status.textContent = nativeToolStatusLabel(block.status);
  summary.append(state, name, status);
  const payload = document.createElement('div');
  payload.className = 'native-tool__details';
  const input = document.createElement('pre');
  const inputText = nativeJson(block.input);
  input.textContent = inputText;
  payload.append(input);
  const outputText = block.output === undefined ? undefined : nativeJson(block.output);
  const output = outputText === undefined ? undefined : document.createElement('pre');
  if (output && outputText !== undefined) {
    output.textContent = outputText;
    payload.append(output);
  }
  mount.append(summary, payload);
  return {
    id: block.id,
    input,
    inputText,
    mount,
    name,
    nameText,
    output,
    outputText,
    payload,
    status,
    statusValue: block.status,
    toolName: block.name,
    type: 'tool',
  };
};

const updateNativeToolBlock = (
  state: NativeToolBlockDomState,
  block: Extract<ConversationContentBlock, { type: 'tool' }>,
): void => {
  const nameText = block.summary || block.name;
  const shouldOpen =
    (state.statusValue !== block.status || state.toolName !== block.name) &&
    nativeToolStartsOpen(block);
  if (state.statusValue !== block.status) {
    state.statusValue = block.status;
    state.mount.dataset.status = block.status;
    state.status.textContent = nativeToolStatusLabel(block.status);
  }
  if (state.nameText !== nameText) {
    state.nameText = nameText;
    state.name.textContent = nameText;
  }
  state.toolName = block.name;
  if (shouldOpen) state.mount.open = true;

  const inputText = nativeJson(block.input);
  if (state.inputText !== inputText) {
    state.inputText = inputText;
    state.input.textContent = inputText;
  }
  const outputText = block.output === undefined ? undefined : nativeJson(block.output);
  if (outputText === undefined) {
    state.output?.remove();
    state.output = undefined;
  } else if (!state.output) {
    state.output = document.createElement('pre');
    state.output.textContent = outputText;
    state.payload.append(state.output);
  } else if (state.outputText !== outputText) {
    state.output.textContent = outputText;
  }
  state.outputText = outputText;
};

const invalidateNativeBlock = (block: NativeBlockDomState): void => {
  if (block.type === 'text') block.markdownGeneration += 1;
};

const nativeMarkdownRenderIsCurrent = (
  context: NativeMessageRenderContext,
  article: HTMLElement,
  messageState: NativeMessageDomState,
  blockState: NativeTextBlockDomState,
  source: string,
  messageStatus: ConversationMessageView['status'],
  generation: number,
): boolean =>
  context.domStates.get(article) === messageState &&
  messageState.blocks.get(blockState.id) === blockState &&
  messageState.role === 'assistant' &&
  messageState.status === messageStatus &&
  blockState.markdownGeneration === generation &&
  blockState.markdownMessageStatus === messageStatus &&
  blockState.markdownSource === source &&
  blockState.markdownState === 'pending';

const renderNativeMarkdown = (
  context: NativeMessageRenderContext,
  article: HTMLElement,
  messageState: NativeMessageDomState,
  blockState: NativeTextBlockDomState,
  source: string,
  messageStatus: ConversationMessageView['status'],
): void => {
  const generation = blockState.markdownGeneration + 1;
  blockState.markdownGeneration = generation;
  blockState.markdownMessageStatus = messageStatus;
  blockState.markdownSource = source;
  blockState.markdownState = 'pending';
  if (blockState.mount.firstChild !== blockState.text || blockState.mount.childNodes.length !== 1) {
    blockState.mount.replaceChildren(blockState.text);
  }
  void context
    .getMarkdownRenderer()
    .renderFragment(source)
    .then((fragment) => {
      if (
        !nativeMarkdownRenderIsCurrent(
          context,
          article,
          messageState,
          blockState,
          source,
          messageStatus,
          generation,
        )
      ) {
        return;
      }
      blockState.mount.replaceChildren(fragment);
      blockState.markdownState = 'rendered';
    })
    .catch(() => {
      if (
        !nativeMarkdownRenderIsCurrent(
          context,
          article,
          messageState,
          blockState,
          source,
          messageStatus,
          generation,
        )
      ) {
        return;
      }
      blockState.mount.replaceChildren(blockState.text);
      blockState.markdownState = 'failed';
    });
};

const updateNativeTextBlock = (
  context: NativeMessageRenderContext,
  article: HTMLElement,
  messageState: NativeMessageDomState,
  blockState: NativeTextBlockDomState,
  block: Extract<ConversationContentBlock, { type: 'text' }>,
): void => {
  const previousSource = blockState.source;
  updateNativeTextNode(blockState.text, previousSource, block.text);
  blockState.source = block.text;
  const renderMarkdown = messageState.role === 'assistant' && messageState.status !== 'streaming';
  blockState.mount.classList.toggle(
    'native-message__stream-text',
    messageState.role === 'assistant' && messageState.status === 'streaming',
  );
  if (!renderMarkdown) {
    if (
      blockState.markdownState !== 'plain' ||
      blockState.mount.firstChild !== blockState.text ||
      blockState.mount.childNodes.length !== 1
    ) {
      blockState.markdownGeneration += 1;
      blockState.markdownMessageStatus = undefined;
      blockState.markdownSource = undefined;
      blockState.markdownState = 'plain';
      blockState.mount.replaceChildren(blockState.text);
    }
    return;
  }
  if (
    blockState.markdownSource === block.text &&
    blockState.markdownMessageStatus === messageState.status &&
    blockState.markdownState !== 'plain'
  ) {
    return;
  }
  renderNativeMarkdown(context, article, messageState, blockState, block.text, messageState.status);
};

const updateNativeBlock = (
  context: NativeMessageRenderContext,
  article: HTMLElement,
  messageState: NativeMessageDomState,
  blockState: NativeBlockDomState,
  block: ConversationContentBlock,
): void => {
  if (blockState.type === 'text' && block.type === 'text') {
    updateNativeTextBlock(context, article, messageState, blockState, block);
    return;
  }
  if (blockState.type === 'thinking' && block.type === 'thinking') {
    updateNativeTextNode(blockState.text, blockState.source, block.text);
    blockState.source = block.text;
    return;
  }
  if (blockState.type === 'tool' && block.type === 'tool') {
    updateNativeToolBlock(blockState, block);
    return;
  }
  if (blockState.type === 'image' && block.type === 'image' && blockState.name !== block.name) {
    blockState.name = block.name;
    blockState.mount.textContent = block.name;
  }
};

const updateNativeMessageLabel = (
  messageState: NativeMessageDomState,
  role: ConversationMessageView['role'],
): void => {
  if (messageState.role === role) return;
  messageState.role = role;
  if (role === 'assistant') {
    const terminalMark = document.createElement('span');
    terminalMark.className = 'native-message__terminal-mark';
    terminalMark.setAttribute('aria-hidden', 'true');
    terminalMark.textContent = '>_';
    messageState.label.replaceChildren(terminalMark, document.createTextNode(' Claude'));
    return;
  }
  messageState.label.textContent = role === 'user' ? '你' : '系统';
};

const createNativeMessageDomState = (article: HTMLElement): NativeMessageDomState => {
  const label = document.createElement('strong');
  label.className = 'native-message__label';
  const body = document.createElement('div');
  body.className = 'native-message__body';
  const caret = document.createElement('span');
  caret.className = 'native-message__stream-caret';
  caret.setAttribute('aria-hidden', 'true');
  const messageState: NativeMessageDomState = {
    blocks: new Map(),
    body,
    caret,
    label,
    role: undefined,
    status: 'complete',
  };
  article.append(label, body);
  return messageState;
};

const reconcileNativeMessageBlocks = (
  messageState: NativeMessageDomState,
  ordered: NativeBlockDomState[],
): void => {
  let cursor: ChildNode | null = messageState.body.firstChild;
  for (const blockState of ordered) {
    if (cursor === blockState.mount) {
      cursor = blockState.mount.nextSibling;
      continue;
    }
    messageState.body.insertBefore(blockState.mount, cursor);
  }
  if (messageState.status !== 'streaming') return;
  const tail = ordered.at(-1);
  if (tail?.type === 'text') {
    tail.mount.append(messageState.caret);
  } else {
    messageState.body.append(messageState.caret);
  }
};

const createNativeMessageRenderer = (
  state: ConversationState,
  getMarkdownRenderer: () => MarkdownDomRenderer,
): NativeMessageRenderer => {
  const context: NativeMessageRenderContext = {
    domStates: new WeakMap(),
    getMarkdownRenderer,
  };

  const update = (
    article: HTMLElement,
    message: ConversationMessageView,
    renderKey = nativeMessageRenderKey(message),
  ): void => {
    let messageState = context.domStates.get(article);
    if (!messageState) {
      messageState = createNativeMessageDomState(article);
      context.domStates.set(article, messageState);
    }
    messageState.caret.remove();
    messageState.status = message.status;
    updateNativeMessageLabel(messageState, message.role);
    article.className = `native-message native-message--${message.role}`;
    article.dataset.nativeMessageId = message.id;
    article.classList.toggle('native-message--streaming', message.status === 'streaming');
    article.setAttribute('aria-busy', String(message.status === 'streaming'));

    const ordered: NativeBlockDomState[] = [];
    const liveBlockIds = new Set<string>();
    for (const block of message.blocks) {
      liveBlockIds.add(block.id);
      let blockState = messageState.blocks.get(block.id);
      if (!blockState || blockState.type !== block.type) {
        if (blockState) {
          invalidateNativeBlock(blockState);
          blockState.mount.remove();
        }
        blockState = createNativeBlockDomState(block);
        messageState.blocks.set(block.id, blockState);
      }
      updateNativeBlock(context, article, messageState, blockState, block);
      ordered.push(blockState);
    }
    for (const [blockId, blockState] of messageState.blocks) {
      if (liveBlockIds.has(blockId)) continue;
      invalidateNativeBlock(blockState);
      blockState.mount.remove();
      messageState.blocks.delete(blockId);
    }
    reconcileNativeMessageBlocks(messageState, ordered);
    state.nativeMessageRenderKeys.set(article, renderKey);
  };

  const render = (message: ConversationMessageView): HTMLElement => {
    const article = document.createElement('article');
    update(article, message);
    return article;
  };

  return { render, update };
};

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
  const nativeMessageRenderer = createNativeMessageRenderer(
    state,
    dependencies.getMarkdownRenderer,
  );
  let lastNativeFooterPresentationKey = '';

  /**
   * Renders the four footer chips from an Agent SDK snapshot. Native mode has no PowerShell status
   * line, so `capabilities` is the only truth available; the terminal-side renderer is suppressed
   * wholesale while this runs, otherwise the chips flicker between two different sources of truth.
   */
  const renderNativeFooter = (snapshot: ConversationSnapshot): void => {
    const capability = snapshot.capabilities;
    const busy = state.nativeControlsUpdating;
    const activePermissionMode = nativeActivePermissionMode(snapshot);
    const presentationKey = JSON.stringify([
      snapshot.conversationId,
      capability?.revision,
      activePermissionMode,
      busy,
    ]);
    if (
      presentationKey === lastNativeFooterPresentationKey &&
      dependencies.footerModel.dataset.presentationOwner === 'native'
    ) {
      return;
    }
    lastNativeFooterPresentationKey = presentationKey;
    for (const chip of [
      dependencies.footerModel,
      dependencies.footerSpeed,
      dependencies.footerMode,
      dependencies.footerEffort,
    ]) {
      chip.dataset.presentationOwner = 'native';
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
    renderNativeMessage: nativeMessageRenderer.render,
    updateNativeMessage: nativeMessageRenderer.update,
  };
};
