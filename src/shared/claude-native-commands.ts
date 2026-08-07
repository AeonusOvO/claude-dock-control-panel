import { CLAUDE_COMMAND_CATALOG, findCliCommand } from './cli-command-catalog';
import type { ConversationCommandView } from './native-conversation';

export type ClaudeNativeCommandMapping = ConversationCommandView['mapping'];

const CLAUDEDOCK_COMMANDS = new Set([
  '/color',
  '/config',
  '/context',
  '/cost',
  '/doctor',
  '/fast',
  '/hooks',
  '/login',
  '/logout',
  '/mcp',
  '/memory',
  '/model',
  '/permissions',
  '/plugin',
  '/privacy-settings',
  '/reload-plugins',
  '/reload-skills',
  '/status',
  '/statusline',
  '/theme',
  '/usage',
  '/usage-credits',
]);

const FORM_COMMANDS = new Set([
  '/clear',
  '/copy',
  '/effort',
  '/exit',
  '/plan',
  '/rename',
  '/resume',
  '/stop',
  '/tasks',
]);

const TERMINAL_ONLY_COMMANDS = new Set([
  '/focus',
  '/keybindings',
  '/scroll-speed',
  '/terminal-setup',
  '/tui',
  '/voice',
]);

const mappingFor = (name: string): ClaudeNativeCommandMapping => {
  if (CLAUDEDOCK_COMMANDS.has(name)) return 'claudedock';
  if (FORM_COMMANDS.has(name)) return 'form';
  if (TERMINAL_ONLY_COMMANDS.has(name)) return 'terminal-only';
  return 'adapter';
};

export const CLAUDE_NATIVE_COMMANDS: ConversationCommandView[] = CLAUDE_COMMAND_CATALOG.map(
  (definition) => ({
    aliases: [...definition.aliases],
    argumentHint: definition.syntax === definition.command ? undefined : definition.syntax,
    description: definition.description,
    mapping: mappingFor(definition.command),
    name: definition.command,
  }),
);

const byInvocation = new Map(
  CLAUDE_NATIVE_COMMANDS.flatMap((command) =>
    [command.name, ...command.aliases].map((name) => [name, command]),
  ),
);

export const resolveClaudeNativeCommand = (input: string): ConversationCommandView | undefined => {
  const invocation = input.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return invocation ? byInvocation.get(invocation) : undefined;
};

export const nativeCommandCoverage = (): { missing: string[]; total: number } => ({
  missing: CLAUDE_COMMAND_CATALOG.filter(
    (definition) =>
      !resolveClaudeNativeCommand(definition.command) ||
      !findCliCommand('claude', definition.command),
  ).map((definition) => definition.command),
  total: CLAUDE_COMMAND_CATALOG.length,
});

export const mergeRuntimeClaudeCommands = (
  runtimeCommands: ReadonlyArray<{
    aliases?: readonly string[];
    argumentHint?: string;
    description?: string;
    name: string;
  }>,
): ConversationCommandView[] => {
  const known = new Map(CLAUDE_NATIVE_COMMANDS.map((command) => [command.name.slice(1), command]));
  const merged = CLAUDE_NATIVE_COMMANDS.map((command) => ({
    ...command,
    aliases: [...command.aliases],
  }));
  for (const runtimeCommand of runtimeCommands) {
    const normalized = runtimeCommand.name.replace(/^\//, '').toLowerCase();
    if (known.has(normalized)) continue;
    merged.push({
      aliases: (runtimeCommand.aliases ?? []).map((alias) => `/${alias.replace(/^\//, '')}`),
      argumentHint: runtimeCommand.argumentHint,
      description:
        runtimeCommand.description || '新版 Claude Code 命令；ClaudeDock 尚未完成兼容检测。',
      mapping: 'unknown',
      name: `/${normalized}`,
    });
  }
  return merged;
};
