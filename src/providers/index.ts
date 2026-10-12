import { ConfigurationError } from "../errors.js";
import { Provider, type ProviderOptions } from "./base.js";
import { CelerisProvider } from "./celeris.js";
import { CloudflareProvider } from "./cloudflare.js";
import { OpenRouterProvider } from "./open-router.js";
import { TypesafeProvider } from "./typesafe.js";

export {
  Provider,
  presentExtensions,
  type ProviderOptions,
  type RequestBodyArgs,
  type RequestExtensions,
} from "./base.js";
export {
  CelerisProvider,
  CELERIS_DEFAULT_MAX_SOFT_TOKENS,
  CELERIS_MAX_EXPLAINED_QUESTIONS,
  CELERIS_MAX_QUESTIONS,
  CELERIS_MAX_SOFT_TOKENS,
  type CelerisWireExtensions,
} from "./celeris.js";
export { CloudflareProvider, type CloudflareProviderOptions } from "./cloudflare.js";
export { OpenRouterProvider } from "./open-router.js";
export { TypesafeProvider } from "./typesafe.js";

/** Provider names accepted by `new Client({ provider })`. */
export type ProviderName =
  | "open-router"
  | "open_router"
  | "openrouter"
  | "typesafe"
  | "cloudflare"
  | "celeris";

const REGISTRY: Readonly<Record<string, new (options?: ProviderOptions) => Provider>> =
  Object.freeze({
    "open-router": OpenRouterProvider,
    typesafe: TypesafeProvider,
    cloudflare: CloudflareProvider,
    celeris: CelerisProvider,
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
// apiKey is given. Typesafe wins over OpenRouter, then Cloudflare, and Celeris
// comes last: it is picked only when its key is the only one set.
const ENV_PRIORITY = [TypesafeProvider, OpenRouterProvider, CloudflareProvider, CelerisProvider] as const;

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
