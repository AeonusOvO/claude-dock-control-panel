import type { McpCatalogEntry } from '../contracts';

/** Renderer-safe offline-first display metadata. Install recipes remain main-process-owned. */
export const CURATED_MCP_SERVERS: readonly McpCatalogEntry[] = [
  {
    description: '在明确选择的项目目录内读取和管理文件。',
    featured: true,
    id: 'curated:filesystem',
    installable: true,
    name: 'filesystem',
    requiresCredential: false,
    transport: 'stdio',
  },
  {
    description: '提供结构化、可修订的顺序思考工具。',
    featured: true,
    id: 'curated:sequential-thinking',
    installable: true,
    name: 'sequential-thinking',
    requiresCredential: false,
    transport: 'stdio',
  },
  {
    description: '按库与版本检索最新技术文档和示例。',
    featured: true,
    id: 'curated:context7',
    installable: true,
    name: 'context7',
    requiresCredential: false,
    transport: 'http',
  },
];
