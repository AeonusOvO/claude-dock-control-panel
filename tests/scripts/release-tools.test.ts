import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ArchiveReader,
  type ObjectDescriptor,
  type ReleaseManifest,
  blockmapBytes,
  cleanupReleaseFixtures,
  createPublicationHarness,
  createReleaseFixture,
  digest,
  feedUrl,
  fixtureRoots,
  manifestTools,
  packageManifest,
  prefix,
  publisherTools,
  validateFixture,
  writeFixtureOrchestration,
} from './release-tools-fixture';

afterEach(cleanupReleaseFixtures);

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

  it('records full source identity and distinguishes ignored outputs from tracked and untracked dirt', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claudedock-source-identity-'));
    fixtureRoots.push(root);
    const emptyGitConfig = path.join(root, 'empty-gitconfig');
    const packageLock = Buffer.from('{"lockfileVersion":3}\n', 'utf8');
    writeFileSync(emptyGitConfig, '', 'utf8');
    writeFileSync(path.join(root, '.gitignore'), 'dist/\noutputs/\n', 'utf8');
    writeFileSync(path.join(root, 'package-lock.json'), packageLock);
    const git = (arguments_: string[]) =>
      execFileSync('git', ['-C', root, ...arguments_], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: emptyGitConfig,
          GIT_CONFIG_SYSTEM: emptyGitConfig,
        },
      });
    git(['init', '--quiet']);
    git(['add', '.gitignore', 'empty-gitconfig', 'package-lock.json']);
    git([
      '-c',
      'user.name=ClaudeDock Tests',
      '-c',
      'user.email=tests@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);

    const clean = manifestTools.readSourceIdentity({ projectRoot: root });
    expect(clean).toEqual({
      gitHead: git(['rev-parse', '--verify', 'HEAD']).trim(),
      packageLockSha256: digest('sha256', 'hex', packageLock),
      treeClean: true,
    });

    mkdirSync(path.join(root, 'outputs'), { recursive: true });
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'outputs', 'installer.exe'), 'ignored', 'utf8');
    writeFileSync(path.join(root, 'dist', 'main.js'), 'ignored', 'utf8');
    expect(manifestTools.readSourceIdentity({ projectRoot: root }).treeClean).toBe(true);

    writeFileSync(path.join(root, 'package-lock.json'), '{"changed":true}\n', 'utf8');
    expect(manifestTools.readSourceIdentity({ projectRoot: root }).treeClean).toBe(false);
    writeFileSync(path.join(root, 'package-lock.json'), packageLock);
    expect(manifestTools.readSourceIdentity({ projectRoot: root }).treeClean).toBe(true);

    writeFileSync(path.join(root, 'untracked.txt'), 'dirty', 'utf8');
    expect(manifestTools.readSourceIdentity({ projectRoot: root }).treeClean).toBe(false);
  });

  it('refuses dirty source and stale same-version build identities', () => {
    const fixture = createReleaseFixture();
    const dirty = validateFixture(fixture.root, fixture.output, false, {
      sourceIdentity: () => ({ ...fixture.sourceIdentity, treeClean: false }),
    });
    expect(dirty.manifest.source).toEqual({ ...fixture.sourceIdentity, treeClean: false });
    expect(dirty.manifest.problems).toContain(
      'source tree is dirty; commit or remove tracked and untracked changes before final release manifest generation',
    );

    const staleSource = {
      ...fixture.sourceIdentity,
      gitHead: 'b'.repeat(40),
      packageLockSha256: 'c'.repeat(64),
    };
    const stale = validateFixture(fixture.root, fixture.output, false, {
      sourceIdentity: () => staleSource,
    });
    expect(stale.manifest.version).toBe('5.0.0-rc.15');
    expect(stale.manifest.source).toEqual(staleSource);
    expect(stale.manifest.problems).toContain(
      'packaged source identity Git HEAD, package-lock.json SHA-256 differs from expected source identity',
    );
  });

  it('validates the exact installer, blockmap, RC manifest, digest chain, and report fields', () => {
    const fixture = createReleaseFixture();
    const result = validateFixture(fixture.root, fixture.output, true);

    expect(result.manifest).toMatchObject({
      channel: 'rc',
      channelManifest: 'rc.yml',
      cohort: {
        blockmap: {
          algorithm: 'BLAKE2b-144',
          chunkCount: 2,
          coverageBytes: fixture.installer.byteLength,
        },
        installerPayload: {
          appAsar: expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
          appAsarUnpacked: expect.objectContaining({ fileCount: 1 }),
          schemaVersion: 1,
        },
      },
      feedUrl,
      problems: [],
      provider: 'generic',
      signature: 'NotSigned',
      source: fixture.sourceIdentity,
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

  it('rejects stale installer payload bytes and mismatched unpacked resources', () => {
    const fixture = createReleaseFixture();
    fixture.installerPayloadFiles.set('resources/app.asar', Buffer.from('stale app.asar'));
    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('resources/app.asar bytes differ from win-unpacked'),
      ]),
    );

    fixture.installerPayloadFiles.set(
      'resources/app.asar',
      readFileSync(path.join(fixture.output, 'win-unpacked', 'resources', 'app.asar')),
    );
    fixture.installerPayloadFiles.set(
      'resources/app.asar.unpacked/assets/runtime/fixture.ps1',
      Buffer.from('mismatched unpacked bytes'),
    );
    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('app.asar.unpacked bytes differ from win-unpacked'),
      ]),
    );
  });

  it('rejects malformed and stale external blockmaps', () => {
    const fixture = createReleaseFixture();
    const blockmapPath = path.join(fixture.output, `${fixture.installerName}.blockmap`);
    writeFileSync(blockmapPath, 'not gzip JSON', 'utf8');
    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('blockmap is not valid gzip JSON')]),
    );

    writeFileSync(blockmapPath, blockmapBytes(Buffer.alloc(fixture.installer.byteLength, 0x78)));
    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('checksum does not match the installer')]),
    );
  });

  it('requires the packaged updater channel and rejects the wrong channel', () => {
    const fixture = createReleaseFixture();
    const appUpdatePath = path.join(fixture.output, 'win-unpacked', 'resources', 'app-update.yml');
    const withoutChannel = Buffer.from(
      `provider: generic\nurl: ${feedUrl}\nuseMultipleRangeRequest: false\n`,
    );
    writeFileSync(appUpdatePath, withoutChannel);
    fixture.installerPayloadFiles.set('resources/app-update.yml', withoutChannel);
    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('channel undefined != intended channel rc')]),
    );

    const wrongChannel = Buffer.from(
      `provider: generic\nurl: ${feedUrl}\nuseMultipleRangeRequest: false\nchannel: latest\n`,
    );
    writeFileSync(appUpdatePath, wrongChannel);
    fixture.installerPayloadFiles.set('resources/app-update.yml', wrongChannel);
    expect(validateFixture(fixture.root, fixture.output).manifest.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('channel latest != intended channel rc')]),
    );
  });

  it('redacts URL userinfo, queries, and fragments from manifest problems', () => {
    const fixture = createReleaseFixture();
    const sensitiveUrl = [
      'https://',
      'user:password',
      '@example.test/feed',
      '?token=credential',
      '#fragment-credential',
    ].join('');
    const archive: ArchiveReader = {
      ...fixture.archive,
      listPackage: () => {
        throw new Error(`invalid feed ${sensitiveUrl}`);
      },
    };
    const result = validateFixture(fixture.root, fixture.output, false, { archive });
    const reportText = JSON.stringify(result.manifest);
    expect(reportText).toContain('<redacted>');
    expect(reportText).not.toContain('user:password');
    expect(reportText).not.toContain('token=credential');
    expect(reportText).not.toContain('fragment-credential');
    expect(manifestTools.sanitizeManifestText(sensitiveUrl)).toBe(
      'https://<redacted>@example.test/feed?<redacted>#<redacted>',
    );
  });

  it.each(['Valid', 'NotSigned'])('accepts determinate Authenticode status %s', (status) => {
    const fixture = createReleaseFixture();
    const result = validateFixture(fixture.root, fixture.output, false, {
      signatureStatus: () => status,
    });
    expect(result.manifest.signature).toBe(status);
    const authenticodeProblems = result.manifest.problems.filter((problem) =>
      problem.includes('Authenticode'),
    );
    expect(authenticodeProblems).toEqual([]);
  });

  it.each(['unknown', 'unavailable', '', 'HashMismatch', 'NotTrusted', 'UnknownError', 'Other'])(
    'rejects nondeterminate Authenticode status %s',
    (status) => {
      const fixture = createReleaseFixture();
      const result = validateFixture(fixture.root, fixture.output, false, {
        signatureStatus: () => status,
      });
      expect(result.manifest.problems).toEqual(
        expect.arrayContaining([expect.stringContaining('expected Valid or NotSigned')]),
      );
    },
  );
});

