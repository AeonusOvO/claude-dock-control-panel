import { describe, expect, it, vi } from 'vitest';
import type { NetworkPreflightResult } from '../../src/shared/contracts';
import type {
  NetworkPreflightLeaseContext,
  NetworkPreflightRouteIdentity,
  NetworkPreflightService,
} from '../../src/main/network/preflight-service';
import {
  ProviderAccessBlockedError,
  ProviderAccessBypassStaleError,
  ProviderAccessGuard,
} from '../../src/main/network/provider-access-guard';

const result = (
  providerStatus: 'allowed' | 'blocked',
  providerAllowed: boolean,
  compatibilityStatus: 'allowed' | 'allowed_with_notice' | 'blocked',
  requiredFailureDetail?: string,
): NetworkPreflightResult => {
  const providerConnectivity = {
    featureAccess: [
      {
        action: 'first-request' as const,
        allowed: providerAllowed,
        ...(providerAllowed ? {} : { reason: 'provider feature denied' }),
      },
    ],
    probes: requiredFailureDetail
      ? [
          {
            checkedAt: 100,
            detail: requiredFailureDetail,
            id: 'required-provider-endpoint',
            kind: 'api' as const,
            label: 'Required provider endpoint',
            process: 'application' as const,
            required: true,
            status: 'failed' as const,
            target: 'https://api.anthropic.com/v1/messages',
          },
        ]
      : [],
    reasons: providerAllowed ? [] : ['PROVIDER_PRIVATE_REASON'],
    signals: [],
    status: providerStatus,
    summary: providerAllowed ? 'PROVIDER_ALLOWED_SUMMARY' : 'PROVIDER_BLOCKED_SUMMARY',
  };
  const advisoryEvidence = {
    paths: [],
    reasons: ['ADVISORY_PRIVATE_REASON'],
    riskLevel: 'high' as const,
    riskScore: 95,
    signals: [],
    summary: 'ADVISORY_PRIVATE_SUMMARY',
  };
  return {
    action: 'first-request',
    advisoryEvidence,
    canonicalCwd: 'D:\\Project',
    checkedAt: 100,
    configurationRevision: 'route-revision',
    featureAccess: [
      {
        action: 'first-request',
        allowed: !providerAllowed,
        ...(!providerAllowed ? {} : { reason: 'FLAT_FEATURE_DENIED' }),
      },
    ],
    generation: 3,
    mainRunId: 7,
    networkScope: 'application',
    paths: [],
    probes: [],
    provider: 'anthropic-claude',
    providerConnectivity,
    providerLabel: 'Anthropic Claude Code',
    reasons: ['FLAT_PRIVATE_REASON'],
    riskLevel: 'high',
    riskScore: 100,
    schemaVersion: 2,
    signals: [],
    startedAt: 90,
    status: compatibilityStatus,
    summary: 'FLAT_PRIVATE_SUMMARY',
  };
};

const request = {
  action: 'first-request' as const,
  cwd: 'D:\\Project',
  networkScope: 'application' as const,
  provider: 'anthropic-claude' as const,
  target: {
    process: 'application' as const,
    url: 'https://api.anthropic.com/v1/messages',
  },
};

const leaseContext = Object.freeze({}) as NetworkPreflightLeaseContext;

const serviceForResult = (preflightResult: NetworkPreflightResult): NetworkPreflightService =>
  ({
    runWithLease: vi.fn(async (_input, _target, operation) =>
      operation(preflightResult, leaseContext),
    ),
  }) as unknown as NetworkPreflightService;

