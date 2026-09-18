import { VERSION } from "../version.js";
import type { Questions, Usage } from "../types.js";

export interface ProviderOptions {
  apiKey?: string | null | undefined;
  baseUrl?: string | null | undefined;
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function parseFloatOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * A provider owns everything that differs between decision-model APIs: where
 * requests go, how they are authenticated, which model is the default, which
 * model names are aliases, and how usage is read back. Client keeps the
 * public API and delegates these questions here.
 */
export abstract class Provider {
  // Null means "not given": the provider's environment variable is consulted
  // instead. Read lazily because abstract getters are not available in the
  // base constructor.
  private providerApiKey: string | null;
  private providerBaseUrl: string | null;

  constructor(options: ProviderOptions = {}) {
    this.providerApiKey = options.apiKey ?? null;
    this.providerBaseUrl = options.baseUrl ?? null;
  }

  /** Identifier used in error messages and by `client.provider`. */
  abstract get name(): string;
  abstract get envVar(): string;
  abstract get defaultBaseUrl(): string;
  abstract get endpointPath(): string;
  abstract get defaultModel(): string;

  /** Map of alias to canonical model name for this provider. */
  get aliases(): Readonly<Record<string, string>> {
    return {};
  }

  /** Whether this provider reports a per-request cost in usage. */
  get reportsCost(): boolean {
    return false;
  }

  get apiKey(): string | null {
    return this.providerApiKey ?? process.env[this.envVar] ?? null;
  }

  get baseUrl(): string {
    return (this.providerBaseUrl ?? this.defaultBaseUrl).replace(/\/$/, "");
  }

  get url(): string {
    return `${this.baseUrl}${this.endpointPath}`;
  }

  hasApiKey(): boolean {
    const key = this.apiKey;
    return key !== null && key.trim() !== "";
  }

  /**
   * Null or blank means the provider default. Known aliases resolve to the
   * provider's canonical name. Anything else passes through untouched.
   */
  resolveModel(model: string | null | undefined): string {
    if (model == null || model.trim() === "") return this.defaultModel;
    return this.aliases[model] ?? model;
  }

  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `node-decision-model/${VERSION}`,
    };
  }

  requestBody(args: { model: string; state: unknown; questions: Questions }): string {
    return JSON.stringify({ model: args.model, state: args.state, questions: args.questions });
  }

  usage(parsed: unknown): Usage {
    const raw =
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as any).usage === "object" &&
      (parsed as any).usage !== null
        ? (parsed as any).usage
        : {};

    return {
      inputTokens: parseInteger(raw.input_tokens),
      outputTokens: parseInteger(raw.output_tokens),
      cost: this.reportsCost ? parseFloatOrNull(raw.cost) : null,
    };
  }

  /**
   * Returns a copy with non-null overrides applied, leaving this instance
   * untouched — a caller may share one provider between clients.
   */
  configure(options: ProviderOptions): this {
    const copy: this = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    if (options.apiKey != null) copy.providerApiKey = options.apiKey;
    if (options.baseUrl != null) copy.providerBaseUrl = options.baseUrl;
    return copy;
  }

  /** Keeps the API key out of logs and error output. */
  toString(): string {
    return `${this.constructor.name}(name=${this.name} baseUrl=${this.baseUrl} apiKey=${
      this.hasApiKey() ? "[REDACTED]" : "null"
    })`;
  }
}
