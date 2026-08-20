export type CliCommandRuntime = 'claude' | 'codex';
export type CliCommandAction = 'compose' | 'run';
export type CliCommandRisk = 'destructive' | 'external' | 'safe' | 'sensitive';
export type CliCommandPlatform = 'linux' | 'macos' | 'windows';

export interface CliCommandDefinition {
  action: CliCommandAction;
  aliases: string[];
  category: string;
  command: string;
  description: string;
  documentedVersion: string;
  platforms: CliCommandPlatform[];
  requirements: string[];
  risk: CliCommandRisk;
  runtime: CliCommandRuntime;
  source: string;
  syntax: string;
}

export const CLI_COMMAND_CATALOG_RETRIEVED_AT = '2026-08-05';
export const CLAUDE_COMMAND_SOURCE = 'https://code.claude.com/docs/en/commands';
export const CODEX_COMMAND_SOURCE =
  'https://learn.chatgpt.com/docs/developer-commands.md?surface=cli';

const CLAUDE_GROUPS = [
  [
    '会话与上下文',
    '/add-dir /background /branch /btw /cd /clear /compact /context /copy /exit /export /focus /fork /goal /recap /rename /resume /rewind /stop /subtask /tasks /teleport /tui',
  ],
  [
    '模型、模式与设置',
    '/advisor /autocompact /color /config /effort /fast /keybindings /model /permissions /plan /privacy-settings /remote-control /remote-env /sandbox /scroll-speed /statusline /terminal-setup /theme /voice',
  ],
  [
    '代理与扩展',
    '/agents /batch /chrome /desktop /fewer-permission-prompts /hooks /ide /init /loop /mcp /memory /plugin /reload-plugins /reload-skills /schedule /skills /workflows',
  ],
  [
    '开发与审查',
    '/autofix-pr /claude-api /code-review /dataviz /debug /deep-research /design-login /design-sync /diff /install-github-app /install-slack-app /review /run /run-skill-generator /security-review /setup-bedrock /setup-vertex /simplify /team-onboarding /ultrareview /verify /web-setup',
  ],
  [
    '账户与帮助',
    '/bug /cost /doctor /feedback /heapdump /help /insights /login /logout /mobile /passes /powerup /radio /release-notes /stats /status /stickers /upgrade /usage /usage-credits',
  ],
] as const;

const CLAUDE_ALIASES: Record<string, string[]> = {
  '/background': ['/bg'],
  '/bug': ['/share'],
  '/clear': ['/reset', '/new'],
  '/config': ['/settings'],
  '/desktop': ['/app'],
  '/doctor': ['/checkup'],
  '/exit': ['/quit'],
  '/loop': ['/proactive'],
  '/mobile': ['/ios', '/android'],
  '/permissions': ['/allowed-tools'],
  '/remote-control': ['/rc'],
  '/resume': ['/continue'],
  '/rewind': ['/checkpoint', '/undo'],
  '/schedule': ['/routines'],
  '/tasks': ['/bashes'],
  '/teleport': ['/tp'],
};

const CLAUDE_SYNTAX: Record<string, string> = {
  '/add-dir': '/add-dir <path>',
  '/advisor': '/advisor [model|off]',
  '/autocompact': '/autocompact [auto|<tokens>]',
  '/autofix-pr': '/autofix-pr [prompt]',
  '/background': '/background [prompt]',
  '/batch': '/batch <instruction>',
  '/branch': '/branch [name]',
  '/btw': '/btw [question]',
  '/bug': '/bug [report]',
  '/cd': '/cd <path>',
  '/claude-api': '/claude-api [migrate|managed-agents-onboard]',
  '/clear': '/clear [name]',
  '/code-review': '/code-review [effort] [--fix] [--comment] [target]',
  '/color': '/color [color|default]',
  '/compact': '/compact [instructions]',
  '/config': '/config [key=value ...]',
  '/context': '/context [all]',
  '/copy': '/copy [N]',
  '/dataviz': '/dataviz [request]',
  '/debug': '/debug [description]',
  '/deep-research': '/deep-research <question>',
  '/design-sync': '/design-sync [hint]',
  '/effort': '/effort [level|auto]',
  '/export': '/export [filename]',
  '/fast': '/fast [on|off]',
  '/feedback': '/feedback [report]',
  '/fork': '/fork [prompt]',
  '/goal': '/goal [condition|clear]',
  '/loop': '/loop [interval] [prompt]',
  '/mcp': '/mcp [reconnect <server>|enable|disable [<server>|all]]',
  '/model': '/model [model]',
  '/plan': '/plan [description]',
  '/plugin': '/plugin [subcommand]',
  '/reload-plugins': '/reload-plugins [--force]',
  '/rename': '/rename [name]',
  '/resume': '/resume [session]',
  '/review': '/review [PR]',
  '/schedule': '/schedule [description]',
  '/simplify': '/simplify [target]',
  '/subtask': '/subtask <task>',
  '/tui': '/tui [default|fullscreen]',
  '/ultrareview': '/ultrareview [PR or branch]',
  '/voice': '/voice [hold|tap|off]',
};

