import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  buildProvider,
  CELERIS_MAX_EXPLAINED_QUESTIONS,
  CELERIS_MAX_IMAGES,
  CELERIS_MAX_QUESTIONS,
  CELERIS_MAX_SOFT_TOKENS,
  CelerisProvider,
  choice,
  Client,
  CloudflareProvider,
  noul,
  OpenRouterProvider,
  providerEnvVars,
  providerFromEnv,
  providerNames,
  RateLimited,
  RequestError,
  TypesafeProvider,
  Unauthorized,
  UnprocessableEntity,
  VERSION,
} from "../src/index.js";
import type { ClientOptions, Questions } from "../src/index.js";
import { CELERIS_MAX_BODY_BYTES, CELERIS_MAX_PIXELS, celerisImageName } from "../src/images.js";
import { run, type CliIo } from "../src/cli/run.js";
import { FakeSleeper, FakeTransport, withEnv } from "./helpers.js";

const BASE = "https://inference.celeris.ai";
const URL = `${BASE}/celeris-1-decision/v1/systemone`;

// Every test starts from a clean slate so a developer's real credentials
// never pick a provider or leak into a request.
const NO_ENV = {
  TYPESAFE_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  CLOUDFLARE_AUTH_TOKEN: undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined,
  CELERIS_API_KEY: undefined,
};

const questions = {
  urgent: noul("Is this urgent?"),
  team: choice("Which team?", { billing: null, auth: null }),
};

const decision = {
  model: "celeris-1-decision",
  answers: {
    urgent: { type: "noul", noul: 0.91 },
    team: { type: "choice", choice: "auth", confidence: 0.8, probabilities: { billing: 0.2, auth: 0.8 } },
  },
  usage: { input_tokens: 210, output_tokens: 14 },
};

const explanations = {
  urgent: "Checkout is down for every customer.",
  team: "The failure is in session validation.",
};

const explained = { ...decision, x_celeris: { explanations } };

const envelope = (code: string, message: string, type = "invalid_request_error", ref?: string) =>
  JSON.stringify({ error: ref === undefined ? { message, type, code } : { message, type, code, ref } });

function celerisClient(transport: FakeTransport, options: Record<string, unknown> = {}) {
  return new Client({ provider: "celeris", apiKey: "ck_test", transport: transport.call, ...options });
}

function provider(): CelerisProvider {
  return new CelerisProvider({ apiKey: "ck_test" });
}

function bodyOf(args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    provider().requestBody({ model: "celeris-1-decision", state: "x", questions, ...args })
  ) as Record<string, unknown>;
}

function requestError(args: Record<string, unknown>): string {
  try {
    bodyOf(args);
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    return (error as Error).message;
  }
  throw new Error("expected RequestError");
}

function manyQuestions(count: number): Questions {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, noul(`Question ${i}?`)]));
}

// --- image fixtures: the smallest headers the sniffer and size readers need ---

function png(width = 1, height = 1): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from("IHDR"),
    ihdr,
    Buffer.alloc(4),
  ]);
}

function jpeg(width = 1, height = 1): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
}

function webp(): Buffer {
  const payload = Buffer.alloc(10);
  const chunk = Buffer.concat([Buffer.from("VP8X"), Buffer.from([payload.length, 0, 0, 0]), payload]);
  const size = 4 + chunk.length;
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from([size & 0xff, 0, 0, 0]), Buffer.from("WEBP"), chunk]);
}

const dataUrl = (bytes: Buffer, type = "image/png") => `data:${type};base64,${bytes.toString("base64")}`;

