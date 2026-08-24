import sevenZip from '7zip-bin';
import { blake2b } from '@noble/hashes/blake2.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

interface BlockmapFile {
  checksums: string[];
  name: string;
  offset: number;
  sizes: number[];
}

interface BlockmapDocument {
  files: BlockmapFile[];
  version: string;
}

interface IntegrityTools {
  extractInstallerPayload(options: { destination: string; installerPath: string }): void;
  inspectBlockmap(options: { blockmapPath: string; installerPath: string }): {
    algorithm: string;
    chunkCount: number;
    coverageBytes: number;
    structureSha256: string;
  };
  inspectInstallerPayload(options: {
    extractInstaller?: (options: { destination: string; installerPath: string }) => void;
    installerPath: string;
    releaseDirectory: string;
    temporaryRoot?: string;
  }): {
    appAsar: { bytes: number; sha256: string };
    appAsarUnpacked: { bytes: number; fileCount: number; sha256: string };
    appUpdate: { bytes: number; sha256: string } | null;
    schemaVersion: number;
  };
}

const projectRoot = path.join(__dirname, '..', '..');
const integrityTools = (await import(
  pathToFileURL(path.join(projectRoot, 'scripts', 'release', 'artifact-integrity.mjs')).href
)) as IntegrityTools;
const fixtureRoots: string[] = [];

const createRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-release-integrity-'));
  fixtureRoots.push(root);
  return root;
};

const blockmapDocument = (installer: Buffer, sizes = [installer.byteLength]): BlockmapDocument => {
  let offset = 0;
  const checksums = sizes.map((size) => {
    const checksum = Buffer.from(
      blake2b(installer.subarray(offset, offset + size), { dkLen: 18 }),
    ).toString('base64');
    offset += size;
    return checksum;
  });
  return {
    files: [{ checksums, name: 'file', offset: 0, sizes }],
    version: '2',
  };
};

const createBlockmapFixture = () => {
  const root = createRoot();
  const installer = Buffer.from('installer bytes split across chunks', 'utf8');
  const installerPath = path.join(root, 'installer.exe');
  const blockmapPath = path.join(root, 'installer.exe.blockmap');
  const document = blockmapDocument(installer, [7, 11, installer.byteLength - 18]);
  writeFileSync(installerPath, installer);
  writeFileSync(blockmapPath, gzipSync(Buffer.from(JSON.stringify(document))));
  return { blockmapPath, document, installer, installerPath };
};

const writeBlockmap = (blockmapPath: string, document: BlockmapDocument) => {
  writeFileSync(blockmapPath, gzipSync(Buffer.from(JSON.stringify(document))));
};

