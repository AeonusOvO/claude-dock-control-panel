import type { ClaudePermissionMode, ClaudeProjectState } from '../../../shared/contracts';

export interface FooterMenusLabelActions {
  permissionModeCatalog: ReadonlyArray<{
    detail: string;
    id: ClaudePermissionMode;
    label: string;
    needsRelaunch: boolean;
  }>;
  permissionModeLabel: (mode?: ClaudePermissionMode) => string;
  modelSpeedFastLabel: (state: ClaudeProjectState) => string;
  modelSpeedFooterLabel: (state: ClaudeProjectState) => string;
}

export const createFooterMenusLabelActions = (): FooterMenusLabelActions => {
  const PERMISSION_MODE_CATALOG: ReadonlyArray<{
    detail: string;
    id: ClaudePermissionMode;
    label: string;
    needsRelaunch: boolean;
  }> = [
    {
      detail: '每次动作都先征求同意。',
      id: 'default',
      label: '手动确认',
      needsRelaunch: false,
    },
    {
      detail: '文件编辑自动通过，其余仍需确认。',
      id: 'acceptEdits',
      label: '自动接受编辑',
      needsRelaunch: false,
    },
    {
      detail: '只读不改，先出方案再动手。',
      id: 'plan',
      label: '计划模式',
      needsRelaunch: false,
    },
    {
      detail: '无视风险直接执行；需要在工作台预置后才能切入。',
      id: 'bypassPermissions',
      label: '完全允许',
      needsRelaunch: false,
    },
    {
      detail: '由 Claude Code 自行判断，能否使用取决于账号与模型。',
      id: 'auto',
      label: '自动选择',
      needsRelaunch: false,
    },
    {
      detail: '只放行已预先批准的动作；不在快捷键循环内，选择后会重启会话。',
      id: 'dontAsk',
      label: '仅预批准',
      needsRelaunch: true,
    },
  ];

  const permissionModeLabel = (mode?: ClaudePermissionMode): string =>
    PERMISSION_MODE_CATALOG.find((entry) => entry.id === mode)?.label ?? '—';

  const modelSpeedFastLabel = (state: ClaudeProjectState): string => {
    if (state.speed.mechanism === 'claude-native-fast') {
      return 'Claude Fast';
    }
    if (
      state.speed.mechanism === 'gpt-service-tier' ||
      state.config.preset === 'chatgpt-subscription'
    ) {
      return 'GPT Fast';
    }
    return state.config.provider === 'anthropic' ? 'Claude Fast' : '快速档';
  };

  const modelSpeedFooterLabel = (state: ClaudeProjectState): string => {
    if (state.speed.status === 'active') {
      return state.speed.mechanism === 'gpt-service-tier'
        ? '速度 GPT Fast · 上游确认'
        : '速度 Claude Fast · 上游确认';
    }
    if (state.speed.status === 'not-active') {
      return state.speed.mechanism === 'gpt-service-tier'
        ? '速度 GPT Fast · 已回退'
        : '速度 Claude Fast · 已回退';
    }
    if (state.speed.status === 'requested') {
      return state.speed.mechanism === 'gpt-service-tier'
        ? '速度 GPT Fast · 已请求'
        : '速度 Claude Fast · 已请求';
    }
    if (state.speed.availability === 'unsupported') {
      return '速度 不支持';
    }
    if (state.speed.availability === 'unverified') {
      return '速度 未验证';
    }
    if (state.speed.availability === 'update-required') {
      return '速度 需更新';
    }
    return '速度 未请求';
  };

  return {
    permissionModeCatalog: PERMISSION_MODE_CATALOG,
    permissionModeLabel,
    modelSpeedFastLabel,
    modelSpeedFooterLabel,
  };
};
