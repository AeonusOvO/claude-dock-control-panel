import { describe, expect, it } from 'vitest';
import type { ClaudeNextConversationConnectionState } from '../../src/shared/contracts';
import { CLAUDE_PROVIDERS } from '../../src/shared/claude/providers';
import {
  MODEL_BRANDS,
  MODEL_BRAND_BY_PROVIDER,
  modelRailIconForProvider,
} from '../../src/renderer/platform/model-brands';
import {
  input,
  settle,
  withRenderer,
  withTerminalRenderer,
} from '../helpers/renderer-interaction-fixture';
import { claudeProjectState } from '../helpers/renderer-terminal-fixture';

const railSelector = '[data-rail-tab="connection"]';
const iconSelector = `${railSelector} .activity-rail__model-icon`;
const connection = (
  preset: keyof typeof MODEL_BRAND_BY_PROVIDER,
): ClaudeNextConversationConnectionState => ({
  config: { ...claudeProjectState().config, preset },
});

describe('model navigation', () => {
  it('covers every supported preset and every bundled model brand', () => {
    expect(Object.keys(MODEL_BRAND_BY_PROVIDER).sort()).toEqual(
      CLAUDE_PROVIDERS.map(({ id }) => id).sort(),
    );
    expect(
      [...new Set(Object.values(MODEL_BRAND_BY_PROVIDER))].filter((id) => id !== 'relay').sort(),
    ).toEqual(Object.keys(MODEL_BRANDS).sort());
    expect(modelRailIconForProvider(undefined)).toBe('model');
    expect(modelRailIconForProvider('unknown-provider')).toBe('relay');
    expect(modelRailIconForProvider('__proto__')).toBe('relay');
  });

  it.each(CLAUDE_PROVIDERS)(
    'restores the saved $id icon without opening the model page',
    async ({ id }) => {
      await withRenderer(
        { getNextClaudeConnection: async () => connection(id) },
        async (harness) => {
          await settle(harness);
          const button = harness.query<HTMLButtonElement>(railSelector);
          expect(button.dataset.modelBrand).toBe(MODEL_BRAND_BY_PROVIDER[id]);
          expect(button.querySelector('.activity-rail__label')?.textContent).toBe('模型');
          expect(button.title).toBe('模型');
          expect(button.getAttribute('aria-label')).toMatch(/^模型，当前接入：/u);
          const images = [...button.querySelectorAll('img')];
          if (MODEL_BRAND_BY_PROVIDER[id] === 'relay') {
            expect(images).toHaveLength(0);
            expect(button.querySelector('path')?.getAttribute('d')).toContain('M10 14a4 4');
          } else {
            expect(images).toHaveLength(2);
            for (const image of images) {
              expect(image.getAttribute('src')).toMatch(/\.svg$/u);
              expect(image.getAttribute('src')).not.toMatch(/^https?:/u);
              expect(image.alt).toBe('');
            }
          }
        },
      );
    },
  );

  it('shows a model symbol before connection and retains readable titles when toggled', async () => {
    await withRenderer({}, async (harness) => {
      await settle(harness);
      const button = harness.query<HTMLButtonElement>(railSelector);
      expect(button.dataset.modelBrand).toBe('model');
      expect(button.querySelector('path')?.getAttribute('d')).toContain('M12 3 3 7.5');
      harness.click(railSelector);
      expect(button.title).toBe('模型（再次点击可收起侧栏）');
      harness.click(railSelector);
      expect(button.title).toBe('模型');
    });
  });

  it.each(['success', 'rejected', 'thrown'] as const)(
    'updates only committed connections: %s',
    async (outcome) => {
      const previous = connection('anthropic');
      const next = connection('deepseek');
      let saved = previous;
      await withRenderer(
        {
          getNextClaudeConnection: async () => saved,
          saveNextClaudeConfig: async () => {
            if (outcome === 'thrown') throw new Error('无法保存');
            if (outcome === 'success') saved = next;
            return {
              ok: outcome === 'success',
              state: saved,
              error: outcome === 'rejected' ? '无法保存' : undefined,
            };
          },
        },
        async (harness) => {
          await settle(harness);
          harness.click(railSelector);
          await settle(harness);
          const originalImage = harness.query(`${iconSelector} img`);
          harness.click('[data-provider-id="deepseek"]');
          expect(harness.query(railSelector).dataset.modelBrand).toBe('claude');
          expect(harness.query(`${iconSelector} img`)).toBe(originalImage);
          harness.click('#connection-wizard-next');
          input(harness.query('#claude-credential'), 'fixture-secret');
          harness.query<HTMLFormElement>('#claude-config-form').requestSubmit();
          await settle(harness);
          expect(harness.method('saveNextClaudeConfig')).toHaveBeenCalledOnce();
          expect(harness.query(railSelector).dataset.modelBrand).toBe(
            outcome === 'success' ? 'deepseek' : 'claude',
          );
        },
      );
    },
  );

  it('does not replace the next-model icon on active-conversation broadcasts or draft changes', async () => {
    await withTerminalRenderer(
      { getNextClaudeConnection: async () => connection('deepseek') },
      async (harness) => {
        const original = harness.query(`${iconSelector} img`);
        harness.emit(
          'onClaudeState',
          claudeProjectState({ active: true, ptyGeneration: 1, stateRevision: 50 }),
        );
        await settle(harness);
        expect(harness.query(railSelector).dataset.modelBrand).toBe('deepseek');
        expect(harness.query(`${iconSelector} img`)).toBe(original);
      },
    );
  });

  it('restores the generic model symbol when the saved connection is cleared', async () => {
    let current = connection('kimi-subscription');
    await withRenderer({ getNextClaudeConnection: async () => current }, async (harness) => {
      await settle(harness);
      expect(harness.query(railSelector).dataset.modelBrand).toBe('kimi');
      current = {};
      harness.click(railSelector);
      await settle(harness);
      expect(harness.query(railSelector).dataset.modelBrand).toBe('model');
      expect(harness.query(iconSelector).querySelector('img')).toBeNull();
    });
  });

  it('fences late image failures and uses a visible fallback if the current asset fails', async () => {
    let current = connection('deepseek');
    await withRenderer({ getNextClaudeConnection: async () => current }, async (harness) => {
      await settle(harness);
      const previousImage = harness.query(`${iconSelector} img`);
      current = connection('chatgpt-subscription');
      harness.click(railSelector);
      await settle(harness);
      previousImage.dispatchEvent(new harness.dom.window.Event('error'));
      expect(harness.query(`${iconSelector} img`).getAttribute('src')).toContain(
        'openai-blossom-black',
      );
      harness.query(`${iconSelector} img`).dispatchEvent(new harness.dom.window.Event('error'));
      expect(harness.query(iconSelector).querySelector('svg')).not.toBeNull();
      expect(harness.query(railSelector).getAttribute('aria-label')).toContain('OpenAI');
    });
  });
});
