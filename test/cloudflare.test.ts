import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProvider,
  choice,
  Client,
  CloudflareProvider,
  ConfigurationError,
  InvalidResponse,
  noul,
  OpenRouterProvider,
  providerFromEnv,
  score,
  TypesafeProvider,
  Unauthorized,
} from "../src/index.js";
import type { ClientOptions } from "../src/index.js";
import { run, type CliIo } from "../src/cli/run.js";
import { FakeTransport, withEnv } from "./helpers.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const RUN_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`;

// Every test starts from a clean slate so a developer's real Cloudflare
// credentials never leak into a request.
const NO_ENV = {
  TYPESAFE_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  CLOUDFLARE_AUTH_TOKEN: undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined,
};

const questions = {
  urgent: noul("Is this urgent?"),
  team: choice("Which team?", { billing: null, auth: null }),
  severity: score("How severe?", ["cosmetic", "minor", "major"]),
};

const decision = {
  model: "clef",
  answers: {
    urgent: { type: "noul", noul: 0.91 },
    team: {
      type: "choice",
      choice: "auth",
      confidence: 0.8,
      probabilities: { billing: 0.2, auth: 0.8 },
    },
    severity: {
      type: "score",
      score: 1.7,
      confidence: 0.7,
      probabilities: { "0": 0.05, "1": 0.2, "2": 0.75 },
      legend: { "0": "cosmetic", "1": "minor", "2": "major" },
    },
  },
  usage: { input_tokens: 210, output_tokens: 14 },
};

const envelope = (result: unknown) =>
  JSON.stringify({ result, success: true, errors: [], messages: [] });

function cloudflareClient(transport: FakeTransport, options: Record<string, unknown> = {}) {
  return new Client({
    provider: new CloudflareProvider({ accountId: ACCOUNT }),
    apiKey: "cf-token",
    transport: transport.call,
    ...options,
  });
}

describe("CloudflareProvider", () => {
  it("describes Workers AI Clef", () => {
    const provider = new CloudflareProvider({ apiKey: "k", accountId: ACCOUNT });
    expect(provider.name).toBe("cloudflare");
    expect(provider.envVar).toBe("CLOUDFLARE_AUTH_TOKEN");
    expect(provider.accountIdEnvVar).toBe("CLOUDFLARE_ACCOUNT_ID");
    expect(provider.defaultModel).toBe("clef");
    expect(provider.baseUrl).toBe(RUN_URL);
    expect(provider.url).toBe(`${RUN_URL}/@cf/cloudflare/clef`);
    expect(provider.reportsCost).toBe(false);
    expect(provider.requestIdHeader).toBe("cf-ray");
  });

  it("routes each model to its own Workers AI URL", () => {
    const provider = new CloudflareProvider({ apiKey: "k", accountId: ACCOUNT });
    expect(provider.urlFor("clef")).toBe(`${RUN_URL}/@cf/cloudflare/clef`);
    expect(provider.urlFor("clef-flash")).toBe(`${RUN_URL}/@cf/cloudflare/clef-flash`);
  });

  it("resolves Workers AI model ids to the body's model selector", () => {
    const provider = new CloudflareProvider({ apiKey: "k", accountId: ACCOUNT });
    expect(provider.resolveModel(undefined)).toBe("clef");
    expect(provider.resolveModel("clef-flash")).toBe("clef-flash");
    expect(provider.resolveModel("@cf/cloudflare/clef")).toBe("clef");
    expect(provider.resolveModel("@cf/cloudflare/clef-flash")).toBe("clef-flash");
  });

  it("reads the account id from the environment", async () => {
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, () => {
      expect(new CloudflareProvider().baseUrl).toBe(RUN_URL);
    });
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: "from-env" }, () => {
      expect(new CloudflareProvider({ accountId: ACCOUNT }).baseUrl).toBe(RUN_URL);
    });
  });

  it("needs an account id unless the base URL is overridden", async () => {
    await withEnv(NO_ENV, () => {
      const provider = new CloudflareProvider({ apiKey: "k" });
      expect(provider.missingConfiguration()).toMatch(/set CLOUDFLARE_ACCOUNT_ID/);
      expect(provider.url).toContain("{CLOUDFLARE_ACCOUNT_ID}");
      expect(
        new CloudflareProvider({ apiKey: "k", baseUrl: "https://gateway.example/ai" })
          .missingConfiguration()
      ).toBeNull();
      expect(new CloudflareProvider({ accountId: ACCOUNT }).missingConfiguration()).toBeNull();
    });
  });

  it("keeps the account id through configure", () => {
    const copy = new CloudflareProvider({ accountId: ACCOUNT }).configure({ apiKey: "k" });
    expect(copy).toBeInstanceOf(CloudflareProvider);
    expect(copy.accountId).toBe(ACCOUNT);
    expect(copy.configure({ accountId: "other" }).accountId).toBe("other");
  });

  it("is built by name", () => {
    expect(buildProvider("cloudflare", { apiKey: "k" })).toBeInstanceOf(CloudflareProvider);
  });
});