const CODEX_GROUPS = [
  [
    '会话',
    '/agent /clear /rename /archive /delete /compact /copy /exit /quit /fork /side /raw /resume /new /review /status /usage /app',
  ],
  [
    '模式与配置',
    '/permissions /keymap /vim /setup-default-sandbox /sandbox-add-read-dir /experimental /approve /memories /model /fast /plan /goal /personality /debug-config /statusline /title /theme /pets',
  ],
  [
    '工具与扩展',
    '/ide /apps /plugins /hooks /skills /import /feedback /init /logout /mcp /mention /diff /ps /stop',
  ],
] as const;

const CODEX_ALIASES: Record<string, string[]> = {
  '/agent': ['/subagents'],
  '/pets': ['/pet'],
  '/side': ['/btw'],
};

const CODEX_SYNTAX: Record<string, string> = {
  '/clear': '/clear [name]',
  '/goal': '/goal [objective|edit|pause|resume|clear]',
  '/ide': '/ide [prompt]',
  '/mcp': '/mcp [verbose]',
  '/mention': '/mention <path>',
  '/new': '/new [name]',
  '/pets': '/pets [off]',
  '/plan': '/plan [prompt]',
  '/raw': '/raw [on|off]',
  '/rename': '/rename [name]',
  '/sandbox-add-read-dir': '/sandbox-add-read-dir <absolute-path>',
  '/side': '/side [prompt]',
  '/usage': '/usage [daily|weekly|cumulative]',
};

const CLAUDE_RUNNABLE = new Set([
  '/agents',
  '/context',
  '/doctor',
  '/help',
  '/hooks',
  '/mcp',
  '/memory',
  '/model',
  '/permissions',
  '/status',
  '/theme',
  '/usage',
]);
const DESTRUCTIVE_COMMANDS = new Set([
  '/archive',
  '/clear',
  '/delete',
  '/exit',
  '/logout',
  '/quit',
  '/stop',
]);
const EXTERNAL_COMMANDS = new Set([
  '/desktop',
  '/install-github-app',
  '/install-slack-app',
  '/login',
  '/mobile',
  '/remote-control',
  '/teleport',
]);
const SENSITIVE_COMMANDS = new Set([
  '/approve',
  '/bypassPermissions',
  '/permissions',
  '/privacy-settings',
  '/sandbox',
]);

const commandDescription = (command: string, category: string): string =>
  `${category} · ${command.slice(1).replaceAll('-', ' ')}`;

const ALL_PLATFORMS: CliCommandPlatform[] = ['windows', 'macos', 'linux'];

