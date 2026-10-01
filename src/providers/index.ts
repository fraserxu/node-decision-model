import { ConfigurationError } from "../errors.js";
import { Provider, type ProviderOptions } from "./base.js";
import { CloudflareProvider } from "./cloudflare.js";
import { OpenRouterProvider } from "./open-router.js";
import { TypesafeProvider } from "./typesafe.js";

export { Provider, type ProviderOptions } from "./base.js";
export { CloudflareProvider, type CloudflareProviderOptions } from "./cloudflare.js";
export { OpenRouterProvider } from "./open-router.js";
export { TypesafeProvider } from "./typesafe.js";

/** Provider names accepted by `new Client({ provider })`. */
export type ProviderName = "open-router" | "open_router" | "openrouter" | "typesafe" | "cloudflare";

const REGISTRY: Readonly<Record<string, new (options?: ProviderOptions) => Provider>> =
  Object.freeze({
    "open-router": OpenRouterProvider,
    typesafe: TypesafeProvider,
    cloudflare: CloudflareProvider,
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
// apiKey is given. Typesafe wins over OpenRouter, and Cloudflare comes last.
const ENV_PRIORITY = [TypesafeProvider, OpenRouterProvider, CloudflareProvider] as const;

/**
 * Picks a provider from the environment, or null when none is fully
 * configured. Cloudflare needs CLOUDFLARE_ACCOUNT_ID as well as its token.
 */
export function providerFromEnv(): Provider | null {
  for (const ProviderClass of ENV_PRIORITY) {
    const provider = new ProviderClass();
    if (provider.hasApiKey() && provider.missingConfiguration() === null) return provider;
  }
  return null;
}

export function providerEnvVars(): string[] {
  return ENV_PRIORITY.map((ProviderClass) => new ProviderClass().envVar);
}
