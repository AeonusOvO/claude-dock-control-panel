import { RUNTIME_SUMMARY_ICON_PATHS, type RuntimeSummaryIconKind } from './runtime-activity-labels';

export const createRuntimeSummaryIcon = (kind: RuntimeSummaryIconKind): HTMLSpanElement => {
  const icon = document.createElement('span');
  icon.className = 'runtime-summary-icon';
  icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const pathDefinition of RUNTIME_SUMMARY_ICON_PATHS[kind]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathDefinition);
    svg.append(path);
  }
  icon.append(svg);
  return icon;
};

interface RuntimeSummaryRowInput {
  action?: HTMLButtonElement;
  detail?: string;
  environment?: boolean;
  icon: RuntimeSummaryIconKind;
  status?: string;
  statusLabel?: string;
  title: string;
}

export const createRuntimeSummaryRow = ({
  action,
  detail,
  environment = false,
  icon,
  status,
  statusLabel,
  title,
}: RuntimeSummaryRowInput): HTMLLIElement => {
  const item = document.createElement('li');
  item.className = `runtime-summary-row${environment ? ' runtime-summary-row--environment' : ''}`;
  if (status) item.dataset.status = status;
  const copy = document.createElement('div');
  copy.className = 'runtime-summary-row__copy';
  const titleLine = document.createElement('div');
  titleLine.className = 'runtime-summary-row__title';
  const heading = document.createElement('strong');
  heading.textContent = title;
  heading.title = title;
  titleLine.append(heading);
  if (statusLabel) {
    const statusElement = document.createElement('span');
    statusElement.className = 'runtime-summary-row__tag';
    statusElement.textContent = statusLabel;
    titleLine.append(statusElement);
  }
  copy.append(titleLine);
  if (detail) {
    const description = document.createElement('span');
    description.textContent = detail;
    description.title = detail;
    copy.append(description);
  }
  item.append(createRuntimeSummaryIcon(icon), copy);
  if (action) {
    const trailing = document.createElement('div');
    trailing.className = 'runtime-summary-row__trailing';
    trailing.append(action);
    item.append(trailing);
  }
  return item;
};

export const createRuntimeSummaryEmpty = (message: string): HTMLLIElement => {
  const item = document.createElement('li');
  item.className = 'runtime-summary-empty';
  const text = document.createElement('span');
  text.textContent = message;
  item.append(createRuntimeSummaryIcon('empty'), text);
  return item;
};