function imageFile(dir: string, name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("CelerisProvider", () => {
  it("describes the Celeris System One endpoint", () => {
    const celeris = provider();
    expect(celeris.name).toBe("celeris");
    expect(celeris.envVar).toBe("CELERIS_API_KEY");
    expect(celeris.defaultModel).toBe("celeris-1-decision");
    expect(celeris.baseUrl).toBe(BASE);
    expect(celeris.url).toBe(URL);
    expect(celeris.reportsCost).toBe(false);
    expect(celeris.requestIdHeader).toBe("x-request-id");
    expect(celeris.aliases).toEqual({});
  });

  it("keeps the model segment of the URL in step with the body model", () => {
    const celeris = provider();
    expect(celeris.resolveModel(undefined)).toBe("celeris-1-decision");
    expect(celeris.resolveModel("")).toBe("celeris-1-decision");
    expect(celeris.resolveModel("celeris-2-decision")).toBe("celeris-2-decision");
    expect(celeris.urlFor("celeris-1-decision")).toBe(URL);
    expect(celeris.urlFor("celeris-2-decision")).toBe(`${BASE}/celeris-2-decision/v1/systemone`);
  });

  it("applies a base URL override under the model path", () => {
    expect(new CelerisProvider({ apiKey: "k", baseUrl: "https://proxy.example/" }).url).toBe(
      "https://proxy.example/celeris-1-decision/v1/systemone"
    );
    expect(provider().configure({ baseUrl: "https://gateway.example" }).urlFor("celeris-1-decision")).toBe(
      "https://gateway.example/celeris-1-decision/v1/systemone"
    );
  });

  it("sends a bearer key with the shared headers", () => {
    const headers = provider().headers();
    expect(headers.Authorization).toBe("Bearer ck_test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(headers["User-Agent"]).toBe(`node-decision-model/${VERSION}`);
  });

  it("is registered by name, last", () => {
    expect(buildProvider("celeris", { apiKey: "k" })).toBeInstanceOf(CelerisProvider);
    expect(buildProvider("CELERIS", { apiKey: "k" })).toBeInstanceOf(CelerisProvider);
    expect(providerNames()).toEqual(["open-router", "typesafe", "cloudflare", "celeris"]);
    expect(providerEnvVars()).toEqual([
      "TYPESAFE_API_KEY",
      "OPENROUTER_API_KEY",
      "CLOUDFLARE_AUTH_TOKEN",
      "CELERIS_API_KEY",
    ]);
  });

  it("reads usage like System One and never reports cost", () => {
    expect(provider().usage({ usage: { input_tokens: 210, output_tokens: 14, cost: 0.1 } })).toEqual({
      inputTokens: 210,
      outputTokens: 14,
      cost: null,
    });
  });
});

describe("Celeris environment selection", () => {
  it("is picked only when CELERIS_API_KEY is the only credential", async () => {
    await withEnv({ ...NO_ENV, CELERIS_API_KEY: "ck_env" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(CelerisProvider);
      const client = new Client();
      expect(client.provider).toBeInstanceOf(CelerisProvider);
      expect(client.model).toBe("celeris-1-decision");
      expect(client.provider.apiKey).toBe("ck_env");
    });
  });

  it("loses to Typesafe, OpenRouter, and a complete Cloudflare", async () => {
    const celeris = { CELERIS_API_KEY: "ck_env" };
    await withEnv({ ...NO_ENV, ...celeris, TYPESAFE_API_KEY: "t" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(TypesafeProvider);
    });
    await withEnv({ ...NO_ENV, ...celeris, OPENROUTER_API_KEY: "o" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(OpenRouterProvider);
    });
    await withEnv({ ...NO_ENV, ...celeris, CLOUDFLARE_AUTH_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(CloudflareProvider);
    });
  });

  it("wins over a Cloudflare token without an account id", async () => {
    await withEnv({ ...NO_ENV, CELERIS_API_KEY: "ck_env", CLOUDFLARE_AUTH_TOKEN: "t" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(CelerisProvider);
    });
  });

  it("is named in the no-provider error and needs its key when named", async () => {
    await withEnv(NO_ENV, () => {
      expect(() => new Client()).toThrow(/CELERIS_API_KEY/);
      expect(() => new Client({ provider: "celeris" })).toThrow(/set CELERIS_API_KEY/);
      expect(() => new Client({ provider: "celeris", apiKey: "ck_1" })).not.toThrow();
    });
  });
});

describe("Celeris request body", () => {
  it("is the plain System One body with no x_celeris when nothing extra is asked", () => {
    const body = provider().requestBody({ model: "celeris-1-decision", state: "x", questions });
    expect(body).toBe(
      JSON.stringify({ model: "celeris-1-decision", state: "x", questions: JSON.parse(JSON.stringify(questions)) })
    );
    expect(provider().requestBody({ model: "celeris-1-decision", state: "x", questions, explain: false })).toBe(body);
  });

  it("sends explain, max_soft_tokens, and images inside x_celeris", () => {
    expect(bodyOf({ explain: true }).x_celeris).toEqual({ explain: true });
    expect(bodyOf({ maxSoftTokens: 560 }).x_celeris).toEqual({ max_soft_tokens: 560 });
    const bytes = png();
    expect(bodyOf({ explain: true, maxSoftTokens: 70, images: [bytes] }).x_celeris).toEqual({
      explain: true,
      images: { image1: dataUrl(bytes) },
      max_soft_tokens: 70,
    });
  });

  it("accepts every documented max_soft_tokens value and nothing else", () => {
    expect(CELERIS_MAX_SOFT_TOKENS).toEqual([70, 140, 280, 560, 1120]);
    for (const value of CELERIS_MAX_SOFT_TOKENS) {
      expect((bodyOf({ maxSoftTokens: value }).x_celeris as { max_soft_tokens: number }).max_soft_tokens).toBe(value);
    }
    for (const value of [0, 100, 279, 281, 2240, 70.5]) {
      expect(requestError({ maxSoftTokens: value })).toBe(
        `maxSoftTokens must be one of 70, 140, 280, 560, 1120 for celeris, got ${value}`
      );
    }
  });

  it("caps the questions at 512, or 64 with explain", () => {
    expect(CELERIS_MAX_QUESTIONS).toBe(512);
    expect(CELERIS_MAX_EXPLAINED_QUESTIONS).toBe(64);
    expect(Object.keys(bodyOf({ questions: manyQuestions(512) }).questions as object)).toHaveLength(512);
    expect(requestError({ questions: manyQuestions(513) })).toBe(
      "celeris answers at most 512 questions per request, got 513"
    );
    expect(bodyOf({ questions: manyQuestions(64), explain: true }).x_celeris).toEqual({ explain: true });
    expect(requestError({ questions: manyQuestions(65), explain: true })).toBe(
      "celeris answers at most 64 questions per request with explain, got 65"
    );
    // 65 is fine when nobody asked for a reason.
    expect(Object.keys(bodyOf({ questions: manyQuestions(65) }).questions as object)).toHaveLength(65);
  });

  it("rejects audio and video, naming the model", () => {
    expect(requestError({ audio: [Buffer.from("RIFF....WAVE")] })).toBe(
      "audio is not accepted by the celeris provider; celeris-1-decision takes text and images only"
    );
    expect(requestError({ videos: ["clip.mp4"] })).toBe(
      "videos are not accepted by the celeris provider; celeris-1-decision takes text and images only"
    );
  });

  it("rejects a body over 8 MiB", () => {
    expect(CELERIS_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
    expect(requestError({ state: "x".repeat(CELERIS_MAX_BODY_BYTES) })).toMatch(
      /^request body is \d+ bytes, over the celeris 8 MiB limit$/
    );
  });
});

describe("Celeris images", () => {
  it("names files by their stem and bytes or data URLs by position", () => {
    const dir = mkdtempSync(join(tmpdir(), "celeris-images-"));
    const photo = imageFile(dir, "photo.jpg", jpeg());
    const receipt = imageFile(dir, "Receipt 2024-05 (front).PNG", png());
    const images = bodyOf({ images: [photo, png(2, 2), receipt, dataUrl(jpeg(), "image/jpeg")] }).x_celeris as {
      images: Record<string, string>;
    };
    expect(Object.keys(images.images)).toEqual(["photo", "image2", "Receipt_2024_05_front", "image4"]);
    expect(images.images.photo).toBe(dataUrl(jpeg(), "image/jpeg"));
    expect(images.images.image2).toBe(dataUrl(png(2, 2)));
    expect(images.images.Receipt_2024_05_front).toBe(dataUrl(png()));
  });

  it("de-duplicates names with _2, _3 suffixes, including a clash with a positional name", () => {
    const dir = mkdtempSync(join(tmpdir(), "celeris-images-"));
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    const first = imageFile(join(dir, "a"), "photo.png", png());
    const second = imageFile(join(dir, "b"), "photo.png", png(2, 2));
    const third = imageFile(dir, "photo.jpg", jpeg());
    const image1 = imageFile(dir, "image1.png", png(3, 3));
    const images = bodyOf({ images: [first, second, third, png(), image1] }).x_celeris as {
      images: Record<string, string>;
    };
    expect(Object.keys(images.images)).toEqual(["photo", "photo_2", "photo_3", "image4", "image1"]);

    // The bytes come first here, so they take "image1" and the file is bumped.
    const clash = bodyOf({ images: [png(), image1] }).x_celeris as { images: Record<string, string> };
    expect(Object.keys(clash.images)).toEqual(["image1", "image1_2"]);
  });

  it("reduces a stem to letters, digits, and underscores", () => {
    expect(celerisImageName("/tmp/My Photo (2).jpg", 0)).toBe("My_Photo_2");
    expect(celerisImageName("/shots/receipt-front.final.png", 3)).toBe("receipt_front_final");
    expect(celerisImageName("/tmp/日本語.png", 1)).toBe("image2");
    expect(celerisImageName("/tmp/___.png", 0)).toBe("image1");
    expect(celerisImageName(null, 7)).toBe("image8");
    expect(celerisImageName(`/tmp/${"a".repeat(100)}.png`, 0)).toBe("a".repeat(64));
  });

  it("takes 8 images and refuses a ninth", () => {
    expect(CELERIS_MAX_IMAGES).toBe(8);
    const eight = Array.from({ length: 8 }, () => png());
    const images = bodyOf({ images: eight }).x_celeris as { images: Record<string, string> };
    expect(Object.keys(images.images)).toEqual(["image1", "image2", "image3", "image4", "image5", "image6", "image7", "image8"]);
    expect(requestError({ images: [...eight, png()] })).toBe("celeris accepts at most 8 images per request, got 9");
  });

  it("enforces 25 megapixels per image", () => {
    expect(CELERIS_MAX_PIXELS).toBe(25_000_000);
    expect(bodyOf({ images: [png(5000, 5000)] }).x_celeris).toHaveProperty("images");
    expect(bodyOf({ images: [jpeg(5000, 5000)] }).x_celeris).toHaveProperty("images");
    expect(requestError({ images: [png(5000, 5001)] })).toBe(
      "image 1 is 5000×5001 (25005000 pixels), over the celeris 25 megapixel limit"
    );
    expect(requestError({ images: [jpeg(5001, 5000)] })).toMatch(/25 megapixel limit/);
  });

  it("accepts PNG and JPEG only", () => {
    expect(requestError({ images: [webp()] })).toBe("image 1 must be a PNG or JPEG image");
    expect(requestError({ images: [Buffer.from("GIF89a")] })).toBe("image 1 must be a PNG or JPEG image");
    expect(requestError({ images: [dataUrl(webp(), "image/webp")] })).toMatch(/data URLs must be base64 PNG or JPEG/);
    expect(requestError({ images: ["https://example.com/a.png"] })).toBe(
      "image 1: remote URLs are not accepted; pass a local PNG or JPEG file"
    );
    expect(requestError({ images: ["/tmp/does-not-exist-celeris.png"] })).toMatch(/could not read file/);
  });

  it("counts the images toward the 8 MiB body", () => {
    const big = Buffer.concat([png(), Buffer.alloc(3 * 1024 * 1024)]);
    expect(bodyOf({ images: [big] }).x_celeris).toHaveProperty("images");
    // Two 3 MiB files are 8 MiB once base64 expands them.
    expect(requestError({ images: [big, big] })).toMatch(/over the celeris 8 MiB limit/);
  });
});

describe("Celeris-only options on other providers", () => {
  const args = { model: "m", state: "x", questions };

  it("are refused by every other provider before anything is built", () => {
    const providers = [
      new TypesafeProvider({ apiKey: "k" }),
      new OpenRouterProvider({ apiKey: "k" }),
      new CloudflareProvider({ apiKey: "k", accountId: "acct" }),
    ];
    for (const other of providers) {
      expect(() => other.requestBody({ ...args, explain: true })).toThrow(
        `explain is only supported by the celeris provider, not ${other.name}; pass provider "celeris" (--provider celeris)`
      );
      expect(() => other.requestBody({ ...args, maxSoftTokens: 280 })).toThrow(
        `maxSoftTokens is only supported by the celeris provider, not ${other.name}`
      );
      // explain: false is the default and never an error.
      expect(() => other.requestBody({ ...args, explain: false })).not.toThrow();
    }
  });

  it("are refused by the client without calling the transport", async () => {
    const transport = new FakeTransport([]);
    const typesafe = new Client({ provider: "typesafe", apiKey: "k", transport: transport.call });
    await expect(typesafe.ask({ state: "x", questions, explain: true })).rejects.toBeInstanceOf(RequestError);
    await expect(typesafe.ask({ state: "x", questions, maxSoftTokens: 560 })).rejects.toThrow(
      /maxSoftTokens is only supported by the celeris provider, not typesafe/
    );
    expect(transport.requests).toHaveLength(0);
  });
});

describe("Client with Celeris", () => {
  it("posts System One to the Celeris URL with a bearer key", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(decision), { "x-request-id": "req_c1" }]]);
    const response = await celerisClient(transport).ask({ state: { title: "x" }, questions });

    const [request] = transport.requests;
    expect(request!.url).toBe(URL);
    expect(request!.headers.Authorization).toBe("Bearer ck_test");
    expect(request!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(request!.body)).toEqual({
      model: "celeris-1-decision",
      state: { title: "x" },
      questions: JSON.parse(JSON.stringify(questions)),
    });
    expect(request!.body).not.toContain("x_celeris");

    expect(response.answers.urgent.noul).toBe(0.91);
    expect(response.answers.team.choice).toBe("auth");
    expect(response.model).toBe("celeris-1-decision");
    expect(response.usage).toEqual({ inputTokens: 210, outputTokens: 14, cost: null });
    expect(response.requestId).toBe("req_c1");
    expect(response.explanations).toEqual({});
    expect(response.answers.urgent).not.toHaveProperty("explanation");
  });

  it("asks for explanations and surfaces them on the response and each answer", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(explained)]]);
    const response = await celerisClient(transport).ask({ state: "x", questions, explain: true });

    expect(JSON.parse(transport.requests[0]!.body).x_celeris).toEqual({ explain: true });
    expect(response.explanations).toEqual(explanations);
    expect(response.answers.urgent.explanation).toBe(explanations.urgent);
    expect(response.answers.team.explanation).toBe(explanations.team);
    expect(response.answers.urgent).toEqual({
      type: "noul",
      noul: 0.91,
      probabilities: {},
      explanation: explanations.urgent,
    });
    expect(response.raw).toMatchObject({ x_celeris: { explanations } });
  });

  it("keeps only string explanations and tolerates their absence", async () => {
    const body = JSON.stringify({ ...decision, x_celeris: { explanations: { urgent: "Because.", team: 7 } } });
    const transport = new FakeTransport([[200, body], [200, JSON.stringify({ ...decision, x_celeris: "nope" })]]);
    const client = celerisClient(transport);
    const partial = await client.ask({ state: "x", questions, explain: true });
    expect(partial.explanations).toEqual({ urgent: "Because." });
    expect(partial.answers.team).not.toHaveProperty("explanation");
    const none = await client.ask({ state: "x", questions, explain: true });
    expect(none.explanations).toEqual({});
  });

  it("passes max_soft_tokens through and rejects a bad value before sending", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(decision)]]);
    await celerisClient(transport).ask({ state: "x", questions, maxSoftTokens: 1120 });
    expect(JSON.parse(transport.requests[0]!.body).x_celeris).toEqual({ max_soft_tokens: 1120 });
    await expect(celerisClient(transport).ask({ state: "x", questions, maxSoftTokens: 300 })).rejects.toThrow(
      /maxSoftTokens must be one of 70, 140, 280, 560, 1120 for celeris, got 300/
    );
    expect(transport.requests).toHaveLength(1);
  });

  it("sends images as the named map", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(decision)]]);
    const bytes = jpeg();
    await celerisClient(transport).ask({ state: "x", questions, images: [bytes] });
    expect(JSON.parse(transport.requests[0]!.body).x_celeris).toEqual({
      images: { image1: dataUrl(bytes, "image/jpeg") },
    });
  });

  it("refuses audio and video before sending", async () => {
    const transport = new FakeTransport([]);
    await expect(celerisClient(transport).ask({ state: "x", questions, audio: [Buffer.alloc(4)] })).rejects.toThrow(
      /audio is not accepted by the celeris provider/
    );
    await expect(celerisClient(transport).ask({ state: "x", questions, videos: [Buffer.alloc(4)] })).rejects.toThrow(
      /videos are not accepted by the celeris provider/
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("honours a base URL override", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(decision)]]);
    await celerisClient(transport, { baseUrl: "https://proxy.example/" }).ask({ state: "x", questions });
    expect(transport.requests[0]!.url).toBe("https://proxy.example/celeris-1-decision/v1/systemone");
  });
});

