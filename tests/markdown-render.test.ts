// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { marked } from 'marked';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKatexMathRenderer,
  createMarkdownRenderer,
  partitionMarkdownStream,
  type KatexRenderApi,
  type MarkdownFrameScheduler,
  type MarkdownRendererOptions,
} from '../src/renderer/markdown';

const createRenderer = (overrides: Partial<MarkdownRendererOptions> = {}) =>
  createMarkdownRenderer({
    document,
    onOpenExternal: vi.fn(),
    writeClipboardText: vi.fn(),
    ...overrides,
  });

const click = (element: Element): boolean =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

const nextMicrotask = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('safe Markdown DOM rendering', () => {
  it('keeps the main renderer CSP closed to remote image requests', () => {
    const html = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u)?.[1];

    expect(policy).toContain("img-src 'self' data:;");
    expect(policy).not.toMatch(/img-src[^;]*https?:/u);
  });

  it('builds the supported Markdown structures without interpreting raw HTML', async () => {
    const renderer = createRenderer();
    const container = document.createElement('div');

    await renderer.renderInto(
      container,
      [
        '# 标题',
        '',
        '**粗体**、*强调*与 ~~删除~~',
        '',
        '- 列表',
        '',
        '> 引用',
        '',
        '| 名称 | 状态 |',
        '| --- | :---: |',
        '| ClaudeDock | 正常 |',
        '',
        '<script>globalThis.compromised = true</script>',
        '<img src="x" onerror="globalThis.compromised = true">',
      ].join('\n'),
    );

    expect(container.querySelector('h1')?.textContent).toBe('标题');
    expect(container.querySelector('strong')?.textContent).toBe('粗体');
    expect(container.querySelector('em')?.textContent).toBe('强调');
    expect(container.querySelector('del')?.textContent).toBe('删除');
    expect(container.querySelector('li')?.textContent).toBe('列表');
    expect(container.querySelector('blockquote')?.textContent).toBe('引用');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>globalThis.compromised = true</script>');
    expect(container.textContent).toContain(
      '<img src="x" onerror="globalThis.compromised = true">',
    );
  });

  it('rejects executable URLs and delegates safe external links without renderer navigation', async () => {
    const onOpenExternal = vi.fn();
    const renderer = createRenderer({ onOpenExternal });
    const container = document.createElement('div');

    await renderer.renderInto(
      container,
      [
        '[安全链接](https://example.com/docs?q=claude)',
        '[危险链接](javascript:globalThis.compromised=true)',
        '![安全图片](data:image/png;base64,AA==)',
        '![危险图片](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
      ].join('\n\n'),
    );

    const link = container.querySelector('a');
    expect(link?.textContent).toBe('安全链接');
    expect(link?.hasAttribute('target')).toBe(false);
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');

    expect(click(link as HTMLAnchorElement)).toBe(false);
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/docs?q=claude');
  });

  it('never creates a remote image request and opens it externally only after explicit consent', async () => {
    const onOpenExternal = vi.fn(async () => undefined);
    const renderer = createRenderer({ onOpenExternal });
    const container = document.createElement('div');

    await renderer.renderInto(
      container,
      '![架构图](https://images.example.com/diagram.png?secret=do-not-leak)',
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toContain('src=');
    expect(onOpenExternal).not.toHaveBeenCalled();
    const open = container.querySelector('.markdown-remote-image__open');
    expect(open?.textContent).toBe('在外部浏览器打开图片');
    expect(container.textContent).toContain('为保护隐私，未自动加载');

    expect(click(open as HTMLButtonElement)).toBe(false);
    await nextMicrotask();
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
    expect(onOpenExternal).toHaveBeenCalledWith(
      'https://images.example.com/diagram.png?secret=do-not-leak',
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses Shiki token data to create spans and copies the original code through the host', async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const codeToTokens = vi.fn(async () => ({
      tokens: [
        [
          { color: 'rgb(120 80 200)', content: 'const', fontStyle: 2 },
          { content: ' answer = 42;' },
        ],
      ],
    }));
    const renderer = createRenderer({
      highlighter: { codeToTokens },
      highlighterTheme: { name: 'claudedock-test-theme' },
      writeClipboardText,
    });
    const container = document.createElement('div');

    await renderer.renderInto(container, '```ts\nconst answer = 42;\n```');

    expect(codeToTokens).toHaveBeenCalledWith('const answer = 42;', {
      lang: 'ts',
      theme: { name: 'claudedock-test-theme' },
    });
    const spans = [...container.querySelectorAll('.markdown-code__token')];
    expect(spans.map((span) => span.textContent).join('')).toBe('const answer = 42;');
    expect((spans[0] as HTMLElement).style.fontWeight).toBe('bold');

    const copyButton = container.querySelector('.markdown-code__copy');
    expect(copyButton?.textContent).toBe('复制');
    click(copyButton as HTMLButtonElement);
    await nextMicrotask();
    expect(writeClipboardText).toHaveBeenCalledWith('const answer = 42;');
    expect(copyButton?.textContent).toBe('已复制');
  });

  it('keeps HTML code inert until the user explicitly runs the artifact', async () => {
    const onRunArtifact = vi.fn(async () => undefined);
    const renderer = createRenderer({ onRunArtifact });
    const container = document.createElement('div');
    const html = '<button onclick="alert(1)">交互</button>';

    await renderer.renderInto(container, `\`\`\`html\n${html}\n\`\`\``);

    expect(container.querySelector('pre code')?.textContent).toBe(html);
    expect(container.querySelector('pre button:not(.markdown-code__copy)')).toBeNull();
    expect(onRunArtifact).not.toHaveBeenCalled();

    const run = container.querySelector('.markdown-artifact-run');
    expect(run?.textContent).toBe('运行此可视化');
    click(run as HTMLButtonElement);
    await nextMicrotask();
    expect(onRunArtifact).toHaveBeenCalledWith(html, expect.any(HTMLElement));
  });

  it('routes inline and display formulas through the locked-down KaTeX adapter', async () => {
    const render = vi.fn<KatexRenderApi['render']>((expression, element) => {
      element.textContent = `rendered:${expression.trim()}`;
    });
    const renderer = createRenderer({
      mathRenderer: createKatexMathRenderer({ render }),
    });
    const container = document.createElement('div');

    await renderer.renderInto(container, 'Inline $x^2$.\n\n$$\ny_1 + y_2\n$$');

    const formulas = [...container.querySelectorAll('.markdown-math')];
    expect(formulas).toHaveLength(2);
    expect(formulas[0]?.classList.contains('markdown-math--inline')).toBe(true);
    expect(formulas[1]?.classList.contains('markdown-math--display')).toBe(true);
    expect(formulas.map((formula) => formula.textContent)).toEqual([
      'rendered:x^2',
      'rendered:y_1 + y_2',
    ]);
    expect(render).toHaveBeenNthCalledWith(
      1,
      'x^2',
      expect.any(HTMLElement),
      expect.objectContaining({
        displayMode: false,
        output: 'htmlAndMathml',
        strict: 'error',
        throwOnError: false,
        trust: false,
      }),
    );
    expect(render).toHaveBeenNthCalledWith(
      2,
      '\ny_1 + y_2\n',
      expect.any(HTMLElement),
      expect.objectContaining({ displayMode: true, trust: false }),
    );
  });

  it('falls back to literal formula text if the math renderer rejects an expression', async () => {
    const renderer = createRenderer({
      mathRenderer: () => {
        throw new Error('unsupported formula');
      },
    });
    const container = document.createElement('div');

    await renderer.renderInto(container, 'Keep $not_supported$ visible.');

    expect(container.querySelector('.markdown-math')?.textContent).toBe('$not_supported$');
  });
});

