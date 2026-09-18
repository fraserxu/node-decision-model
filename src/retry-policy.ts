import { ConfigurationError } from "./errors.js";

const DEFAULT_STATUSES: readonly number[] = Object.freeze([
  408,
  429,
  ...Array.from({ length: 100 }, (_, i) => 500 + i),
]);

export interface RetryPolicyOptions {
  /** Retries after the initial attempt. */
  maxRetries?: number;
  /** First backoff in milliseconds, doubling each retry. */
  backoffInitial?: number;
  /** Backoff ceiling in milliseconds. */
  backoffMax?: number;
  /** Fraction of the backoff randomly subtracted, 0..1. */
  backoffJitter?: number;
  /** Statuses that trigger a retry. */
  httpStatuses?: readonly number[];
  /** Honor `Retry-After` and `retry-after-ms`. */
  respectRetryAfter?: boolean;
  /** Ceiling in milliseconds for a server-supplied delay. */
  maxRetryAfter?: number;
  /** Retry socket and connection failures. */
  retryConnectionErrors?: boolean;
  /** Retry open and read timeouts. */
  retryTimeouts?: boolean;
  /** Budget in milliseconds across attempts and delays; `null` disables. */
  totalTimeout?: number | null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function headerValue(headers: Record<string, unknown>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const single = Array.isArray(value) ? value[0] : value;
    return single == null ? null : String(single);
  }
  return null;
}

function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const TIMEOUT_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
]);

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Retry rules shared by every provider. Defaults follow the official Typesafe
 * SDKs: two retries after the initial attempt, exponential backoff from 500ms
 * capped at 5s with up to 25% jitter subtracted, Retry-After honored up to
 * 60s, and a 30s total budget across attempts. All durations are in
 * milliseconds.
 */
export class RetryPolicy {
  static readonly DEFAULT_STATUSES = DEFAULT_STATUSES;

  readonly maxRetries: number;
  readonly backoffInitial: number;
  readonly backoffMax: number;
  readonly backoffJitter: number;
  readonly httpStatuses: readonly number[];
  readonly respectRetryAfter: boolean;
  readonly maxRetryAfter: number;
  readonly retryConnectionErrors: boolean;
  readonly retryTimeouts: boolean;
  readonly totalTimeout: number | null;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 2;
    this.backoffInitial = options.backoffInitial ?? 500;
    this.backoffMax = options.backoffMax ?? 5_000;
    this.backoffJitter = options.backoffJitter ?? 0.25;
    this.httpStatuses = options.httpStatuses ?? DEFAULT_STATUSES;
    this.respectRetryAfter = options.respectRetryAfter ?? true;
    this.maxRetryAfter = options.maxRetryAfter ?? 60_000;
    this.retryConnectionErrors = options.retryConnectionErrors ?? true;
    this.retryTimeouts = options.retryTimeouts ?? true;
    this.totalTimeout = options.totalTimeout === undefined ? 30_000 : options.totalTimeout;
    this.validate();
  }

  /** Accepts a RetryPolicy, an options object, or undefined (defaults). */
  static from(value: RetryPolicy | RetryPolicyOptions | undefined | null): RetryPolicy {
    if (value instanceof RetryPolicy) return value;
    if (value == null) return new RetryPolicy();
    if (typeof value === "object") return new RetryPolicy(value);
    throw new ConfigurationError(
      `retry must be a RetryPolicy or an options object, got ${typeof value}`
    );
  }

  retryableStatus(status: number): boolean {
    return this.httpStatuses.includes(status);
  }

  isTimeoutError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (TIMEOUT_ERROR_NAMES.has(error.name) ||
        errorCode(error) === "UND_ERR_CONNECT_TIMEOUT" ||
        errorCode(error.cause) === "UND_ERR_CONNECT_TIMEOUT")
    );
  }

  isConnectionError(error: unknown): boolean {
    if (this.isTimeoutError(error)) return false;
    if (!(error instanceof Error)) return false;
    const code = errorCode(error) ?? errorCode(error.cause);
    if (code !== null && CONNECTION_ERROR_CODES.has(code)) return true;
    // Node's fetch wraps every network failure in a TypeError ("fetch failed").
    return error instanceof TypeError;
  }

  retryableError(error: unknown): boolean {
    if (this.isTimeoutError(error)) return this.retryTimeouts;
    if (this.isConnectionError(error)) return this.retryConnectionErrors;
    return false;
  }

  /**
   * Milliseconds to wait before the retry numbered `retryNumber` (0 for the
   * first retry). `random` returns a number in [0, 1) and exists so tests can
   * pin the jitter.
   */
  backoff(retryNumber: number, random: () => number = Math.random): number {
    const base = Math.min(this.backoffInitial * 2 ** retryNumber, this.backoffMax);
    return Math.max(base * (1.0 - this.backoffJitter * random()), 0);
  }

  /**
   * Delay before the next retry: the server's Retry-After when present and
   * honored (clamped to maxRetryAfter), otherwise the computed backoff.
   */
  delay(
    retryNumber: number,
    { headers = {}, random = Math.random }: { headers?: Record<string, string>; random?: () => number } = {}
  ): number {
    const hinted = this.respectRetryAfter ? this.retryAfterMs(headers) : null;
    if (hinted !== null) return Math.min(hinted, this.maxRetryAfter);
    return this.backoff(retryNumber, random);
  }

  /**
   * Reads `retry-after-ms` (preferred) or `Retry-After` (seconds or HTTP
   * date). Header names match case-insensitively. Returns null when absent or
   * unparseable.
   */
  retryAfterMs(headers: Record<string, string>): number | null {
    if (headers === null || typeof headers !== "object") return null;

    const ms = headerValue(headers, "retry-after-ms");
    if (ms !== null) {
      const parsed = parseNumber(ms);
      if (parsed !== null && parsed >= 0) return parsed;
    }

    const raw = headerValue(headers, "retry-after");
    if (raw === null) return null;

    // A numeric value is seconds; a negative one is ignored rather than handed
    // to Date.parse, which would leniently read "-5" as a date.
    const seconds = parseNumber(raw);
    if (seconds !== null) return seconds >= 0 ? seconds * 1000 : null;

    const date = Date.parse(raw);
    if (Number.isNaN(date)) return null;
    return Math.max(date - Date.now(), 0);
  }

  private validate(): void {
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new ConfigurationError(
        `maxRetries must be a non-negative integer, got ${JSON.stringify(this.maxRetries)}`
      );
    }
    for (const [name, value] of Object.entries({
      backoffInitial: this.backoffInitial,
      backoffMax: this.backoffMax,
      maxRetryAfter: this.maxRetryAfter,
    })) {
      if (!isFiniteNonNegative(value)) {
        throw new ConfigurationError(
          `${name} must be a finite non-negative number, got ${JSON.stringify(value)}`
        );
      }
    }
    if (!isFiniteNonNegative(this.backoffJitter) || this.backoffJitter > 1.0) {
      throw new ConfigurationError(
        `backoffJitter must be a number between 0 and 1, got ${JSON.stringify(this.backoffJitter)}`
      );
    }
    if (this.totalTimeout !== null && !isFiniteNonNegative(this.totalTimeout)) {
      throw new ConfigurationError(
        `totalTimeout must be null or a finite non-negative number, got ${JSON.stringify(this.totalTimeout)}`
      );
    }
    if (!Array.isArray(this.httpStatuses)) {
      throw new ConfigurationError(
        `httpStatuses must be an array of statuses, got ${JSON.stringify(this.httpStatuses)}`
      );
    }
  }
}
