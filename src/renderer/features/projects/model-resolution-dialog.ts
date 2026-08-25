import type {
  ClaudeConversationModelChoice,
  ClaudeConversationModelDifference,
  ClaudeConversationModelIdentity,
  ClaudeConversationModelResolution,
} from '../../../shared/contracts';
import type { ProjectsElements } from './elements';

export interface ConversationModelDialogResult {
  choice: ClaudeConversationModelChoice;
  remember: boolean;
}

export interface ConversationModelDialog {
  requestChoice: (
    resolution: ClaudeConversationModelResolution,
    conversationLabel: string,
  ) => Promise<ConversationModelDialogResult | null>;
}

const DIFFERENCE_LABELS: Record<ClaudeConversationModelDifference, string> = {
  account: '账户',
  authentication: '认证方式',
  credential: 'API 凭据',
  endpoint: '接口地址',
  'main-model': '详细模型',
  platform: '平台',
  protocol: '接口协议',
  'router-provider': '中转路由',
  'small-model': '简单模型',
};

const appendIdentityRow = (list: HTMLDListElement, label: string, value: string): void => {
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  detail.title = value;
  list.append(term, detail);
};

const renderIdentity = (
  container: HTMLElement,
  identity: ClaudeConversationModelIdentity,
  badge: string,
): void => {
  const badgeElement = document.createElement('span');
  badgeElement.className = 'conversation-model-dialog__badge';
  badgeElement.textContent = badge;
  const heading = document.createElement('h3');
  heading.textContent = identity.providerLabel;
  const facts = document.createElement('dl');
  appendIdentityRow(facts, '详细模型', identity.mainModel);
  appendIdentityRow(facts, '简单模型', identity.smallModel);
  appendIdentityRow(facts, '账户 / API', identity.accountDetail);
  appendIdentityRow(facts, '认证方式', identity.authModeLabel);
  appendIdentityRow(facts, '接口协议', identity.protocolLabel);
  appendIdentityRow(facts, '接口地址', identity.endpoint ?? '由平台或本机服务管理');
  if (identity.connectionName) appendIdentityRow(facts, '接入名称', identity.connectionName);
  container.replaceChildren(badgeElement, heading, facts);
};

export const createConversationModelDialog = (
  elements: ProjectsElements,
): ConversationModelDialog => {
  let resolveActive: ((result: ConversationModelDialogResult | null) => void) | undefined;

  elements.conversationModelDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    elements.conversationModelDialog.close('cancel');
  });
  elements.conversationModelOriginal.addEventListener('click', (event) => {
    event.preventDefault();
    if (!elements.conversationModelOriginal.disabled) {
      elements.conversationModelDialog.close('use-conversation');
    }
  });
  elements.conversationModelCurrent.addEventListener('click', (event) => {
    event.preventDefault();
    elements.conversationModelDialog.close('use-current');
  });
  elements.conversationModelDialog.addEventListener('click', (event) => {
    if (event.target === elements.conversationModelDialog) {
      elements.conversationModelDialog.close('cancel');
    }
  });
  elements.conversationModelDialog.addEventListener('close', () => {
    const resolve = resolveActive;
    resolveActive = undefined;
    if (!resolve) return;
    const choice = elements.conversationModelDialog.returnValue;
    resolve(
      choice === 'use-conversation' || choice === 'use-current'
        ? { choice, remember: elements.conversationModelRemember.checked }
        : null,
    );
  });

  const requestChoice = (
    resolution: ClaudeConversationModelResolution,
    conversationLabel: string,
  ): Promise<ConversationModelDialogResult | null> => {
    if (elements.conversationModelDialog.open || resolveActive) return Promise.resolve(null);
    elements.conversationModelDialog.returnValue = '';
    elements.conversationModelRemember.checked = false;
    elements.conversationModelDialogTitle.textContent = `“${conversationLabel}”绑定了另一套模型`;
    elements.conversationModelDialogDescription.textContent =
      '请选择恢复时使用哪套完整接入。平台、账户、API、接口和两个模型会作为一个整体处理。';
    renderIdentity(elements.conversationModelOriginalCard, resolution.conversation, '对话原有');
    renderIdentity(elements.conversationModelCurrentCard, resolution.current, '正在接入');
    elements.conversationModelDifferences.textContent = `检测到不同：${resolution.differences
      .map((difference) => DIFFERENCE_LABELS[difference])
      .join('、')}`;
    elements.conversationModelOriginal.disabled = !resolution.restorable;
    elements.conversationModelWarning.hidden = resolution.restorable;
    elements.conversationModelWarning.textContent = resolution.restorable
      ? ''
      : resolution.conversation.source === 'legacy-model-only'
        ? '这是旧版对话，只记录了模型名，原账户或 API 接入无法可靠还原。你仍可安全使用正在接入的模型。'
        : '原订阅账户已不同或所需 API 凭据不可恢复。请先重新登录/配置后再使用原有模型。';

    elements.conversationModelDialog.showModal();
    return new Promise((resolve) => {
      resolveActive = resolve;
    });
  };

  return { requestChoice };
};
