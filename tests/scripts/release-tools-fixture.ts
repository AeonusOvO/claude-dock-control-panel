import { blake2b } from '@noble/hashes/blake2.js';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { vi } from 'vitest';

export interface Artifact {
  bytes: number;
  name: string;
  sha256: string;
  sha512: string;
}

interface SourceIdentity {
  gitHead: string;
  packageLockSha256: string;
  treeClean: boolean;
}

export interface ReleaseManifest {
  artifacts: Artifact[];
  channel: string;
  channelManifest: string;
  cohort: unknown;
  directory: string;
  feedUrl?: string;
  generatedAt: string;
  problems: string[];
  provider?: string;
  signature: string;
  source: SourceIdentity;
  version: string;
}

export interface ArchiveReader {
  extractFile(archivePath: string, filePath: string): Buffer;
  listPackage(archivePath: string): string[];
}

interface InstallerExtractor {
  (options: { destination: string; installerPath: string }): void;
}

interface ReleaseValidation {
  blockmap?: Artifact;
  channelManifestBytes?: Buffer;
  channelManifestPath: string;
  installer?: Artifact;
  manifest: ReleaseManifest;
  updateManifest?: { version?: string };
}

interface ManifestTools {
  compareSemanticVersions(left: string, right: string): number;
  readSourceIdentity(options: { projectRoot: string }): SourceIdentity;
  resolveReleaseChannel(packageManifest: unknown): string;
  sanitizeManifestText(value: unknown): string;
  validateGenericFeed(packageManifest: unknown): { feedUrl: string };
  validateRelease(options: {
    archive?: ArchiveReader;
    extractInstaller?: InstallerExtractor;
    now?: Date;
    projectRoot: string;
    releaseDirectory?: string;
    signatureStatus?: () => string;
    sourceIdentity?: () => SourceIdentity;
    temporaryRoot?: string;
    writeReport?: boolean;
  }): ReleaseValidation;
}

export interface ObjectDescriptor {
  body?: Buffer;
  bytes: number;
  cacheControl: string;
  contentType: string;
  firstByte?: number;
  key: string;
  localPath?: string;
  remoteName?: string;
  sha256?: string;
  sha512?: string;
}

interface RemoteObject {
  body: Buffer;
  cacheControl: string;
  sha256?: string;
  sha512?: string;
}

interface ReleaseOrchestrationTools {
  releaseSteps: readonly { arguments: string[]; name: string }[];
  writeReleaseOrchestration(options: { releaseDirectory: string; source: SourceIdentity }): {
    recordPath: string;
  };
}

interface PublisherTools {
  CHANNEL_CACHE_CONTROL: string;
  IMMUTABLE_CACHE_CONTROL: string;
  createCosStorage(options: {
    bucket: string;
    client: {
      deleteObject?(parameters: unknown): Promise<unknown>;
      getBucketVersioning?(parameters: unknown): Promise<unknown>;
      getObject?(parameters: unknown): Promise<unknown>;
      headObject(parameters: unknown): Promise<unknown>;
      putObject(parameters: unknown): Promise<unknown>;
    };
    region: string;
    secrets?: string[];
  }): {
    assertAtomicCreateSupported(): Promise<void>;
    create(descriptor: ObjectDescriptor): Promise<boolean>;
    head(key: string): Promise<unknown>;
    read(key: string): Promise<Buffer | undefined>;
  };
  loadFrozenValidatedRelease(options: {
    archive?: ArchiveReader;
    extractInstaller?: InstallerExtractor;
    now?: Date;
    projectRoot: string;
    releaseDirectory?: string;
    signatureStatus?: () => string;
    sourceIdentity?: () => SourceIdentity;
    temporaryRoot?: string;
  }): ReleaseValidation;
  publishValidatedRelease(options: {
    fetchImpl: typeof fetch;
    log?: (message: string) => void;
    prefix: string;
    promoteChannels?: string[];
    release: ReleaseValidation;
    storage: {
      assertAtomicCreateSupported(): Promise<void>;
      create(descriptor: ObjectDescriptor): Promise<boolean>;
      delete(key: string): Promise<void>;
      head(key: string): Promise<{
        bytes?: number;
        cacheControl?: string;
        exists: boolean;
        sha256?: string;
        sha512?: string;
      }>;
      put(descriptor: ObjectDescriptor): Promise<void>;
      read(key: string): Promise<Buffer | undefined>;
    };
  }): Promise<{ assets: string[]; channels: string[]; version: string }>;
  readCosEnvironment(
    feedUrl: string,
    environment: Record<string, string>,
  ): {
    prefix: string;
  };
  redactSensitiveText(value: unknown, secrets?: string[]): string;
}

