import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Artifact {
  bytes: number;
  name: string;
  sha256: string;
  sha512: string;
}

interface ReleaseManifest {
  artifacts: Artifact[];
  channel: string;
  channelManifest: string;
  directory: string;
  feedUrl?: string;
  generatedAt: string;
  problems: string[];
  provider?: string;
  signature: string;
  version: string;
}

interface ReleaseValidation {
  blockmap?: Artifact;
  channelManifestPath: string;
  installer?: Artifact;
  manifest: ReleaseManifest;
  updateManifest?: { version?: string };
}

interface ManifestTools {
  compareSemanticVersions(left: string, right: string): number;
  resolveReleaseChannel(packageManifest: unknown): string;
  validateGenericFeed(packageManifest: unknown): { feedUrl: string };
  validateRelease(options: {
    now?: Date;
    projectRoot: string;
    releaseDirectory?: string;
    signatureStatus?: () => string;
    writeReport?: boolean;
  }): ReleaseValidation;
}

interface ObjectDescriptor {
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
const manifestTools = (await import(
  pathToFileURL(path.join(scriptsDirectory, 'manifest.mjs')).href
)) as ManifestTools;
const publisherTools = (await import(
  pathToFileURL(path.join(scriptsDirectory, 'publish-cos.mjs')).href
)) as PublisherTools;

const fixtureRoots: string[] = [];
const feedUrl = 'https://claudedock-test-123.cos.ap-test.myqcloud.com/updates/windows/x64/';
const prefix = 'updates/windows/x64/';

const digest = (algorithm: 'sha256' | 'sha512', encoding: 'base64' | 'hex', body: Buffer) =>
  createHash(algorithm).update(body).digest(encoding);

const packageManifest = (
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

const createReleaseFixture = (version = '5.0.0-rc.15') => {
  const root = mkdtempSync(path.join(tmpdir(), 'claudedock-release-tools-'));
  fixtureRoots.push(root);
  const output = path.join(root, 'outputs');
  mkdirSync(output);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageManifest(version)), 'utf8');
  const installerName = `ClaudeDock-Setup-${version}-x64.exe`;
  const channel = version.includes('-') ? version.split('-')[1]!.split('.')[0]! : 'latest';
  const installer = Buffer.from(`installer-${version}`);
  const blockmap = Buffer.from(`blockmap-${version}`);
  writeFileSync(path.join(output, installerName), installer);
  writeFileSync(path.join(output, `${installerName}.blockmap`), blockmap);
  writeFileSync(
    path.join(output, `${channel}.yml`),
    updateManifest(version, installerName, installer),
    'utf8',
  );
  return { channel, installer, installerName, output, root };
};

const validateFixture = (root: string, output: string, writeReport = false) =>
  manifestTools.validateRelease({
    now: new Date('2026-08-23T01:02:03.000Z'),
    projectRoot: root,
    releaseDirectory: output,
    signatureStatus: () => 'NotSigned',
    writeReport,
  });

