export const requiredElement = <ElementType extends HTMLElement>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
};
