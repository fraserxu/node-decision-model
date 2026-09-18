import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import type { ClientOptions } from "../src/index.js";
import { formatHuman, table } from "../src/cli/format.js";
import {
  mergeQuestions,
  parseArgv,
  parseQuestionSpec,
  parseQuestionsJson,
  UsageError,
} from "../src/cli/parse.js";
import { run, type CliIo } from "../src/cli/run.js";
import { DecisionResponse } from "../src/response.js";
import { connectionError, FakeTransport, withEnv } from "./helpers.js";

/** Captures output and serves scripted stdin. */
class FakeIo implements CliIo {
  out = "";
  err = "";
  readonly stdout = { write: (chunk: string) => (this.out += chunk) };
  readonly stderr = { write: (chunk: string) => (this.err += chunk) };
  readonly stdin: CliIo["stdin"];
  clientOptions?: ClientOptions;

  constructor(options: { stdin?: string; transport?: FakeTransport } = {}) {
    const text = options.stdin;
    this.stdin = {
      isTTY: text === undefined,
      read: async () => text ?? "",
    };
    if (options.transport !== undefined) {
      this.clientOptions = { apiKey: "test-key", transport: options.transport.call };
    }
  }
}

const fullBody = JSON.stringify({
  id: "resp_42",
  model: "typesafe/jev-1.13",
  answers: {
    urgent: { type: "noul", noul: 0.87, probabilities: { true: 0.87, false: 0.13 } },
    team: {
      type: "choice",
      choice: "infra",
      confidence: 0.62,
      probabilities: { billing: 0.1, auth: 0.28, infra: 0.62 },
    },
    severity: {
      type: "score",
      score: 2.4,
      confidence: 0.55,
      probabilities: { "0": 0.05, "1": 0.1, "2": 0.25, "3": 0.6 },
      legend: { "0": "cosmetic", "1": "minor", "2": "major", "3": "critical" },
    },
  },
  usage: { input_tokens: 120, output_tokens: 9, cost: 0.0012 },
});

const questionFlags = [
  "--noul",
  "urgent=Is this urgent?",
  "--choice",
  "team=Which team owns this?|billing,auth,infra",
  "--score",
  "severity=How severe is this?|cosmetic,minor,major,critical",
];

const expectedQuestions = {
  urgent: { type: "noul", instructions: "Is this urgent?" },
  team: {
    type: "choice",
    instructions: "Which team owns this?",
    criteria: { billing: null, auth: null, infra: null },
  },
  severity: {
    type: "score",
    instructions: "How severe is this?",
    criteria: ["cosmetic", "minor", "major", "critical"],
  },
};

describe("parseQuestionSpec", () => {
  it("parses a noul spec", () => {
    expect(parseQuestionSpec("noul", "urgent=Is this urgent?")).toEqual([
      "urgent",
      { type: "noul", instructions: "Is this urgent?" },
    ]);
  });

  it("keeps = and | inside noul instructions", () => {
    expect(parseQuestionSpec("noul", "eq= Is 2+2=4 | really? ")[1].instructions).toBe(
      "Is 2+2=4 | really?"
    );
  });

  it("parses choice labels into null criteria", () => {
    expect(parseQuestionSpec("choice", "team=Which team?| billing , auth,infra")).toEqual([
      "team",
      { type: "choice", instructions: "Which team?", criteria: { billing: null, auth: null, infra: null } },
    ]);
  });

  it("splits at the last pipe so instructions may contain one", () => {
    const [, question] = parseQuestionSpec("score", "s=Rate a|b|low,high");
    expect(question).toEqual({ type: "score", instructions: "Rate a|b", criteria: ["low", "high"] });
  });

  it("rejects specs without an id or without labels", () => {
    expect(() => parseQuestionSpec("noul", "Is this urgent?")).toThrow(UsageError);
    expect(() => parseQuestionSpec("noul", "=Is this urgent?")).toThrow(/id must not be empty/);
    expect(() => parseQuestionSpec("noul", "my id=Is this urgent?")).toThrow(/contain spaces/);
    expect(() => parseQuestionSpec("choice", "team=Which team?")).toThrow(/id=instructions\|label/);
    expect(() => parseQuestionSpec("choice", "team=Which team?|a,,b")).toThrow(/labels must not be empty/);
    expect(() => parseQuestionSpec("choice", "team=Which team?|a,b,a")).toThrow(/"a" is listed twice/);
  });

  it("surfaces builder validation as usage errors naming the question", () => {
    expect(() => parseQuestionSpec("noul", "urgent=")).toThrow(/question "urgent": instructions must not be empty/);
    expect(() => parseQuestionSpec("score", "s=How bad?|only")).toThrow(/question "s": criteria must be an array with 2..10 entries/);
  });
});

