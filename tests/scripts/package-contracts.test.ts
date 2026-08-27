import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface PackageManifest {
  build?: {
    files?: unknown;
  };
  devDependencies?: Record<string, unknown>;
  engines?: Record<string, unknown>;
  license?: unknown;
  scripts?: Record<string, unknown>;
  version?: unknown;
}

interface SourceIdentity {
  gitHead: string;
  packageLockSha256: string;
  treeClean: boolean;
}

interface PackageLockManifest {
  packages?: Record<string, { devDependencies?: Record<string, unknown>; version?: unknown }>;
  version?: unknown;
}

interface DependencyRule {
  from?: { pathNot?: unknown };
  name: string;
  to?: { dependencyTypes?: string[]; path?: string };
}

const projectRoot = path.join(__dirname, '..', '..');
const loadCommonJs = createRequire(import.meta.url);
const dependencyCruiser = loadCommonJs(path.join(projectRoot, '.dependency-cruiser.cjs')) as {
  forbidden: DependencyRule[];
};
const packageManifest = JSON.parse(
  readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
) as PackageManifest;
const packageLockManifest = JSON.parse(
  readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'),
) as PackageLockManifest;

const packagedFiles = (): string[] => {
  expect(Array.isArray(packageManifest.build?.files)).toBe(true);
  return packageManifest.build?.files as string[];
};

interface ArchiveReader {
  extractFile(archivePath: string, filePath: string): Buffer;
  listPackage(archivePath: string): string[];
}

interface ManifestTools {
  inspectPackagedApplication(options: {
    archive: ArchiveReader;
    expectedSourceIdentity: SourceIdentity;
    packageManifest: unknown;
    projectRoot: string;
    releaseDirectory: string;
  }): { problems: string[] };
}

const manifestTools = (await import(
  pathToFileURL(path.join(projectRoot, 'scripts', 'release', 'manifest.mjs')).href
)) as ManifestTools;
const fixtureRoots: string[] = [];
const brandFileNames = [
  'claude-spark-clay.svg',
  'openai-blossom-black.svg',
  'openai-blossom-white.svg',
] as const;
const feedUrl = 'https://claudedock-test-123.cos.ap-test.myqcloud.com/updates/windows/x64/';

const createPackagedApplicationFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-package-inspection-'));
  fixtureRoots.push(root);
  const releaseDirectory = path.join(root, 'outputs');
  const resources = path.join(releaseDirectory, 'win-unpacked', 'resources');
  const brandsDirectory = path.join(root, 'src', 'renderer', 'assets', 'brands');
  mkdirSync(resources, { recursive: true });
  mkdirSync(brandsDirectory, { recursive: true });
  writeFileSync(path.join(resources, 'app.asar'), 'fixture archive', 'utf8');
  writeFileSync(
    path.join(resources, 'app-update.yml'),
    `provider: generic\nurl: ${feedUrl}\nuseMultipleRangeRequest: false\nchannel: rc\n`,
    'utf8',
  );
  const fixtureManifest = {
    build: {
      publish: {
        provider: 'generic',
        url: feedUrl,
        useMultipleRangeRequest: false,
      },
    },
    version: '5.0.0-rc.16',
  };
  const sourceIdentity = {
    gitHead: 'a'.repeat(40),
    packageLockSha256: 'b'.repeat(64),
    treeClean: true,
  };
  const archiveFiles = new Map<string, Buffer>([
    [
      'dist/build-source-identity.json',
      Buffer.from(JSON.stringify({ schemaVersion: 1, ...sourceIdentity }), 'utf8'),
    ],
    ['package.json', Buffer.from(JSON.stringify(fixtureManifest), 'utf8')],
    ['LICENSE', Buffer.from('Fixture license\n', 'utf8')],
    ['NOTICE', Buffer.from('Fixture notice\n', 'utf8')],
  ]);
  for (const fileName of brandFileNames) {
    const sourceBytes = Buffer.from(`<svg data-fixture="${fileName}"></svg>\n`, 'utf8');
    writeFileSync(path.join(brandsDirectory, fileName), sourceBytes);
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    archiveFiles.set(`dist/renderer/assets/${stem}-fixturehash${extension}`, sourceBytes);
  }
  const archive: ArchiveReader = {
    extractFile: (_archivePath, filePath) => {
      const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\/+/, '');
      const bytes = archiveFiles.get(normalizedPath);
      if (!bytes) throw new Error(`${normalizedPath} is absent`);
      return Buffer.from(bytes);
    },
    listPackage: () =>
      [...archiveFiles.keys()].map((filePath) => `\\${filePath.replaceAll('/', '\\')}`),
  };
  return {
    archive,
    archiveFiles,
    fixtureManifest,
    releaseDirectory,
    resources,
    root,
    sourceIdentity,
  };
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('package contracts', () => {
  it('keeps the rc.32 identity and Apache license declaration', () => {
    expect(packageManifest.version).toBe('5.0.0-rc.32');
    expect(packageManifest.license).toBe('Apache-2.0');
    expect(packageManifest.engines).toEqual({ node: '>=24', npm: '>=11' });
  });

  it('keeps package and lockfile versions synchronized', () => {
    expect(packageLockManifest.version).toBe(packageManifest.version);
    expect(packageLockManifest.packages?.['']?.version).toBe(packageManifest.version);
  });

  it('pins release integrity tools as exact direct dev dependencies', () => {
    const expected = { '@noble/hashes': '2.2.0', '7zip-bin': '5.2.0' };
    expect(packageManifest.devDependencies).toMatchObject(expected);
    expect(packageLockManifest.packages?.['']?.devDependencies).toMatchObject(expected);
    expect(packageLockManifest.packages?.['node_modules/@noble/hashes']?.version).toBe('2.2.0');
    expect(packageLockManifest.packages?.['node_modules/7zip-bin']?.version).toBe('5.2.0');
  });

  it('generates packaged source identity immediately after clean and before compilation', () => {
    expect(packageManifest.scripts?.['generate:source-identity']).toBe(
      'node scripts/build/source-identity.mjs',
    );
    const buildSteps = String(packageManifest.scripts?.build).split(' && ');
    expect(buildSteps.slice(0, 2)).toEqual(['npm run clean', 'npm run generate:source-identity']);
    expect(buildSteps.indexOf('npm run generate:source-identity')).toBeLessThan(
      buildSteps.indexOf('npm run typecheck'),
    );
    expect(buildSteps.at(-1)).toBe('npm run build:renderer');
    expect(packagedFiles()).toContain('dist/**/*');
  });

  it('keeps orphan matching narrow and catches Node core plus resolved Electron imports', () => {
    const rule = (name: string) =>
      dependencyCruiser.forbidden.find((entry) => entry.name === name)!;
    expect(rule('no-orphans').from?.pathNot).toContain('^[^/]+\\.(json|js|cjs|mjs|ts)$');
    expect(rule('no-orphans').from?.pathNot).not.toContain(
      '(^|/)(\\.|)[^/]+\\.(json|js|cjs|mjs|ts)$',
    );
    expect(rule('shared-stays-pure').to).toEqual({ dependencyTypes: ['core'] });
    expect(rule('shared-no-electron').to).toEqual({
      path: '^(electron|node_modules/electron)(/|$)',
    });
    expect(
      new RegExp(rule('shared-no-electron').to?.path ?? '').test('node_modules/electron/index.js'),
    ).toBe(true);
    expect(rule('preload-no-node-builtins').to).toEqual({ dependencyTypes: ['core'] });
  });

  it.each(['LICENSE', 'NOTICE'])('explicitly packages the root %s file', (fileName) => {
    const files = packagedFiles();
    expect(files.filter((entry) => entry === fileName)).toHaveLength(1);

    const filePath = path.join(projectRoot, fileName);
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).size).toBeGreaterThan(0);
  });

  it('accepts the exact packaged version, legal files, brand bytes, updater feed, and executable set', () => {
    const fixture = createPackagedApplicationFixture();

    expect(
      manifestTools.inspectPackagedApplication({
        archive: fixture.archive,
        expectedSourceIdentity: fixture.sourceIdentity,
        packageManifest: fixture.fixtureManifest,
        projectRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
      }).problems,
    ).toEqual([]);
  });

  it('reports packaged-application content drift through release problems', () => {
    const fixture = createPackagedApplicationFixture();
    fixture.archiveFiles.set(
      'package.json',
      Buffer.from(JSON.stringify({ ...fixture.fixtureManifest, version: '5.0.0-rc.15' }), 'utf8'),
    );
    fixture.archiveFiles.set(
      'dist/build-source-identity.json',
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          ...fixture.sourceIdentity,
          gitHead: 'c'.repeat(40),
        }),
        'utf8',
      ),
    );
    fixture.archiveFiles.delete('LICENSE');
    const clayAsset = [...fixture.archiveFiles.keys()].find((filePath) =>
      filePath.includes('claude-spark-clay-'),
    );
    expect(clayAsset).toBeDefined();
    fixture.archiveFiles.set(clayAsset!, Buffer.from('<svg>different</svg>\n', 'utf8'));
    fixture.archiveFiles.set(
      'dist/renderer/assets/unexpected-fixture.svg',
      Buffer.from('<svg></svg>\n', 'utf8'),
    );
    fixture.archiveFiles.set('runtime/claude.exe', Buffer.from('forbidden archive executable'));
    writeFileSync(
      path.join(fixture.releaseDirectory, 'win-unpacked', 'claude.exe'),
      'forbidden unpacked executable',
      'utf8',
    );
    writeFileSync(
      path.join(fixture.resources, 'app-update.yml'),
      'provider: generic\nurl: https://wrong.example.test/updates/\nuseMultipleRangeRequest: true\n',
      'utf8',
    );

    const problems = manifestTools.inspectPackagedApplication({
      archive: fixture.archive,
      expectedSourceIdentity: fixture.sourceIdentity,
      packageManifest: fixture.fixtureManifest,
      projectRoot: fixture.root,
      releaseDirectory: fixture.releaseDirectory,
    }).problems;

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('packaged source identity Git HEAD differs'),
        expect.stringContaining('packaged app version 5.0.0-rc.15'),
        expect.stringContaining('packaged root LICENSE is invalid'),
        expect.stringContaining('must contain exactly 3 SVG files; found 4'),
        expect.stringContaining('bytes differ from claude-spark-clay.svg'),
        expect.stringContaining('contains forbidden claude.exe'),
        expect.stringContaining('useMultipleRangeRequest=false'),
        expect.stringContaining('!= intended feed'),
      ]),
    );
  });

  it('requires an exact credential-free source identity inside app.asar', () => {
    const fixture = createPackagedApplicationFixture();
    fixture.archiveFiles.delete('dist/build-source-identity.json');

    expect(
      manifestTools.inspectPackagedApplication({
        archive: fixture.archive,
        expectedSourceIdentity: fixture.sourceIdentity,
        packageManifest: fixture.fixtureManifest,
        projectRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
      }).problems,
    ).toContain(
      'packaged source identity is invalid: missing root dist/build-source-identity.json',
    );

    fixture.archiveFiles.set(
      'dist/build-source-identity.json',
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, ...fixture.sourceIdentity, credential: 'not-allowed' }),
        'utf8',
      ),
    );
    expect(
      manifestTools.inspectPackagedApplication({
        archive: fixture.archive,
        expectedSourceIdentity: fixture.sourceIdentity,
        packageManifest: fixture.fixtureManifest,
        projectRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
      }).problems,
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('document must contain only gitHead, packageLockSha256'),
      ]),
    );
  });

  it('requires the unpacked ASAR and packaged updater configuration', () => {
    const fixture = createPackagedApplicationFixture();
    rmSync(path.join(fixture.resources, 'app.asar'));
    rmSync(path.join(fixture.resources, 'app-update.yml'));

    expect(
      manifestTools.inspectPackagedApplication({
        archive: fixture.archive,
        expectedSourceIdentity: fixture.sourceIdentity,
        packageManifest: fixture.fixtureManifest,
        projectRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
      }).problems,
    ).toEqual(
      expect.arrayContaining([
        'missing packaged application: win-unpacked/resources/app.asar',
        'missing packaged updater configuration: win-unpacked/resources/app-update.yml',
      ]),
    );
  });
});