const commandAvailability = (
  runtime: CliCommandRuntime,
  command: string,
): Pick<CliCommandDefinition, 'platforms' | 'requirements'> => {
  const platforms: CliCommandPlatform[] =
    command === '/desktop' || (runtime === 'codex' && command === '/app')
      ? ['windows', 'macos']
      : runtime === 'codex' &&
          (command === '/setup-default-sandbox' || command === '/sandbox-add-read-dir')
        ? ['windows']
        : [...ALL_PLATFORMS];
  const shared: Record<string, string[]> = {
    '/agent': ['至少存在一个已派生的子代理线程'],
    '/apps': ['当前环境已启用 Apps/Connectors'],
    '/fast': ['当前模型目录声明可用 Fast tier'],
    '/hooks': ['Hook 功能可用；实际条目取决于当前配置'],
    '/personality': ['当前模型支持 personality 指令'],
    '/plugins': ['插件功能与策略允许'],
    '/ps': ['unified_exec 已启用时才会列出后台终端'],
    '/skills': ['实际条目取决于本机动态安装的 Skills'],
  };
  const claude: Record<string, string[]> = {
    '/autofix-pr': ['需要 gh CLI 与 Claude Code on the web 访问权限'],
    '/batch': ['需要 Git 仓库'],
    '/chrome': ['需要 Claude in Chrome 功能'],
    '/design-sync': ['仅 Anthropic API 接入可用'],
    '/desktop': ['需要 Claude 订阅；Windows 仅 x64'],
    '/focus': ['仅 fullscreen renderer'],
    '/fork': ['需要 Claude Code >= 2.1.212；agent view 关闭时行为不同'],
    '/passes': ['仅符合资格的账户显示'],
    '/privacy-settings': ['仅 Pro/Max 订阅'],
    '/radio': ['Bedrock、Vertex、Foundry 与 Claude Platform on AWS 不可用'],
    '/remote-control': ['需要 Claude.ai 订阅并登录'],
    '/remote-env': ['需要 cloud agents'],
    '/sandbox': ['仅支持 sandbox 的平台/环境'],
    '/schedule': ['需要 Anthropic 托管云 routines 能力'],
    '/scroll-speed': ['仅 fullscreen renderer；JetBrains IDE 终端不可用'],
    '/setup-bedrock': ['仅 CLAUDE_CODE_USE_BEDROCK=1 时显示'],
    '/setup-vertex': ['仅 CLAUDE_CODE_USE_VERTEX=1 时显示'],
    '/stop': ['仅附着到后台会话时可用'],
    '/subtask': ['需要 Claude Code >= 2.1.212 且 agent view 开启'],
    '/teleport': ['需要 Claude.ai 订阅与 Claude Code on the web 会话'],
    '/terminal-setup': ['仅在需要额外键位配置的终端显示'],
    '/voice': ['需要 Claude.ai 账户'],
    '/web-setup': ['需要本机 gh CLI'],
  };
  const codex: Record<string, string[]> = {
    '/app': ['需要已安装或可安装的 ChatGPT 桌面应用'],
    '/archive': ['任务运行期间不可用'],
    '/copy': ['至少已有一条完成的输出'],
    '/delete': ['任务或 side chat 运行期间不可用'],
    '/import': ['仅本地空闲 TUI；远程/App Server 会话不可用'],
    '/plan': ['任务运行期间不可用'],
    '/sandbox-add-read-dir': ['仅原生 Windows CLI'],
    '/setup-default-sandbox': ['仅 degraded restricted-token sandbox'],
    '/side': ['side chat、review mode 或任务运行期间不可用'],
    '/stop': ['仅对当前会话的后台终端生效'],
  };
  return {
    platforms,
    requirements: [
      ...(shared[command] ?? []),
      ...((runtime === 'claude' ? claude : codex)[command] ?? []),
    ],
  };
};

const buildCatalog = (
  runtime: CliCommandRuntime,
  groups: ReadonlyArray<readonly [string, string]>,
  aliases: Record<string, string[]>,
): CliCommandDefinition[] =>
  groups.flatMap(([category, commands]) =>
    commands.split(' ').map((command) => {
      const availability = commandAvailability(runtime, command);
      return {
        action: runtime === 'claude' && CLAUDE_RUNNABLE.has(command) ? 'run' : 'compose',
        aliases: aliases[command] ?? [],
        category,
        command,
        description: commandDescription(command, category),
        documentedVersion: runtime === 'claude' ? '2.1.221' : '0.146.0',
        platforms: availability.platforms,
        requirements: availability.requirements,
        risk: DESTRUCTIVE_COMMANDS.has(command)
          ? 'destructive'
          : EXTERNAL_COMMANDS.has(command)
            ? 'external'
            : SENSITIVE_COMMANDS.has(command)
              ? 'sensitive'
              : 'safe',
        runtime,
        source: runtime === 'claude' ? CLAUDE_COMMAND_SOURCE : CODEX_COMMAND_SOURCE,
        syntax: (runtime === 'claude' ? CLAUDE_SYNTAX : CODEX_SYNTAX)[command] ?? command,
      } satisfies CliCommandDefinition;
    }),
  );

export const CLAUDE_COMMAND_CATALOG = buildCatalog('claude', CLAUDE_GROUPS, CLAUDE_ALIASES);
export const CODEX_COMMAND_CATALOG = buildCatalog('codex', CODEX_GROUPS, CODEX_ALIASES);
export const CLI_COMMAND_CATALOG = [...CLAUDE_COMMAND_CATALOG, ...CODEX_COMMAND_CATALOG];

export const commandInvocationNames = (runtime: CliCommandRuntime): string[] =>
  CLI_COMMAND_CATALOG.filter((entry) => entry.runtime === runtime).flatMap((entry) => [
    entry.command,
    ...entry.aliases,
  ]);

export const findCliCommand = (
  runtime: CliCommandRuntime,
  invocation: string,
): CliCommandDefinition | undefined =>
  CLI_COMMAND_CATALOG.find(
    (entry) =>
      entry.runtime === runtime &&
      (entry.command === invocation || entry.aliases.includes(invocation)),
  );

export const claudeRunnableCommands = (): ReadonlyMap<string, boolean> =>
  new Map(
    CLAUDE_COMMAND_CATALOG.filter((entry) => entry.action === 'run').flatMap((entry) =>
      [entry.command, ...entry.aliases].map((invocation) => [invocation, false]),
    ),
  );