describe("parseQuestionsJson", () => {
  it("accepts the wire format and validates through the builders", () => {
    const questions = parseQuestionsJson(
      JSON.stringify({
        urgent: { type: "noul", instructions: "Urgent?", criteria: { true: "yes", false: "no" } },
        team: { type: "choice", instructions: "Team?", criteria: { a: "alpha", b: null } },
        severity: { type: "score", instructions: ["How", "bad"], criteria: ["low", "high"] },
      })
    );
    expect(Object.keys(questions)).toEqual(["urgent", "team", "severity"]);
    expect(questions.urgent).toEqual({
      type: "noul",
      instructions: "Urgent?",
      criteria: { true: "yes", false: "no" },
    });
    expect(questions.severity).toEqual({ type: "score", instructions: ["How", "bad"], criteria: ["low", "high"] });
  });

  it("rejects invalid JSON, non-objects, unknown types, and bad entries", () => {
    expect(() => parseQuestionsJson("{nope")).toThrow(/not valid JSON/);
    expect(() => parseQuestionsJson("[1]")).toThrow(/JSON object keyed by question id/);
    expect(() => parseQuestionsJson('{"q": 1}')).toThrow(/question "q": must be an object/);
    expect(() => parseQuestionsJson('{"q": {"type": "essay"}}')).toThrow(/"type" must be/);
    expect(() => parseQuestionsJson('{"q": {"type": "choice", "instructions": "x", "criteria": {}}}')).toThrow(
      /question "q": criteria must be an object with 1..255 entries/
    );
  });
});

describe("mergeQuestions", () => {
  it("rejects an id defined twice", () => {
    expect(() =>
      mergeQuestions([parseQuestionSpec("noul", "urgent=a"), parseQuestionSpec("noul", "urgent=b")])
    ).toThrow(/question "urgent" is defined twice/);
  });
});

describe("parseArgv", () => {
  it("maps commands and help flags", () => {
    expect(parseArgv([])).toEqual({ kind: "help", topic: "main", exitCode: 2 });
    expect(parseArgv(["--help"])).toEqual({ kind: "help", topic: "main", exitCode: 0 });
    expect(parseArgv(["help", "ask"])).toEqual({ kind: "help", topic: "ask", exitCode: 0 });
    expect(parseArgv(["ask", "-h"])).toEqual({ kind: "help", topic: "ask", exitCode: 0 });
    expect(parseArgv(["providers", "--help"])).toEqual({ kind: "help", topic: "providers", exitCode: 0 });
    expect(parseArgv(["--version"])).toEqual({ kind: "version" });
    expect(parseArgv(["providers"])).toEqual({ kind: "providers" });
  });

  it("collects ask options with the positional state", () => {
    const command = parseArgv([
      "ask",
      "the state",
      ...questionFlags,
      "--provider",
      "typesafe",
      "--model",
      "jev",
      "--base-url",
      "https://proxy.example",
      "--timeout",
      "1500",
      "--max-retries",
      "0",
      "--json",
      "-v",
    ]);
    expect(command).toEqual({
      kind: "ask",
      options: {
        state: "the state",
        jsonState: false,
        noul: ["urgent=Is this urgent?"],
        choice: ["team=Which team owns this?|billing,auth,infra"],
        score: ["severity=How severe is this?|cosmetic,minor,major,critical"],
        questions: undefined,
        provider: "typesafe",
        model: "jev",
        baseUrl: "https://proxy.example",
        timeout: 1500,
        maxRetries: 0,
        json: true,
        verbose: true,
      },
    });
  });

  it("rejects unknown commands, unknown options, and bad numbers", () => {
    expect(() => parseArgv(["decide"])).toThrow(/unknown command "decide"/);
    expect(() => parseArgv(["ask", "--nope"])).toThrow(/Unknown option '--nope'/);
    expect(() => parseArgv(["ask", "--timeout", "soon"])).toThrow(/--timeout expects a non-negative integer/);
    expect(() => parseArgv(["ask", "--max-retries", "-1"])).toThrow(UsageError);
    expect(() => parseArgv(["ask", "a", "b"])).toThrow(/unexpected argument "b"/);
    expect(() => parseArgv(["ask", "a", "--state", "b"])).toThrow(/given twice/);
    expect(() => parseArgv(["providers", "extra"])).toThrow(/unexpected argument "extra"/);
  });
});