describe("Celeris error envelope", () => {
  it("puts the message and code of a 401 in the error", async () => {
    const body = envelope("invalid_api_key", "Invalid API key provided.", "authentication_error");
    const transport = new FakeTransport([[401, body, { "x-request-id": "req_c2" }]]);
    const error = await celerisClient(transport)
      .ask({ state: "x", questions })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Unauthorized).message).toBe("unauthorized: Invalid API key provided. (code invalid_api_key)");
    expect((error as Unauthorized).status).toBe(401);
    expect((error as Unauthorized).body).toBe(body);
    expect((error as Unauthorized).headers).toEqual({ "x-request-id": "req_c2" });
  });

  it("adds the envelope's ref to the message when present", async () => {
    const body = envelope("invalid_api_key", "Invalid API key provided.", "authentication_error", "q-a1");
    const error = await celerisClient(new FakeTransport([[401, body]]))
      .ask({ state: "x", questions })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Unauthorized).message).toBe(
      "unauthorized: Invalid API key provided. (code invalid_api_key, ref q-a1)"
    );
    expect((error as Unauthorized).body).toBe(body);

    const detail = (fields: Record<string, unknown>) => provider().errorDetail(400, JSON.stringify({ error: fields }));
    expect(detail({ message: "Bad request.", ref: "q-d3" })).toBe("Bad request. (ref q-d3)");
    expect(detail({ code: "invalid_request", ref: "q-d3" })).toBe("code invalid_request, ref q-d3");
    expect(detail({ ref: "q-d3" })).toBe("ref q-d3");
    expect(detail({ type: "invalid_request_error", ref: "q-d3" })).toBe("code invalid_request_error, ref q-d3");
    expect(detail({ message: "Bad request.", code: "invalid_request", ref: "" })).toBe(
      "Bad request. (code invalid_request)"
    );
    expect(detail({ message: "Bad request.", ref: 42 })).toBe("Bad request.");
  });

  it("is not retried on 422 and carries the validation detail", async () => {
    const body = envelope("too_many_questions", "questions: at most 64 entries when explain is true");
    const transport = new FakeTransport([[422, body]]);
    const sleeper = new FakeSleeper();
    const error = await celerisClient(transport, { sleeper: sleeper.call })
      .ask({ state: "x", questions })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnprocessableEntity);
    expect((error as ApiError).message).toBe(
      "unprocessable entity: questions: at most 64 entries when explain is true (code too_many_questions)"
    );
    expect(transport.requests).toHaveLength(1);
    expect(sleeper.slept).toEqual([]);
  });

  it("retries a 429 after Retry-After, then succeeds or gives up", async () => {
    const limited = [429, envelope("rate_limit_exceeded", "Too many requests."), { "retry-after": "2" }] as const;
    const recovers = new FakeTransport([limited, [200, JSON.stringify(decision)]]);
    const sleeper = new FakeSleeper();
    const response = await celerisClient(recovers, { sleeper: sleeper.call }).ask({ state: "x", questions });
    expect(response.answers.urgent.noul).toBe(0.91);
    expect(sleeper.slept).toEqual([2000]);

    const busy = [429, envelope("service_busy", "Service is busy."), { "retry-after": "1" }] as const;
    const exhausted = new FakeTransport([busy, busy, busy]);
    const stillSleeping = new FakeSleeper();
    const error = await celerisClient(exhausted, { sleeper: stillSleeping.call })
      .ask({ state: "x", questions })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as ApiError).message).toBe("rate limited: Service is busy. (code service_busy)");
    expect(exhausted.requests).toHaveLength(3);
    expect(stillSleeping.slept).toEqual([1000, 1000]);
  });

  it("names the code on statuses without their own class and retries 5xx", async () => {
    const quota = new FakeTransport([[402, envelope("insufficient_quota", "You have run out of credits.")]]);
    const error = await celerisClient(quota).ask({ state: "x", questions }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(
      "api error (status 402): You have run out of credits. (code insufficient_quota)"
    );
    expect((error as ApiError).status).toBe(402);

    const flaky = new FakeTransport([[503, envelope("server_error", "Try again.")], [200, JSON.stringify(decision)]]);
    const sleeper = new FakeSleeper();
    await celerisClient(flaky, { sleeper: sleeper.call, random: () => 0 }).ask({ state: "x", questions });
    expect(flaky.requests).toHaveLength(2);
    expect(sleeper.slept).toEqual([500]);
  });

  it("falls back to the plain message when the body is not the envelope", async () => {
    for (const body of ["", "Forbidden", "{}", JSON.stringify({ error: "string" }), JSON.stringify({ error: {} })]) {
      const error = await celerisClient(new FakeTransport([[401, body]]))
        .ask({ state: "x", questions })
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe("unauthorized");
    }
    expect(provider().errorDetail(401, JSON.stringify({ error: { type: "authentication_error" } }))).toBe(
      "code authentication_error"
    );
    expect(provider().errorDetail(400, JSON.stringify({ error: { message: "Bad request." } }))).toBe("Bad request.");
  });
});

