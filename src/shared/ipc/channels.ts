const requestChannels = {
  // app
  APP_CLIPBOARD_READ: 'app:clipboard-read',
  APP_CLIPBOARD_WRITE: 'app:clipboard-write',
  APP_GET_SETTINGS: 'app:get-settings',
  APP_GET_DIAGNOSTICS: 'app:get-diagnostics',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_SET_ADVANCED_SETTINGS: 'app:set-advanced-settings',
  APP_SET_CLAUDE_CONTEXT_WINDOW_MODE: 'app:set-claude-context-window-mode',
  APP_SET_CLOSE_BEHAVIOR: 'app:set-close-behavior',
  APP_SET_FOOTER_RESOURCE_PREFERENCE: 'app:set-footer-resource-preference',
  APP_SET_LAUNCH_AT_LOGIN: 'app:set-launch-at-login',
  APP_SET_MANAGED_CHATGPT_CONTEXT_WINDOW_MODE: 'app:set-managed-chatgpt-context-window-mode',

  // onboarding
  ONBOARDING_COMPLETE: 'onboarding:complete',
  ONBOARDING_GET: 'onboarding:get',
  ONBOARDING_RESET: 'onboarding:reset',
  ONBOARDING_SKIP: 'onboarding:skip',
  ONBOARDING_UPDATE: 'onboarding:update',

  // application-proxy
  APPLICATION_PROXY_DETECT: 'application-proxy:detect',
  APPLICATION_PROXY_GET: 'application-proxy:get',
  APPLICATION_PROXY_SAVE: 'application-proxy:save',
  APPLICATION_PROXY_TEST: 'application-proxy:test',

  // artifact
  ARTIFACT_CREATE: 'artifact:create',
  ARTIFACT_DESTROY: 'artifact:destroy',
  ARTIFACT_GET_NETWORK_STATE: 'artifact:get-network-state',
  ARTIFACT_SET_NETWORK_ALLOWED: 'artifact:set-network-allowed',

  // busy
  BUSY_LIST: 'busy:list',
  BUSY_SET_CONVERSATION: 'busy:set-conversation',

  // chat
  CHAT_DELETE_CONVERSATION: 'chat:delete-conversation',
  CHAT_DELETE_DRAFT_ATTACHMENT: 'chat:delete-draft-attachment',
  CHAT_GET_CONFIG: 'chat:get-config',
  CHAT_GET_CONVERSATION: 'chat:get-conversation',
  CHAT_IMPORT_ATTACHMENT_BYTES: 'chat:import-attachment-bytes',
  CHAT_IMPORT_ATTACHMENTS: 'chat:import-attachments',
  CHAT_IMPORT_CLIPBOARD_IMAGE: 'chat:import-clipboard-image',
  CHAT_LIST_CONVERSATIONS: 'chat:list-conversations',
  CHAT_PREFLIGHT: 'chat:preflight',
  CHAT_READ_ATTACHMENT: 'chat:read-attachment',
  CHAT_RELEASE_ATTACHMENT_DRAFT: 'chat:release-attachment-draft',
  CHAT_RENAME_CONVERSATION: 'chat:rename-conversation',
  CHAT_SAVE_CONFIG: 'chat:save-config',
  CHAT_SAVE_CONVERSATION: 'chat:save-conversation',
  CHAT_START: 'chat:start',
  CHAT_STOP: 'chat:stop',
  CHAT_TEST_CONNECTION: 'chat:test-connection',

  // claude
  CLAUDE_COMMAND: 'claude:command',
  CLAUDE_CONNECTION_HISTORY: 'claude:connection-history',
  CLAUDE_CONNECTION_HISTORY_APPLY: 'claude:connection-history-apply',
  CLAUDE_CONNECTION_HISTORY_DELETE: 'claude:connection-history-delete',
  CLAUDE_CONNECTION_HISTORY_RENAME: 'claude:connection-history-rename',
  CLAUDE_DELETE_SESSION: 'claude:delete-session',
  CLAUDE_EXECUTION_SETTINGS_GET: 'claude:execution-settings-get',
  CLAUDE_EXECUTION_SETTINGS_UPDATE: 'claude:execution-settings-update',
  CLAUDE_EXECUTION_SETTINGS_USE_RECOMMENDED: 'claude:execution-settings-use-recommended',
  CLAUDE_EXECUTION_SETTINGS_RESTORE_DEFAULT: 'claude:execution-settings-restore-default',
  CLAUDE_GET_CONNECTION_ADVICE: 'claude:get-connection-advice',
  CLAUDE_GET_GATEWAY_DIAGNOSTICS: 'claude:get-gateway-diagnostics',
  CLAUDE_GET_SESSIONS: 'claude:get-sessions',
  CLAUDE_GET_SESSIONS_FOR_PATH: 'claude:get-sessions-for-path',
  CLAUDE_GET_STATE: 'claude:get-state',
  CLAUDE_LAUNCH: 'claude:launch',
  CLAUDE_LAUNCH_PREFLIGHT_DECIDE: 'claude:launch-preflight-decide',
  CLAUDE_LAUNCH_WITH_SESSION: 'claude:launch-with-session',
  CLAUDE_MANAGED_CHATGPT_GATEWAY_MODEL: 'claude:managed-chatgpt-gateway-model',
  CLAUDE_MANAGED_CHATGPT_GATEWAY_LOGOUT: 'claude:managed-chatgpt-gateway-logout',
  CLAUDE_MANAGED_CHATGPT_GATEWAY_OPEN_MANAGEMENT: 'claude:managed-chatgpt-gateway-open-management',
  CLAUDE_MANAGED_CHATGPT_GATEWAY_SETUP: 'claude:managed-chatgpt-gateway-setup',
  CLAUDE_MANAGED_CHATGPT_GATEWAY_STATE: 'claude:managed-chatgpt-gateway-state',
  CLAUDE_MODEL_OPTIONS: 'claude:model-options',
  CLAUDE_PERMISSION_RESPONSE: 'claude:permission-response',
  CLAUDE_PLUGINS_GET: 'claude:plugins-get',
  CLAUDE_PLUGINS_INSTALL: 'claude:plugins-install',
  CLAUDE_PLUGINS_MARKETPLACE_ADD: 'claude:plugins-marketplace-add',
  CLAUDE_PLUGINS_MARKETPLACE_REMOVE: 'claude:plugins-marketplace-remove',
  CLAUDE_PLUGINS_MARKETPLACES_REFRESH: 'claude:plugins-marketplaces-refresh',
  CLAUDE_PLUGINS_SET_ENABLED: 'claude:plugins-set-enabled',
  CLAUDE_PLUGINS_UNINSTALL: 'claude:plugins-uninstall',
  CLAUDE_PLUGINS_UPDATE: 'claude:plugins-update',
  CLAUDE_PLUGINS_UPDATE_ALL: 'claude:plugins-update-all',
  CLAUDE_PROVIDER_MODELS_DISCOVER: 'claude:provider-models-discover',
  CLAUDE_RELAUNCH: 'claude:relaunch',
  CLAUDE_RENAME_SESSION: 'claude:rename-session',
  CLAUDE_ROUTER_DELETE_PROVIDER: 'claude:router-delete-provider',
  CLAUDE_ROUTER_GET_STATE: 'claude:router-get-state',
  CLAUDE_ROUTER_INSTALL: 'claude:router-install',
  CLAUDE_ROUTER_INSTALL_SOURCE: 'claude:router-install-source',
  CLAUDE_ROUTER_OPEN_MANAGEMENT: 'claude:router-open-management',
  CLAUDE_ROUTER_REPAIR_FROM_PROJECT: 'claude:router-repair-from-project',
  CLAUDE_ROUTER_SAVE_PROVIDER: 'claude:router-save-provider',
  CLAUDE_ROUTER_START: 'claude:router-start',
  CLAUDE_ROUTER_STOP: 'claude:router-stop',
  CLAUDE_ROUTER_UNINSTALL: 'claude:router-uninstall',
  CLAUDE_SAVE_CONFIG: 'claude:save-config',
  CLAUDE_SET_ALLOW_BYPASS_PERMISSIONS: 'claude:set-allow-bypass-permissions',
  CLAUDE_SET_EFFORT: 'claude:set-effort',
  CLAUDE_SET_MODEL_SPEED: 'claude:set-model-speed',
  CLAUDE_SET_PERMISSION_MODE: 'claude:set-permission-mode',
  CLAUDE_SWITCH_MODEL: 'claude:switch-model',
  CLAUDE_TEST_CONNECTION: 'claude:test-connection',

  // codex
  CODEX_GET_STATE: 'codex:get-state',
  CODEX_INSTALL_UPDATE: 'codex:install-update',
  CODEX_LAUNCH: 'codex:launch',
  CODEX_LOGIN_CANCEL: 'codex:login-cancel',
  CODEX_LOGIN_START: 'codex:login-start',
  CODEX_LOGOUT: 'codex:logout',

  // directory
  DIRECTORY_CHOOSE: 'directory:choose',

  // download
  DOWNLOAD_CANCEL: 'download:cancel',
  DOWNLOAD_HISTORY_CLEAR: 'download:history-clear',
  DOWNLOAD_HISTORY_DELETE: 'download:history-delete',
  DOWNLOAD_LIST: 'download:list',
  DOWNLOAD_PAUSE: 'download:pause',
  DOWNLOAD_RESUME: 'download:resume',

  // markdown
  MARKDOWN_OPEN_EXTERNAL: 'markdown:open-external',

  // mcp
  MCP_BACKUP_RESTORE: 'mcp:backup-restore',
  MCP_BACKUPS: 'mcp:backups',
  MCP_GET_CATALOG: 'mcp:get-catalog',
  MCP_INSTALL: 'mcp:install',
  MCP_REMOVE: 'mcp:remove',
  MCP_TOGGLE_APPLY: 'mcp:toggle-apply',
  MCP_TOGGLE_DISCARD: 'mcp:toggle-discard',
  MCP_TOGGLE_PREVIEW: 'mcp:toggle-preview',

  // native-attachment
  NATIVE_ATTACHMENT_IMPORT_BYTES: 'native-attachment:import-bytes',
  NATIVE_ATTACHMENT_IMPORT_CLIPBOARD: 'native-attachment:import-clipboard',
  NATIVE_ATTACHMENT_IMPORT_PATHS: 'native-attachment:import-paths',
  NATIVE_ATTACHMENT_READ: 'native-attachment:read',
  NATIVE_ATTACHMENT_REMOVE: 'native-attachment:remove',

  // native-conversation
  NATIVE_CONVERSATION_ADOPT_TERMINAL: 'native-conversation:adopt-terminal',
  NATIVE_CONVERSATION_CLOSE: 'native-conversation:close',
  NATIVE_CONVERSATION_DISCARD_RECOVERY: 'native-conversation:discard-recovery',
  NATIVE_CONVERSATION_GET: 'native-conversation:get',
  NATIVE_CONVERSATION_INTERRUPT: 'native-conversation:interrupt',
  NATIVE_CONVERSATION_LIST_RECOVERIES: 'native-conversation:list-recoveries',
  NATIVE_CONVERSATION_RENAME: 'native-conversation:rename',
  NATIVE_CONVERSATION_RESPOND: 'native-conversation:respond',
  NATIVE_CONVERSATION_RESTORE_DRAFT: 'native-conversation:restore-draft',
  NATIVE_CONVERSATION_START: 'native-conversation:start',
  NATIVE_CONVERSATION_STOP_TASK: 'native-conversation:stop-task',
  NATIVE_CONVERSATION_SUBMIT: 'native-conversation:submit',
  NATIVE_CONVERSATION_TRANSFER_TO_TERMINAL: 'native-conversation:transfer-to-terminal',
  NATIVE_CONVERSATION_UPDATE_CONTROLS: 'native-conversation:update-controls',

  // network-preflight
  NETWORK_PREFLIGHT_CLEAR_HISTORY: 'network-preflight:clear-history',
  NETWORK_PREFLIGHT_GET: 'network-preflight:get',
  NETWORK_PREFLIGHT_GET_HISTORY: 'network-preflight:get-history',
  NETWORK_PREFLIGHT_INVALIDATE: 'network-preflight:invalidate',
  NETWORK_PREFLIGHT_RUN: 'network-preflight:run',

  // project
  PROJECT_ACTIVATE: 'project:activate',
  PROJECT_ADD: 'project:add',
  PROJECT_CLOSE: 'project:close',
  PROJECT_CLOSE_FOLDER: 'project:close-folder',
  PROJECT_FORGET: 'project:forget',
  PROJECT_OPEN_CONVERSATION: 'project:open-conversation',
  PROJECT_OPEN_STORED_CONVERSATION: 'project:open-stored-conversation',
  PROJECT_RENAME_CONVERSATION: 'project:rename-conversation',

  // router
  ROUTER_CC_SWITCH_EXPORT_CURRENT: 'router:cc-switch-export-current',
  ROUTER_CC_SWITCH_INSTALL: 'router:cc-switch-install',
  ROUTER_CC_SWITCH_UNINSTALL: 'router:cc-switch-uninstall',
  ROUTER_KERNEL_STATE: 'router:kernel-state',

  // runtime
  RUNTIME_GET: 'runtime:get',
  RUNTIME_GET_ACTIVITY: 'runtime:get-activity',
  RUNTIME_SET: 'runtime:set',
  RUNTIME_TERMINATE_PROCESS: 'runtime:terminate-process',

  // software
  SOFTWARE_APPLICATION_UPDATER_DOWNLOAD: 'software:application-updater-download',
  SOFTWARE_APPLICATION_UPDATER_GET: 'software:application-updater-get',
  SOFTWARE_APPLICATION_UPDATER_INSTALL: 'software:application-updater-install',
  SOFTWARE_CLAUDE_INSTALL_UPDATE: 'software:claude-install-update',
  SOFTWARE_UPDATES_GET: 'software:updates-get',

  // terminal
  TERMINAL_RESTART: 'terminal:restart',
  TERMINAL_START: 'terminal:start',
  TERMINAL_STOP: 'terminal:stop',

  // ui
  UI_SET_THEME: 'ui:set-theme',

  // workspace
  WORKSPACE_GET_STATE: 'workspace:get-state',
  WORKSPACE_GET_STORED_PROJECTS: 'workspace:get-stored-projects',
  WORKSPACE_REMOVE_STORED_PROJECT: 'workspace:remove-stored-project',
} as const;