describe('COS release publication', () => {
  it('requires an exact orchestrator record for the frozen manifest bytes', () => {
    const fixture = createReleaseFixture();
    validateFixture(fixture.root, fixture.output, true);
    const reportPath = path.join(fixture.output, 'release-manifest.json');

    expect(() =>
      publisherTools.loadFrozenValidatedRelease({
        projectRoot: fixture.root,
        releaseDirectory: fixture.output,
      }),
    ).toThrow('release orchestration record cannot be read');

    writeFixtureOrchestration(fixture.output, fixture.sourceIdentity);
    writeFileSync(reportPath, `${readFileSync(reportPath, 'utf8')}\n`, 'utf8');
    expect(() =>
      publisherTools.loadFrozenValidatedRelease({
        projectRoot: fixture.root,
        releaseDirectory: fixture.output,
      }),
    ).toThrow('frozen release manifest differs from the orchestrated manifest');
  });

  it('loads the frozen manifest without rewriting it or changing generatedAt', () => {
    const fixture = createReleaseFixture();
    validateFixture(fixture.root, fixture.output, true);
    writeFixtureOrchestration(fixture.output, fixture.sourceIdentity);
    const reportPath = path.join(fixture.output, 'release-manifest.json');
    const frozenReport = readFileSync(reportPath, 'utf8');

    const release = publisherTools.loadFrozenValidatedRelease({
      archive: fixture.archive,
      extractInstaller: fixture.extractInstaller,
      now: new Date('2026-08-24T10:11:12.000Z'),
      projectRoot: fixture.root,
      releaseDirectory: fixture.output,
      signatureStatus: () => 'NotSigned',
      sourceIdentity: () => fixture.sourceIdentity,
    });

    expect(release.manifest.generatedAt).toBe('2026-08-23T01:02:03.000Z');
    expect(readFileSync(reportPath, 'utf8')).toBe(frozenReport);
  });

  it('refuses source identity or artifact drift from the frozen manifest without rewriting it', () => {
    const fixture = createReleaseFixture();
    validateFixture(fixture.root, fixture.output, true);
    writeFixtureOrchestration(fixture.output, fixture.sourceIdentity);
    const reportPath = path.join(fixture.output, 'release-manifest.json');
    const frozenReport = readFileSync(reportPath, 'utf8');
    const options = {
      archive: fixture.archive,
      extractInstaller: fixture.extractInstaller,
      projectRoot: fixture.root,
      releaseDirectory: fixture.output,
      signatureStatus: () => 'NotSigned',
    };

    expect(() =>
      publisherTools.loadFrozenValidatedRelease({
        ...options,
        sourceIdentity: () => ({ ...fixture.sourceIdentity, gitHead: 'b'.repeat(40) }),
      }),
    ).toThrow('current Git HEAD or package-lock.json SHA-256 differs from the frozen manifest');

    fixture.archiveFiles.set(
      'dist/build-source-identity.json',
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, ...fixture.sourceIdentity, gitHead: 'b'.repeat(40) }),
        'utf8',
      ),
    );
    expect(() =>
      publisherTools.loadFrozenValidatedRelease({
        ...options,
        sourceIdentity: () => fixture.sourceIdentity,
      }),
    ).toThrow(
      'current non-writing release validation failed: packaged source identity Git HEAD differs from expected source identity',
    );
    fixture.archiveFiles.set(
      'dist/build-source-identity.json',
      Buffer.from(JSON.stringify({ schemaVersion: 1, ...fixture.sourceIdentity }), 'utf8'),
    );

    fixture.installerPayloadFiles.set('resources/app.asar', Buffer.from('stale installer payload'));
    expect(() =>
      publisherTools.loadFrozenValidatedRelease({
        ...options,
        sourceIdentity: () => fixture.sourceIdentity,
      }),
    ).toThrow(
      'current non-writing release validation failed: installer payload cannot be linked to win-unpacked',
    );
    fixture.installerPayloadFiles.set(
      'resources/app.asar',
      readFileSync(path.join(fixture.output, 'win-unpacked', 'resources', 'app.asar')),
    );

    writeFileSync(
      path.join(fixture.output, `${fixture.installerName}.blockmap`),
      blockmapBytes(fixture.installer, [fixture.installer.byteLength]),
    );
    expect(() =>
      publisherTools.loadFrozenValidatedRelease({
        ...options,
        sourceIdentity: () => fixture.sourceIdentity,
      }),
    ).toThrow('current release artifacts differ from the frozen manifest');
    expect(readFileSync(reportPath, 'utf8')).toBe(frozenReport);
  });

  it('compares deterministic cohort evidence and rechecks blockmap chunks from a frozen report', () => {
    const fixture = createReleaseFixture();
    validateFixture(fixture.root, fixture.output, true);
    writeFixtureOrchestration(fixture.output, fixture.sourceIdentity);
    const reportPath = path.join(fixture.output, 'release-manifest.json');
    const blockmapPath = path.join(fixture.output, `${fixture.installerName}.blockmap`);
    const frozen = JSON.parse(readFileSync(reportPath, 'utf8')) as ReleaseManifest;
    const blockmapArtifact = frozen.artifacts.find(({ name }) => name.endsWith('.blockmap'))!;
    const updateFrozenArtifact = (bytes: Buffer) => {
      blockmapArtifact.bytes = bytes.byteLength;
      blockmapArtifact.sha256 = digest('sha256', 'hex', bytes);
      blockmapArtifact.sha512 = digest('sha512', 'base64', bytes);
      writeFileSync(reportPath, `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
      writeFixtureOrchestration(fixture.output, fixture.sourceIdentity);
    };
    const options = {
      archive: fixture.archive,
      extractInstaller: fixture.extractInstaller,
      projectRoot: fixture.root,
      releaseDirectory: fixture.output,
      signatureStatus: () => 'NotSigned',
      sourceIdentity: () => fixture.sourceIdentity,
    };

    const alternate = blockmapBytes(fixture.installer, [fixture.installer.byteLength]);
    writeFileSync(blockmapPath, alternate);
    updateFrozenArtifact(alternate);
    expect(() => publisherTools.loadFrozenValidatedRelease(options)).toThrow(
      'current release metadata differs from the frozen manifest',
    );

    const stale = blockmapBytes(Buffer.alloc(fixture.installer.byteLength, 0x78), [
      fixture.installer.byteLength,
    ]);
    writeFileSync(blockmapPath, stale);
    updateFrozenArtifact(stale);
    expect(() => publisherTools.loadFrozenValidatedRelease(options)).toThrow(
      'current non-writing release validation failed: external blockmap is invalid',
    );
  });

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

  it('publishes the frozen channel bytes when the local YAML changes after validation', async () => {
    const fixture = createReleaseFixture();
    validateFixture(fixture.root, fixture.output, true);
    writeFixtureOrchestration(fixture.output, fixture.sourceIdentity);
    const release = publisherTools.loadFrozenValidatedRelease({
      archive: fixture.archive,
      extractInstaller: fixture.extractInstaller,
      projectRoot: fixture.root,
      releaseDirectory: fixture.output,
      signatureStatus: () => 'NotSigned',
      sourceIdentity: () => fixture.sourceIdentity,
    });
    const channelPath = path.join(fixture.output, 'rc.yml');
    const frozenText = readFileSync(channelPath, 'utf8');
    const changedText = frozenText.replace(
      /(sha512: )([0-9A-Za-z+/])/u,
      (_match, label: string, character: string) => `${label}${character === 'A' ? 'B' : 'A'}`,
    );
    expect(changedText).toHaveLength(frozenText.length);
    expect(changedText).not.toBe(frozenText);
    const harness = createPublicationHarness();
    harness.setAfterCreate(async (descriptor) => {
      if (descriptor.key === `${prefix}${fixture.installerName}.blockmap`) {
        writeFileSync(channelPath, changedText, 'utf8');
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
    expect(readFileSync(channelPath, 'utf8')).toBe(changedText);
    expect(harness.remote.get(`${prefix}rc.yml`)?.body.toString('utf8')).toBe(frozenText);
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
      'Authorization: secret-key-value https://feed-user:feed-password@example.com/a?q-ak=secret-id-value&q-signature=abc security-token-value',
      ['secret-id-value', 'secret-key-value', 'security-token-value'],
    );
    expect(redacted).not.toContain('secret-id-value');
    expect(redacted).not.toContain('secret-key-value');
    expect(redacted).not.toContain('security-token-value');
    expect(redacted).not.toContain('feed-user');
    expect(redacted).not.toContain('feed-password');
    expect(redacted).not.toContain('q-signature=abc');

    const secretBearingUrl = [
      'https://',
      environment.TENCENT_COS_SECRET_ID,
      ':other-userinfo',
      '@example.test/a',
      `?custom=${environment.TENCENT_COS_SECRET_KEY}`,
      '#fragment-value',
    ].join('');
    expect(
      publisherTools.redactSensitiveText(secretBearingUrl, [
        environment.TENCENT_COS_SECRET_ID,
        environment.TENCENT_COS_SECRET_KEY,
      ]),
    ).toBe('https://<redacted>@example.test/a?<redacted>#<redacted>');

    const client = {
      headObject: vi.fn(async () => {
        throw new Error(
          'Authorization=secret-key-value https://feed-user:feed-password@example.com/a?q-signature=abc',
        );
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
    expect(errorMessage).not.toContain('feed-user');
    expect(errorMessage).not.toContain('feed-password');
    expect(errorMessage).not.toContain('q-signature=abc');
  });
});