class Io implements CliIo {
  out = "";
  err = "";
  readonly stdout = { write: (chunk: string) => (this.out += chunk), isTTY: false };
  readonly stderr = { write: (chunk: string) => (this.err += chunk) };
  readonly stdin = { piped: false, read: async () => "" };
  readonly env = {};
  readonly clientOptions: ClientOptions;
  now = () => 0;
  constructor(clientOptions: ClientOptions = {}) {
    this.clientOptions = clientOptions;
  }
}

const askFlags = ["ask", "-s", "x", "--noul", "urgent=Is this urgent?", "--choice", "team=Which team?|billing,auth"];

describe("CLI with Celeris", () => {
  it("prints the reason under each answer with --explain", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(explained)]]);
    await withEnv(NO_ENV, async () => {
      const io = new Io({ apiKey: "ck_test", transport: transport.call });
      expect(await run([...askFlags, "--provider", "celeris", "--explain"], io)).toBe(0);
      expect(io.err).toBe("");
      expect(io.out).toBe(
        [
          "urgent  yes   91%",
          "        Checkout is down for every customer.",
          "team    auth  80%  billing 20%",
          "        The failure is in session validation.",
          "celeris-1-decision · 210 in / 14 out tokens · 0.0s",
          "",
        ].join("\n")
      );
    });
    expect(transport.requests[0]!.url).toBe(URL);
    expect(JSON.parse(transport.requests[0]!.body).x_celeris).toEqual({ explain: true });
  });

  it("puts the reason under a single answer and before the verbose distribution", async () => {
    const body = JSON.stringify({
      model: "celeris-1-decision",
      answers: { answer: { type: "noul", noul: 0.91 } },
      usage: {},
      x_celeris: { explanations: { answer: "Revenue is at zero." } },
    });
    await withEnv(NO_ENV, async () => {
      const io = new Io({ apiKey: "ck_test", transport: new FakeTransport([[200, body]]).call });
      expect(await run(["yesno", "Is this urgent?", "-s", "x", "--provider", "celeris", "--explain", "-v"], io)).toBe(0);
      expect(io.out).toBe(
        [
          "yes  91%",
          "  Revenue is at zero.",
          "  yes  91%",
          "  no   9%",
          "celeris · celeris-1-decision · 0.0s",
          "",
        ].join("\n")
      );

      const quiet = new Io({ apiKey: "ck_test", transport: new FakeTransport([[200, body]]).call });
      expect(await run(["yesno", "Q?", "-s", "x", "--provider", "celeris", "--explain", "-q"], quiet)).toBe(0);
      expect(quiet.out).toBe("yes\n");
    });
  });

  it("includes explanations in --json, on the response and on each answer", async () => {
    await withEnv(NO_ENV, async () => {
      const io = new Io({ apiKey: "ck_test", transport: new FakeTransport([[200, JSON.stringify(explained)]]).call });
      expect(await run([...askFlags, "--provider", "celeris", "--explain", "--json"], io)).toBe(0);
      expect(JSON.parse(io.out)).toEqual({
        provider: "celeris",
        model: "celeris-1-decision",
        id: null,
        requestId: null,
        elapsedMs: 0,
        usage: { inputTokens: 210, outputTokens: 14, cost: null },
        answers: {
          urgent: { type: "noul", noul: 0.91, probabilities: {}, explanation: explanations.urgent },
          team: {
            type: "choice",
            choice: "auth",
            confidence: 0.8,
            probabilities: { billing: 0.2, auth: 0.8 },
            explanation: explanations.team,
          },
        },
        explanations,
      });
    });
  });

  it("is selected from the environment when CELERIS_API_KEY is the only key", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(decision)]]);
    await withEnv({ ...NO_ENV, CELERIS_API_KEY: "ck_env" }, async () => {
      const io = new Io({ transport: transport.call });
      expect(await run([...askFlags, "-q"], io)).toBe(0);
      expect(io.out).toBe("urgent\tyes\nteam\tauth\n");
    });
    expect(transport.requests[0]!.url).toBe(URL);
    expect(transport.requests[0]!.headers.Authorization).toBe("Bearer ck_env");
  });

  it("rejects --explain and --max-soft-tokens on other providers as usage errors", async () => {
    await withEnv(NO_ENV, async () => {
      const explain = new Io({ apiKey: "k", transport: new FakeTransport([]).call });
      expect(await run([...askFlags, "--provider", "typesafe", "--explain"], explain)).toBe(2);
      expect(explain.err).toBe(
        [
          'decision-model: explain is only supported by the celeris provider, not typesafe; pass provider "celeris" (--provider celeris)',
          "  Pass --provider celeris, with CELERIS_API_KEY set. --explain and --max-soft-tokens are Celeris features.",
          '  Example: decision-model yesno "Is this urgent?" --explain --provider celeris -f issue.json',
          "  Run 'decision-model help ask' for usage.",
          "",
        ].join("\n")
      );

      const tokens = new Io();
      expect(await run(["yesno", "Q?", "--max-soft-tokens", "280", "--provider", "open-router", "--dry-run"], tokens)).toBe(2);
      expect(tokens.err).toMatch(/maxSoftTokens is only supported by the celeris provider, not open-router/);

      const json = new Io({ apiKey: "k", transport: new FakeTransport([]).call });
      expect(await run(["yesno", "Q?", "--explain", "--provider", "cloudflare", "--base-url", "https://gw.example", "--json"], json)).toBe(2);
      expect(JSON.parse(json.err).error).toMatchObject({ type: "UsageError", message: expect.stringContaining("not cloudflare") });
    });
  });

  it("validates --max-soft-tokens", async () => {
    await withEnv(NO_ENV, async () => {
      const bad = new Io();
      expect(await run(["yesno", "Q?", "--max-soft-tokens", "100", "--provider", "celeris", "--dry-run"], bad)).toBe(2);
      expect(bad.err).toBe(
        [
          "decision-model: maxSoftTokens must be one of 70, 140, 280, 560, 1120 for celeris, got 100",
          "  --max-soft-tokens takes 70, 140, 280 (the default), 560, or 1120.",
          "  Run 'decision-model help yesno' for usage.",
          "",
        ].join("\n")
      );

      const text = new Io();
      expect(await run(["yesno", "Q?", "--max-soft-tokens", "lots", "--provider", "celeris", "--dry-run"], text)).toBe(2);
      expect(text.err).toMatch(/--max-soft-tokens expects a non-negative integer, got "lots"/);

      const ok = new Io();
      expect(await run(["yesno", "Q?", "--max-soft-tokens", "560", "--provider", "celeris", "--dry-run"], ok)).toBe(0);
      expect(JSON.parse(ok.out).request.x_celeris).toEqual({ max_soft_tokens: 560 });
    });
  });

  it("dry-runs the full x_celeris object and the URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "celeris-cli-"));
    const photo = imageFile(dir, "photo.png", png());
    await withEnv(NO_ENV, async () => {
      const io = new Io();
      const code = await run(
        ["yesno", "Is the total legible?", "-s", "receipt", "-i", photo, "--explain", "--max-soft-tokens", "140", "--provider", "celeris", "--dry-run"],
        io
      );
      expect(code).toBe(0);
      expect(JSON.parse(io.out)).toEqual({
        provider: "celeris",
        model: "celeris-1-decision",
        url: URL,
        request: {
          model: "celeris-1-decision",
          state: "receipt",
          questions: { answer: { type: "noul", instructions: "Is the total legible?" } },
          x_celeris: { explain: true, images: { photo: dataUrl(png()) }, max_soft_tokens: 140 },
        },
      });

      const plain = new Io();
      expect(await run(["yesno", "Q?", "-s", "x", "--provider", "celeris", "--dry-run"], plain)).toBe(0);
      expect(JSON.parse(plain.out).request).not.toHaveProperty("x_celeris");
    });
  });

  it("sends --image files as the named map and names the limits on a refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "celeris-cli-"));
    const receipt = imageFile(dir, "receipt.jpg", jpeg());
    const transport = new FakeTransport([[200, JSON.stringify(decision)]]);
    await withEnv(NO_ENV, async () => {
      const io = new Io({ apiKey: "ck_test", transport: transport.call });
      expect(await run([...askFlags, "--image", receipt, "--provider", "celeris", "-q"], io)).toBe(0);
      expect(io.out).toBe("urgent\tyes\nteam\tauth\n");

      const many = new Io();
      const nine = Array.from({ length: 9 }, () => ["--image", receipt]).flat();
      expect(await run(["yesno", "Q?", ...nine, "--provider", "celeris", "--dry-run"], many)).toBe(2);
      expect(many.err).toContain("decision-model: celeris accepts at most 8 images per request, got 9");
      expect(many.err).toContain("Celeris allows 8 PNG or JPEG images, 25 megapixels each, and an 8 MiB request body.");

      const webpFile = imageFile(dir, "photo.webp", webp());
      const format = new Io();
      expect(await run(["yesno", "Q?", "--image", webpFile, "--provider", "celeris", "--dry-run"], format)).toBe(2);
      expect(format.err).toMatch(/must be a PNG or JPEG image\n {2}Pass a local PNG or JPEG file/);
    });
    expect(JSON.parse(transport.requests[0]!.body).x_celeris).toEqual({
      images: { receipt: dataUrl(jpeg(), "image/jpeg") },
    });
  });

  it("rejects --audio and --video for Celeris with a pointer to clef-omni", async () => {
    await withEnv(NO_ENV, async () => {
      const io = new Io();
      expect(await run(["yesno", "Q?", "--audio", "clip.wav", "--provider", "celeris", "--dry-run"], io)).toBe(2);
      expect(io.err).toBe(
        [
          "decision-model: audio is not accepted by the celeris provider; celeris-1-decision takes text and images only",
          "  Celeris takes text and images. For audio or video, pass --provider cloudflare --model clef-omni.",
          '  Example: decision-model yesno "Is the fan rattling?" --audio unit.wav --video fan.mp4 --provider cloudflare --model clef-omni',
          "  Run 'decision-model help yesno' for usage.",
          "",
        ].join("\n")
      );
      const video = new Io();
      expect(await run(["yesno", "Q?", "--video", "clip.mp4", "--provider", "celeris", "--dry-run"], video)).toBe(2);
      expect(video.err).toMatch(/videos are not accepted by the celeris provider/);
    });
  });

  it("reports the explain question cap with a hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "celeris-cli-"));
    const path = join(dir, "questions.json");
    writeFileSync(path, JSON.stringify(manyQuestions(65)));
    await withEnv(NO_ENV, async () => {
      const io = new Io();
      expect(await run(["ask", "-s", "x", "--questions", path, "--explain", "--provider", "celeris", "--dry-run"], io)).toBe(2);
      expect(io.err).toContain("celeris answers at most 64 questions per request with explain, got 65");
      expect(io.err).toContain("Celeris answers up to 512 questions per request, or 64 with --explain.");
    });
  });

  it("passes --base-url through under the model path", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(decision)]]);
    await withEnv(NO_ENV, async () => {
      const io = new Io({ apiKey: "ck_test", transport: transport.call });
      expect(await run([...askFlags, "--provider", "celeris", "--base-url", "https://proxy.example/", "-q"], io)).toBe(0);
    });
    expect(transport.requests[0]!.url).toBe("https://proxy.example/celeris-1-decision/v1/systemone");
  });

  it("reports the envelope message, code, ref, status, and request id on a failure", async () => {
    const body = envelope("invalid_api_key", "Invalid API key provided.", "authentication_error");
    await withEnv(NO_ENV, async () => {
      const json = new Io({ apiKey: "ck_bad", transport: new FakeTransport([[401, body, { "X-Request-Id": "req_c3" }]]).call });
      expect(await run(["yesno", "Q?", "-s", "x", "--provider", "celeris", "--json"], json)).toBe(1);
      expect(JSON.parse(json.err)).toEqual({
        error: {
          type: "Unauthorized",
          message: "unauthorized: Invalid API key provided. (code invalid_api_key) (status 401)",
          status: 401,
          requestId: "req_c3",
          retryable: false,
        },
      });

      const withRef = envelope("invalid_request", "state: too long", "invalid_request_error", "q-d3");
      const human = new Io({ apiKey: "ck_bad", transport: new FakeTransport([[422, withRef]]).call });
      expect(await run(["yesno", "Q?", "-s", "x", "--provider", "celeris"], human)).toBe(1);
      expect(human.err).toBe(
        `decision-model: unprocessable entity: state: too long (code invalid_request, ref q-d3) (status 422)\n${withRef}\n`
      );

      const limited = new Io({
        apiKey: "ck_test",
        transport: new FakeTransport([[429, envelope("rate_limit_exceeded", "Slow down.")]]).call,
      });
      expect(await run(["yesno", "Q?", "-s", "x", "--provider", "celeris", "--json", "--max-retries", "0"], limited)).toBe(1);
      expect(JSON.parse(limited.err).error).toMatchObject({
        type: "RateLimited",
        message: "rate limited: Slow down. (code rate_limit_exceeded) (status 429)",
        retryable: true,
      });
    });
  });

  it("lists Celeris among the providers and marks it when it is the default", async () => {
    await withEnv({ ...NO_ENV, CELERIS_API_KEY: "ck_env" }, async () => {
      const io = new Io();
      expect(await run(["providers"], io)).toBe(0);
      expect(io.out).toMatch(/\*  celeris {6}CELERIS_API_KEY {8}celeris-1-decision {2}set/);
      expect(io.out).toContain("default: celeris (CELERIS_API_KEY is set).");

      const verbose = new Io();
      expect(await run(["providers", "-v"], verbose)).toBe(0);
      expect(verbose.out).toContain(URL);
    });
    await withEnv({ ...NO_ENV, TYPESAFE_API_KEY: "t" }, async () => {
      const io = new Io();
      expect(await run(["providers"], io)).toBe(0);
      expect(io.out).toMatch(/ {3}celeris {6}CELERIS_API_KEY {8}celeris-1-decision {2}not set/);
    });
  });

  it("documents the flags in help", async () => {
    const io = new Io();
    expect(await run(["help", "ask"], io)).toBe(0);
    expect(io.out).toContain("--explain");
    expect(io.out).toContain("--max-soft-tokens <n>");
    expect(io.out).toContain("--provider <name>    open-router, typesafe, cloudflare, or celeris.");
    const main = new Io();
    expect(await run(["--help"], main)).toBe(0);
    expect(main.out).toContain("CELERIS_API_KEY selects Celeris");
    const all = new Io();
    expect(await run(["help", "all"], all)).toBe(0);
    expect(all.out).toContain("request.x_celeris");
  });
});
