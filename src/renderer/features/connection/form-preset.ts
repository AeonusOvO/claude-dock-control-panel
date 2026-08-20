import type { ClaudePreset, SaveClaudeConfigInput } from '../../../shared/contracts';
import { findClaudeProvider, type ClaudeProviderId } from '../../../shared/claude/providers';
import type { ConfigurableEndpointProtocol } from '../../../shared/router/connection-endpoint';
import {
  authModeField,
  authModeHelp,
  authModeLabel,
  baseUrlField,
  baseUrlHelp,
  claudeAuthMode,
  claudeBaseUrl,
  claudeConfigForm,
  claudeConfigStepDescription,
  claudeConfigStepTitle,
  claudeCredential,
  claudeModel,
  claudeModelFast,
  claudePreset,
  claudeProtocol,
  credentialField,
  credentialLabel,
  credentialSourceSettings,
  environmentSetup,
  modelHelp,
  openProviderConsoleButton,
  openProviderDocsButton,
  protocolField,
  protocolHelp,
  providerCaveat,
  providerDescription,
  providerSetup,
  providerTitle,
} from './form-elements';
import type { ConnectionFormState } from './form-state';

export interface ConnectionFormPresetActions {
  applyPresetUi: (preset: ClaudePreset, preserveValues: boolean) => void;
}

