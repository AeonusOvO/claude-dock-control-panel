declare const registryTokenBrand: unique symbol;

export type RegistryToken<Value> = symbol & {
  readonly [registryTokenBrand]: Value;
};

export type RegistryFactory<Value> = (registry: Registry) => Value;

export const createRegistryToken = <Value>(description: string): RegistryToken<Value> =>
  Symbol(description) as RegistryToken<Value>;

const tokenDescription = (token: RegistryToken<unknown>): string =>
  token.description ?? '<anonymous>';

export class Registry {
  readonly #factories = new Map<RegistryToken<unknown>, RegistryFactory<unknown>>();
  readonly #instances = new Map<RegistryToken<unknown>, unknown>();
  readonly #resolutionStack: RegistryToken<unknown>[] = [];

  public register<Value>(
    token: RegistryToken<Value>,
    factory: RegistryFactory<NoInfer<Value>>,
  ): void {
    const registryToken = token as RegistryToken<unknown>;
    if (this.#factories.has(registryToken)) {
      throw new Error(`Registry token already registered: ${tokenDescription(registryToken)}`);
    }
    this.#factories.set(registryToken, factory as RegistryFactory<unknown>);
  }

  public resolve<Value>(token: RegistryToken<Value>): Value {
    const registryToken = token as RegistryToken<unknown>;
    if (this.#instances.has(registryToken)) {
      return this.#instances.get(registryToken) as Value;
    }

    const factory = this.#factories.get(registryToken);
    if (!factory) {
      throw new Error(`Registry token is not registered: ${tokenDescription(registryToken)}`);
    }

    const cycleStart = this.#resolutionStack.indexOf(registryToken);
    if (cycleStart >= 0) {
      const chain = [...this.#resolutionStack.slice(cycleStart), registryToken]
        .map(tokenDescription)
        .join(' -> ');
      throw new Error(`Circular registry dependency: ${chain}`);
    }

    this.#resolutionStack.push(registryToken);
    try {
      const instance = factory(this);
      this.#instances.set(registryToken, instance);
      return instance as Value;
    } finally {
      this.#resolutionStack.pop();
    }
  }
}
