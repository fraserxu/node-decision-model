import { RequestError } from "../errors.js";
import { assertCelerisBodySize, encodeCelerisImages } from "../images.js";
import { Provider, type RequestBodyArgs } from "./base.js";

/** Documented Celeris request limits. */
export const CELERIS_MAX_QUESTIONS = 512;
/** With `explain`, the model writes a sentence per answer, so fewer fit. */
export const CELERIS_MAX_EXPLAINED_QUESTIONS = 64;
/**
 * The values `max_soft_tokens` accepts: the resolution every image in the
 * request is read at, costing roughly that many input tokens per image. 280
 * is what the model uses when it is not set; lower suits classification,
 * higher small text and OCR. It has no effect on a request without images.
 */
export const CELERIS_MAX_SOFT_TOKENS: readonly number[] = Object.freeze([70, 140, 280, 560, 1120]);
export const CELERIS_DEFAULT_MAX_SOFT_TOKENS = 280;

const DEFAULT_MODEL = "celeris-1-decision";

/** The `x_celeris` object on the wire. Absent from the body when every field is unset. */
export interface CelerisWireExtensions {
  explain?: true;
  images?: Record<string, string>;
  max_soft_tokens?: number;
}

/**
 * The OpenAI-style envelope Celeris returns on a non-2xx status. `ref` is a
 * short reference Celeris may add for support, for example `q-d3`.
 */
interface CelerisErrorEnvelope {
  message: string | null;
  type: string | null;
  code: string | null;
  ref: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseErrorEnvelope(body: string | null): CelerisErrorEnvelope | null {
  if (body === null || body.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const error = (parsed as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const envelope = {
    message: stringOrNull(record.message),
    type: stringOrNull(record.type),
    code: stringOrNull(record.code),
    ref: stringOrNull(record.ref),
  };
  return Object.values(envelope).every((field) => field === null) ? null : envelope;
}

/**
 * Celeris's decision model, celeris-1-decision, behind the System One wire
 * format Typesafe uses: the same body, answers, and usage. Celeris adds an
 * `x_celeris` object for what System One has no field for: `explain` for a
 * sentence of reasoning per answer, `images` as a map of names to data URLs,
 * and `max_soft_tokens` for the resolution images are read at. The model is a
 * segment of the URL as well as the body's `model`, so `urlFor` keeps the two
 * together. Errors come in an OpenAI-style
 * `{ error: { message, type, code, ref? } }` envelope.
 */
export class CelerisProvider extends Provider {
  override get name(): string {
    return "celeris";
  }

  override get envVar(): string {
    return "CELERIS_API_KEY";
  }

  override get defaultBaseUrl(): string {
    return "https://inference.celeris.ai";
  }

  override get endpointPath(): string {
    return this.modelPath(this.defaultModel);
  }

  override get defaultModel(): string {
    return DEFAULT_MODEL;
  }

  override get requestIdHeader(): string {
    return "x-request-id";
  }

  override urlFor(model: string): string {
    return `${this.baseUrl}${this.modelPath(model)}`;
  }

  /**
   * The System One body plus `x_celeris`, which is present only when at
   * least one of its fields is set, so a plain request is byte-for-byte the
   * Typesafe one. Audio and video are refused: the model sees text and
   * images only.
   */
  override requestBody(args: RequestBodyArgs): string {
    const images = args.images ?? [];
    const audio = args.audio ?? [];
    const videos = args.videos ?? [];

    const refused = audio.length > 0 ? "audio is" : videos.length > 0 ? "videos are" : null;
    if (refused !== null) {
      throw new RequestError(
        `${refused} not accepted by the celeris provider; ${args.model} takes text and images only`
      );
    }

    const count = Object.keys(args.questions).length;
    if (args.explain === true && count > CELERIS_MAX_EXPLAINED_QUESTIONS) {
      throw new RequestError(
        `celeris answers at most ${CELERIS_MAX_EXPLAINED_QUESTIONS} questions per request with explain, got ${count}`
      );
    }
    if (count > CELERIS_MAX_QUESTIONS) {
      throw new RequestError(`celeris answers at most ${CELERIS_MAX_QUESTIONS} questions per request, got ${count}`);
    }
    if (args.maxSoftTokens !== undefined && !CELERIS_MAX_SOFT_TOKENS.includes(args.maxSoftTokens)) {
      throw new RequestError(
        `maxSoftTokens must be one of ${CELERIS_MAX_SOFT_TOKENS.join(", ")} for celeris, got ${JSON.stringify(args.maxSoftTokens)}`
      );
    }

    const extensions: CelerisWireExtensions = {};
    if (args.explain === true) extensions.explain = true;
    if (images.length > 0) extensions.images = encodeCelerisImages(images);
    if (args.maxSoftTokens !== undefined) extensions.max_soft_tokens = args.maxSoftTokens;

    const payload: Record<string, unknown> = {
      model: args.model,
      state: args.state,
      questions: args.questions,
    };
    if (Object.keys(extensions).length > 0) payload.x_celeris = extensions;

    const body = JSON.stringify(payload);
    assertCelerisBodySize(body);
    return body;
  }

  /**
   * `message (code X, ref Y)` from the error envelope, whichever parts the
   * body has: the code (or the type when there is no code) and the `ref`
   * Celeris attaches for support go in the parentheses.
   */
  override errorDetail(status: number, body: string | null): string | null {
    const envelope = parseErrorEnvelope(body);
    if (envelope === null) return null;
    const label = envelope.code ?? envelope.type;
    const parts: string[] = [];
    if (label !== null) parts.push(`code ${label}`);
    if (envelope.ref !== null) parts.push(`ref ${envelope.ref}`);
    const suffix = parts.length === 0 ? null : parts.join(", ");
    if (envelope.message === null) return suffix;
    return suffix === null ? envelope.message : `${envelope.message} (${suffix})`;
  }

  /** `x_celeris.explanations`, keeping only the entries that are strings. */
  override explanations(parsed: unknown): Record<string, string> {
    if (parsed === null || typeof parsed !== "object") return {};
    const extensions = (parsed as { x_celeris?: unknown }).x_celeris;
    if (extensions === null || typeof extensions !== "object") return {};
    const raw = (extensions as { explanations?: unknown }).explanations;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};

    const explanations: Record<string, string> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") explanations[id] = value;
    }
    return explanations;
  }

  private modelPath(model: string): string {
    return `/${model}/v1/systemone`;
  }
}
