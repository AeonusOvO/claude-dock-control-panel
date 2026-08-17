import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clampPercentage } from '../src/renderer/percentage-utils';
import { rendererStyles } from './renderer-css';

describe('Footer resource percentage clamping', () => {
  it('should clamp percentages to 0-100 range using production helper', () => {
    // Test the actual production clampPercentage function
    expect(clampPercentage(150)).toBe(100);
    expect(clampPercentage(99.7)).toBe(99.7);
    expect(clampPercentage(-5)).toBe(0);
    expect(clampPercentage(0)).toBe(0);
    expect(clampPercentage(100)).toBe(100);
    expect(clampPercentage(50.5)).toBe(50.5);
    expect(clampPercentage(undefined)).toBe(undefined);
  });
});

describe('Footer menu CSS and HTML semantics', () => {
  it('should have role=radio selected styles in production CSS', () => {
    // Verify the production CSS includes role=radio selected state
    expect(rendererStyles).toContain("button[role='radio'][aria-checked='true']");
    expect(rendererStyles).toMatch(/button\[role='radio'\]\[aria-checked='true'\]\s*\{/);
  });

  it('should have radiogroup containers in production HTML', () => {
    const htmlPath = resolve(__dirname, '../src/renderer/index.html');
    const htmlContent = readFileSync(htmlPath, 'utf-8');

    // Verify resource preference buttons use role=radio in radiogroup
    expect(htmlContent).toContain('role="radiogroup"');
    expect(htmlContent).toContain('role="radio"');
    expect(htmlContent).toContain('data-resource-preference');
  });

  it('should have aria-controls on footer trigger buttons in production HTML', () => {
    const htmlPath = resolve(__dirname, '../src/renderer/index.html');
    const htmlContent = readFileSync(htmlPath, 'utf-8');

    // Verify footer triggers have aria-controls
    expect(htmlContent).toMatch(/id="footer-model"[^>]*aria-controls="footer-model-menu"/);
    expect(htmlContent).toMatch(/id="footer-speed"[^>]*aria-controls="footer-speed-menu"/);
    expect(htmlContent).toMatch(/id="footer-mode"[^>]*aria-controls="footer-mode-menu"/);
    expect(htmlContent).toMatch(/id="footer-effort"[^>]*aria-controls="footer-effort-menu"/);
  });
});

describe('Footer menu item focus restoration', () => {
  it('should restore focus to trigger after menu selection in buildFooterMenuItem', () => {
    const mainPath = resolve(__dirname, '../src/renderer/main.ts');
    const mainContent = readFileSync(mainPath, 'utf-8');

    // Verify buildFooterMenuItem click handler contains hideFooterMenus, onChoose, and focus restoration in order
    const buildFooterMenuItemMatch = mainContent.match(
      /const buildFooterMenuItem = \([^)]+\)[^{]+\{[\s\S]+?item\.addEventListener\('click', \(\) => \{([\s\S]+?)\}\);/,
    );

    expect(buildFooterMenuItemMatch).toBeTruthy();
    if (!buildFooterMenuItemMatch?.[1]) {
      throw new Error('buildFooterMenuItem click handler body not found');
    }

    const clickHandlerBody: string = buildFooterMenuItemMatch[1];

    // Verify the sequence: hideFooterMenus() -> onChoose() -> triggerButton?.focus()
    const hideIndex = clickHandlerBody.indexOf('hideFooterMenus()');
    const onChooseIndex = clickHandlerBody.indexOf('onChoose()');
    const focusIndex = clickHandlerBody.indexOf('triggerButton?.focus()');

    expect(hideIndex).toBeGreaterThan(-1);
    expect(onChooseIndex).toBeGreaterThan(-1);
    expect(focusIndex).toBeGreaterThan(-1);

    // Verify order: hide -> choose -> focus
    expect(onChooseIndex).toBeGreaterThan(hideIndex);
    expect(focusIndex).toBeGreaterThan(onChooseIndex);
  });
});

describe('Footer menu native conversation refresh logic', () => {
  it('should refresh native conversation footer when activeNativeConversationId exists', () => {
    const mainPath = resolve(__dirname, '../src/renderer/main.ts');
    const mainContent = readFileSync(mainPath, 'utf-8');

    // Extract ChatGPT window mode handler using precise start/end markers
    const chatgptStart = mainContent.indexOf(
      'const contextWindowMode = button?.dataset.contextWindowMode',
    );
    const chatgptEnd = mainContent.indexOf('const preference = button?.dataset.resourcePreference');
    expect(chatgptStart).toBeGreaterThan(-1);
    expect(chatgptEnd).toBeGreaterThan(chatgptStart);

    const chatgptHandler = mainContent.slice(chatgptStart, chatgptEnd);

    // Verify ChatGPT handler checks activeNativeConversationId and renders native conversation
    expect(chatgptHandler).toContain('if (activeNativeConversationId)');
    expect(chatgptHandler).toContain('nativeConversationSnapshots.get(activeNativeConversationId)');
    expect(chatgptHandler).toContain('renderNativeConversation(snapshot)');
    expect(chatgptHandler).toContain('hideFooterMenus()');
    expect(chatgptHandler).toContain('footerResource.focus()');

    // Extract resource preference handler using precise start/end markers
    const resourceStart = mainContent.indexOf(
      'const preference = button?.dataset.resourcePreference',
    );
    const resourceEnd = mainContent.indexOf('footerModel.addEventListener(');
    expect(resourceStart).toBeGreaterThan(-1);
    expect(resourceEnd).toBeGreaterThan(resourceStart);

    const resourceHandler = mainContent.slice(resourceStart, resourceEnd);

    // Verify resource preference handler checks activeNativeConversationId first
    expect(resourceHandler).toContain('if (activeNativeConversationId)');
    expect(resourceHandler).toContain(
      'nativeConversationSnapshots.get(activeNativeConversationId)',
    );
    expect(resourceHandler).toContain('renderNativeConversation(snapshot)');

    // Verify else branch renders terminal/Codex footer
    expect(resourceHandler).toContain('} else {');
    expect(resourceHandler).toContain('renderFooterResource');
    expect(resourceHandler).toContain('hideFooterMenus()');
    expect(resourceHandler).toContain('footerResource.focus()');
  });

  it('should refresh native conversation footer in applyClaudeContextWindowMode', () => {
    const mainPath = resolve(__dirname, '../src/renderer/main.ts');
    const mainContent = readFileSync(mainPath, 'utf-8');

    // Extract applyClaudeContextWindowMode using precise start/end markers
    const applyStart = mainContent.indexOf('const applyClaudeContextWindowMode = (');
    const applyEnd = mainContent.indexOf('claudeContextWindowCustomInput.addEventListener(');
    expect(applyStart).toBeGreaterThan(-1);
    expect(applyEnd).toBeGreaterThan(applyStart);

    const applyClaudeHandler = mainContent.slice(applyStart, applyEnd);

    // Verify it checks activeNativeConversationId first
    expect(applyClaudeHandler).toContain('if (activeNativeConversationId)');
    expect(applyClaudeHandler).toContain(
      'nativeConversationSnapshots.get(activeNativeConversationId)',
    );
    expect(applyClaudeHandler).toContain('renderNativeConversation(snapshot)');

    // Verify else branch for terminal
    expect(applyClaudeHandler).toContain('} else if (status)');
    expect(applyClaudeHandler).toContain('renderFooterResource');
    expect(applyClaudeHandler).toContain('hideFooterMenus()');
    expect(applyClaudeHandler).toContain('footerResource.focus()');
  });
});
