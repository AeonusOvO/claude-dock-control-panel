import { marked } from 'marked';

export interface MarkdownToken {
  align?: Array<null | string>;
  checked?: boolean;
  depth?: number;
  header?: MarkdownTableCell[];
  href?: string;
  items?: MarkdownListItem[];
  lang?: string;
  ordered?: boolean;
  raw?: string;
  rows?: MarkdownTableCell[][];
  start?: number | string;
  text?: string;
  title?: null | string;
  tokens?: MarkdownToken[];
  type: string;
}

interface MarkdownListItem extends MarkdownToken {
  task?: boolean;
}

interface MarkdownTableCell {
  text?: string;
  tokens?: MarkdownToken[];
}

export interface ShikiToken {
  color?: string;
  content: string;
  fontStyle?: number;
}

export interface MarkdownCodeHighlighter {
  codeToTokens(
    code: string,
    options: {
      lang: string;
      theme?: unknown;
    },
  ): Promise<unknown> | unknown;
}

export type MarkdownMathRenderer = (
  expression: string,
  element: HTMLElement,
  displayMode: boolean,
) => Promise<void> | void;

export interface KatexRenderApi {
  render(
    expression: string,
    element: HTMLElement,
    options: {
      displayMode: boolean;
      output: 'htmlAndMathml';
      strict: 'error';
      throwOnError: false;
      trust: false;
    },
  ): void;
}

export interface MarkdownRendererOptions {
  document?: Document;
  highlighter?: MarkdownCodeHighlighter;
  highlighterTheme?: unknown;
  mathRenderer?: MarkdownMathRenderer;
  onOpenExternal: (url: string) => Promise<void> | void;
  onRunArtifact?: (html: string, mount: HTMLElement) => Promise<void> | void;
  writeClipboardText: (text: string) => Promise<void> | void;
}

export interface MarkdownFrameScheduler {
  cancel(handle: number): void;
  request(callback: FrameRequestCallback): number;
}

export interface MarkdownStreamPartition {
  hasUnclosedFence: boolean;
  stable: MarkdownToken[];
  stableSource: string;
  unstable: MarkdownToken[];
  unstableSource: string;
}

interface MathSegment {
  displayMode: boolean;
  expression: string;
  raw: string;
  type: 'math';
}

interface TextSegment {
  text: string;
  type: 'text';
}

type InlineSegment = MathSegment | TextSegment;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const tokenRaw = (token: MarkdownToken): string => token.raw ?? token.text ?? '';

const asTokens = (value: unknown): MarkdownToken[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is MarkdownToken => isRecord(entry) && typeof entry.type === 'string',
      )
    : [];

const lexMarkdown = (source: string): MarkdownToken[] =>
  marked.lexer(source, { gfm: true }) as unknown as MarkdownToken[];

const isEscaped = (source: string, index: number): boolean => {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
};

const findClosingMarker = (source: string, marker: '$' | '$$', start: number): number => {
  for (let cursor = start; cursor <= source.length - marker.length; cursor += 1) {
    if (
      source.startsWith(marker, cursor) &&
      !isEscaped(source, cursor) &&
      (marker === '$$' || (!source.startsWith('$$', cursor) && source[cursor - 1] !== '$'))
    ) {
      return cursor;
    }
  }
  return -1;
};

const splitMathSegments = (source: string): InlineSegment[] => {
  const segments: InlineSegment[] = [];
  let textStart = 0;
  let cursor = 0;

  const appendText = (end: number): void => {
    if (end > textStart) {
      segments.push({ text: source.slice(textStart, end), type: 'text' });
    }
  };

  while (cursor < source.length) {
    if (source[cursor] !== '$' || isEscaped(source, cursor)) {
      cursor += 1;
      continue;
    }

    const marker: '$' | '$$' = source.startsWith('$$', cursor) ? '$$' : '$';
    const expressionStart = cursor + marker.length;
    const closing = findClosingMarker(source, marker, expressionStart);
    if (closing < 0) {
      cursor += marker.length;
      continue;
    }

    const expression = source.slice(expressionStart, closing);
    const invalidInlineSpacing =
      marker === '$' &&
      (/^\s/u.test(expression) || /\s$/u.test(expression) || expression.length === 0);
    if (invalidInlineSpacing || (marker === '$$' && expression.trim().length === 0)) {
      cursor += marker.length;
      continue;
    }

    appendText(cursor);
    const end = closing + marker.length;
    segments.push({
      displayMode: marker === '$$',
      expression,
      raw: source.slice(cursor, end),
      type: 'math',
    });
    cursor = end;
    textStart = end;
  }

  appendText(source.length);
  return segments.length > 0 ? segments : [{ text: source, type: 'text' }];
};