const createPublicationHarness = () => {
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

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('release manifest validation', () => {
  it('selects detected prerelease channels and compares complete semantic versions', () => {
    expect(manifestTools.resolveReleaseChannel(packageManifest('5.0.0-rc.15'))).toBe('rc');
    expect(manifestTools.resolveReleaseChannel(packageManifest('5.0.0-beta.2'))).toBe('beta');
    expect(manifestTools.resolveReleaseChannel(packageManifest('5.0.0'))).toBe('latest');
    expect(
      manifestTools.resolveReleaseChannel({
        ...packageManifest('5.0.0-rc.15'),
        build: { ...packageManifest('5.0.0-rc.15').build, detectUpdateChannel: false },
      }),
    ).toBe('latest');
    expect(manifestTools.compareSemanticVersions('5.0.0-rc.15', '5.0.0-rc.14')).toBe(1);
    expect(manifestTools.compareSemanticVersions('5.0.0', '5.0.0-rc.99')).toBe(1);
    expect(
      manifestTools.compareSemanticVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992'),
    ).toBe(1);
    expect(
      manifestTools.compareSemanticVersions('9007199254740993.0.0', '9007199254740992.0.0'),
    ).toBe(1);
    expect(() => manifestTools.resolveReleaseChannel(packageManifest('5.0.0-rc.01'))).toThrow(
      'invalid semantic version',
    );
  });

  it('rejects feed credentials, mutable URLs, unsupported ranges, and multiple providers', () => {
    for (const publish of [
      { provider: 'generic', url: 'http://example.com/', useMultipleRangeRequest: false },
      {
        provider: 'generic',
        url: 'https://user:password@example.com/',
        useMultipleRangeRequest: false,
      },
      {
        provider: 'generic',
        url: 'https://example.com/?token=secret',
        useMultipleRangeRequest: false,
      },
      { provider: 'generic', url: 'https://example.com/#feed', useMultipleRangeRequest: false },
      { provider: 'generic', url: 'https://example.com/feed', useMultipleRangeRequest: false },
      { provider: 'generic', url: 'https://example.com/', useMultipleRangeRequest: true },
      [
        { provider: 'generic', url: 'https://example.com/', useMultipleRangeRequest: false },
        { provider: 'generic', url: 'https://backup.example.com/', useMultipleRangeRequest: false },
      ],
    ]) {
      expect(() => manifestTools.validateGenericFeed(packageManifest('5.0.0', publish))).toThrow();
    }
  });

  it('validates the exact installer, blockmap, RC manifest, digest chain, and report fields', () => {
    const fixture = createReleaseFixture();
    const result = validateFixture(fixture.root, fixture.output, true);

    expect(result.manifest).toMatchObject({
      channel: 'rc',
      channelManifest: 'rc.yml',
      feedUrl,
      problems: [],
      provider: 'generic',
      signature: 'NotSigned',
      version: '5.0.0-rc.15',
    });
    expect(result.manifest.artifacts.map(({ name }) => name)).toEqual([
      fixture.installerName,
      `${fixture.installerName}.blockmap`,
      'rc.yml',
    ]);
    const report = JSON.parse(
      readFileSync(path.join(fixture.output, 'release-manifest.json'), 'utf8'),
    ) as ReleaseManifest;
    expect(report.generatedAt).toBe('2026-08-23T01:02:03.000Z');
  });

  it('reports stale artifacts and every broken installer reference', () => {
    const fixture = createReleaseFixture();
    const manifestPath = path.join(fixture.output, 'rc.yml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8')
        .replace(`url: ${fixture.installerName}`, 'url: wrong.exe')
        .replace(/sha512: .+/g, 'sha512: wrong'),
      'utf8',
    );
    writeFileSync(path.join(fixture.output, 'old-installer.exe'), 'stale', 'utf8');

    const result = validateFixture(fixture.root, fixture.output);

    expect(result.manifest.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('file URL wrong.exe'),
        expect.stringContaining('sha512 does not match'),
        expect.stringContaining('stale files'),
      ]),
    );
  });

  it('rejects split update-file fields and malformed YAML instead of flattening structure', () => {
    const fixture = createReleaseFixture();
    const manifestPath = path.join(fixture.output, 'rc.yml');
    const sha512 = digest('sha512', 'base64', fixture.installer);
    writeFileSync(
      manifestPath,
      [
        'version: 5.0.0-rc.15',
        'files:',
        `  - sha512: ${sha512}`,
        `    size: ${fixture.installer.byteLength}`,
        `  - url: ${fixture.installerName}`,
        `path: ${fixture.installerName}`,
        `sha512: ${sha512}`,
        '',
      ].join('\n'),
      'utf8',
    );

    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toContain(
      'rc.yml must contain exactly one update file',
    );

    writeFileSync(manifestPath, 'files: [unterminated', 'utf8');
    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('rc.yml cannot be parsed')]),
    );
  });
});