const scriptsDirectory = path.join(__dirname, '..', '..', 'scripts', 'release');
export const manifestTools = (await import(
  pathToFileURL(path.join(scriptsDirectory, 'manifest.mjs')).href
)) as ManifestTools;
export const publisherTools = (await import(
  pathToFileURL(path.join(scriptsDirectory, 'publish-cos.mjs')).href
)) as PublisherTools;
export const releaseOrchestrationTools = (await import(
  pathToFileURL(path.join(scriptsDirectory, 'release.mjs')).href
)) as ReleaseOrchestrationTools;

export const fixtureRoots: string[] = [];
const fixtureArchives = new Map<string, ArchiveReader>();
const fixtureExtractors = new Map<string, InstallerExtractor>();
const fixtureSourceIdentities = new Map<string, SourceIdentity>();
export const feedUrl = 'https://claudedock-test-123.cos.ap-test.myqcloud.com/updates/windows/x64/';
export const prefix = 'updates/windows/x64/';
const brandFileNames = [
  'claude-spark-clay.svg',
  'openai-blossom-black.svg',
  'openai-blossom-white.svg',
] as const;

export const digest = (algorithm: 'sha256' | 'sha512', encoding: 'base64' | 'hex', body: Buffer) =>
  createHash(algorithm).update(body).digest(encoding);

export const blockmapBytes = (installer: Buffer, chunkSizes?: number[]) => {
  const midpoint = Math.max(1, Math.floor(installer.byteLength / 2));
  const sizes =
    chunkSizes ?? [midpoint, installer.byteLength - midpoint].filter((size) => size > 0);
  let offset = 0;
  const checksums = sizes.map((size) => {
    const checksum = Buffer.from(
      blake2b(installer.subarray(offset, offset + size), { dkLen: 18 }),
    ).toString('base64');
    offset += size;
    return checksum;
  });
  return gzipSync(
    Buffer.from(
      JSON.stringify({
        files: [{ checksums, name: 'file', offset: 0, sizes }],
        version: '2',
      }),
    ),
  );
};

export const packageManifest = (
  version: string,
  publish: unknown = {
    provider: 'generic',
    url: feedUrl,
    useMultipleRangeRequest: false,
  },
) => ({
  build: {
    detectUpdateChannel: true,
    productName: 'ClaudeDock Test',
    publish,
  },
  version,
});

const updateManifest = (version: string, installerName: string, installer: Buffer) => {
  const sha512 = digest('sha512', 'base64', installer);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${installer.byteLength}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-08-23T00:00:00.000Z'",
    '',
  ].join('\n');
};

