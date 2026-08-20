import { enhanceSelect } from '../../platform/components';

export interface ChatGptGuideElements {
  guide: HTMLElement;
  title: HTMLElement;
  source: HTMLElement;
  statusCard: HTMLDivElement;
  statusTitle: HTMLElement;
  statusDetail: HTMLElement;
  action: HTMLButtonElement;
  progressCard: HTMLDivElement;
  progressTitle: HTMLElement;
  progressDetail: HTMLElement;
  progressMeter: HTMLProgressElement;
  modelField: HTMLLabelElement;
  modelSelect: HTMLSelectElement;
  secondaryActions: HTMLDivElement;
  boundary: HTMLElement;
}

export const buildChatGptSubscriptionGuideElements = (): ChatGptGuideElements => {
  const guide = document.createElement('section');
  guide.className = 'subscription-gateway-guide';
  guide.setAttribute('aria-label', 'ChatGPT 订阅托管网关');

  const title = document.createElement('strong');
  title.textContent = 'OpenAI Codex 负责人公开分享的 claudex 路径';
  const source = document.createElement('p');
  source.textContent =
    'Thibault “Tibo” Sottiaux 公开分享了 CLIProxyAPI 接入 Claude Code 的实践。ClaudeDock 把安装、配置和后台运行收进一个界面，不要求你打开终端或第三方控制台。';
  const statusCard = document.createElement('div');
  statusCard.className = 'subscription-gateway-status';
  statusCard.setAttribute('aria-live', 'polite');
  const statusText = document.createElement('div');
  const statusTitle = document.createElement('strong');
  statusTitle.textContent = '正在检查托管网关';
  const statusDetail = document.createElement('span');
  statusDetail.textContent = '请稍候…';
  statusText.append(statusTitle, statusDetail);
  const action = document.createElement('button');
  action.type = 'button';
  action.dataset.ripple = '';
  action.textContent = '一键安装并登录';
  action.disabled = true;
  statusCard.append(statusText, action);
  const progressCard = document.createElement('div');
  progressCard.className = 'subscription-gateway-progress';
  progressCard.setAttribute('aria-live', 'polite');
  progressCard.hidden = true;
  const progressTitle = document.createElement('strong');
  const progressDetail = document.createElement('span');
  const progressMeter = document.createElement('progress');
  progressMeter.setAttribute('aria-label', 'ChatGPT 自动接入进度');
  progressMeter.max = 8;
  progressCard.append(progressTitle, progressDetail, progressMeter);
  const modelField = document.createElement('label');
  modelField.className = 'field subscription-gateway-model';
  modelField.hidden = true;
  const modelLabel = document.createElement('span');
  modelLabel.textContent = '当前模型';
  const modelSelect = document.createElement('select');
  const modelHelpText = document.createElement('small');
  modelHelpText.textContent = '列表来自本机网关实时接口；打开项目后可复测并保存到当前项目。';
  modelField.append(modelLabel, modelSelect, modelHelpText);
  enhanceSelect(modelSelect);
  const secondaryActions = document.createElement('div');
  secondaryActions.className = 'subscription-gateway-actions';
  const boundary = document.createElement('small');
  boundary.textContent =
    '一次点击会自动检测 Claude Code、补齐缺失组件、打开 OpenAI 官方授权并读取模型列表；已打开项目时还会真实测试并保存到当前项目。此方式不需要 CCR；不会读取 OAuth Token 内容，也不会修改 shell、Codex、Claude Code 用户设置或系统级路由。';

  return {
    guide,
    title,
    source,
    statusCard,
    statusTitle,
    statusDetail,
    action,
    progressCard,
    progressTitle,
    progressDetail,
    progressMeter,
    modelField,
    modelSelect,
    secondaryActions,
    boundary,
  };
};
