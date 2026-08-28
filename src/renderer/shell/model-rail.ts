import type { ClaudeConfigView } from '../../shared/contracts';
import {
  modelBrand,
  modelRailIconForProvider,
  type ModelRailIconId,
} from '../platform/model-brands';

const fallbackPaths = {
  model: ['M12 3 3 7.5 12 12l9-4.5L12 3Z', 'M3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5'],
  relay: [
    'M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.3 7',
    'M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7L12.7 17',
  ],
};

const fallbackIcon = (kind: keyof typeof fallbackPaths): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const data of fallbackPaths[kind]) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
};

/** Derives navigation identity from saved global state, never the draft or active conversation. */
export const createModelRail = (
  button: HTMLButtonElement,
): ((config?: ClaudeConfigView) => void) => {
  const icon = button.querySelector<HTMLElement>('.activity-rail__model-icon')!;
  let renderedIcon: ModelRailIconId | undefined;
  let generation = 0;

  return (config): void => {
    const id = modelRailIconForProvider(config?.preset);
    if (renderedIcon === id) return;
    renderedIcon = id;
    const revision = ++generation;
    button.dataset.modelBrand = id;
    if (id === 'model' || id === 'relay') {
      button.setAttribute('aria-label', id === 'model' ? '模型' : '模型，当前接入：中转站');
      icon.replaceChildren(fallbackIcon(id));
      return;
    }

    const brand = modelBrand(id);
    button.setAttribute('aria-label', `模型，当前接入：${brand.label}`);
    const images = (['light', 'dark'] as const).map((appearance) => {
      const image = document.createElement('img');
      image.alt = '';
      image.className = `activity-rail__model-image activity-rail__model-image--${appearance}`;
      image.classList.toggle('activity-rail__model-image--monochrome', brand.monochrome === true);
      image.addEventListener('error', () => {
        if (revision === generation) icon.replaceChildren(fallbackIcon('model'));
      });
      image.src = appearance === 'dark' ? (brand.dark ?? brand.light) : brand.light;
      return image;
    });
    icon.replaceChildren(...images);
  };
};
