const normalizedRuntimeError = (value: string): string => {
  const compact = value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
  if (/ConnectionRefused/i.test(compact)) {
    return 'Claude Code 无法连接到当前接口地址。端点可能已停止、被代理拒绝，或保存后的路由已经变化。';
  }
  if (
    /input exceeds the context window|context window of this model|maximum context length|too many input tokens/i.test(
      compact,
    )
  ) {
    return '当前对话已超过模型上下文上限，连压缩请求也无法送达。请新建对话继续；ClaudeDock 已改为按模型与窗口模式设置容量，并在后续托管 ChatGPT 会话中提前自动压缩。';
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid (?:api )?key|authentication/i.test(compact)) {
    return 'Claude Code 的真实会话被接口拒绝认证。请重新核对认证方式与当前保存的密钥。';
  }
  if (/model.+(?:not found|invalid|unsupported|does not exist)|unknown model/i.test(compact)) {
    return `Claude Code 的真实会话未被当前模型接受。供应商原始错误：${compact}`;
  }
  if (/\b404\b|not found/i.test(compact)) {
    return 'Claude Code 没有找到消息接口；请确认当前基址最终提供 /v1/messages。';
  }
  if (
    /output_config\.effort.+(?:xhigh|max).+not supported when thinking is disabled/i.test(compact)
  ) {
    return 'Claude Code 在 thinking 关闭的请求中发送了过高的思考档位；ClaudeDock 正在自动降到“均衡”。';
  }
  return compact
    ? 'Claude Code 的接口请求失败；请检查接入地址、认证方式和模型配置。原始错误已保留在终端输出中。'
    : 'Claude Code 的真实会话请求失败。';
};

const withoutTerminalControls = (value: string): string =>
  value
    .replace(
      // ANSI CSI / OSC control sequences emitted by the terminal renderer.
      // eslint-disable-next-line no-control-regex
      /(?:\][^]*(?:|\\)|\[[0-?]*[ -/]*[@-~])/g,
      '',
    )
    .replace(/\r/g, '\n');

const latestClaudeRuntimeApiError = (value: string): string | undefined => {
  const withoutAnsi = withoutTerminalControls(value);
  const marker = 'api error:';
  const markerAt = withoutAnsi.toLowerCase().lastIndexOf(marker);
  if (markerAt < 0) {
    return undefined;
  }
  return withoutAnsi
    .slice(markerAt + marker.length, markerAt + marker.length + 800)
    .replace(/\s+/g, ' ')
    .trim();
};

export const parseClaudeEffortThinkingDisabledError = (
  value: string,
): 'max' | 'xhigh' | undefined => {
  const latest = latestClaudeRuntimeApiError(value);
  if (!latest || !/output_config\.effort/i.test(latest) || !/thinking is disabled/i.test(latest)) {
    return undefined;
  }
  const rejected = /output_config\.effort\s*['"]?(xhigh|max)['"]?/i
    .exec(latest)?.[1]
    ?.toLowerCase();
  return rejected === 'max' || rejected === 'xhigh' ? rejected : undefined;
};

export const parseClaudeRuntimeApiError = (value: string): string | undefined => {
  const latest = latestClaudeRuntimeApiError(value);
  return latest ? normalizedRuntimeError(latest) : undefined;
};

export const parseClaudeContextWindowError = (value: string): boolean => {
  const latest = latestClaudeRuntimeApiError(value);
  return Boolean(
    latest &&
    // `prompt is too long` is the canonical Anthropic 400 wording; gateways reword it freely, so
    // match the shortened form some of them emit as well.
    /input exceeds the context window|context window of this model|maximum context length|too many input tokens|prompt is too long|prompt too long/i.test(
      latest,
    ),
  );
};