describe("Cloudflare environment selection", () => {
  it("selects Cloudflare when the token and account id are set", async () => {
    await withEnv({ ...NO_ENV, CLOUDFLARE_AUTH_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, () => {
      const client = new Client();
      expect(client.provider).toBeInstanceOf(CloudflareProvider);
      expect(client.model).toBe("clef");
    });
  });

  it("skips Cloudflare when the account id is missing", async () => {
    await withEnv({ ...NO_ENV, CLOUDFLARE_AUTH_TOKEN: "t" }, () => {
      expect(providerFromEnv()).toBeNull();
      expect(() => new Client()).toThrow(ConfigurationError);
    });
  });

  it("ranks Cloudflare after Typesafe and OpenRouter", async () => {
    const cloudflare = { CLOUDFLARE_AUTH_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
    await withEnv({ ...NO_ENV, ...cloudflare, TYPESAFE_API_KEY: "t" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(TypesafeProvider);
    });
    await withEnv({ ...NO_ENV, ...cloudflare, OPENROUTER_API_KEY: "o" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(OpenRouterProvider);
    });
  });

  it("explains a missing account id when Cloudflare is named", async () => {
    await withEnv(NO_ENV, () => {
      expect(() => new Client({ provider: "cloudflare", apiKey: "t" })).toThrow(
        /accountId is required for cloudflare: pass accountId or set CLOUDFLARE_ACCOUNT_ID/
      );
      expect(() => new Client({ provider: "cloudflare" })).toThrow(/set CLOUDFLARE_AUTH_TOKEN/);
    });
  });
});

describe("Client with Cloudflare", () => {
  it("posts the Jev wire format to the Clef URL with a bearer token", async () => {
    const transport = new FakeTransport([[200, envelope(decision), { "cf-ray": "8f1e-SJC" }]]);
    const response = await cloudflareClient(transport).ask({ state: { title: "x" }, questions });

    const [request] = transport.requests;
    expect(request!.url).toBe(`${RUN_URL}/@cf/cloudflare/clef`);
    expect(request!.headers.Authorization).toBe("Bearer cf-token");
    expect(JSON.parse(request!.body)).toEqual({
      model: "clef",
      state: { title: "x" },
      questions: JSON.parse(JSON.stringify(questions)),
    });

    expect(response.answers.urgent.noul).toBe(0.91);
    expect(response.answers.team.choice).toBe("auth");
    expect(response.answers.severity.score).toBe(1.7);
    expect(response.model).toBe("clef");
    expect(response.usage).toEqual({ inputTokens: 210, outputTokens: 14, cost: null });
    expect(response.requestId).toBe("8f1e-SJC");
  });

  it("sends clef-flash to its own URL", async () => {
    const transport = new FakeTransport([
      [200, envelope({ ...decision, model: "clef-flash" })],
      [200, envelope({ ...decision, model: "clef-flash" })],
    ]);
    const flash = cloudflareClient(transport, { model: "clef-flash" });
    expect(flash.model).toBe("clef-flash");
    await flash.ask({ state: "x", questions });
    await cloudflareClient(transport, { model: "@cf/cloudflare/clef-flash" }).ask({
      state: "x",
      questions,
    });

    for (const request of transport.requests) {
      expect(request.url).toBe(`${RUN_URL}/@cf/cloudflare/clef-flash`);
      expect(JSON.parse(request.body).model).toBe("clef-flash");
    }
  });

  it("accepts an unwrapped body, as a gateway may return", async () => {
    const transport = new FakeTransport([[200, JSON.stringify(decision)]]);
    const response = await cloudflareClient(transport).ask({ state: "x", questions });
    expect(response.answers.urgent.noul).toBe(0.91);
  });

  it("keeps the envelope in raw", async () => {
    const transport = new FakeTransport([[200, envelope(decision)]]);
    const response = await cloudflareClient(transport).ask({ state: "x", questions });
    expect(response.raw).toMatchObject({ success: true, result: { model: "clef" } });
  });

  it("raises InvalidResponse when the envelope reports failure", async () => {
    const body = JSON.stringify({
      result: null,
      success: false,
      errors: [{ code: 5006, message: "Error: oneOf at '/' not met" }],
      messages: [],
    });
    const transport = new FakeTransport([[200, body]]);
    const error = await cloudflareClient(transport)
      .ask({ state: "x", questions })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidResponse);
    expect((error as Error).message).toBe(
      "cloudflare reported failure: Error: oneOf at '/' not met"
    );
  });

  it("raises InvalidResponse when the result is not an object", async () => {
    const transport = new FakeTransport([[200, envelope("nope")]]);
    await expect(cloudflareClient(transport).ask({ state: "x", questions })).rejects.toThrow(
      /response result was not a JSON object/
    );
  });

  it("maps HTTP errors like any other provider", async () => {
    const body = JSON.stringify({
      result: null,
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
    });
    const transport = new FakeTransport([[401, body, { "cf-ray": "8f1e-SJC" }]]);
    const error = await cloudflareClient(transport)
      .ask({ state: "x", questions })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Unauthorized).body).toBe(body);
  });

  it("goes through the default fetch transport", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(envelope(decision), {
        status: 200,
        headers: { "content-type": "application/json", "cf-ray": "abc-LHR" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new Client({
      provider: new CloudflareProvider({ accountId: ACCOUNT }),
      apiKey: "cf-token",
      model: "clef-flash",
    });
    const response = await client.ask({ state: "x", questions });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RUN_URL}/@cf/cloudflare/clef-flash`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cf-token");
    expect(response.requestId).toBe("abc-LHR");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

describe("CLI with Cloudflare", () => {
  it("asks Clef with --provider cloudflare", async () => {
    const transport = new FakeTransport([[200, envelope({ ...decision, model: "clef-flash" })]]);
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io({ apiKey: "cf-token", transport: transport.call });
      const args = ["ask", "-s", "x", "--noul", "urgent=Is this urgent?"];
      expect(await run([...args, "--provider", "cloudflare", "--model", "clef-flash", "-q"], io)).toBe(0);
      expect(io.out).toBe("urgent\tyes\n");
    });
    expect(transport.requests[0]!.url).toBe(`${RUN_URL}/@cf/cloudflare/clef-flash`);
  });

  it("names the missing account id", async () => {
    await withEnv({ ...NO_ENV, CLOUDFLARE_AUTH_TOKEN: "t" }, async () => {
      const io = new Io();
      expect(await run(["yesno", "Q?", "-s", "x", "--provider", "cloudflare"], io)).toBe(2);
      expect(io.err).toMatch(/set CLOUDFLARE_ACCOUNT_ID/);
    });
  });

  it("dry-runs against the model's URL", async () => {
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io();
      const args = ["yesno", "Q?", "-s", "x", "--provider", "cloudflare", "--model", "clef-flash"];
      expect(await run([...args, "--dry-run"], io)).toBe(0);
      expect(JSON.parse(io.out)).toMatchObject({
        provider: "cloudflare",
        model: "clef-flash",
        url: `${RUN_URL}/@cf/cloudflare/clef-flash`,
        request: { model: "clef-flash", state: "x" },
      });
    });
  });

  it("marks a token without an account id as incomplete", async () => {
    await withEnv({ ...NO_ENV, CLOUDFLARE_AUTH_TOKEN: "t" }, async () => {
      const io = new Io();
      expect(await run(["providers"], io)).toBe(0);
      expect(io.out).toMatch(/cloudflare\s+CLOUDFLARE_AUTH_TOKEN\s+clef\s+incomplete/);
    });
  });
});

function onePixelPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
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

describe("CLI images for Clef", () => {
  it("sends a local --image file to Clef", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clef-cli-"));
    const path = join(dir, "photo.png");
    const bytes = onePixelPng();
    writeFileSync(path, bytes);
    const transport = new FakeTransport([[200, envelope(decision)]]);
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io({ apiKey: "cf-token", transport: transport.call });
      const code = await run(
        ["ask", "-s", "a photo", "--noul", "urgent=Is this urgent?", "--image", path, "--provider", "cloudflare", "-q"],
        io
      );
      expect(code).toBe(0);
      expect(io.out).toBe("urgent\tyes\n");
    });
    const sent = JSON.parse(transport.requests[0]!.body) as {
      state: string;
      images: { content_type: string; base64: string }[];
    };
    expect(sent.state).toBe("a photo");
    expect(sent.images).toEqual([{ content_type: "image/png", base64: bytes.toString("base64") }]);
    expect(transport.requests[0]!.url).toBe(`${RUN_URL}/@cf/cloudflare/clef`);
  });

  it("shows the embedded image in a dry run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clef-cli-"));
    const path = join(dir, "photo.png");
    writeFileSync(path, onePixelPng());
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io();
      const code = await run(
        ["yesno", "What is in this photo?", "-i", path, "--provider", "cloudflare", "--dry-run"],
        io
      );
      expect(code).toBe(0);
      const printed = JSON.parse(io.out) as { request: { images: { content_type: string }[] } };
      expect(printed.request.images[0]!.content_type).toBe("image/png");
    });
  });

  it("rejects a remote URL and images for other providers as usage errors", async () => {
    await withEnv(NO_ENV, async () => {
      const url = new Io();
      expect(
        await run(["yesno", "Q?", "--image", "https://example.com/a.png", "--provider", "cloudflare", "--dry-run"], url)
      ).toBe(2);
      expect(url.err).toMatch(/remote URLs are not accepted/);

      const other = new Io();
      expect(await run(["yesno", "Q?", "--image", "photo.png", "--dry-run"], other)).toBe(2);
      expect(other.err).toMatch(/only supported by the cloudflare provider/);
    });
  });

  it("reports an unreadable --image as a usage error before sending", async () => {
    const transport = new FakeTransport([]);
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io({ apiKey: "cf-token", transport: transport.call });
      const code = await run(
        ["yesno", "Q?", "--image", "/tmp/does-not-exist-clef-cli.png", "--provider", "cloudflare"],
        io
      );
      expect(code).toBe(2);
      expect(io.err).toMatch(/could not read file/);
      expect(io.err).toMatch(/Pass a local PNG, JPEG, or WebP file/);
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("posts images through the mocked fetch transport", async () => {
    const bytes = onePixelPng();
    const fetchMock = vi.fn(async () => new Response(envelope(decision), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({
      provider: new CloudflareProvider({ accountId: ACCOUNT }),
      apiKey: "cf-token",
    });
    await client.ask({ state: "x", questions, images: [bytes] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(String(init.body)) as { images: { content_type: string; base64: string }[] };
    expect(sent.images[0]).toEqual({ content_type: "image/png", base64: bytes.toString("base64") });
  });
});