describe('COS release publication', () => {
  it('uploads immutable assets first, verifies them publicly, and commits the channel last', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();

    const result = await publisherTools.publishValidatedRelease({
      fetchImpl: harness.fetchImpl,
      prefix,
      release,
      storage: harness.storage,
    });

    expect(result).toMatchObject({
      assets: [fixture.installerName, `${fixture.installerName}.blockmap`],
      channels: ['rc.yml'],
      version: '5.0.0-rc.15',
    });
    const shippedWrites = () =>
      harness.writes.filter(({ key }) => !key.includes('.claudedock-publication-locks/'));
    expect(shippedWrites().map(({ key }) => key)).toEqual([
      `${prefix}${fixture.installerName}`,
      `${prefix}${fixture.installerName}.blockmap`,
      `${prefix}rc.yml`,
    ]);
    expect(
      shippedWrites()
        .slice(0, 2)
        .every(({ cacheControl }) => cacheControl === publisherTools.IMMUTABLE_CACHE_CONTROL),
    ).toBe(true);
    expect(shippedWrites()[2]?.cacheControl).toBe(publisherTools.CHANNEL_CACHE_CONTROL);
    expect(
      harness.fetchImpl.mock.calls.filter(([, init]) => new Headers(init?.headers).has('range')),
    ).toHaveLength(2);

    await publisherTools.publishValidatedRelease({
      fetchImpl: harness.fetchImpl,
      prefix,
      release,
      storage: harness.storage,
    });
    expect(shippedWrites()).toHaveLength(3);
    expect(harness.storage.delete).toHaveBeenCalledTimes(2);
  });

  it('refuses an immutable collision before replacing any remote bytes', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    harness.remote.set(`${prefix}${fixture.installerName}`, {
      body: Buffer.from('different remote installer'),
      cacheControl: publisherTools.IMMUTABLE_CACHE_CONTROL,
    });

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release,
        storage: harness.storage,
      }),
    ).rejects.toThrow('immutable key collision');
    expect(harness.writes).toHaveLength(0);
  });

  it('rejects same-size immutable bytes when remote checksum metadata is absent', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    harness.remote.set(`${prefix}${fixture.installerName}`, {
      body: Buffer.from('installer-5.0.0-rc.14'),
      cacheControl: publisherTools.IMMUTABLE_CACHE_CONTROL,
    });

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release,
        storage: harness.storage,
      }),
    ).rejects.toThrow('public digest does not match');
    expect(harness.writes).toHaveLength(0);
  });

  it('does not publish a channel manifest when public single-range verification fails', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    harness.setRangeStatus(200);

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release,
        storage: harness.storage,
      }),
    ).rejects.toThrow('returned HTTP 200');
    expect(harness.writes.map(({ key }) => key)).toEqual([`${prefix}${fixture.installerName}`]);
    expect(harness.remote.has(`${prefix}rc.yml`)).toBe(false);
  });

  it('rejects incorrect single-range bytes even when the full public object is correct', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    harness.setRangeByte((fixture.installer[0] ?? 0) ^ 0xff);

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release,
        storage: harness.storage,
      }),
    ).rejects.toThrow('single-byte range differs');
    expect(harness.remote.has(`${prefix}rc.yml`)).toBe(false);
  });

  it('does not overwrite an immutable object created between HEAD and create-only PUT', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    const racedBody = Buffer.from('installer-5.0.0-rc.14');
    let injected = false;
    harness.setBeforeCreate(async (descriptor) => {
      if (!injected && descriptor.key === `${prefix}${fixture.installerName}`) {
        injected = true;
        harness.remote.set(descriptor.key, {
          body: racedBody,
          cacheControl: publisherTools.IMMUTABLE_CACHE_CONTROL,
        });
      }
    });

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release,
        storage: harness.storage,
      }),
    ).rejects.toThrow('public digest does not match');
    expect(harness.remote.get(`${prefix}${fixture.installerName}`)?.body).toEqual(racedBody);
    expect(harness.writes).toHaveLength(0);
  });

  it('serializes concurrent channel publishers with create-only COS locks', async () => {
    const higherFixture = createReleaseFixture('5.0.0-rc.2');
    const lowerFixture = createReleaseFixture('5.0.0-rc.1');
    const higherRelease = validateFixture(higherFixture.root, higherFixture.output);
    const lowerRelease = validateFixture(lowerFixture.root, lowerFixture.output);
    const harness = createPublicationHarness();
    let releaseLock: () => void = () => undefined;
    const keepLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let reportLockAcquired: () => void = () => undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      reportLockAcquired = resolve;
    });
    harness.setAfterCreate(async (descriptor) => {
      if (descriptor.key.includes('.claudedock-publication-locks/rc.lock')) {
        reportLockAcquired();
        await keepLock;
      }
    });

    const higherPublication = publisherTools.publishValidatedRelease({
      fetchImpl: harness.fetchImpl,
      prefix,
      release: higherRelease,
      storage: harness.storage,
    });
    await lockAcquired;
    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release: lowerRelease,
        storage: harness.storage,
      }),
    ).rejects.toThrow('publication lock for rc is already held');
    releaseLock();
    await expect(higherPublication).resolves.toMatchObject({ version: '5.0.0-rc.2' });
    expect(readFileSync(path.join(higherFixture.output, 'rc.yml'), 'utf8')).toBe(
      harness.remote.get(`${prefix}rc.yml`)?.body.toString('utf8'),
    );
  });

  it('recovers lock ownership when COS creates the lock but loses the success response', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    let failedAcknowledgement = false;
    harness.setAfterCreate(async (descriptor) => {
      if (
        !failedAcknowledgement &&
        descriptor.key.includes('.claudedock-publication-locks/rc.lock')
      ) {
        failedAcknowledgement = true;
        throw new Error('simulated connection reset after COS created the lock');
      }
    });

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release,
        storage: harness.storage,
      }),
    ).resolves.toMatchObject({ version: '5.0.0-rc.15' });
    expect(failedAcknowledgement).toBe(true);
    expect(harness.remote.has(`${prefix}.claudedock-publication-locks/rc.lock`)).toBe(false);
  });

  it('recovers lock ownership when an SDK retry converts a lost response into 409', async () => {
    const fixture = createReleaseFixture();
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    let injectedRetryConflict = false;
    harness.setBeforeCreate(async (descriptor) => {
      if (
        !injectedRetryConflict &&
        descriptor.key.includes('.claudedock-publication-locks/rc.lock')
      ) {
        injectedRetryConflict = true;
        harness.remote.set(descriptor.key, {
          body: descriptor.body!,
          cacheControl: descriptor.cacheControl,
        });
      }
    });

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        release,
        storage: harness.storage,
      }),
    ).resolves.toMatchObject({ version: '5.0.0-rc.15' });
    expect(injectedRetryConflict).toBe(true);
    expect(harness.remote.has(`${prefix}.claudedock-publication-locks/rc.lock`)).toBe(false);
  });

  it('preflights every promoted channel before changing the first channel pointer', async () => {
    const fixture = createReleaseFixture('5.0.0');
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    const previousLatest = Buffer.from('version: 4.9.0\n', 'utf8');
    harness.remote.set(`${prefix}latest.yml`, {
      body: previousLatest,
      cacheControl: publisherTools.CHANNEL_CACHE_CONTROL,
    });
    harness.remote.set(`${prefix}rc.yml`, {
      body: Buffer.from('version: 5.1.0-rc.1\n', 'utf8'),
      cacheControl: publisherTools.CHANNEL_CACHE_CONTROL,
    });

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        promoteChannels: ['rc'],
        release,
        storage: harness.storage,
      }),
    ).rejects.toThrow('rc.yml version 5.1.0-rc.1 is newer');
    expect(harness.remote.get(`${prefix}latest.yml`)?.body).toEqual(previousLatest);
    expect(
      harness.writes.some(({ key }) => key === `${prefix}latest.yml` || key === `${prefix}rc.yml`),
    ).toBe(false);
    expect(harness.remote.has(`${prefix}.claudedock-publication-locks/latest.lock`)).toBe(false);
    expect(harness.remote.has(`${prefix}.claudedock-publication-locks/rc.lock`)).toBe(false);
  });

  it('releases earlier channel locks when a later lock is already held', async () => {
    const fixture = createReleaseFixture('5.0.0');
    const release = validateFixture(fixture.root, fixture.output);
    const harness = createPublicationHarness();
    const existingRcLock = Buffer.from('another publisher owns this lock', 'utf8');
    harness.remote.set(`${prefix}.claudedock-publication-locks/rc.lock`, {
      body: existingRcLock,
      cacheControl: 'no-store',
    });

    await expect(
      publisherTools.publishValidatedRelease({
        fetchImpl: harness.fetchImpl,
        prefix,
        promoteChannels: ['rc'],
        release,
        storage: harness.storage,
      }),
    ).rejects.toThrow('publication lock for rc is already held');
    expect(harness.remote.has(`${prefix}.claudedock-publication-locks/latest.lock`)).toBe(false);
    expect(harness.remote.get(`${prefix}.claudedock-publication-locks/rc.lock`)?.body).toEqual(
      existingRcLock,
    );
  });

  it('uses COS overwrite protection and refuses buckets with versioning history', async () => {
    const descriptor: ObjectDescriptor = {
      body: Buffer.from('lock', 'utf8'),
      bytes: 4,
      cacheControl: 'no-store',
      contentType: 'text/plain',
      key: `${prefix}.lock`,
    };
    const putObject = vi.fn(async () => ({}));
    const storage = publisherTools.createCosStorage({
      bucket: 'claudedock-test-123',
      client: {
        getBucketVersioning: vi.fn(async () => ({ VersioningConfiguration: {} })),
        headObject: vi.fn(async () => ({})),
        putObject,
      },
      region: 'ap-test',
    });

    await expect(storage.assertAtomicCreateSupported()).resolves.toBeUndefined();
    await expect(storage.create(descriptor)).resolves.toBe(true);
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ 'x-cos-forbid-overwrite': 'true' }),
    );

    putObject.mockRejectedValueOnce({ code: 'FileAlreadyExists', statusCode: 409 });
    await expect(storage.create(descriptor)).resolves.toBe(false);

    const versionedStorage = publisherTools.createCosStorage({
      bucket: 'claudedock-test-123',
      client: {
        getBucketVersioning: vi.fn(async () => ({
          VersioningConfiguration: { Status: 'Suspended' },
        })),
        headObject: vi.fn(async () => ({})),
        putObject: vi.fn(async () => ({})),
      },
      region: 'ap-test',
    });
    await expect(versionedStorage.assertAtomicCreateSupported()).rejects.toThrow(
      'versioning is Suspended',
    );
  });

  it('validates environment routing and redacts COS credentials and signed queries', async () => {
    const environment = {
      TENCENT_COS_BUCKET: 'claudedock-test-123',
      TENCENT_COS_PREFIX: prefix,
      TENCENT_COS_REGION: 'ap-test',
      TENCENT_COS_SECRET_ID: 'secret-id-value',
      TENCENT_COS_SECRET_KEY: 'secret-key-value',
      TENCENT_COS_SECURITY_TOKEN: 'security-token-value',
    };
    expect(publisherTools.readCosEnvironment(feedUrl, environment).prefix).toBe(prefix);
    const redacted = publisherTools.redactSensitiveText(
      'Authorization: secret-key-value https://example.com/a?q-ak=secret-id-value&q-signature=abc security-token-value',
      ['secret-id-value', 'secret-key-value', 'security-token-value'],
    );
    expect(redacted).not.toContain('secret-id-value');
    expect(redacted).not.toContain('secret-key-value');
    expect(redacted).not.toContain('security-token-value');
    expect(redacted).not.toContain('q-signature=abc');

    const client = {
      headObject: vi.fn(async () => {
        throw new Error('Authorization=secret-key-value https://example.com/a?q-signature=abc');
      }),
      putObject: vi.fn(async () => ({})),
    };
    const storage = publisherTools.createCosStorage({
      bucket: environment.TENCENT_COS_BUCKET,
      client,
      region: environment.TENCENT_COS_REGION,
      secrets: [environment.TENCENT_COS_SECRET_KEY],
    });
    let errorMessage = '';
    try {
      await storage.head(`${prefix}rc.yml`);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toContain('<redacted>');
    expect(errorMessage).not.toContain('secret-key-value');
    expect(errorMessage).not.toContain('q-signature=abc');
  });
});