describe("table", () => {
  it("pads every column but the last", () => {
    expect(table([["a", "bb", "c"], ["dddd", "e", ""]])).toEqual(["a     bb  c", "dddd  e"]);
  });
});

describe("formatHuman", () => {
  it("prints one line per answer and a summary", () => {
    const response = new DecisionResponse({
      answers: { urgent: { type: "noul", noul: 0.5, probabilities: {} } },
      usage: { inputTokens: null, outputTokens: null, cost: null },
      model: null,
      id: null,
      raw: {},
    });
    expect(formatHuman(response, { verbose: false })).toBe("urgent  noul  0.500\n");
    expect(formatHuman(response, { verbose: true })).toBe(
      "urgent  noul  0.500\n    (no probabilities reported)\n"
    );
  });
});

describe("run", () => {
  it("prints help to stdout with --help and to stderr with no command", async () => {
    const help = new FakeIo();
    expect(await run(["--help"], help)).toBe(0);
    expect(help.out).toMatch(/^Usage: decision-model <command>/);

    const bare = new FakeIo();
    expect(await run([], bare)).toBe(2);
    expect(bare.out).toBe("");
    expect(bare.err).toMatch(/^Usage: decision-model <command>/);

    const ask = new FakeIo();
    expect(await run(["ask", "--help"], ask)).toBe(0);
    expect(ask.out).toMatch(/^Usage: decision-model ask/);
    expect(ask.out).toContain("--choice <id>=<instructions>|<label>,...");
  });

  it("prints the version", async () => {
    const io = new FakeIo();
    expect(await run(["--version"], io)).toBe(0);
    expect(io.out).toBe(`${VERSION}\n`);
  });

  it("reports usage errors with a hint and exit code 2", async () => {
    const io = new FakeIo();
    expect(await run(["ask", "state", "--bogus"], io)).toBe(2);
    expect(io.err).toBe("decision-model: Unknown option '--bogus'\nRun 'decision-model help ask' for usage.\n");
  });

  it("asks with flag-built questions and prints a table", async () => {
    const transport = new FakeTransport([[200, fullBody]]);
    const io = new FakeIo({ transport });
    expect(await run(["ask", "Server returns 500 on checkout", ...questionFlags], io)).toBe(0);

    const request = transport.requests[0]!;
    expect(request.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(JSON.parse(request.body)).toEqual({
      model: "typesafe/jev-1.13",
      state: "Server returns 500 on checkout",
      questions: expectedQuestions,
    });
    expect(io.err).toBe("");
    expect(io.out).toBe(
      [
        "urgent    noul    0.870",
        "team      choice  infra  confidence 0.620",
        "severity  score   2.400  confidence 0.550",
        "",
        "model: typesafe/jev-1.13  id: resp_42  tokens: 120 in / 9 out  cost: 0.0012",
        "",
      ].join("\n")
    );
  });

  it("prints distributions with --verbose, using the score legend", async () => {
    const io = new FakeIo({ transport: new FakeTransport([[200, fullBody]]) });
    expect(await run(["ask", "s", ...questionFlags, "--verbose"], io)).toBe(0);
    expect(io.out).toContain("    true 0.870  false 0.130\n");
    expect(io.out).toContain("    billing 0.100  auth 0.280  infra 0.620\n");
    expect(io.out).toContain(
      "    0 (cosmetic) 0.050  1 (minor) 0.100  2 (major) 0.250  3 (critical) 0.600\n"
    );
  });

  it("prints JSON with --json", async () => {
    const io = new FakeIo({
      transport: new FakeTransport([[200, fullBody, { "x-typesafe-request-id": "req_9" }]]),
    });
    expect(await run(["ask", "s", ...questionFlags, "--json"], io)).toBe(0);
    expect(io.err).toBe("");
    expect(JSON.parse(io.out)).toEqual({
      id: "resp_42",
      model: "typesafe/jev-1.13",
      requestId: "req_9",
      usage: { inputTokens: 120, outputTokens: 9, cost: 0.0012 },
      answers: JSON.parse(fullBody).answers,
    });
  });

  it("passes provider, model, base URL, timeout, and retries to the client", async () => {
    const transport = new FakeTransport([[500, "boom"], [200, fullBody]]);
    const io = new FakeIo({ transport });
    const code = await run(
      [
        "ask",
        "s",
        ...questionFlags,
        "--provider",
        "typesafe",
        "--model",
        "typesafe/jev-1.13",
        "--base-url",
        "https://proxy.example/",
        "--timeout",
        "100",
        "--max-retries",
        "0",
      ],
      io
    );
    expect(code).toBe(1);
    expect(io.err).toBe("decision-model: ApiError (status 500): api error (status 500)\nboom\n");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.url).toBe("https://proxy.example/v1/systemone");
    expect(JSON.parse(transport.requests[0]!.body).model).toBe("jev-latest");
  });

  it("reads the state from stdin when it is piped", async () => {
    const transport = new FakeTransport([[200, fullBody]]);
    const io = new FakeIo({ transport, stdin: '{"title": "piped"}\n' });
    expect(await run(["ask", ...questionFlags, "--json-state"], io)).toBe(0);
    expect(JSON.parse(transport.requests[0]!.body).state).toEqual({ title: "piped" });
  });

  it("requires a state when stdin is a terminal", async () => {
    const io = new FakeIo({ transport: new FakeTransport([]) });
    expect(await run(["ask", ...questionFlags], io)).toBe(2);
    expect(io.err).toMatch(/a state is required/);
  });

  it("rejects --json-state that is not JSON", async () => {
    const io = new FakeIo({ transport: new FakeTransport([]) });
    expect(await run(["ask", "not json", "--json-state", ...questionFlags], io)).toBe(2);
    expect(io.err).toMatch(/--json-state: the state is not valid JSON/);
  });

  it("requires at least one question", async () => {
    const io = new FakeIo({ transport: new FakeTransport([]) });
    expect(await run(["ask", "s"], io)).toBe(2);
    expect(io.err).toMatch(/at least one question is required/);
  });

  describe("@ inputs", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "decision-model-cli-"));
      await writeFile(join(dir, "issue.json"), '{"title": "from file"}');
      await writeFile(
        join(dir, "questions.json"),
        JSON.stringify({ spam: { type: "noul", instructions: "Spam?" } })
      );
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it("reads the state and questions from files and merges with flags", async () => {
      const transport = new FakeTransport([[200, fullBody]]);
      const io = new FakeIo({ transport });
      const code = await run(
        [
          "ask",
          `@${join(dir, "issue.json")}`,
          "--json-state",
          ...questionFlags,
          "--questions",
          `@${join(dir, "questions.json")}`,
        ],
        io
      );
      // The fake body has no "spam" answer, so the client reports it missing.
      expect(code).toBe(1);
      expect(io.err).toBe("decision-model: MissingAnswers: missing or wrong-type answers for: spam\n");
      const body = JSON.parse(transport.requests[0]!.body);
      expect(body.state).toEqual({ title: "from file" });
      expect(Object.keys(body.questions)).toEqual(["urgent", "team", "severity", "spam"]);
    });

    it("reads questions from stdin with @-", async () => {
      const transport = new FakeTransport([[200, fullBody]]);
      const io = new FakeIo({
        transport,
        stdin: JSON.stringify({ urgent: { type: "noul", instructions: "Urgent?" } }),
      });
      // Answers for questions that were not asked are ignored, so this succeeds.
      expect(await run(["ask", "s", "--questions", "@-"], io)).toBe(0);
      expect(io.out).toBe(
        "urgent  noul  0.870\n\nmodel: typesafe/jev-1.13  id: resp_42  tokens: 120 in / 9 out  cost: 0.0012\n"
      );
      expect(JSON.parse(transport.requests[0]!.body).questions).toEqual({
        urgent: { type: "noul", instructions: "Urgent?" },
      });
    });

    it("refuses to read stdin twice", async () => {
      const io = new FakeIo({ transport: new FakeTransport([]), stdin: "x" });
      expect(await run(["ask", "@-", "--questions", "@-"], io)).toBe(2);
      expect(io.err).toMatch(/stdin was already read/);
    });

    it("reports an unreadable file", async () => {
      const io = new FakeIo({ transport: new FakeTransport([]) });
      expect(await run(["ask", `@${join(dir, "missing.txt")}`, ...questionFlags], io)).toBe(2);
      expect(io.err).toMatch(/state: could not read ".*missing\.txt": ENOENT/);
    });
  });

  it("reports a missing API key as a configuration error", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
      const io = new FakeIo();
      expect(await run(["ask", "s", ...questionFlags], io)).toBe(2);
      expect(io.err).toBe(
        "decision-model: no provider configured: pass provider or apiKey, or set one of TYPESAFE_API_KEY, OPENROUTER_API_KEY\n"
      );

      const named = new FakeIo();
      expect(await run(["ask", "s", ...questionFlags, "--provider", "typesafe"], named)).toBe(2);
      expect(named.err).toMatch(/set TYPESAFE_API_KEY/);

      const unknown = new FakeIo();
      expect(await run(["ask", "s", ...questionFlags, "--provider", "acme"], unknown)).toBe(2);
      expect(unknown.err).toMatch(/unknown provider "acme"/);
    });
  });

  it("names the root cause of a transport failure", async () => {
    const io = new FakeIo({ transport: new FakeTransport([connectionError("ECONNREFUSED")]) });
    expect(await run(["ask", "s", ...questionFlags, "--max-retries", "0"], io)).toBe(1);
    expect(io.err).toBe("decision-model: TransportError: transport error: fetch failed (ECONNREFUSED)\n");
  });

  it("truncates long error bodies", async () => {
    const io = new FakeIo({ transport: new FakeTransport([[401, "x".repeat(600)]]) });
    expect(await run(["ask", "s", ...questionFlags], io)).toBe(1);
    expect(io.err).toBe(`decision-model: Unauthorized (status 401): unauthorized\n${"x".repeat(500)}…\n`);
  });

  it("lists providers and which one the environment selects", async () => {
    await withEnv({ TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: undefined }, async () => {
      const io = new FakeIo();
      expect(await run(["providers"], io)).toBe(0);
      expect(io.out).toBe(
        [
          "NAME         ENV VAR             DEFAULT MODEL      URL                                        API KEY",
          "open-router  OPENROUTER_API_KEY  typesafe/jev-1.13  https://openrouter.ai/api/alpha/decisions  not set",
          "typesafe     TYPESAFE_API_KEY    jev-latest         https://api.typesafe.ai/v1/systemone       set",
          "",
          "default: typesafe (TYPESAFE_API_KEY is set)",
          "",
        ].join("\n")
      );
    });
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
      const io = new FakeIo();
      expect(await run(["providers"], io)).toBe(0);
      expect(io.out).toContain("default: none (set TYPESAFE_API_KEY or OPENROUTER_API_KEY)");
    });
  });
});