const sendChannels = {
  // app
  APP_CONFIRM_QUIT: 'app:confirm-quit',
  APP_MINIMIZE_TO_TRAY: 'app:minimize-to-tray',
  APP_QUIT_REQUEST_RECEIVED: 'app:quit-request-received',

  // claude
  CLAUDE_PERMISSION_MODE_OBSERVED: 'claude:permission-mode-observed',
  CLAUDE_PERMISSION_MODE_PROBE_RESULT: 'claude:permission-mode-probe-result',

  // terminal
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_WRITE: 'terminal:write',
} as const;

const eventChannels = {
  // app
  APP_OPEN_DOWNLOAD_CENTER: 'app:open-download-center',
  APP_QUIT_REQUESTED: 'app:quit-requested',
  APP_QUIT_REQUEST_INVALIDATED: 'app:quit-request-invalidated',
  APP_WINDOW_RESTORED: 'app:window-restored',

  // application-proxy
  APPLICATION_PROXY_CHANGED: 'application-proxy:changed',

  // artifact
  ARTIFACT_NETWORK_LOG: 'artifact:network-log',

  // busy
  BUSY_CHANGED: 'busy:changed',

  // chat
  CHAT_STREAM: 'chat:stream',

  // claude
  CLAUDE_MANAGED_CHATGPT_SETUP_PROGRESS: 'claude:managed-chatgpt-setup-progress',
  CLAUDE_PERMISSION_MODE_PROBE: 'claude:permission-mode-probe',
  CLAUDE_PERMISSION_REQUEST: 'claude:permission-request',
  CLAUDE_STATE: 'claude:state',

  // codex
  CODEX_STATE: 'codex:state',

  // conversation
  CONVERSATION_OWNER_CONFLICT: 'conversation:owner-conflict',

  // download
  DOWNLOAD_CHANGED: 'download:changed',

  // native-conversation
  NATIVE_CONVERSATION_SNAPSHOT: 'native-conversation:snapshot',

  // network-preflight
  NETWORK_PREFLIGHT_RESULT: 'network-preflight:result',

  // router
  ROUTER_OPERATION_PROGRESS: 'router:operation-progress',

  // runtime
  RUNTIME_ACTIVITY_CHANGED: 'runtime:activity-changed',

  // software
  SOFTWARE_APPLICATION_UPDATER_CHANGED: 'software:application-updater-changed',

  // terminal
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_SIZE: 'terminal:size',

  // workspace
  WORKSPACE_STATE: 'workspace:state',
} as const;

export const CHANNELS = {
  ...requestChannels,
  ...sendChannels,
  ...eventChannels,
} as const;

type ChannelValue<T> = T[keyof T];

export type RequestChannel = ChannelValue<typeof requestChannels>;
export type SendChannel = ChannelValue<typeof sendChannels>;
export type EventChannel = ChannelValue<typeof eventChannels>;
export type IpcChannel = ChannelValue<typeof CHANNELS>;

export const REQUEST_CHANNELS = Object.freeze(
  Object.values(requestChannels),
) as readonly RequestChannel[];
export const SEND_CHANNELS = Object.freeze(Object.values(sendChannels)) as readonly SendChannel[];
export const EVENT_CHANNELS = Object.freeze(
  Object.values(eventChannels),
) as readonly EventChannel[];
export const IPC_CHANNELS = Object.freeze(Object.values(CHANNELS)) as readonly IpcChannel[];