const findUnclosedFenceOffset = (source: string): number | undefined => {
  let activeFence: { character: '`' | '~'; length: number; offset: number } | undefined;
  let offset = 0;
  const lines = source.match(/[^\n]*(?:\n|$)/gu) ?? [];

  for (const lineWithEnding of lines) {
    if (lineWithEnding.length === 0) {
      continue;
    }
    const line = lineWithEnding.replace(/\r?\n$/u, '');
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u)?.[1];
    if (!marker) {
      offset += lineWithEnding.length;
      continue;
    }

    const character = marker[0] as '`' | '~';
    if (!activeFence) {
      activeFence = { character, length: marker.length, offset };
    } else {
      const isClosing =
        character === activeFence.character &&
        marker.length >= activeFence.length &&
        /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.test(line);
      if (isClosing) {
        activeFence = undefined;
      }
    }
    offset += lineWithEnding.length;
  }

  return activeFence?.offset;
};

/**
 * Splits a streaming Markdown snapshot into immutable and provisional token ranges.
 * The final token always remains provisional. An unclosed fenced block also makes
 * the opening fence and everything following it provisional.
 */
export const partitionMarkdownStream = (source: string): MarkdownStreamPartition => {
  const tokens = lexMarkdown(source);
  const unclosedFenceOffset = findUnclosedFenceOffset(source);
  let unstableIndex = Math.max(0, tokens.length - 1);

  if (unclosedFenceOffset !== undefined) {
    let tokenOffset = 0;
    const fenceTokenIndex = tokens.findIndex((token) => {
      const end = tokenOffset + tokenRaw(token).length;
      const overlapsFence = end > unclosedFenceOffset;
      tokenOffset = end;
      return overlapsFence;
    });
    if (fenceTokenIndex >= 0) {
      unstableIndex = Math.min(unstableIndex, fenceTokenIndex);
    }
  }

  const stable = tokens.slice(0, unstableIndex);
  const unstable = tokens.slice(unstableIndex);
  const stableSource = stable.map(tokenRaw).join('');
  return {
    hasUnclosedFence: unclosedFenceOffset !== undefined,
    stable,
    stableSource,
    unstable,
    unstableSource: source.slice(stableSource.length),
  };
};

/**
 * Adapts KaTeX's DOM render API with security-sensitive options fixed by ClaudeDock.
 * The model cannot enable trusted commands, HTML extensions, or throwing parse errors.
 */
export const createKatexMathRenderer =
  (katex: KatexRenderApi): MarkdownMathRenderer =>
  (expression, element, displayMode): void => {
    katex.render(expression, element, {
      displayMode,
      output: 'htmlAndMathml',
      strict: 'error',
      throwOnError: false,
      trust: false,
    });
  };

const safeExternalUrl = (candidate: string): string | undefined => {
  const trimmed = candidate.trim();
  const containsControlCharacter = [...trimmed].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (containsControlCharacter) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const safeEmbeddedImageUrl = (candidate: string): string | undefined => {
  const trimmed = candidate.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/iu.test(trimmed)) {
    return trimmed;
  }
  return undefined;
};