export const createReleaseFixture = (version = '5.0.0-rc.15') => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-release-tools-'));
  fixtureRoots.push(root);
  const output = path.join(root, 'outputs');
  const resources = path.join(output, 'win-unpacked', 'resources');
  const unpackedRuntime = path.join(resources, 'app.asar.unpacked', 'assets', 'runtime');
  const brandsDirectory = path.join(root, 'src', 'renderer', 'assets', 'brands');
  mkdirSync(resources, { recursive: true });
  mkdirSync(unpackedRuntime, { recursive: true });
  mkdirSync(brandsDirectory, { recursive: true });

  const rootManifest = packageManifest(version);
  const packageLock = Buffer.from(
    `${JSON.stringify({ lockfileVersion: 3, name: 'fixture', version })}\n`,
    'utf8',
  );
  const sourceIdentity = {
    gitHead: 'a'.repeat(40),
    packageLockSha256: digest('sha256', 'hex', packageLock),
    treeClean: true,
  };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootManifest), 'utf8');
  writeFileSync(path.join(root, 'package-lock.json'), packageLock);
  const legalFiles = new Map([
    ['LICENSE', Buffer.from('Fixture license\n', 'utf8')],
    ['NOTICE', Buffer.from('Fixture notice\n', 'utf8')],
  ]);
  for (const [name, bytes] of legalFiles) writeFileSync(path.join(root, name), bytes);

  const archiveFiles = new Map<string, Buffer>([
    [
      'dist/build-source-identity.json',
      Buffer.from(JSON.stringify({ schemaVersion: 1, ...sourceIdentity }), 'utf8'),
    ],
    ['package.json', Buffer.from(JSON.stringify(rootManifest), 'utf8')],
    ...legalFiles,
  ]);
  for (const fileName of brandFileNames) {
    const bytes = Buffer.from(`<svg data-fixture="${fileName}"></svg>\n`, 'utf8');
    writeFileSync(path.join(brandsDirectory, fileName), bytes);
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    archiveFiles.set(`dist/renderer/assets/${stem}-fixturehash${extension}`, bytes);
  }
  const archive: ArchiveReader = {
    extractFile: (_archivePath, filePath) => {
      const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\/+/, '');
      const bytes = archiveFiles.get(normalizedPath);
      if (!bytes) throw new Error(`${normalizedPath} was not found in the fixture archive`);
      return Buffer.from(bytes);
    },
    listPackage: () =>
      [...archiveFiles.keys()].map((filePath) => `\\${filePath.replaceAll('/', '\\')}`),
  };
  fixtureArchives.set(root, archive);

  const appAsarBytes = Buffer.from('fixture archive placeholder', 'utf8');
  const unpackedRuntimeBytes = Buffer.from('fixture runtime payload\n', 'utf8');
  const appAsarPath = path.join(resources, 'app.asar');
  writeFileSync(appAsarPath, appAsarBytes);
  writeFileSync(path.join(unpackedRuntime, 'fixture.ps1'), unpackedRuntimeBytes);
  const installerName = `ClaudeDock-Setup-${version}-x64.exe`;
  const channel = version.includes('-') ? version.split('-')[1]!.split('.')[0]! : 'latest';
  const appUpdateBytes = Buffer.from(
    [
      'provider: generic',
      `url: ${feedUrl}`,
      'useMultipleRangeRequest: false',
      `channel: ${channel}`,
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(path.join(resources, 'app-update.yml'), appUpdateBytes);
  const installerPayloadFiles = new Map<string, Buffer>([
    ['resources/app.asar', appAsarBytes],
    ['resources/app.asar.unpacked/assets/runtime/fixture.ps1', unpackedRuntimeBytes],
    ['resources/app-update.yml', appUpdateBytes],
  ]);
  const extractInstaller: InstallerExtractor = ({ destination }) => {
    for (const [relativePath, bytes] of installerPayloadFiles) {
      const targetPath = path.join(destination, ...relativePath.split('/'));
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes);
    }
  };
  fixtureExtractors.set(root, extractInstaller);

  const installer = Buffer.from(`installer-${version}`);
  const blockmap = blockmapBytes(installer);
  writeFileSync(path.join(output, installerName), installer);
  writeFileSync(path.join(output, `${installerName}.blockmap`), blockmap);
  writeFileSync(
    path.join(output, `${channel}.yml`),
    updateManifest(version, installerName, installer),
    'utf8',
  );
  fixtureSourceIdentities.set(root, sourceIdentity);
  return {
    archive,
    archiveFiles,
    extractInstaller,
    installer,
    installerName,
    installerPayloadFiles,
    output,
    root,
    sourceIdentity,
  };
};

export const validateFixture = (
  root: string,
  output: string,
  writeReport = false,
  overrides: {
    archive?: ArchiveReader;
    extractInstaller?: InstallerExtractor;
    now?: Date;
    signatureStatus?: () => string;
    sourceIdentity?: () => SourceIdentity;
  } = {},
) =>
  manifestTools.validateRelease({
    archive: overrides.archive ?? fixtureArchives.get(root),
    extractInstaller: overrides.extractInstaller ?? fixtureExtractors.get(root),
    now: overrides.now ?? new Date('2026-08-23T01:02:03.000Z'),
    projectRoot: root,
    releaseDirectory: output,
    signatureStatus: overrides.signatureStatus ?? (() => 'NotSigned'),
    sourceIdentity:
      overrides.sourceIdentity ?? (() => fixtureSourceIdentities.get(root) as SourceIdentity),
    writeReport,
  });

