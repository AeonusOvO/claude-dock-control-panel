import type { ClaudePluginView } from '../contracts';

export interface LocalizedPluginCopy {
  category: string;
  description: string;
  originalDescription?: string;
}

interface CapabilityRule {
  label: string;
  pattern: RegExp;
}

const capabilityRules: CapabilityRule[] = [
  { label: '安全检查与漏洞发现', pattern: /security|vulnerab|owasp|audit|threat|secret/i },
  { label: '自动化测试与质量验证', pattern: /\btest|testing|quality|coverage|qa\b/i },
  { label: 'API 设计、调试与文档处理', pattern: /\bapi\b|openapi|swagger|endpoint|graphql/i },
  {
    label: '代码审查、规范检查与重构',
    pattern: /code review|lint|format|refactor|static analysis/i,
  },
  { label: 'Git 与代码托管协作', pattern: /\bgit\b|github|gitlab|pull request|repository/i },
  {
    label: '数据库、SQL 与数据模型操作',
    pattern: /database|\bsql\b|postgres|mysql|mongodb|redis/i,
  },
  {
    label: '云服务、部署与基础设施管理',
    pattern: /cloud|deploy|kubernetes|docker|terraform|aws|azure|gcp/i,
  },
  {
    label: '监控、日志与可观测性分析',
    pattern: /monitor|logging|observability|telemetry|incident|sentry/i,
  },
  {
    label: '文档编写、知识库与内容整理',
    pattern: /document|documentation|knowledge|wiki|content/i,
  },
  {
    label: '前端、界面与无障碍开发',
    pattern: /frontend|react|vue|angular|css|design|figma|accessibility|\bui\b/i,
  },
  { label: '移动端与跨平台应用开发', pattern: /mobile|android|ios|flutter|react native/i },
  {
    label: '数据分析、机器学习与研究',
    pattern: /data|analytics|machine learning|\bml\b|research|science/i,
  },
  {
    label: '项目管理与团队协作',
    pattern: /project management|productivity|workflow|jira|linear|slack|team/i,
  },
  { label: '构建、发布与依赖维护', pattern: /build|release|package|dependency|npm|ci\/cd|\bci\b/i },
  { label: '搜索、检索与信息提取', pattern: /search|retriev|extract|crawler|scrap/i },
  { label: '开发流程自动化', pattern: /automat|agent|orchestrat|workflow/i },
];

const categoryRules: CapabilityRule[] = [
  { label: '安全与审计', pattern: /security|vulnerab|owasp|audit|compliance|threat/i },
  { label: '测试与质量', pattern: /\btest|testing|quality|coverage|lint|review/i },
  { label: '数据与数据库', pattern: /database|\bsql\b|data|analytics|postgres|mysql|mongodb/i },
  {
    label: '部署与运维',
    pattern: /deploy|cloud|kubernetes|docker|terraform|monitor|observability/i,
  },
  { label: '设计与前端', pattern: /frontend|react|vue|angular|css|design|figma|\bui\b/i },
  { label: '文档与知识', pattern: /document|knowledge|wiki|content|research/i },
  {
    label: '协作与效率',
    pattern: /productivity|workflow|jira|linear|slack|team|project management/i,
  },
  { label: '开发工具', pattern: /./i },
];

const containsChinese = (value: string): boolean => /[\u3400-\u9fff]/u.test(value);

export const localizePluginCopy = (
  plugin: Pick<ClaudePluginView, 'description' | 'marketplaceName' | 'name'>,
): LocalizedPluginCopy => {
  const description = plugin.description.trim();
  if (!description || description === '这个插件没有提供说明。') {
    return {
      category: '插件扩展',
      description: `“${plugin.name}”暂未提供详细说明。安装后可在 Claude Code 中使用来自 ${plugin.marketplaceName} 的扩展能力。`,
    };
  }
  if (containsChinese(description)) {
    return {
      category: categoryRules.find((rule) => rule.pattern.test(description))?.label ?? '插件扩展',
      description,
    };
  }

  const capabilities = capabilityRules
    .filter((rule) => rule.pattern.test(description))
    .map((rule) => rule.label)
    .slice(0, 3);
  const category =
    categoryRules.find((rule) => rule.pattern.test(description))?.label ?? '开发工具';
  const capabilityCopy =
    capabilities.length > 0
      ? `主要用于${capabilities.join('、')}。`
      : '用于扩展 Claude Code 的项目处理能力。';
  const automationCopy = /automat|automatically|streamline|accelerat/i.test(description)
    ? '可帮助减少重复操作并加快日常开发流程。'
    : '具体支持范围以插件原文和安装后的命令说明为准。';

  return {
    category,
    description: `${capabilityCopy}${automationCopy}`,
    originalDescription: description,
  };
};