export const createConnectionFormPresetActions = (
  formState: ConnectionFormState,
  setAuthOptions: (
    options: Array<{ label: string; value: SaveClaudeConfigInput['authMode'] }>,
    selected?: SaveClaudeConfigInput['authMode'],
  ) => void,
  moveProviderTools: (providerId?: ClaudeProviderId) => void,
  renderProviderPicker: () => void,
  syncConnectionInteractivity: () => void,
): ConnectionFormPresetActions => {
  const applyPresetUi = (preset: ClaudePreset, preserveValues: boolean): void => {
    const provider = findClaudeProvider(preset) ?? findClaudeProvider('custom');
    if (!provider) {
      return;
    }
    formState.selectedProviderId = provider.id;
    claudePreset.value = provider.id;
    const isManagedChatGpt = provider.id === 'chatgpt-subscription';
    environmentSetup.hidden = isManagedChatGpt || formState.connectionEnvironmentReady;
    claudeConfigForm.hidden = isManagedChatGpt;
    const isOfficialLogin = provider.id === 'anthropic';
    const isAdvanced =
      provider.id === 'custom' || provider.id === 'gateway' || provider.id === 'curl';
    const supportsProtocolSwitch = provider.id === 'custom';
    if (!preserveValues || !supportsProtocolSwitch) {
      claudeProtocol.value = 'anthropic';
      formState.selectedRouterProviderId = undefined;
    }
    const protocol = claudeProtocol.value as ConfigurableEndpointProtocol;
    protocolField.hidden = !supportsProtocolSwitch;
    baseUrlField.hidden = isManagedChatGpt || !provider.editableBaseUrl;
    authModeField.hidden = isManagedChatGpt;
    credentialSourceSettings.hidden = isManagedChatGpt;
    claudeConfigStepTitle.textContent = isManagedChatGpt
      ? '选择托管网关模型'
      : '选择模型并填写凭据';
    claudeConfigStepDescription.textContent = isManagedChatGpt
      ? '地址和本地访问密钥由 ClaudeDock 自动配置；你只需要按需调整模型。'
      : '密钥只交给主进程加密保存，界面不会回显已保存内容。';

    if (isAdvanced) {
      setAuthOptions(
        supportsProtocolSwitch && protocol === 'openai'
          ? [
              { label: '接口密钥（Authorization / Bearer）', value: 'authToken' },
              { label: '无需认证（仅建议本机网关）', value: 'none' },
            ]
          : [
              { label: '接口密钥（X-Api-Key）', value: 'apiKey' },
              { label: '持有者令牌（Authorization / Bearer）', value: 'authToken' },
              { label: '无需认证（仅建议本机网关）', value: 'none' },
            ],
        preserveValues
          ? (claudeAuthMode.value as SaveClaudeConfigInput['authMode'])
          : provider.authMode,
      );
    } else {
      const authLabel =
        provider.authMode === 'existing'
          ? '使用 Claude Code 现有登录'
          : provider.authMode === 'apiKey'
            ? '接口密钥（X-Api-Key）'
            : provider.authMode === 'authToken'
              ? '持有者令牌（Authorization / Bearer）'
              : '无需认证';
      setAuthOptions([{ label: authLabel, value: provider.authMode }], provider.authMode);
    }

    if (!preserveValues) {
      claudeBaseUrl.value = provider.baseUrl;
      claudeModel.value = provider.model;
      claudeModelFast.value = provider.modelFast ?? provider.model;
    }
    baseUrlHelp.textContent = supportsProtocolSwitch
      ? protocol === 'openai'
        ? '可填域名、/v1、/v1/chat/completions 或 /v1/responses；保存时会自动补全，并由本地 Router 转换。'
        : '按服务商给出的基址填写（含 /v1 等路径都会保留）；Claude Code 会自己追加 /v1/messages。'
      : provider.id === 'chatgpt-subscription'
        ? '填写本机 Anthropic Messages 兼容网关的基址；CLIProxyAPI 默认是 127.0.0.1:8317。不要填写 OAuth 回调端口 1455 或管理页地址。'
        : provider.id === 'gateway'
          ? '填写路由器真正的模型接口；默认 3456 是模型接口，3458 是管理页。'
          : '接口必须提供 Anthropic /v1/messages，且不能直接使用 OpenAI /chat/completions。';
    protocolHelp.textContent =
      provider.id === 'chatgpt-subscription'
        ? 'Claude Code 访问本机 Anthropic Messages 入口；本地网关再完成 Codex OAuth 请求与协议转换，这不是官方直连。'
        : protocol === 'openai'
          ? 'OpenAI 请求会自动写入并启动本地 Router，再转换为 Claude Code 使用的 Anthropic Messages 请求。'
          : 'Anthropic Messages 接口由 Claude Code 直接访问，不经过协议转换。';
    modelHelp.textContent =
      provider.id === 'chatgpt-subscription'
        ? `默认映射为主模型 ${provider.model}、小型/备用模型 ${provider.modelFast ?? provider.model}；后者会更换模型，不是服务速度档位。请以本地网关实时可用模型为准，可在这里修改。`
        : `主模型会同时用于默认、Opus 与 Sonnet 路由；当前推荐 ${provider.model}。`;
    authModeHelp.textContent =
      provider.id === 'chatgpt-subscription'
        ? '这里填写本地网关 config.yaml 的 api-keys 客户端密钥，并以 Bearer Token 发送；不要粘贴 ChatGPT 密码、Cookie 或 OAuth Token。'
        : provider.authMode === 'existing'
          ? 'ClaudeDock 不读取或复用 Claude Code 的登录令牌。'
          : provider.authMode === 'apiKey'
            ? '该服务商使用 x-api-key 请求头。'
            : '该服务商使用 Authorization: Bearer 请求头。';
    authModeLabel.textContent = isOfficialLogin
      ? '官方认证方式'
      : supportsProtocolSwitch && protocol === 'openai'
        ? '中转站认证方式'
        : 'Claude Code 到接口的认证方式';
    credentialLabel.textContent =
      provider.id === 'chatgpt-subscription'
        ? '本地网关访问密钥（不是 ChatGPT 凭据）'
        : provider.id === 'gateway'
          ? '路由器访问密钥（不是上游密钥）'
          : supportsProtocolSwitch && protocol === 'openai'
            ? 'OpenAI 中转站密钥'
            : `${provider.label} 凭据`;
    claudeCredential.placeholder = provider.keyHint ?? '留空则保留已保存的凭据';
    credentialField.hidden =
      isManagedChatGpt ||
      claudeAuthMode.value === 'existing' ||
      claudeAuthMode.value === 'none' ||
      provider.id === 'ollama';

    providerSetup.hidden = false;
    providerTitle.textContent = provider.label;
    providerDescription.textContent = provider.description;
    providerCaveat.hidden = !provider.caveat;
    providerCaveat.textContent = provider.caveat ?? '';
    openProviderConsoleButton.hidden = !provider.consoleUrl;
    openProviderConsoleButton.dataset.externalUrl = provider.consoleUrl ?? '';
    openProviderConsoleButton.textContent =
      provider.id === 'chatgpt-subscription' ? '查看公开原帖' : '打开密钥控制台';
    openProviderDocsButton.hidden = !provider.docsUrl;
    openProviderDocsButton.dataset.externalUrl = provider.docsUrl ?? '';
    openProviderDocsButton.textContent =
      provider.id === 'chatgpt-subscription' ? '查看上游源码' : '查看官方文档';
    moveProviderTools(provider.id);
    renderProviderPicker();
    syncConnectionInteractivity();
  };

  return {
    applyPresetUi,
  };
};