export const writeFixtureOrchestration = (releaseDirectory: string, source: SourceIdentity) =>
  releaseOrchestrationTools.writeReleaseOrchestration({
    releaseDirectory,
    source,
  });

export const createPublicationHarness = () => {
  const remote = new Map<string, RemoteObject>();
  const writes: ObjectDescriptor[] = [];
  let afterCreate: ((descriptor: ObjectDescriptor) => Promise<void>) | undefined;
  let beforeCreate: ((descriptor: ObjectDescriptor) => Promise<void>) | undefined;
  let rangeByte: number | undefined;
  let rangeStatus = 206;
  const descriptorBody = (descriptor: ObjectDescriptor) => {
    if (descriptor.body) return descriptor.body;
    if (!descriptor.localPath) throw new Error(`missing body for ${descriptor.key}`);
    return readFileSync(descriptor.localPath);
  };
  const writeRemote = (descriptor: ObjectDescriptor) => {
    writes.push(descriptor);
    remote.set(descriptor.key, {
      body: descriptorBody(descriptor),
      cacheControl: descriptor.cacheControl,
      sha256: descriptor.sha256,
      sha512: descriptor.sha512,
    });
  };
  const storage = {
    assertAtomicCreateSupported: vi.fn(async () => undefined),
    create: vi.fn(async (descriptor: ObjectDescriptor) => {
      await beforeCreate?.(descriptor);
      if (remote.has(descriptor.key)) return false;
      writeRemote(descriptor);
      await afterCreate?.(descriptor);
      return true;
    }),
    delete: vi.fn(async (key: string) => {
      remote.delete(key);
    }),
    head: vi.fn(async (key: string) => {
      const object = remote.get(key);
      return object
        ? {
            bytes: object.body.byteLength,
            cacheControl: object.cacheControl,
            exists: true,
            sha256: object.sha256,
            sha512: object.sha512,
          }
        : { exists: false };
    }),
    put: vi.fn(async (descriptor: ObjectDescriptor) => {
      writeRemote(descriptor);
    }),
    read: vi.fn(async (key: string) => remote.get(key)?.body),
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const object = remote.get(key);
    if (!object) return new Response('missing', { status: 404 });
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers({
      'cache-control': object.cacheControl,
      'content-length': String(object.body.byteLength),
    });
    if (method === 'HEAD') return new Response(null, { headers, status: 200 });
    const requestHeaders = new Headers(init?.headers ?? request?.headers);
    if (requestHeaders.get('range') === 'bytes=0-0') {
      if (rangeStatus !== 206)
        return new Response(new Uint8Array(object.body), { headers, status: rangeStatus });
      headers.set('content-length', '1');
      headers.set('content-range', `bytes 0-0/${object.body.byteLength}`);
      return new Response(new Uint8Array([rangeByte ?? object.body[0] ?? 0]), {
        headers,
        status: 206,
      });
    }
    return new Response(new Uint8Array(object.body), { headers, status: 200 });
  });
  return {
    fetchImpl,
    remote,
    setAfterCreate: (hook: typeof afterCreate) => {
      afterCreate = hook;
    },
    setBeforeCreate: (hook: typeof beforeCreate) => {
      beforeCreate = hook;
    },
    setRangeByte: (byte: number | undefined) => {
      rangeByte = byte;
    },
    setRangeStatus: (status: number) => {
      rangeStatus = status;
    },
    storage,
    writes,
  };
};

export const cleanupReleaseFixtures = () => {
  for (const root of fixtureRoots.splice(0)) {
    fixtureArchives.delete(root);
    fixtureExtractors.delete(root);
    fixtureSourceIdentities.delete(root);
    rmSync(root, { force: true, recursive: true });
  }
};