describe('streaming Markdown rendering', () => {
  it('keeps an unclosed fenced block and everything after it in the unstable tail', () => {
    const partition = partitionMarkdownStream('Stable paragraph.\n\n```html\n<div>still streaming');

    expect(partition.hasUnclosedFence).toBe(true);
    expect(partition.stable.map((token) => token.type).filter((type) => type !== 'space')).toEqual([
      'paragraph',
    ]);
    expect(partition.stableSource).toContain('Stable paragraph.');
    expect(partition.unstable.map((token) => token.type)).toContain('code');
    expect(partition.unstableSource).toContain('```html');
  });

  it('preserves stable DOM nodes while rebuilding only the provisional tail', async () => {
    const renderer = createRenderer();
    const container = document.createElement('div');
    const stream = renderer.createStream(container);

    await stream.update('# Stable heading\n\nTail is streaming');
    const heading = container.querySelector('h1');
    const firstTail = container.querySelector('p');

    await stream.update(
      '# Stable heading\n\nCompleted paragraph.\n\n```html\n<div>still streaming',
    );

    expect(container.querySelector('h1')).toBe(heading);
    expect(container.querySelector('p')).not.toBe(firstTail);
    expect(container.querySelector('p')?.textContent).toBe('Completed paragraph.');
    expect(container.querySelector('pre')?.textContent).toContain('<div>still streaming');

    await stream.finish(
      '# Stable heading\n\nCompleted paragraph.\n\n```html\n<div>done</div>\n```',
    );
    expect(container.querySelector('pre code')?.textContent).toBe('<div>done</div>');
    await expect(stream.update('too late')).rejects.toThrow(/finished/u);
  });

  it('coalesces multiple deltas into one scheduled frame and renders the newest snapshot', async () => {
    let scheduled: FrameRequestCallback | undefined;
    const scheduler: MarkdownFrameScheduler = {
      cancel: vi.fn(),
      request: vi.fn((callback) => {
        scheduled = callback;
        return 7;
      }),
    };
    const renderer = createRenderer();
    const container = document.createElement('div');
    const stream = renderer.createStream(container, scheduler);

    const first = stream.update('old');
    const second = stream.update('newest');
    expect(scheduler.request).toHaveBeenCalledTimes(1);
    expect(scheduled).toBeTypeOf('function');
    scheduled?.(16);
    await Promise.all([first, second]);

    expect(container.textContent).toBe('newest');
  });

  it('lexes only after the stable boundary and down-samples a very large provisional tail', async () => {
    const lexer = vi.spyOn(marked, 'lexer');
    const renderer = createRenderer();
    const container = document.createElement('div');
    const stream = renderer.createStream(container);
    const stable = '# Stable heading\n\n';

    await stream.update(`${stable}${'x'.repeat(5_000)}`);
    const firstTail = container.querySelector('p');
    expect(firstTail?.textContent).toHaveLength(5_000);

    lexer.mockClear();
    await stream.update(`${stable}${'x'.repeat(5_050)}`);
    expect(container.querySelector('p')).toBe(firstTail);
    expect(container.querySelector('p')?.textContent).toHaveLength(5_000);
    expect(lexer).not.toHaveBeenCalled();

    await stream.update(`${stable}${'x'.repeat(5_400)}`);
    expect(container.querySelector('h1')?.textContent).toBe('Stable heading');
    expect(container.querySelector('p')).not.toBe(firstTail);
    expect(container.querySelector('p')?.textContent).toHaveLength(5_400);
    expect(lexer).toHaveBeenCalledTimes(1);
    expect(lexer.mock.calls[0]?.[0]).toBe('x'.repeat(5_400));
  });
});
