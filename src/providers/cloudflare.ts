import { InvalidResponse } from "../errors.js";
import { Provider, type ProviderOptions } from "./base.js";

export interface CloudflareProviderOptions extends ProviderOptions {
  /** Overrides CLOUDFLARE_ACCOUNT_ID. */
  accountId?: string | null | undefined;
}

const ACCOUNT_ID_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID";

// The Workers AI model ids map to the selector the request body carries:
// "clef" runs @cf/cloudflare/clef and "clef-flash" runs @cf/cloudflare/clef-flash.
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "@cf/cloudflare/clef": "clef",
  "@cf/cloudflare/clef-flash": "clef-flash",
});

function messagesFrom(errors: unknown): string {
  if (!Array.isArray(errors)) return "";
  const messages = errors
    .map((error) =>
      error !== null && typeof error === "object" && typeof error.message === "string"
        ? (error.message as string)
        : null
    )
    .filter((message): message is string => message !== null);
  return messages.length === 0 ? "" : `: ${messages.join("; ")}`;
}

/**
 * Cloudflare's Clef decision models on Workers AI. The request body is the
 * Jev wire format; each model has its own URL under the account, and the REST
 * API wraps the decision in a `{ success, result, errors }` envelope.
 */
export class CloudflareProvider extends Provider {
  private providerAccountId: string | null;

  constructor(options: CloudflareProviderOptions = {}) {
    super(options);
    this.providerAccountId = options.accountId ?? null;
  }

  override get name(): string {
    return "cloudflare";
  }

  override get envVar(): string {
    return "CLOUDFLARE_AUTH_TOKEN";
  }

  get accountIdEnvVar(): string {
    return ACCOUNT_ID_ENV_VAR;
  }

  get accountId(): string | null {
    const id = this.providerAccountId ?? process.env[ACCOUNT_ID_ENV_VAR] ?? null;
    return id === null || id.trim() === "" ? null : id.trim();
  }

  override get defaultBaseUrl(): string {
    // The placeholder only shows up in listings; missingConfiguration() stops
    // a request from being sent to it.
    const account = this.accountId ?? `{${ACCOUNT_ID_ENV_VAR}}`;
    return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`;
  }

  override get endpointPath(): string {
    return this.modelPath(this.defaultModel);
  }

  override get defaultModel(): string {
    return "clef";
  }

  override get aliases(): Readonly<Record<string, string>> {
    return ALIASES;
  }

  override get requestIdHeader(): string {
    return "cf-ray";
  }

  override urlFor(model: string): string {
    return `${this.baseUrl}${this.modelPath(model)}`;
  }

  override missingConfiguration(): string | null {
    if (this.accountId !== null || this.providerBaseUrl !== null) return null;
    return `accountId is required for cloudflare: pass accountId or set ${ACCOUNT_ID_ENV_VAR}`;
  }

  override unwrap(parsed: Record<string, unknown>): unknown {
    if (typeof parsed.success !== "boolean" || !("result" in parsed)) return parsed;
    if (!parsed.success) {
      throw new InvalidResponse(`cloudflare reported failure${messagesFrom(parsed.errors)}`);
    }
    return parsed.result;
  }

  override configure(options: CloudflareProviderOptions): this {
    const copy = super.configure(options);
    if (options.accountId != null) copy.providerAccountId = options.accountId;
    return copy;
  }

  private modelPath(model: string): string {
    return `/@cf/cloudflare/${model}`;
  }
}
