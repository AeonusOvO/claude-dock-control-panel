import type { McpCatalogEntry } from './contracts';

/** Offline-first entries with deterministic install shapes. No credential-bearing server is
 * auto-installed: entries that need secrets remain visible but require their own authentication. */
export const CURATED_MCP_SERVERS: readonly McpCatalogEntry[] = [
  {
    config: {
      args: ['-y', '@modelcontextprotocol/server-filesystem', '{{cwd}}'],
      command: 'npx',
      type: 'stdio',
    },
    description: '在明确选择的项目目录内读取和管理文件。',
    featured: true,
    id: 'curated:filesystem',
    name: 'filesystem',
    officialUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    requiresCredential: false,
    transport: 'stdio',
  },
  {
    config: {
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      command: 'npx',
      type: 'stdio',
    },
    description: '提供结构化、可修订的顺序思考工具。',
    featured: true,
    id: 'curated:sequential-thinking',
    name: 'sequential-thinking',
    officialUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    requiresCredential: false,
    transport: 'stdio',
  },
  {
    config: { type: 'http', url: 'https://mcp.context7.com/mcp' },
    description: '按库与版本检索最新技术文档和示例。',
    featured: true,
    id: 'curated:context7',
    name: 'context7',
    officialUrl: 'https://github.com/upstash/context7',
    requiresCredential: false,
    transport: 'http',
  },
];
