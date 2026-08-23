import { StringDecoder } from 'node:string_decoder';

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const redactSensitivePaths = (value: string, sensitivePaths: readonly string[]): string => {
  let redacted = value;
  for (const sensitivePath of sensitivePaths) {
    if (!sensitivePath) continue;
    const variants = new Set([
      sensitivePath,
      sensitivePath.replaceAll('\\', '/'),
      sensitivePath.replaceAll('/', '\\'),
    ]);
    for (const variant of variants) {
      redacted = redacted.replace(new RegExp(escapeRegularExpression(variant), 'gi'), '[授权目录]');
    }
  }
  return redacted;
};

export const managedGatewayErrorMessage = (
  error: unknown,
  sensitivePaths: readonly string[] = [],
): string => {
  const raw = redactSensitivePaths(
    error instanceof Error ? error.message : String(error),
    sensitivePaths,
  );
  return raw
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----/gi, '[私钥已隐藏]')
    .replace(/-----END [^-\r\n]*PRIVATE KEY-----/gi, '[私钥已隐藏]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/mgmt-claudedock-[A-Za-z0-9_-]{8,}/gi, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer [已隐藏]')
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|authorization|password|credential|account(?:[_-]?id)?|email|plan(?:[_-]?(?:id|name|type))?)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      '$1[已隐藏]',
    )
    .replace(/([?&](?:code|token|state)\s*=)[^&\s]+/gi, '$1[已隐藏]')
    .replace(/^Authentication saved to .+$/gim, 'Authentication saved')
    .replace(/codex-[^\r\n/\\]*\.json/gi, '[OpenAI 授权文件]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱已隐藏]')
    .replace(/\b(?:acct|account)[-_][A-Za-z0-9_-]{4,}\b/gi, '[账户标识已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}\b/g, '[已隐藏]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[凭据已隐藏]@')
    .replace(/https?:\/\/localhost:\d+\/[^\s]+/gi, '[本机回调地址]')
    .replace(/https?:\/\/127\.0\.0\.1:\d+\/[^\s]+/gi, '[本机回调地址]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
};

export class ManagedGatewayStartupLog {
  private readonly decoder = new StringDecoder('utf8');
  private lines: string[] = [];
  private remainder = '';
  private totalCharacters = 0;

  public constructor(
    private readonly maximumCharacters = 12_000,
    private readonly maximumLines = 40,
    private readonly sensitivePaths: readonly string[] = [],
  ) {}

  public append(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const parts = `${this.remainder}${text}`.split(/\r?\n/);
    this.remainder = parts.pop() ?? '';
    for (const line of parts) {
      this.push(line);
    }
  }

  public finish(): void {
    const final = `${this.remainder}${this.decoder.end()}`;
    this.remainder = '';
    if (final) this.push(final);
  }

  public summary(): string {
    this.finish();
    return this.lines.join(' | ').slice(-this.maximumCharacters);
  }

  private push(line: string): void {
    const sanitized = managedGatewayErrorMessage(line, this.sensitivePaths);
    if (!sanitized) return;
    this.lines.push(sanitized);
    this.totalCharacters += sanitized.length;
    while (this.lines.length > this.maximumLines || this.totalCharacters > this.maximumCharacters) {
      const removed = this.lines.shift();
      this.totalCharacters -= removed?.length ?? 0;
    }
  }
}
