# ClaudeDock CLI 指令清单

本清单是 ClaudeDock 4.6.0 的静态工作台目录，用于核对内置入口，不替代 CLI 自己根据版本、平台、功能开关、Skills、Plugins 和 MCP 动态生成的 `/` 列表。动态安装项只在原生列表中展示，不伪装为静态“完整清单”。

- 核对日期：2026-08-05
- Claude Code 目标版本：2.1.221
- Codex CLI 目标版本：0.146.0
- Claude 来源：[Claude Code commands](https://code.claude.com/docs/en/commands)
- Codex 来源：[Codex developer commands](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli)

注册表的唯一实现位于 `src/shared/ui/cli-command-catalog.ts`，主进程执行白名单、Claude/Codex 工作台和自动化测试共同读取它。每项均携带运行时、主命令、别名、官方语法、分类、来源、核对版本、平台、功能条件、风险以及 `run`/`compose` 动作。Claude 只有安全且无需必填参数的少数命令可直接排队，直接执行入口一律不接受参数；带参数、退出/清理、外部跳转或敏感权限命令只填入输入框或再次确认。Codex 全部为 `compose`，权限仍由原生 TUI 处理。

## Claude Code：101 个主表项，120 个调用名

### 会话与上下文

`/add-dir`、`/background`（`/bg`）、`/branch`、`/btw`、`/cd`、`/clear`（`/reset`、`/new`）、`/compact`、`/context`、`/copy`、`/exit`（`/quit`）、`/export`、`/focus`、`/fork`、`/goal`、`/recap`、`/rename`、`/resume`（`/continue`）、`/rewind`（`/checkpoint`、`/undo`）、`/stop`、`/subtask`、`/tasks`（`/bashes`）、`/teleport`（`/tp`）、`/tui`。

### 模型、模式与设置

`/advisor`、`/autocompact`、`/color`、`/config`（`/settings`）、`/effort`、`/fast`、`/keybindings`、`/model`、`/permissions`（`/allowed-tools`）、`/plan`、`/privacy-settings`、`/remote-control`（`/rc`）、`/remote-env`、`/sandbox`、`/scroll-speed`、`/statusline`、`/terminal-setup`、`/theme`、`/voice`。

### 代理与扩展

`/agents`、`/batch`、`/chrome`、`/desktop`（`/app`）、`/fewer-permission-prompts`、`/hooks`、`/ide`、`/init`、`/loop`（`/proactive`）、`/mcp`、`/memory`、`/plugin`、`/reload-plugins`、`/reload-skills`、`/schedule`（`/routines`）、`/skills`、`/workflows`。

### 开发与审查

`/autofix-pr`、`/claude-api`、`/code-review`、`/dataviz`、`/debug`、`/deep-research`、`/design-login`、`/design-sync`、`/diff`、`/install-github-app`、`/install-slack-app`、`/review`、`/run`、`/run-skill-generator`、`/security-review`、`/setup-bedrock`、`/setup-vertex`、`/simplify`、`/team-onboarding`、`/ultrareview`、`/verify`、`/web-setup`。

### 账户与帮助

`/bug`（`/share`）、`/cost`、`/doctor`（`/checkup`）、`/feedback`、`/heapdump`、`/help`、`/insights`、`/login`、`/logout`、`/mobile`（`/ios`、`/android`）、`/passes`、`/powerup`、`/radio`、`/release-notes`、`/stats`、`/status`、`/stickers`、`/upgrade`、`/usage`、`/usage-credits`。

明确排除已移除的 `/pr-comments`、`/vim`、`/ultraplan`。

## Codex CLI：50 个主表项，53 个调用名

### 会话

`/agent`（`/subagents`）、`/clear`、`/rename`、`/archive`、`/delete`、`/compact`、`/copy`、`/exit`、`/quit`、`/fork`、`/side`（`/btw`）、`/raw`、`/resume`、`/new`、`/review`、`/status`、`/usage`、`/app`。

### 模式与配置

`/permissions`、`/keymap`、`/vim`、`/setup-default-sandbox`、`/sandbox-add-read-dir`、`/experimental`、`/approve`、`/memories`、`/model`、`/fast`、`/plan`、`/goal`、`/personality`、`/debug-config`、`/statusline`、`/title`、`/theme`、`/pets`（`/pet`）。

### 工具与扩展

`/ide`、`/apps`、`/plugins`、`/hooks`、`/skills`、`/import`、`/feedback`、`/init`、`/logout`、`/mcp`、`/mention`、`/diff`、`/ps`、`/stop`。

Codex 的所有静态入口只生成命令骨架，不自动发送；实时审批不从原生 TUI 迁出。