const createPayloadFixture = () => {
  const root = createRoot();
  const releaseDirectory = path.join(root, 'outputs');
  const resources = path.join(releaseDirectory, 'win-unpacked', 'resources');
  const appAsar = Buffer.from('synthetic app.asar bytes', 'utf8');
  const unpacked = Buffer.from('synthetic unpacked runtime bytes', 'utf8');
  const appUpdate = Buffer.from(
    'provider: generic\nurl: https://example.test/feed/\nuseMultipleRangeRequest: false\nchannel: rc\n',
    'utf8',
  );
  const payloadFiles = new Map<string, Buffer>([
    ['resources/app.asar', appAsar],
    ['resources/app.asar.unpacked/assets/runtime/tool.ps1', unpacked],
    ['resources/app-update.yml', appUpdate],
  ]);
  for (const [relativePath, bytes] of payloadFiles) {
    const targetPath = path.join(
      resources,
      ...relativePath.replace(/^resources\//u, '').split('/'),
    );
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, bytes);
  }
  const extractInstaller = ({ destination }: { destination: string }) => {
    for (const [relativePath, bytes] of payloadFiles) {
      const targetPath = path.join(destination, ...relativePath.split('/'));
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes);
    }
  };
  return {
    extractInstaller,
    installerPath: path.join(root, 'synthetic-installer.exe'),
    payloadFiles,
    releaseDirectory,
    root,
  };
};

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('external blockmap integrity', () => {
  it('accepts canonical gzip blockmap v2 with complete BLAKE2b-144 coverage', () => {
    const fixture = createBlockmapFixture();
    expect(
      integrityTools.inspectBlockmap({
        blockmapPath: fixture.blockmapPath,
        installerPath: fixture.installerPath,
      }),
    ).toMatchObject({
      algorithm: 'BLAKE2b-144',
      chunkCount: 3,
      coverageBytes: fixture.installer.byteLength,
      structureSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('rejects arbitrary text and stale canonical checksums', () => {
    const fixture = createBlockmapFixture();
    writeFileSync(fixture.blockmapPath, 'arbitrary blockmap text');
    expect(() =>
      integrityTools.inspectBlockmap({
        blockmapPath: fixture.blockmapPath,
        installerPath: fixture.installerPath,
      }),
    ).toThrow('blockmap is not valid gzip JSON');

    writeBlockmap(
      fixture.blockmapPath,
      blockmapDocument(Buffer.alloc(fixture.installer.byteLength, 0x78)),
    );
    expect(() =>
      integrityTools.inspectBlockmap({
        blockmapPath: fixture.blockmapPath,
        installerPath: fixture.installerPath,
      }),
    ).toThrow('checksum does not match the installer');
  });

  it.each([
    {
      expected: 'exactly one file',
      mutate: (document: BlockmapDocument) => {
        document.files = [];
      },
    },
    {
      expected: 'must be named file',
      mutate: (document: BlockmapDocument) => {
        document.files[0]!.name = 'installer.exe';
      },
    },
    {
      expected: 'offset must equal 0',
      mutate: (document: BlockmapDocument) => {
        document.files[0]!.offset = 1;
      },
    },
    {
      expected: 'positive safe integer',
      mutate: (document: BlockmapDocument) => {
        document.files[0]!.sizes[0] = 0;
      },
    },
    {
      expected: 'canonical 18-byte Base64',
      mutate: (document: BlockmapDocument) => {
        document.files[0]!.checksums[0] = 'not-base64';
      },
    },
    {
      expected: 'does not equal installer size',
      mutate: (document: BlockmapDocument) => {
        document.files[0]!.sizes[0] = document.files[0]!.sizes[0]! - 1;
      },
    },
  ])('rejects malformed blockmap structure: $expected', ({ expected, mutate }) => {
    const fixture = createBlockmapFixture();
    mutate(fixture.document);
    writeBlockmap(fixture.blockmapPath, fixture.document);
    expect(() =>
      integrityTools.inspectBlockmap({
        blockmapPath: fixture.blockmapPath,
        installerPath: fixture.installerPath,
      }),
    ).toThrow(expected);
  });
});

describe('NSIS payload linkage', () => {
  it('byte-links app.asar, app.asar.unpacked, and packaged updater evidence', () => {
    const fixture = createPayloadFixture();
    expect(
      integrityTools.inspectInstallerPayload({
        extractInstaller: fixture.extractInstaller,
        installerPath: fixture.installerPath,
        releaseDirectory: fixture.releaseDirectory,
        temporaryRoot: fixture.root,
      }),
    ).toMatchObject({
      appAsar: { bytes: fixture.payloadFiles.get('resources/app.asar')!.byteLength },
      appAsarUnpacked: { fileCount: 1 },
      appUpdate: { bytes: fixture.payloadFiles.get('resources/app-update.yml')!.byteLength },
      schemaVersion: 1,
    });
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith('claudedock-nsis-payload-')),
    ).toEqual([]);
  });

  it('rejects stale app.asar and mismatched unpacked bytes', () => {
    const fixture = createPayloadFixture();
    fixture.payloadFiles.set('resources/app.asar', Buffer.from('stale app.asar'));
    expect(() =>
      integrityTools.inspectInstallerPayload({
        extractInstaller: fixture.extractInstaller,
        installerPath: fixture.installerPath,
        releaseDirectory: fixture.releaseDirectory,
      }),
    ).toThrow('resources/app.asar bytes differ from win-unpacked');

    fixture.payloadFiles.set(
      'resources/app.asar',
      readFileSync(path.join(fixture.releaseDirectory, 'win-unpacked', 'resources', 'app.asar')),
    );
    fixture.payloadFiles.set(
      'resources/app.asar.unpacked/assets/runtime/tool.ps1',
      Buffer.from('different unpacked bytes'),
    );
    expect(() =>
      integrityTools.inspectInstallerPayload({
        extractInstaller: fixture.extractInstaller,
        installerPath: fixture.installerPath,
        releaseDirectory: fixture.releaseDirectory,
      }),
    ).toThrow('app.asar.unpacked bytes differ from win-unpacked');
  });

  it('rejects stale packaged updater bytes and cleans extraction directories in finally', () => {
    const fixture = createPayloadFixture();
    fixture.payloadFiles.set('resources/app-update.yml', Buffer.from('stale updater'));
    expect(() =>
      integrityTools.inspectInstallerPayload({
        extractInstaller: fixture.extractInstaller,
        installerPath: fixture.installerPath,
        releaseDirectory: fixture.releaseDirectory,
        temporaryRoot: fixture.root,
      }),
    ).toThrow('resources/app-update.yml bytes differ from win-unpacked');
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith('claudedock-nsis-payload-')),
    ).toEqual([]);

    expect(() =>
      integrityTools.inspectInstallerPayload({
        extractInstaller: () => {
          throw new Error('synthetic extraction failure');
        },
        installerPath: fixture.installerPath,
        releaseDirectory: fixture.releaseDirectory,
        temporaryRoot: fixture.root,
      }),
    ).toThrow('synthetic extraction failure');
    expect(
      readdirSync(fixture.root).filter((name) => name.startsWith('claudedock-nsis-payload-')),
    ).toEqual([]);
  });

  it('rejects packaged updater presence drift in either direction', () => {
    const missingInstallerUpdater = createPayloadFixture();
    missingInstallerUpdater.payloadFiles.delete('resources/app-update.yml');
    expect(() =>
      integrityTools.inspectInstallerPayload({
        extractInstaller: missingInstallerUpdater.extractInstaller,
        installerPath: missingInstallerUpdater.installerPath,
        releaseDirectory: missingInstallerUpdater.releaseDirectory,
      }),
    ).toThrow('resources/app-update.yml presence differs from win-unpacked');

    const missingUnpackedUpdater = createPayloadFixture();
    rmSync(
      path.join(
        missingUnpackedUpdater.releaseDirectory,
        'win-unpacked',
        'resources',
        'app-update.yml',
      ),
    );
    expect(() =>
      integrityTools.inspectInstallerPayload({
        extractInstaller: missingUnpackedUpdater.extractInstaller,
        installerPath: missingUnpackedUpdater.installerPath,
        releaseDirectory: missingUnpackedUpdater.releaseDirectory,
      }),
    ).toThrow('resources/app-update.yml presence differs from win-unpacked');
  });

  it('accepts the direct application layout emitted by native 7z NSIS extraction', () => {
    const root = createRoot();
    const payloadSource = path.join(root, 'payload-source');
    const resources = path.join(payloadSource, 'resources');
    const installerArchivePath = path.join(root, 'synthetic-installer.7z');
    const destination = path.join(root, 'extracted');
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, 'app.asar'), 'native 7z fixture', 'utf8');
    execFileSync(sevenZip.path7za, ['a', installerArchivePath, '.'], {
      cwd: payloadSource,
      encoding: 'utf8',
      windowsHide: true,
    });
    mkdirSync(destination, { recursive: true });

    integrityTools.extractInstallerPayload({
      destination,
      installerPath: installerArchivePath,
    });

    expect(readFileSync(path.join(destination, 'resources', 'app.asar'), 'utf8')).toBe(
      'native 7z fixture',
    );
  });
});
