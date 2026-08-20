import type { Registry, RegistryToken } from '../../src/main/infra/registry';

export const createTestMainServiceRegistry = async (): Promise<Registry> => {
  const [{ Registry }, { registerLifecycleServiceReferences }] = await Promise.all([
    import('../../src/main/infra/registry'),
    import('../../src/main/infra/service-tokens'),
  ]);
  const services = new Registry();
  registerLifecycleServiceReferences(services);
  return services;
};

export const registerTestService = <Value>(
  services: Registry,
  token: RegistryToken<Value>,
  value: NoInfer<Value>,
): Value => {
  services.register(token, () => value);
  return value;
};
