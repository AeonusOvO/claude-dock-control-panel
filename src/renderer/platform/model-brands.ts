import type { ClaudeProviderId } from '../../shared/claude/providers';
import claude from '../assets/brands/claude-spark-clay.svg';
import openaiLight from '../assets/brands/openai-blossom-black.svg';
import openaiDark from '../assets/brands/openai-blossom-white.svg';
import deepseek from '../assets/brands/model-deepseek.svg';
import glm from '../assets/brands/model-glm.svg';
import kimi from '../assets/brands/model-kimi.svg';
import minimax from '../assets/brands/model-minimax.svg';
import mimo from '../assets/brands/model-mimo.svg';
import qwen from '../assets/brands/model-qwen.svg';
import doubao from '../assets/brands/model-doubao.svg';
import stepfun from '../assets/brands/model-stepfun.svg';
import hunyuan from '../assets/brands/model-hunyuan.svg';
import wenxin from '../assets/brands/model-wenxin.svg';
import spark from '../assets/brands/model-spark.svg';
import ollama from '../assets/brands/model-ollama.svg';

interface ModelBrand {
  label: string;
  light: string;
  dark?: string;
  monochrome?: boolean;
}

/** Local, audited artwork only. Model versions in one family share their brand. */
export const MODEL_BRANDS = {
  claude: { label: 'Claude', light: claude },
  openai: { label: 'ChatGPT / OpenAI', light: openaiLight, dark: openaiDark },
  deepseek: { label: 'DeepSeek', light: deepseek },
  glm: { label: 'GLM / 智谱', light: glm, monochrome: true },
  kimi: { label: 'Kimi', light: kimi, monochrome: true },
  minimax: { label: 'MiniMax', light: minimax },
  mimo: { label: '小米 MiMo', light: mimo, monochrome: true },
  qwen: { label: '千问', light: qwen },
  doubao: { label: '豆包 / 火山方舟', light: doubao },
  stepfun: { label: '阶跃星辰', light: stepfun },
  hunyuan: { label: '腾讯混元', light: hunyuan },
  wenxin: { label: '百度文心', light: wenxin },
  spark: { label: '讯飞星火', light: spark },
  ollama: { label: 'Ollama', light: ollama, monochrome: true },
} satisfies Record<string, ModelBrand>;

export type ModelBrandId = keyof typeof MODEL_BRANDS;
export type ModelRailIconId = ModelBrandId | 'model' | 'relay';

/** Exhaustive over supported presets, including regional and subscription variants. */
export const MODEL_BRAND_BY_PROVIDER = {
  anthropic: 'claude',
  'anthropic-api': 'claude',
  'chatgpt-subscription': 'openai',
  deepseek: 'deepseek',
  'glm-cn': 'glm',
  'glm-global': 'glm',
  'glm-api': 'glm',
  'glm-subscription-cn': 'glm',
  'glm-subscription-global': 'glm',
  'kimi-code': 'kimi',
  'kimi-open': 'kimi',
  'kimi-subscription': 'kimi',
  'minimax-cn': 'minimax',
  'minimax-global': 'minimax',
  'minimax-subscription-cn': 'minimax',
  'minimax-subscription-global': 'minimax',
  mimo: 'mimo',
  'qwen-cn': 'qwen',
  'qwen-global': 'qwen',
  'qwen-api': 'qwen',
  doubao: 'doubao',
  'doubao-api': 'doubao',
  stepfun: 'stepfun',
  'stepfun-api': 'stepfun',
  hunyuan: 'hunyuan',
  qianfan: 'wenxin',
  spark: 'spark',
  ollama: 'ollama',
  // A recognizable upstream model name must not disguise a relay as an official connection.
  siliconflow: 'relay',
  openrouter: 'relay',
  custom: 'relay',
  gateway: 'relay',
  curl: 'relay',
} as const satisfies Record<ClaudeProviderId, ModelBrandId | 'relay'>;

export const modelRailIconForProvider = (providerId: string | undefined): ModelRailIconId => {
  if (providerId === undefined) return 'model';
  if (!Object.hasOwn(MODEL_BRAND_BY_PROVIDER, providerId)) return 'relay';
  return MODEL_BRAND_BY_PROVIDER[providerId as ClaudeProviderId];
};

export const modelBrand = (id: ModelBrandId): ModelBrand => MODEL_BRANDS[id];
