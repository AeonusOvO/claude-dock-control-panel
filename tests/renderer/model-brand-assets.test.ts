import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const assetsDirectory = path.join(process.cwd(), 'src', 'renderer', 'assets', 'brands');
const sourceRoot =
  'https://raw.githubusercontent.com/lobehub/lobe-icons/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-svg/icons';
const assets = [
  [
    'model-deepseek.svg',
    'deepseek-color',
    'deba5f98a5c1796e20fcac3149bcd7eb8a32f0bdd04d048819400b1f28bd1439',
  ],
  ['model-glm.svg', 'zai', 'e748cb5108ce37b116d7a5ba97d37e0ae97eadf6849b0de11afb248e244a01e1'],
  ['model-kimi.svg', 'kimi', 'ed08131b46acf70e6e2144eceb775e74098b58ea65fa21eaee04be7b05cfe63b'],
  [
    'model-minimax.svg',
    'minimax-color',
    '7f7187fa6d9b341ac5f22f6c5a970523afb439dc45566d64eb4f4b9b604d6b01',
  ],
  [
    'model-mimo.svg',
    'xiaomimimo',
    'b04ad7dad52af2212c4567daf0ee6856f2c4625c92c680a27f9880295d558b71',
  ],
  [
    'model-qwen.svg',
    'qwen-color',
    '77f5768c66d08ce1d3d14e73373975c1bc0454be88c81523ddd0ffd7e2974029',
  ],
  [
    'model-doubao.svg',
    'doubao-color',
    '3cd31ba03ae44b8c29561597a3b863809efecb13fcdfd08407a086df86a69b55',
  ],
  [
    'model-stepfun.svg',
    'stepfun-color',
    'f55afc0e6004c8854f76bd5bbcc0fce9fc0ed9316691d54fb02d088c24fab40d',
  ],
  [
    'model-hunyuan.svg',
    'hunyuan-color',
    '510e7bb438506b5aadfaf8b9551d1606efd5b4171161a64a64204c72a453658a',
  ],
  [
    'model-wenxin.svg',
    'wenxin-color',
    '9fb88d8b6f7be470ddb07f0574ec276b08a35ba96d73ec5f2f3b6fc338da5cb6',
  ],
  [
    'model-spark.svg',
    'spark-color',
    '4068581452b808e4d9f8c5b43b42d324512d6801de26e57cf848125c28db85bc',
  ],
  [
    'model-ollama.svg',
    'ollama',
    '3a268218fb2e6e81fa31df70f70b51331625047794db81db21d35359428fae7a',
  ],
] as const;

describe('bundled model brand artwork', () => {
  it.each(assets)(
    'preserves pinned source geometry and attribution for %s',
    (fileName, slug, hash) => {
      const asset = readFileSync(path.join(assetsDirectory, fileName), 'utf8');
      const source = asset.replace(/^<!--[\s\S]*?-->\s*/u, '').trimEnd();
      expect(asset).toContain('Source: ' + sourceRoot + '/' + slug + '.svg');
      expect(asset).toContain('Retrieved: 2026-08-28');
      expect(asset).toContain('Source SVG SHA-256: ' + hash);
      expect(createHash('sha256').update(source).digest('hex')).toBe(hash);
      expect(asset).toContain('viewBox="0 0 24 24"');
      expect(asset).not.toMatch(/<(?:image|script|foreignObject)\b|\son\w+=|\shref=|url\((?!#)/iu);
    },
  );

  it('ships the upstream MIT attribution in the existing packaged NOTICE', () => {
    const notice = readFileSync(path.join(process.cwd(), 'NOTICE'), 'utf8');
    expect(notice).toContain('Copyright (c) 2023 LobeHub');
    expect(notice).toContain('Permission is hereby granted, free of charge');
    expect(notice).toContain('4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75');
  });
});
