import { ConfigurationError } from "../errors.js";
import { Provider, type ProviderOptions } from "./base.js";
import { OpenRouterProvider } from "./open-router.js";
import { TypesafeProvider } from "./typesafe.js";

export { Provider, type ProviderOptions } from "./base.js";
export { OpenRouterProvider } from "./open-router.js";
export { TypesafeProvider } from "./typesafe.js";

/** Provider names accepted by `new Client({ provider })`. */
export type ProviderName = "open-router" | "open_router" | "openrouter" | "typesafe";

const REGISTRY: Readonly<Record<string, new (options?: ProviderOptions) => Provider>> =
  Object.freeze({
    "open-router": OpenRouterProvider,
    typesafe: TypesafeProvider,
  });

function normalizeName(name: string): string {
  const compact = name.toLowerCase().replace(/[_-]/g, "");
  return compact === "openrouter" ? "open-router" : name.toLowerCase();
}

export function providerNames(): string[] {
  return Object.keys(REGISTRY);
}

export function buildProvider(name: string, options: ProviderOptions = {}): Provider {
  const ProviderClass = REGISTRY[normalizeName(name)];
  if (ProviderClass === undefined) {
    throw new ConfigurationError(
      `unknown provider ${JSON.stringify(name)}; known providers: ${providerNames().join(", ")}`
    );
  }
  return new ProviderClass(options);
}

// Order in which environment variables are consulted when no provider or
// apiKey is given. Typesafe wins when both keys are set.
const ENV_PRIORITY = [TypesafeProvider, OpenRouterProvider] as const;

/** Picks a provider from the environment, or null when no key is set. */
export function providerFromEnv(): Provider | null {
  for (const ProviderClass of ENV_PRIORITY) {
    const provider = new ProviderClass();
    if (provider.hasApiKey()) return provider;
  }
  return null;
}

export function providerEnvVars(): string[] {
  return ENV_PRIORITY.map((ProviderClass) => new ProviderClass().envVar);
}