const safeRemoteImageUrl = (candidate: string): string | undefined => {
  const safe = safeExternalUrl(candidate);
  if (!safe) {
    return undefined;
  }
  try {
    const url = new URL(safe);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const normalizedLanguage = (value: string | undefined): string =>
  value?.trim().split(/\s+/u)[0]?.toLowerCase() || 'text';

/**
 * Shiki themes provide literal RGB colours, but code must repaint instantly with the app theme.
 * Preserve each token's hue category while routing the final colour through shell variables.
 */
const syntaxColorVariable = (color: string): string => {
  const hex = color.match(/^#([0-9a-f]{6})$/iu)?.[1];
  const rgb = color.match(/^rgba?\(\s*(\d{1,3})(?:\s+|,\s*)(\d{1,3})(?:\s+|,\s*)(\d{1,3})/iu);
  const channels = hex
    ? [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    : rgb
      ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      : undefined;
  if (!channels) {
    return 'var(--syntax-neutral)';
  }
  const [red = 0, green = 0, blue = 0] = channels.map((value) => Math.min(255, Math.max(0, value)));
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  if (chroma < 24) {
    return 'var(--syntax-neutral)';
  }
  let hue =
    maximum === red
      ? ((green - blue) / chroma) % 6
      : maximum === green
        ? (blue - red) / chroma + 2
        : (red - green) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 18 || hue >= 345) {
    return 'var(--syntax-red)';
  }
  if (hue < 68) {
    return 'var(--syntax-yellow)';
  }
  if (hue < 168) {
    return 'var(--syntax-green)';
  }
  if (hue < 205) {
    return 'var(--syntax-cyan)';
  }
  if (hue < 270) {
    return 'var(--syntax-blue)';
  }
  return 'var(--syntax-magenta)';
};

const shikiLines = (result: unknown): ShikiToken[][] => {
  const candidate = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.tokens)
      ? result.tokens
      : [];
  return candidate
    .filter(Array.isArray)
    .map((line) =>
      line.filter(
        (token): token is ShikiToken => isRecord(token) && typeof token.content === 'string',
      ),
    );
};

const defaultFrameScheduler = (): MarkdownFrameScheduler => ({
  cancel: (handle) => {
    if (typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(handle);
    } else {
      window.clearTimeout(handle);
    }
  },
  request: (callback) =>
    typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(callback)
      : window.setTimeout(() => callback(performance.now()), 0),
});

export class MarkdownDomRenderer {
  private readonly dom: Document;
  private readonly highlighter?: MarkdownCodeHighlighter;
  private readonly highlighterTheme?: unknown;
  private readonly mathRenderer?: MarkdownMathRenderer;
  private readonly onOpenExternal: MarkdownRendererOptions['onOpenExternal'];
  private readonly onRunArtifact?: MarkdownRendererOptions['onRunArtifact'];
  private readonly writeClipboardText: MarkdownRendererOptions['writeClipboardText'];

  public constructor(options: MarkdownRendererOptions) {
    this.dom = options.document ?? document;
    this.highlighter = options.highlighter;
    this.highlighterTheme = options.highlighterTheme;
    this.mathRenderer = options.mathRenderer;
    this.onOpenExternal = options.onOpenExternal;
    this.onRunArtifact = options.onRunArtifact;
    this.writeClipboardText = options.writeClipboardText;
  }

  public createStream(
    container: HTMLElement,
    scheduler: MarkdownFrameScheduler = defaultFrameScheduler(),
  ): MarkdownStreamRenderer {
    return new MarkdownStreamRenderer(this, container, scheduler);
  }

  public async renderFragment(source: string): Promise<DocumentFragment> {
    return this.renderTokens(lexMarkdown(source));
  }

  public async renderInto(container: HTMLElement, source: string): Promise<void> {
    container.replaceChildren(await this.renderFragment(source));
  }

  public async renderTokens(tokens: readonly MarkdownToken[]): Promise<DocumentFragment> {
    const fragment = this.dom.createDocumentFragment();
    for (const token of tokens) {
      await this.appendToken(fragment, token);
    }
    return fragment;
  }

  private async appendChildren(
    parent: Node,
    tokens: MarkdownToken[] | undefined,
    fallback = '',
  ): Promise<void> {
    if (tokens && tokens.length > 0) {
      for (const token of tokens) {
        await this.appendToken(parent, token);
      }
      return;
    }
    await this.appendTextWithMath(parent, fallback);
  }

  private async appendTextWithMath(parent: Node, source: string): Promise<void> {
    for (const segment of splitMathSegments(source)) {
      if (segment.type === 'text') {
        parent.appendChild(this.dom.createTextNode(segment.text));
        continue;
      }

      const math = this.dom.createElement('span');
      math.className = segment.displayMode
        ? 'markdown-math markdown-math--display'
        : 'markdown-math markdown-math--inline';
      math.setAttribute('aria-label', segment.expression);
      math.setAttribute('role', 'math');
      if (!this.mathRenderer) {
        math.textContent = segment.raw;
      } else {
        try {
          await this.mathRenderer(segment.expression, math, segment.displayMode);
        } catch {
          math.replaceChildren(this.dom.createTextNode(segment.raw));
        }
      }
      parent.appendChild(math);
    }
  }

  private async appendCode(parent: Node, token: MarkdownToken): Promise<void> {
    const source = token.text ?? '';
    const language = normalizedLanguage(token.lang);
    const pre = this.dom.createElement('pre');
    pre.className = 'markdown-code';
    pre.dataset.language = language;

    const copy = this.dom.createElement('button');
    copy.className = 'markdown-code__copy';
    copy.type = 'button';
    copy.textContent = '复制';
    copy.setAttribute('aria-label', `复制${language === 'text' ? '' : ` ${language}`}代码`);
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      void (async () => {
        try {
          await this.writeClipboardText(source);
          copy.textContent = '已复制';
        } catch {
          copy.textContent = '复制失败';
        }
      })();
    });

    const code = this.dom.createElement('code');
    code.dataset.language = language;
    if (this.highlighter) {
      try {
        const options =
          this.highlighterTheme === undefined
            ? { lang: language }
            : { lang: language, theme: this.highlighterTheme };
        const lines = shikiLines(await this.highlighter.codeToTokens(source, options));
        if (lines.length === 0) {
          code.textContent = source;
        } else {
          lines.forEach((line, lineIndex) => {
            for (const highlighted of line) {
              const span = this.dom.createElement('span');
              span.className = 'markdown-code__token';
              span.textContent = highlighted.content;
              if (highlighted.color) {
                span.style.color = syntaxColorVariable(highlighted.color);
              }
              if (highlighted.fontStyle !== undefined) {
                if ((highlighted.fontStyle & 1) !== 0) {
                  span.style.fontStyle = 'italic';
                }
                if ((highlighted.fontStyle & 2) !== 0) {
                  span.style.fontWeight = 'bold';
                }
                const decorations: string[] = [];
                if ((highlighted.fontStyle & 4) !== 0) {
                  decorations.push('underline');
                }
                if ((highlighted.fontStyle & 8) !== 0) {
                  decorations.push('line-through');
                }
                if (decorations.length > 0) {
                  span.style.textDecoration = decorations.join(' ');
                }
              }
              code.append(span);
            }
            if (lineIndex < lines.length - 1) {
              code.append(this.dom.createTextNode('\n'));
            }
          });
        }
      } catch {
        code.textContent = source;
      }
    } else {
      code.textContent = source;
    }

    pre.append(copy, code);
    parent.appendChild(pre);

    if ((language === 'html' || language === 'htm') && this.onRunArtifact) {
      const run = this.dom.createElement('button');
      run.className = 'markdown-artifact-run';
      run.type = 'button';
      run.textContent = '运行此可视化';
      const artifactMount = this.dom.createElement('div');
      artifactMount.className = 'artifact-view';
      artifactMount.dataset.state = 'idle';
      run.addEventListener('click', (event) => {
        event.preventDefault();
        void (async () => {
          run.disabled = true;
          try {
            await this.onRunArtifact?.(source, artifactMount);
          } catch {
            run.textContent = '运行失败';
          } finally {
            run.disabled = false;
          }
        })();
      });
      parent.appendChild(run);
      parent.appendChild(artifactMount);
    }
  }

  private async appendTable(parent: Node, token: MarkdownToken): Promise<void> {
    const table = this.dom.createElement('table');
    const head = this.dom.createElement('thead');
    const headRow = this.dom.createElement('tr');
    for (const [index, cell] of (token.header ?? []).entries()) {
      const element = this.dom.createElement('th');
      const alignment = token.align?.[index];
      if (alignment === 'left' || alignment === 'center' || alignment === 'right') {
        element.dataset.align = alignment;
      }
      await this.appendChildren(element, cell.tokens, cell.text ?? '');
      headRow.append(element);
    }
    head.append(headRow);
    table.append(head);

    const body = this.dom.createElement('tbody');
    for (const row of token.rows ?? []) {
      const rowElement = this.dom.createElement('tr');
      for (const [index, cell] of row.entries()) {
        const element = this.dom.createElement('td');
        const alignment = token.align?.[index];
        if (alignment === 'left' || alignment === 'center' || alignment === 'right') {
          element.dataset.align = alignment;
        }
        await this.appendChildren(element, cell.tokens, cell.text ?? '');
        rowElement.append(element);
      }
      body.append(rowElement);
    }
    table.append(body);
    parent.appendChild(table);
  }

  private async appendToken(parent: Node, token: MarkdownToken): Promise<void> {
    switch (token.type) {
      case 'space':
      case 'def':
        return;
      case 'paragraph': {
        const paragraph = this.dom.createElement('p');
        await this.appendChildren(paragraph, asTokens(token.tokens), token.text ?? '');
        parent.appendChild(paragraph);
        return;
      }
      case 'heading': {
        const depth = Math.min(6, Math.max(1, token.depth ?? 1));
        const heading = this.dom.createElement(`h${depth}`);
        await this.appendChildren(heading, asTokens(token.tokens), token.text ?? '');
        parent.appendChild(heading);
        return;
      }
      case 'blockquote': {
        const quote = this.dom.createElement('blockquote');
        await this.appendChildren(quote, asTokens(token.tokens), token.text ?? '');
        parent.appendChild(quote);
        return;
      }
      case 'list': {
        const list = this.dom.createElement(token.ordered ? 'ol' : 'ul');
        const start = Number(token.start);
        if (token.ordered && Number.isInteger(start) && start > 1) {
          list.setAttribute('start', String(start));
        }
        for (const item of token.items ?? []) {
          const listItem = this.dom.createElement('li');
          if (item.task) {
            listItem.append(this.dom.createTextNode(item.checked ? '[x] ' : '[ ] '));
          }
          await this.appendChildren(listItem, asTokens(item.tokens), item.text ?? '');
          list.append(listItem);
        }
        parent.appendChild(list);
        return;
      }
      case 'table':
        await this.appendTable(parent, token);
        return;
      case 'hr':
        parent.appendChild(this.dom.createElement('hr'));
        return;
      case 'code':
        await this.appendCode(parent, token);
        return;
      case 'strong':
      case 'em':
      case 'del': {
        const element = this.dom.createElement(token.type);
        await this.appendChildren(element, asTokens(token.tokens), token.text ?? '');
        parent.appendChild(element);
        return;
      }
      case 'codespan': {
        const code = this.dom.createElement('code');
        code.textContent = token.text ?? '';
        parent.appendChild(code);
        return;
      }
      case 'br':
        parent.appendChild(this.dom.createElement('br'));
        return;
      case 'link': {
        const safe = safeExternalUrl(token.href ?? '');
        if (!safe) {
          await this.appendChildren(parent, asTokens(token.tokens), token.text ?? token.raw ?? '');
          return;
        }
        const link = this.dom.createElement('a');
        link.href = safe;
        if (token.title) {
          link.title = token.title;
        }
        await this.appendChildren(link, asTokens(token.tokens), token.text ?? safe);
        link.addEventListener('click', (event) => {
          event.preventDefault();
          void (async () => {
            try {
              await this.onOpenExternal(safe);
            } catch {
              // The host reports navigation errors; never fall back to renderer navigation.
            }
          })();
        });
        parent.appendChild(link);
        return;
      }
      case 'image': {
        const embedded = safeEmbeddedImageUrl(token.href ?? '');
        if (embedded) {
          const image = this.dom.createElement('img');
          image.src = embedded;
          image.alt = token.text ?? '';
          image.loading = 'lazy';
          image.decoding = 'async';
          image.setAttribute('referrerpolicy', 'no-referrer');
          if (token.title) {
            image.title = token.title;
          }
          parent.appendChild(image);
          return;
        }

        const remote = safeRemoteImageUrl(token.href ?? '');
        if (!remote) {
          parent.appendChild(this.dom.createTextNode(token.text ?? token.raw ?? ''));
          return;
        }

        const placeholder = this.dom.createElement('span');
        placeholder.className = 'markdown-remote-image';
        placeholder.setAttribute('role', 'group');
        placeholder.setAttribute('aria-label', `远程图片：${token.text || '未命名图片'}`);
        const label = this.dom.createElement('span');
        label.className = 'markdown-remote-image__label';
        label.textContent = `${token.text || '远程图片'}（为保护隐私，未自动加载）`;
        const open = this.dom.createElement('button');
        open.className = 'button button--quiet markdown-remote-image__open';
        open.type = 'button';
        open.textContent = '在外部浏览器打开图片';
        open.title = '图片不会嵌入 ClaudeDock；点击后交给系统浏览器打开。';
        open.addEventListener('click', (event) => {
          event.preventDefault();
          void (async () => {
            try {
              await this.onOpenExternal(remote);
            } catch {
              // Never fall back to an unaudited renderer request or navigation.
            }
          })();
        });
        placeholder.append(label, open);
        parent.appendChild(placeholder);
        return;
      }
      case 'text':
      case 'escape':
        if (token.type === 'text' && token.tokens && token.tokens.length > 0) {
          await this.appendChildren(parent, asTokens(token.tokens), token.text ?? '');
        } else {
          await this.appendTextWithMath(parent, token.text ?? token.raw ?? '');
        }
        return;
      case 'html':
      case 'tag':
        parent.appendChild(this.dom.createTextNode(token.raw ?? token.text ?? ''));
        return;
      default:
        parent.appendChild(this.dom.createTextNode(token.raw ?? token.text ?? ''));
    }
  }
}

interface StreamWaiter {
  reject(error: unknown): void;
  resolve(): void;
  revision: number;
}

export class MarkdownStreamRenderer {
  private static readonly EAGER_TAIL_LIMIT = 4_096;
  private static readonly MIN_TAIL_GROWTH = 256;
  private static readonly TAIL_GROWTH_DIVISOR = 16;

  private committedStableSource = '';
  private destroyed = false;
  private finalRequested = false;
  private finalized = false;
  private frameHandle: number | undefined;
  private lastRenderedSource = '';
  private latestSource = '';
  private rendering = false;
  private revision = 0;
  private stableNodes: Node[] = [];
  private tailNodes: Node[] = [];
  private readonly waiters: StreamWaiter[] = [];

  public constructor(
    private readonly renderer: MarkdownDomRenderer,
    private readonly container: HTMLElement,
    private readonly scheduler: MarkdownFrameScheduler,
  ) {}

  public update(source: string): Promise<void> {
    if (this.destroyed || this.finalized || this.finalRequested) {
      return Promise.reject(new Error('Markdown stream is already finished.'));
    }
    return this.requestRender(source, false);
  }

  public finish(source: string): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Markdown stream has been destroyed.'));
    }
    if (this.finalized) {
      return Promise.resolve();
    }
    this.finalRequested = true;
    return this.requestRender(source, true);
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.frameHandle !== undefined) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = undefined;
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve();
    }
  }

  private requestRender(source: string, final: boolean): Promise<void> {
    this.latestSource = source;
    this.finalRequested ||= final;
    this.revision += 1;
    const revision = this.revision;
    const rendered = new Promise<void>((resolve, reject) => {
      this.waiters.push({ reject, resolve, revision });
    });
    this.schedule();
    return rendered;
  }

  private schedule(): void {
    if (
      this.destroyed ||
      this.rendering ||
      this.frameHandle !== undefined ||
      (this.finalized && this.waiters.length === 0)
    ) {
      return;
    }
    this.frameHandle = this.scheduler.request(() => {
      this.frameHandle = undefined;
      void this.renderLatest();
    });
  }

  private resolveThrough(revision: number): void {
    const ready = this.waiters.filter((waiter) => waiter.revision <= revision);
    const pending = this.waiters.filter((waiter) => waiter.revision > revision);
    this.waiters.length = 0;
    this.waiters.push(...pending);
    for (const waiter of ready) {
      waiter.resolve();
    }
  }

  private rejectThrough(revision: number, error: unknown): void {
    const ready = this.waiters.filter((waiter) => waiter.revision <= revision);
    const pending = this.waiters.filter((waiter) => waiter.revision > revision);
    this.waiters.length = 0;
    this.waiters.push(...pending);
    for (const waiter of ready) {
      waiter.reject(error);
    }
  }

  private removeNodes(nodes: Node[]): void {
    for (const node of nodes) {
      node.parentNode?.removeChild(node);
    }
  }

  /**
   * An unfinished paragraph or fence can stay provisional for a long response. Re-lexing it for
   * every tiny delta is quadratic, so beyond the eager window preview refreshes require growth
   * proportional to the provisional tail. Skipped revisions are still settled; finish() always
   * renders the exact final source.
   */
  private shouldDeferLargeTail(source: string, tailLength: number): boolean {
    if (
      tailLength <= MarkdownStreamRenderer.EAGER_TAIL_LIMIT ||
      this.lastRenderedSource.length === 0 ||
      source.length < this.lastRenderedSource.length
    ) {
      return false;
    }
    const growth = source.length - this.lastRenderedSource.length;
    const requiredGrowth = Math.max(
      MarkdownStreamRenderer.MIN_TAIL_GROWTH,
      Math.ceil(tailLength / MarkdownStreamRenderer.TAIL_GROWTH_DIVISOR),
    );
    return growth < requiredGrowth;
  }

  private async renderLatest(): Promise<void> {
    const revision = this.revision;
    const source = this.latestSource;
    const final = this.finalRequested;
    this.rendering = true;
    try {
      if (final) {
        const fragment = await this.renderer.renderFragment(source);
        if (revision !== this.revision || this.destroyed) {
          return;
        }
        const nodes = [...fragment.childNodes];
        this.container.replaceChildren(fragment);
        this.stableNodes = nodes;
        this.tailNodes = [];
        this.committedStableSource = source;
        this.lastRenderedSource = source;
        this.finalized = true;
        this.resolveThrough(revision);
        return;
      }

      const extendsStablePrefix = source.startsWith(this.committedStableSource);
      const partitionSource = extendsStablePrefix
        ? source.slice(this.committedStableSource.length)
        : source;
      const appendOnlyPreview = source.startsWith(this.lastRenderedSource);
      if (
        extendsStablePrefix &&
        appendOnlyPreview &&
        this.shouldDeferLargeTail(source, partitionSource.length)
      ) {
        this.resolveThrough(revision);
        return;
      }

      const partition = partitionMarkdownStream(partitionSource);
      const [stableFragment, tailFragment] = await Promise.all([
        this.renderer.renderTokens(partition.stable),
        this.renderer.renderTokens(partition.unstable),
      ]);
      if (revision !== this.revision || this.destroyed) {
        return;
      }

      this.removeNodes(this.tailNodes);
      this.tailNodes = [];
      if (!extendsStablePrefix) {
        this.removeNodes(this.stableNodes);
        this.stableNodes = [];
      }

      const newStableNodes = [...stableFragment.childNodes];
      this.container.append(stableFragment);
      this.stableNodes.push(...newStableNodes);
      const newTailNodes = [...tailFragment.childNodes];
      this.container.append(tailFragment);
      this.tailNodes = newTailNodes;
      this.committedStableSource = `${extendsStablePrefix ? this.committedStableSource : ''}${partition.stableSource}`;
      this.lastRenderedSource = source;
      this.resolveThrough(revision);
    } catch (error) {
      this.rejectThrough(revision, error);
    } finally {
      this.rendering = false;
      if (!this.destroyed && this.revision > revision) {
        this.schedule();
      }
    }
  }
}

export const createMarkdownRenderer = (options: MarkdownRendererOptions): MarkdownDomRenderer =>
  new MarkdownDomRenderer(options);
