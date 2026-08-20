import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createRegistryToken, Registry, type RegistryToken } from '../../src/main/infra/registry';

describe('main infrastructure registry', () => {
  it('keeps tokens with the same description independent', () => {
    const first = createRegistryToken<number>('counter');
    const second = createRegistryToken<number>('counter');
    const registry = new Registry();
    registry.register(first, () => 1);
    registry.register(second, () => 2);

    expect(registry.resolve(first)).toBe(1);
    expect(registry.resolve(second)).toBe(2);
  });

  it('creates a registered service lazily and caches it', () => {
    const token = createRegistryToken<object>('service');
    const service = {};
    const factory = vi.fn(() => service);
    const registry = new Registry();
    registry.register(token, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(registry.resolve(token)).toBe(service);
    expect(registry.resolve(token)).toBe(service);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('lets a factory resolve another registered dependency', () => {
    const dependency = createRegistryToken<{ value: number }>('dependency');
    const consumer = createRegistryToken<number>('consumer');
    const registry = new Registry();
    registry.register(consumer, (services) => services.resolve(dependency).value + 1);
    registry.register(dependency, () => ({ value: 41 }));

    expect(registry.resolve(consumer)).toBe(42);
  });

  it('keeps registrations and instances local to each registry', () => {
    const token = createRegistryToken<object>('scoped-service');
    const firstService = {};
    const secondService = {};
    const firstRegistry = new Registry();
    const secondRegistry = new Registry();
    firstRegistry.register(token, () => firstService);
    secondRegistry.register(token, () => secondService);

    expect(firstRegistry.resolve(token)).toBe(firstService);
    expect(secondRegistry.resolve(token)).toBe(secondService);
  });

  it('rejects duplicate registration without replacing the original factory', () => {
    const token = createRegistryToken<number>('duplicate');
    const registry = new Registry();
    registry.register(token, () => 1);

    expect(() => registry.register(token, () => 2)).toThrow(
      'Registry token already registered: duplicate',
    );
    expect(registry.resolve(token)).toBe(1);
  });

  it('reports an unregistered token by description', () => {
    const token = createRegistryToken<number>('missing-service');

    expect(() => new Registry().resolve(token)).toThrow(
      'Registry token is not registered: missing-service',
    );
  });

  it('reports direct and indirect dependency cycles', () => {
    const direct = createRegistryToken<number>('direct');
    const first = createRegistryToken<number>('first');
    const second = createRegistryToken<number>('second');
    const directRegistry = new Registry();
    directRegistry.register(direct, (services) => services.resolve(direct));

    expect(() => directRegistry.resolve(direct)).toThrow(
      'Circular registry dependency: direct -> direct',
    );

    const indirectRegistry = new Registry();
    indirectRegistry.register(first, (services) => services.resolve(second));
    indirectRegistry.register(second, (services) => services.resolve(first));

    expect(() => indirectRegistry.resolve(first)).toThrow(
      'Circular registry dependency: first -> second -> first',
    );
  });

  it('does not cache failures or retain failed resolution state', () => {
    const token = createRegistryToken<number>('retryable');
    const factory = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw new Error('temporary failure');
      })
      .mockReturnValue(7);
    const registry = new Registry();
    registry.register(token, factory);

    expect(() => registry.resolve(token)).toThrow('temporary failure');
    expect(registry.resolve(token)).toBe(7);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('caches an intentional undefined service', () => {
    const token = createRegistryToken<undefined>('undefined-service');
    const factory = vi.fn(() => undefined);
    const registry = new Registry();
    registry.register(token, factory);

    expect(registry.resolve(token)).toBeUndefined();
    expect(registry.resolve(token)).toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('preserves token value types and rejects non-symbol keys', () => {
    const token = createRegistryToken<number>('typed');
    const registry = new Registry();
    registry.register(token, () => 1);

    expectTypeOf(registry.resolve(token)).toEqualTypeOf<number>();
    expectTypeOf(token).toEqualTypeOf<RegistryToken<number>>();
    expectTypeOf(token).toMatchTypeOf<symbol>();

    const compileTimeAssertions = (): void => {
      // @ts-expect-error The token fixes the factory result type before registration.
      registry.register(token, () => 'invalid');
      // @ts-expect-error Registries accept typed symbol tokens, not strings.
      registry.register('typed', () => 1);
      // @ts-expect-error Registries resolve typed symbol tokens, not strings.
      registry.resolve('typed');
    };
    expectTypeOf(compileTimeAssertions).toEqualTypeOf<() => void>();
  });
});