describe('ProviderAccessGuard v2 authority', () => {
  it('uses only provider connectivity for admission and blocked-error copy', async () => {
    const allowed = result('allowed', true, 'blocked');
    const allowedOperation = vi.fn(() => 'entered');
    const allowedGuard = new ProviderAccessGuard(serviceForResult(allowed));

    await expect(allowedGuard.withAllowed(request, allowedOperation)).resolves.toBe('entered');
    expect(allowedOperation).toHaveBeenCalledWith(allowed);

    const blocked = result('blocked', false, 'allowed');
    const blockedOperation = vi.fn();
    const blockedGuard = new ProviderAccessGuard(serviceForResult(blocked));
    let error: unknown;
    try {
      await blockedGuard.withAllowed(request, blockedOperation);
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ProviderAccessBlockedError);
    expect((error as Error).message).toContain('PROVIDER_BLOCKED_SUMMARY');
    expect((error as Error).message).toContain('provider feature denied');
    expect((error as Error).message).toContain('PROVIDER_PRIVATE_REASON');
    expect((error as Error).message).not.toContain('FLAT_PRIVATE_SUMMARY');
    expect((error as Error).message).not.toContain('FLAT_PRIVATE_REASON');
    expect((error as Error).message).not.toContain('ADVISORY_PRIVATE_SUMMARY');
    expect((error as Error).message).not.toContain('ADVISORY_PRIVATE_REASON');
    expect(blockedOperation).not.toHaveBeenCalled();
  });

  it('keeps allowed_with_notice green when provider authority allows the action', async () => {
    const allowed = result('allowed', true, 'allowed_with_notice');
    const operation = vi.fn(() => 'entered');
    const guard = new ProviderAccessGuard(serviceForResult(allowed));

    await expect(guard.withAllowed(request, operation)).resolves.toBe('entered');
    expect(operation).toHaveBeenCalledWith(allowed);
  });

  it('forces one immediate recheck for a required HTTP 5xx without making it allowed', async () => {
    const blocked = result(
      'blocked',
      false,
      'blocked',
      '应用路径返回 HTTP 503，提供商端点服务不可用。',
    );
    const recovered = result('allowed', true, 'allowed');
    const runWithLease = vi
      .fn()
      .mockImplementationOnce(async (_input, _target, operation) =>
        operation(blocked, leaseContext),
      )
      .mockImplementationOnce(async (_input, _target, operation) =>
        operation(recovered, leaseContext),
      );
    const guard = new ProviderAccessGuard({ runWithLease } as unknown as NetworkPreflightService);
    const operation = vi.fn(() => 'recovered');

    await expect(guard.withAllowed(request, operation)).resolves.toBe('recovered');
    expect(runWithLease).toHaveBeenCalledTimes(2);
    expect(runWithLease.mock.calls[1]?.[0]).toMatchObject({ force: true });
    expect(operation).toHaveBeenCalledWith(recovered);
  });

  it('blocks after the single forced retry when a required HTTP 5xx persists', async () => {
    const blocked = result(
      'blocked',
      false,
      'blocked',
      'CLI 路径返回 HTTP 502，提供商端点服务不可用。',
    );
    const runWithLease = vi.fn(async (_input, _target, operation) =>
      operation(blocked, leaseContext),
    );
    const guard = new ProviderAccessGuard({ runWithLease } as unknown as NetworkPreflightService);
    const operation = vi.fn();

    await expect(guard.withAllowed(request, operation)).rejects.toBeInstanceOf(
      ProviderAccessBlockedError,
    );
    expect(runWithLease).toHaveBeenCalledTimes(2);
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not retry a non-transient required HTTP failure', async () => {
    const blocked = result('blocked', false, 'blocked', 'CLI 路径返回 HTTP 407，需要代理认证。');
    const runWithLease = vi.fn(async (_input, _target, operation) =>
      operation(blocked, leaseContext),
    );
    const guard = new ProviderAccessGuard({ runWithLease } as unknown as NetworkPreflightService);

    await expect(guard.withAllowed(request, vi.fn())).rejects.toBeInstanceOf(
      ProviderAccessBlockedError,
    );
    expect(runWithLease).toHaveBeenCalledOnce();
  });

  it('rechecks the exact blocked route and admits from nested provider evidence', async () => {
    const blocked = result('blocked', false, 'allowed');
    const capture = new ProviderAccessBlockedError(blocked, request.target).capture;
    const recovered = result('allowed', true, 'blocked');
    const identity: NetworkPreflightRouteIdentity = {
      action: capture.action,
      canonicalCwd: capture.canonicalCwd,
      configurationRevision: capture.configurationRevision,
      generation: capture.generation,
      networkScope: capture.networkScope,
      provider: capture.provider,
      target: capture.target,
    };
    const runWithExistingLease = vi.fn(async (_input, _target, context, operation) => {
      expect(context).toBe(leaseContext);
      return operation(recovered, leaseContext);
    });
    const runWithCurrentRouteLease = vi.fn(async (_input, _target, operation) =>
      operation(identity, leaseContext),
    );
    const guard = new ProviderAccessGuard({
      runWithCurrentRouteLease,
      runWithExistingLease,
    } as unknown as NetworkPreflightService);
    const operation = vi.fn(() => 'recovered');

    await expect(guard.recheck(capture, operation)).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledWith(recovered);
    expect(runWithCurrentRouteLease).toHaveBeenCalledOnce();
    expect(runWithExistingLease).toHaveBeenCalledOnce();
  });

  it('rejects recheck authority when the exact target changed', async () => {
    const blocked = result('blocked', false, 'blocked');
    const capture = new ProviderAccessBlockedError(blocked, request.target).capture;
    const runWithExistingLease = vi.fn();
    const runWithCurrentRouteLease = vi.fn(async (_input, _target, operation) =>
      operation(
        {
          action: capture.action,
          canonicalCwd: capture.canonicalCwd,
          configurationRevision: capture.configurationRevision,
          generation: capture.generation,
          networkScope: capture.networkScope,
          provider: capture.provider,
          target: {
            process: 'application' as const,
            url: 'https://gateway.example.test/v1/chat/completions',
          },
        },
        leaseContext,
      ),
    );
    const guard = new ProviderAccessGuard({
      runWithCurrentRouteLease,
      runWithExistingLease,
    } as unknown as NetworkPreflightService);

    await expect(guard.recheck(capture, vi.fn())).rejects.toBeInstanceOf(
      ProviderAccessBypassStaleError,
    );
    expect(runWithExistingLease).not.toHaveBeenCalled();
  });
});
