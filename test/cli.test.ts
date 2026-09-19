import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import type { ClientOptions } from "../src/index.js";
import { colorEnabled, createStyle, PLAIN } from "../src/cli/color.js";
import { formatHuman, headline, table } from "../src/cli/format.js";
import {
  mergeQuestions,
  parseArgv,
  parseInputJson,
  parseQuestionSpec,
  parseQuestionsJson,
  UsageError,
} from "../src/cli/parse.js";
import { run, type CliIo } from "../src/cli/run.js";
import { DecisionResponse } from "../src/response.js";
import { connectionError, FakeTransport, withEnv } from "./helpers.js";

/** Captures output, serves scripted stdin, and ticks a fake clock. */
class FakeIo implements CliIo {
  out = "";
  err = "";
  readonly stdout: CliIo["stdout"];
  readonly stderr = { write: (chunk: string) => (this.err += chunk) };
  readonly stdin: CliIo["stdin"];
  readonly env: NodeJS.ProcessEnv;
  clientOptions?: ClientOptions;
  private ticks = 0;

  constructor(
    options: { stdin?: string | undefined; transport?: FakeTransport; tty?: boolean; env?: NodeJS.ProcessEnv } = {}
  ) {
    this.stdout = { write: (chunk: string) => (this.out += chunk), isTTY: options.tty === true };
    const text = options.stdin;
    this.stdin = { piped: text !== undefined, read: async () => text ?? "" };
    this.env = options.env ?? {};
    if (options.transport !== undefined) {
      this.clientOptions = { apiKey: "test-key", transport: options.transport.call };
    }
  }

  /** The first call is the start, the second the end: every request takes 1234 ms. */
  now = (): number => (this.ticks++ === 0 ? 0 : 1234);
}

const answers = {
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
} as const;

const fullBody = JSON.stringify({
  id: "resp_42",
  model: "typesafe/jev-1.13",
  answers,
  usage: { input_tokens: 120, output_tokens: 9, cost: 0.0012 },
});

/** A body answering a single-question command, which uses the id "answer". */
function singleBody(answer: (typeof answers)[keyof typeof answers]): string {
  return JSON.stringify({ model: "typesafe/jev-1.13", answers: { answer }, usage: {} });
}

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

const FOOTER = "typesafe/jev-1.13 · 120 in / 9 out tokens · cost 0.0012 · 1.2s · id resp_42";

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

  it("rejects specs without an id or without labels, with an example and the verb form", () => {
    expect(() => parseQuestionSpec("noul", "Is this urgent?")).toThrow(/needs an id before "="/);
    expect(() => parseQuestionSpec("noul", "=Is this urgent?")).toThrow(/must not be empty or contain spaces/);
    expect(() => parseQuestionSpec("noul", "my id=Is this urgent?")).toThrow(/contain spaces/);
    expect(() => parseQuestionSpec("choice", "team=Which team?")).toThrow(/needs labels after a "\|"/);
    expect(() => parseQuestionSpec("choice", "team=Which team?|a,,b")).toThrow(/labels must not be empty/);
    expect(() => parseQuestionSpec("choice", "team=Which team?|a,b,a")).toThrow(/"a" is listed twice/);

    try {
      parseQuestionSpec("choice", "team=oops");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).hints).toEqual([
        'Example: --choice team="Which team owns this?|billing,auth,infra"',
        'For one question, no quoting is needed: decision-model choose "Which team owns this?" billing auth infra -f issue.json',
      ]);
    }
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
    expect(() => parseQuestionsJson("{nope")).toThrow(/--questions is not valid JSON/);
    expect(() => parseQuestionsJson("[1]")).toThrow(/JSON object keyed by question id/);
    expect(() => parseQuestionsJson('{"q": 1}')).toThrow(/question "q": must be an object/);
    expect(() => parseQuestionsJson('{"q": {"type": "essay"}}')).toThrow(/"type" must be/);
    expect(() => parseQuestionsJson('{"q": {"type": "choice", "instructions": "x", "criteria": {}}}')).toThrow(
      /question "q": criteria must be an object with 1..255 entries/
    );
  });
});

describe("parseInputJson", () => {
  it("returns the state untouched and the questions validated", () => {
    const input = parseInputJson(
      JSON.stringify({ state: { title: "x" }, questions: { q: { type: "noul", instructions: "Q?" } } })
    );
    expect(input).toEqual({ state: { title: "x" }, questions: { q: { type: "noul", instructions: "Q?" } } });
  });

  it("names what is missing", () => {
    expect(() => parseInputJson("[]")).toThrow(/--input must be a JSON object/);
    expect(() => parseInputJson('{"questions": {}}')).toThrow(/missing "state"/);
    expect(() => parseInputJson('{"state": 1}')).toThrow(/missing "questions"/);
    expect(() => parseInputJson('{"state": 1, "questions": []}')).toThrow(/--input "questions" must be a JSON object/);
    expect(() => parseInputJson('{"state": null, "questions": {}}')).toThrow(/--input "state" must not be null/);
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
    expect(parseArgv(["help", "all"])).toEqual({ kind: "help", topic: "all", exitCode: 0 });
    expect(parseArgv(["ask", "-h"])).toEqual({ kind: "help", topic: "ask", exitCode: 0 });
    expect(parseArgv(["yesno", "--help"])).toEqual({ kind: "help", topic: "yesno", exitCode: 0 });
    expect(parseArgv(["providers", "--help"])).toEqual({ kind: "help", topic: "providers", exitCode: 0 });
    expect(parseArgv(["--version"])).toEqual({ kind: "version" });
    expect(parseArgv(["providers"])).toEqual({ kind: "providers", verbose: false });
    expect(parseArgv(["providers", "-v"])).toEqual({ kind: "providers", verbose: true });
    expect(() => parseArgv(["help", "nope"])).toThrow(/no help topic "nope"/);
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
        state: undefined,
        positionalState: "the state",
        file: undefined,
        jsonState: false,
        noul: ["urgent=Is this urgent?"],
        choice: ["team=Which team owns this?|billing,auth,infra"],
        score: ["severity=How severe is this?|cosmetic,minor,major,critical"],
        questions: undefined,
        input: undefined,
        provider: "typesafe",
        model: "jev",
        baseUrl: "https://proxy.example",
        timeout: 1500,
        maxRetries: 0,
        json: true,
        quiet: false,
        verbose: true,
        noColor: false,
        dryRun: false,
      },
    });
  });

  it("parses the single-question verbs with their labels", () => {
    const yesno = parseArgv(["yesno", "Urgent?", "-s", "state", "--threshold", "0.8", "--check", "-q"]);
    expect(yesno).toMatchObject({
      kind: "single",
      options: { verb: "yesno", question: "Urgent?", labels: [], threshold: 0.8, check: true, state: "state", quiet: true },
    });

    const choose = parseArgv(["choose", "Which team?", "billing", "platform infra", "-f", "issue.json"]);
    expect(choose).toMatchObject({
      kind: "single",
      options: { verb: "choose", question: "Which team?", labels: ["billing", "platform infra"], threshold: 0.5, check: false, file: "issue.json" },
    });

    const scored = parseArgv(["score", "How bad?", "low", "high", "--dry-run", "--no-color"]);
    expect(scored).toMatchObject({
      kind: "single",
      options: { verb: "score", question: "How bad?", labels: ["low", "high"], dryRun: true, noColor: true },
    });
  });

  it("rejects malformed verb arguments with an example", () => {
    expect(() => parseArgv(["yesno"])).toThrow(/yesno needs a question/);
    expect(() => parseArgv(["yesno", "Urgent?", "extra"])).toThrow(/yesno takes only a question, got an extra argument "extra"/);
    expect(() => parseArgv(["choose", "Which?"])).toThrow(/choose needs at least one label/);
    expect(() => parseArgv(["choose", "Which?", "a", "a"])).toThrow(/label "a" is listed twice/);
    expect(() => parseArgv(["score", "How?", "only"])).toThrow(/score needs 2 to 10 levels .* got 1/);
    expect(() => parseArgv(["score", "How?", ...Array.from({ length: 11 }, (_, i) => `l${i}`)])).toThrow(/got 11/);
    expect(() => parseArgv(["yesno", "Q?", "--threshold", "2"])).toThrow(/--threshold expects a number between 0 and 1/);
    expect(() => parseArgv(["choose", "Q?", "a", "--check"])).toThrow(/Unknown option '--check'/);
  });

  it("rejects conflicting inputs", () => {
    expect(() => parseArgv(["ask", "a", "--state", "b"])).toThrow(/given twice: as an argument and with --state/);
    expect(() => parseArgv(["ask", "-s", "a", "-f", "b"])).toThrow(/given twice: with --state and with --file/);
    expect(() => parseArgv(["ask", "a", "b"])).toThrow(/ask takes at most one state argument, got "b"/);
    expect(() => parseArgv(["ask", "--input", "-", "-s", "x", "--noul", "q=Q?"])).toThrow(
      /--input cannot be combined with a state, question flags/
    );
    expect(() => parseArgv(["ask", "--input", "-", "--questions", "q.json", "--json-state"])).toThrow(
      /--input cannot be combined with --json-state, --questions/
    );
  });

  it("rejects unknown commands with a suggestion, and bad options and numbers", () => {
    try {
      parseArgv(["asks"]);
      expect.unreachable();
    } catch (error) {
      expect((error as UsageError).message).toBe('unknown command "asks"');
      expect((error as UsageError).hints).toEqual(['Did you mean "ask"?']);
    }
    expect(() => parseArgv(["decide"])).toThrow(/unknown command "decide"/);
    expect(() => parseArgv(["ask", "--nope"])).toThrow(/Unknown option '--nope'/);
    expect(() => parseArgv(["ask", "--timeout", "soon"])).toThrow(/--timeout expects a non-negative integer/);
    expect(() => parseArgv(["ask", "--max-retries", "-1"])).toThrow(UsageError);
    expect(() => parseArgv(["providers", "extra"])).toThrow(/providers takes no arguments/);
  });
});

describe("table", () => {
  it("pads every column but the last, styling after padding", () => {
    expect(table([["a", "bb", "c"], ["dddd", "e", ""]])).toEqual(["a     bb  c", "dddd  e"]);
    const upper = (text: string) => text.toUpperCase();
    expect(table([["a", "b"], ["ccc", "d"]], [upper])).toEqual(["A    b", "CCC  d"]);
  });
});

describe("headline", () => {
  it("splits yes/no at the threshold and reports the probability of that side", () => {
    expect(headline(answers.urgent, 0.5)).toMatchObject({ answer: "yes", confidence: 0.87, detail: "" });
    expect(headline(answers.urgent, 0.9)).toMatchObject({ answer: "no", confidence: 0.13 });
    expect(headline(answers.urgent, 0.5).distribution).toEqual([
      { label: "yes", probability: 0.87 },
      { label: "no", probability: 0.13 },
    ]);
  });

  it("lists a choice's runners-up in descending order", () => {
    expect(headline(answers.team, 0.5)).toMatchObject({
      answer: "infra",
      confidence: 0.62,
      detail: "auth 28% · billing 10%",
    });
    const bare = headline({ type: "choice", choice: "x", confidence: 0.4, probabilities: {} }, 0.5);
    expect(bare).toMatchObject({ answer: "x", confidence: 0.4, detail: "", distribution: [{ label: "x", probability: 0.4 }] });
  });

  it("names the level nearest the score and keeps the number in the detail", () => {
    expect(headline(answers.severity, 0.5)).toMatchObject({
      answer: "major",
      confidence: 0.25,
      detail: "2.40 on a 0–3 scale · critical 60% · minor 10% · cosmetic 5%",
    });
    expect(headline(answers.severity, 0.5).distribution.map((entry) => entry.label)).toEqual([
      "0 cosmetic",
      "1 minor",
      "2 major",
      "3 critical",
    ]);
    const unlabeled = headline(
      { type: "score", score: 1.6, confidence: 0.7, probabilities: { "0": 0.3, "1": 0.7 }, legend: {} },
      0.5
    );
    expect(unlabeled).toMatchObject({ answer: "level 1", confidence: 0.7, detail: "1.60 on a 0–1 scale · level 0 30%" });
  });
});

describe("colorEnabled", () => {
  it("follows the flag, then the environment, then the terminal", () => {
    expect(colorEnabled({ isTTY: true, env: {}, disabled: false })).toBe(true);
    expect(colorEnabled({ isTTY: false, env: {}, disabled: false })).toBe(false);
    expect(colorEnabled({ isTTY: true, env: {}, disabled: true })).toBe(false);
    expect(colorEnabled({ isTTY: true, env: { NO_COLOR: "1" }, disabled: false })).toBe(false);
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "1" }, disabled: false })).toBe(true);
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "0" }, disabled: false })).toBe(false);
    expect(colorEnabled({ isTTY: false, env: { FORCE_COLOR: "1" }, disabled: true })).toBe(false);
  });
});

describe("formatHuman", () => {
  const response = new DecisionResponse({
    answers: { urgent: { type: "noul", noul: 0.5, probabilities: {} } },
    usage: { inputTokens: null, outputTokens: null, cost: null },
    model: null,
    id: null,
    raw: {},
  });
  const base = { style: PLAIN, verbose: false, showIds: true, threshold: 0.5, provider: "typesafe", elapsedMs: 1040 };

  it("prints an answer line and a footer with whatever is known", () => {
    expect(formatHuman(response, base)).toBe("urgent  yes  50%\n1.0s\n");
    expect(formatHuman(response, { ...base, showIds: false })).toBe("yes  50%\n1.0s\n");
  });

  it("derives the yes/no distribution and names the provider when verbose", () => {
    expect(formatHuman(response, { ...base, verbose: true })).toBe(
      "urgent  yes  50%\n        yes  50%\n        no   50%\ntypesafe · 1.0s\n"
    );
  });

  it("styles the answer, colours the confidence by size, and draws bars when enabled", () => {
    const style = createStyle(true);
    const styled = formatHuman(response, { ...base, style, verbose: true, showIds: false });
    expect(styled).toContain(style.bold("yes"));
    expect(styled).toContain(style.yellow("50%"));
    expect(styled).toContain(style.cyan("██████████") + style.dim("░░░░░░░░░░"));
    const confident = new DecisionResponse({ ...response, answers: { u: { type: "noul", noul: 0.9, probabilities: {} } }, raw: {} });
    expect(formatHuman(confident, { ...base, style })).toContain(style.green("90%"));
  });
});

describe("run", () => {
  it("prints help to stdout with --help and to stderr with no command", async () => {
    const help = new FakeIo();
    expect(await run(["--help"], help)).toBe(0);
    expect(help.out).toMatch(/^Usage: decision-model <command>/);
    expect(help.out).toContain('yesno  "<question>"');

    const bare = new FakeIo();
    expect(await run([], bare)).toBe(2);
    expect(bare.out).toBe("");
    expect(bare.err).toMatch(/^Usage: decision-model <command>/);

    const ask = new FakeIo();
    expect(await run(["ask", "--help"], ask)).toBe(0);
    expect(ask.out).toMatch(/^Usage: decision-model ask/);
    expect(ask.out).toContain("--choice <id>=<instructions>|<label>,...");
    expect(ask.out).toContain("--input <file|->");

    const all = new FakeIo();
    expect(await run(["help", "all"], all)).toBe(0);
    for (const section of ["Usage: decision-model yesno", "Usage: decision-model choose", "Usage: decision-model score", "Usage: decision-model ask", "Usage: decision-model providers", "Questions wire format", "JSON output", "Dry run"]) {
      expect(all.out).toContain(section);
    }
  });

  it("prints the version", async () => {
    const io = new FakeIo();
    expect(await run(["--version"], io)).toBe(0);
    expect(io.out).toBe(`${VERSION}\n`);
  });

  it("reports usage errors with hints and exit code 2, as JSON when --json is given", async () => {
    const io = new FakeIo();
    expect(await run(["ask", "state", "--bogus"], io)).toBe(2);
    expect(io.err).toBe("decision-model: Unknown option '--bogus'\n  Run 'decision-model help ask' for usage.\n");

    const typo = new FakeIo();
    expect(await run(["asks"], typo)).toBe(2);
    expect(typo.err).toBe('decision-model: unknown command "asks"\n  Did you mean "ask"?\n  Run \'decision-model help\' for usage.\n');

    const json = new FakeIo();
    expect(await run(["choose", "Q?", "--json"], json)).toBe(2);
    expect(json.out).toBe("");
    expect(JSON.parse(json.err)).toEqual({
      error: { type: "UsageError", message: "choose needs at least one label after the question", retryable: false },
    });
  });

  it("asks with flag-built questions and prints answers with a footer", async () => {
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
        "urgent    yes    87%",
        "team      infra  62%  auth 28% · billing 10%",
        "severity  major  25%  2.40 on a 0–3 scale · critical 60% · minor 10% · cosmetic 5%",
        FOOTER,
        "",
      ].join("\n")
    );
  });

  it("prints distributions under each answer with --verbose", async () => {
    const io = new FakeIo({ transport: new FakeTransport([[200, fullBody]]) });
    expect(await run(["ask", "s", ...questionFlags, "--verbose"], io)).toBe(0);
    expect(io.out).toBe(
      [
        "urgent    yes    87%",
        "          yes  87%",
        "          no   13%",
        "team      infra  62%  auth 28% · billing 10%",
        "          infra    62%",
        "          auth     28%",
        "          billing  10%",
        "severity  major  25%  2.40 on a 0–3 scale · critical 60% · minor 10% · cosmetic 5%",
        "          0 cosmetic  5%",
        "          1 minor     10%",
        "          2 major     25%",
        "          3 critical  60%",
        `open-router · ${FOOTER}`,
        "",
      ].join("\n")
    );
  });

  it("prints only ids and answers with --quiet", async () => {
    const io = new FakeIo({ transport: new FakeTransport([[200, fullBody]]) });
    expect(await run(["ask", "s", ...questionFlags, "-q"], io)).toBe(0);
    expect(io.out).toBe("urgent\tyes\nteam\tinfra\nseverity\tmajor\n");
  });

  it("prints JSON with --json, adding the provider and elapsed time", async () => {
    const io = new FakeIo({
      transport: new FakeTransport([[200, fullBody, { "x-typesafe-request-id": "req_9" }]]),
    });
    expect(await run(["ask", "s", ...questionFlags, "--json"], io)).toBe(0);
    expect(io.err).toBe("");
    expect(JSON.parse(io.out)).toEqual({
      provider: "open-router",
      model: "typesafe/jev-1.13",
      id: "resp_42",
      requestId: "req_9",
      elapsedMs: 1234,
      usage: { inputTokens: 120, outputTokens: 9, cost: 0.0012 },
      answers,
    });
  });

  it("colours output for a terminal and keeps it plain when piped or asked", async () => {
    const tty = new FakeIo({ transport: new FakeTransport([[200, fullBody]]), tty: true });
    await run(["ask", "s", ...questionFlags], tty);
    expect(tty.out).toContain("[1minfra[22m");

    const piped = new FakeIo({ transport: new FakeTransport([[200, fullBody]]) });
    await run(["ask", "s", ...questionFlags], piped);
    expect(piped.out).not.toContain("[");

    const flagged = new FakeIo({ transport: new FakeTransport([[200, fullBody]]), tty: true });
    await run(["ask", "s", ...questionFlags, "--no-color"], flagged);
    expect(flagged.out).not.toContain("[");

    const forced = new FakeIo({ transport: new FakeTransport([[200, fullBody]]), env: { FORCE_COLOR: "1" } });
    await run(["ask", "s", ...questionFlags, "-v"], forced);
    expect(forced.out).toContain("█");
  });

  describe("single-question verbs", () => {
    it("yesno prints yes or no with its probability, using the id answer", async () => {
      const transport = new FakeTransport([[200, singleBody(answers.urgent)]]);
      const io = new FakeIo({ transport });
      expect(await run(["yesno", "Is this urgent?", "-s", "Server 500"], io)).toBe(0);
      expect(JSON.parse(transport.requests[0]!.body)).toEqual({
        model: "typesafe/jev-1.13",
        state: "Server 500",
        questions: { answer: { type: "noul", instructions: "Is this urgent?" } },
      });
      expect(io.out).toBe("yes  87%\ntypesafe/jev-1.13 · 1.2s\n");

      const quiet = new FakeIo({ transport: new FakeTransport([[200, singleBody(answers.urgent)]]) });
      expect(await run(["yesno", "-q", "Is this urgent?", "-s", "x"], quiet)).toBe(0);
      expect(quiet.out).toBe("yes\n");

      const strict = new FakeIo({ transport: new FakeTransport([[200, singleBody(answers.urgent)]]) });
      expect(await run(["yesno", "Q?", "-s", "x", "--threshold", "0.9"], strict)).toBe(0);
      expect(strict.out).toMatch(/^no  13%\n/);
    });

    it("yesno --check answers with the exit status and prints nothing", async () => {
      const yes = new FakeIo({ transport: new FakeTransport([[200, singleBody(answers.urgent)]]) });
      expect(await run(["yesno", "--check", "Q?", "-s", "x"], yes)).toBe(0);
      expect(yes.out).toBe("");

      const no = new FakeIo({ transport: new FakeTransport([[200, singleBody(answers.urgent)]]) });
      expect(await run(["yesno", "--check", "--threshold", "0.9", "Q?", "-s", "x"], no)).toBe(1);
      expect(no.out).toBe("");

      const failed = new FakeIo({ transport: new FakeTransport([[500, "boom"]]) });
      expect(await run(["yesno", "--check", "Q?", "-s", "x", "--max-retries", "0"], failed)).toBe(3);
      expect(failed.err).toMatch(/^decision-model: api error \(status 500\)\nboom\n$/);

      const json = new FakeIo({ transport: new FakeTransport([[200, singleBody(answers.urgent)]]) });
      expect(await run(["yesno", "--check", "--json", "Q?", "-s", "x"], json)).toBe(0);
      expect(JSON.parse(json.out).answers.answer.noul).toBe(0.87);
    });

    it("choose sends the labels as null criteria, spaces included", async () => {
      const transport = new FakeTransport([[200, singleBody(answers.team)]]);
      const io = new FakeIo({ transport });
      expect(await run(["choose", "Which team?", "billing", "auth", "platform infra", "-s", "x"], io)).toBe(0);
      expect(JSON.parse(transport.requests[0]!.body).questions).toEqual({
        answer: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: null, auth: null, "platform infra": null },
        },
      });
      expect(io.out).toBe("infra  62%  auth 28% · billing 10%\ntypesafe/jev-1.13 · 1.2s\n");
    });

    it("score sends the levels in order and prints the nearest one", async () => {
      const transport = new FakeTransport([[200, singleBody(answers.severity)]]);
      const io = new FakeIo({ transport });
      expect(await run(["score", "How severe?", "cosmetic", "minor", "major", "critical", "-s", "x", "-q"], io)).toBe(0);
      expect(JSON.parse(transport.requests[0]!.body).questions).toEqual({
        answer: { type: "score", instructions: "How severe?", criteria: ["cosmetic", "minor", "major", "critical"] },
      });
      expect(io.out).toBe("major\n");
    });
  });

  describe("state sources", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "decision-model-cli-"));
      await writeFile(join(dir, "issue.json"), '{"title": "from file"}');
      await writeFile(join(dir, "issue.txt"), "plain text state");
      await writeFile(join(dir, "broken.json"), "{nope");
      await writeFile(
        join(dir, "questions.json"),
        JSON.stringify({ spam: { type: "noul", instructions: "Spam?" } })
      );
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    async function stateSentBy(argv: string[], stdin?: string): Promise<unknown> {
      const transport = new FakeTransport([[200, singleBody(answers.urgent)]]);
      const io = new FakeIo({ transport, stdin });
      const code = await run(argv, io);
      expect(io.err).toBe("");
      expect(code).toBe(0);
      return JSON.parse(transport.requests[0]!.body).state;
    }

    it("reads -f as text, parsing .json files and anything with --json-state", async () => {
      expect(await stateSentBy(["yesno", "Q?", "-f", join(dir, "issue.txt")])).toBe("plain text state");
      expect(await stateSentBy(["yesno", "Q?", "-f", join(dir, "issue.json")])).toEqual({ title: "from file" });
      expect(await stateSentBy(["yesno", "Q?", "-f", "-"], "from stdin")).toBe("from stdin");
      expect(await stateSentBy(["yesno", "Q?", "-f", "-", "--json-state"], '{"a": 1}')).toEqual({ a: 1 });
    });

    it("reads piped stdin when no state is given, and sends an empty state otherwise", async () => {
      expect(await stateSentBy(["yesno", "Q?"], "piped")).toBe("piped");
      const transport = new FakeTransport([[200, fullBody]]);
      expect(await run(["ask", ...questionFlags, "--json-state"], new FakeIo({ transport, stdin: '{"title": "piped"}\n' }))).toBe(0);
      expect(JSON.parse(transport.requests[0]!.body).state).toEqual({ title: "piped" });

      const bare = new FakeTransport([[200, singleBody(answers.team)]]);
      const io = new FakeIo({ transport: bare });
      expect(await run(["choose", "The toilet paper roll goes:", "over", "under"], io)).toBe(0);
      expect(JSON.parse(bare.requests[0]!.body).state).toBe("");
      expect(io.err).toBe("");
      expect(io.out).toMatch(/^infra  62%/);
    });

    it("still accepts @path and @- as the ask positional", async () => {
      expect(await stateSentBy(["ask", `@${join(dir, "issue.json")}`, "--noul", "answer=Q?"])).toEqual({ title: "from file" });
      expect(await stateSentBy(["ask", "@-", "--noul", "answer=Q?"], "old style")).toBe("old style");
    });

    it("reports unreadable and unparsable files", async () => {
      const missing = new FakeIo({ transport: new FakeTransport([]) });
      expect(await run(["yesno", "Q?", "-f", join(dir, "missing.txt")], missing)).toBe(2);
      expect(missing.err).toMatch(/--file: could not read ".*missing\.txt": ENOENT/);

      const broken = new FakeIo({ transport: new FakeTransport([]) });
      expect(await run(["yesno", "Q?", "-f", join(dir, "broken.json")], broken)).toBe(2);
      expect(broken.err).toMatch(/--file .*broken\.json: the state is not valid JSON/);

      const flagged = new FakeIo({ transport: new FakeTransport([]) });
      expect(await run(["yesno", "Q?", "-s", "not json", "--json-state"], flagged)).toBe(2);
      expect(flagged.err).toMatch(/--json-state: the state is not valid JSON/);
    });

    it("reads --questions inline, from a file, from stdin, and merges with flags", async () => {
      const inline = new FakeTransport([[200, fullBody]]);
      const inlineIo = new FakeIo({ transport: inline });
      expect(await run(["ask", "s", "--questions", '{"urgent": {"type": "noul", "instructions": "Urgent?"}}'], inlineIo)).toBe(0);
      expect(JSON.parse(inline.requests[0]!.body).questions).toEqual({ urgent: { type: "noul", instructions: "Urgent?" } });

      const file = new FakeTransport([[200, fullBody]]);
      const fileIo = new FakeIo({ transport: file });
      // The fake body has no "spam" answer, so the client reports it missing.
      expect(await run(["ask", "s", ...questionFlags, "--questions", join(dir, "questions.json")], fileIo)).toBe(1);
      expect(fileIo.err).toBe("decision-model: missing or wrong-type answers for: spam\n");
      expect(Object.keys(JSON.parse(file.requests[0]!.body).questions)).toEqual(["urgent", "team", "severity", "spam"]);

      const compat = new FakeTransport([[200, fullBody]]);
      expect(await run(["ask", "s", "--questions", `@${join(dir, "questions.json")}`], new FakeIo({ transport: compat }))).toBe(1);
      expect(Object.keys(JSON.parse(compat.requests[0]!.body).questions)).toEqual(["spam"]);

      const stdin = new FakeTransport([[200, fullBody]]);
      const stdinIo = new FakeIo({ transport: stdin, stdin: JSON.stringify({ urgent: { type: "noul", instructions: "Urgent?" } }) });
      expect(await run(["ask", "s", "--questions", "-"], stdinIo)).toBe(0);
      expect(stdinIo.out).toBe(`urgent  yes  87%\n${FOOTER}\n`);
    });

    it("refuses to read stdin twice and requires at least one question", async () => {
      const twice = new FakeIo({ transport: new FakeTransport([]), stdin: "x" });
      expect(await run(["ask", "-f", "-", "--questions", "-"], twice)).toBe(2);
      expect(twice.err).toMatch(/--questions: stdin was already read/);

      const none = new FakeIo({ transport: new FakeTransport([]) });
      expect(await run(["ask", "s"], none)).toBe(2);
      expect(none.err).toMatch(/at least one question is required\n  Add --noul, --choice, --score, --questions, or --input\./);
    });

    it("takes a whole request from --input", async () => {
      const transport = new FakeTransport([[200, fullBody]]);
      const io = new FakeIo({
        transport,
        stdin: JSON.stringify({ state: { title: "doc" }, questions: { urgent: { type: "noul", instructions: "Urgent?" } } }),
      });
      expect(await run(["ask", "--input", "-", "-q"], io)).toBe(0);
      expect(JSON.parse(transport.requests[0]!.body)).toEqual({
        model: "typesafe/jev-1.13",
        state: { title: "doc" },
        questions: { urgent: { type: "noul", instructions: "Urgent?" } },
      });
      expect(io.out).toBe("urgent\tyes\n");

      const bad = new FakeIo({ transport: new FakeTransport([]), stdin: '{"state": 1}' });
      expect(await run(["ask", "--input", "-"], bad)).toBe(2);
      expect(bad.err).toMatch(/--input is missing "questions"/);
    });
  });

  it("prints the request with --dry-run and never calls the transport or needs a key", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
      const transport = new FakeTransport([]);
      const io = new FakeIo();
      expect(await run(["choose", "Which?", "a", "b", "-s", "x", "--dry-run", "--model", "jev"], io)).toBe(0);
      expect(transport.requests).toHaveLength(0);
      // The alias resolves exactly as it would for a real request.
      expect(JSON.parse(io.out)).toEqual({
        provider: "open-router",
        model: "typesafe/jev-1.13",
        url: "https://openrouter.ai/api/alpha/decisions",
        request: {
          model: "typesafe/jev-1.13",
          state: "x",
          questions: { answer: { type: "choice", instructions: "Which?", criteria: { a: null, b: null } } },
        },
      });
    });
    await withEnv({ TYPESAFE_API_KEY: "t" }, async () => {
      const io = new FakeIo();
      expect(await run(["yesno", "Q?", "-s", "x", "--dry-run", "--base-url", "https://proxy.example/"], io)).toBe(0);
      expect(JSON.parse(io.out)).toMatchObject({ provider: "typesafe", model: "jev-latest", url: "https://proxy.example/v1/systemone" });
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
    expect(io.err).toBe("decision-model: api error (status 500)\nboom\n");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.url).toBe("https://proxy.example/v1/systemone");
    expect(JSON.parse(transport.requests[0]!.body).model).toBe("jev-latest");
  });

  it("explains a missing API key in CLI terms", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
      const io = new FakeIo();
      expect(await run(["yesno", "Q?", "-s", "x"], io)).toBe(2);
      expect(io.err).toBe(
        [
          "decision-model: no API key found",
          "  Set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or pass --provider with its key in the environment.",
          "  Run 'decision-model providers' to see what is set.",
          "  Run 'decision-model help yesno' for usage.",
          "",
        ].join("\n")
      );

      const named = new FakeIo();
      expect(await run(["ask", "s", ...questionFlags, "--provider", "typesafe"], named)).toBe(2);
      expect(named.err).toMatch(/^decision-model: no API key for typesafe\n  Set TYPESAFE_API_KEY in the environment\./);

      const unknown = new FakeIo();
      expect(await run(["ask", "s", ...questionFlags, "--provider", "acme"], unknown)).toBe(2);
      expect(unknown.err).toMatch(/unknown provider "acme"; known providers: open-router, typesafe\n  Run 'decision-model providers' to list them\./);

      const json = new FakeIo();
      expect(await run(["yesno", "Q?", "-s", "x", "--json"], json)).toBe(2);
      expect(JSON.parse(json.err)).toEqual({ error: { type: "UsageError", message: "no API key found", retryable: false } });
    });
  });

  it("names the root cause of a transport failure", async () => {
    const io = new FakeIo({ transport: new FakeTransport([connectionError("ECONNREFUSED")]) });
    expect(await run(["ask", "s", ...questionFlags, "--max-retries", "0"], io)).toBe(1);
    expect(io.err).toBe("decision-model: transport error: fetch failed (ECONNREFUSED)\n");
  });

  it("truncates long error bodies", async () => {
    const io = new FakeIo({ transport: new FakeTransport([[401, "x".repeat(600)]]) });
    expect(await run(["ask", "s", ...questionFlags], io)).toBe(1);
    expect(io.err).toBe(`decision-model: unauthorized (status 401)\n${"x".repeat(500)}…\n`);
  });

  it("reports failures as one JSON line on stderr with --json", async () => {
    const denied = new FakeIo({
      transport: new FakeTransport([[401, "bad key", { "x-typesafe-request-id": "req_7" }]]),
    });
    expect(await run(["yesno", "Q?", "-s", "x", "--json"], denied)).toBe(1);
    expect(denied.out).toBe("");
    expect(denied.err.endsWith("\n")).toBe(true);
    expect(JSON.parse(denied.err)).toEqual({
      error: { type: "Unauthorized", message: "unauthorized (status 401)", status: 401, requestId: "req_7", retryable: false },
    });

    const limited = new FakeIo({ transport: new FakeTransport([[429, ""]]) });
    expect(await run(["yesno", "Q?", "-s", "x", "--json", "--max-retries", "0"], limited)).toBe(1);
    expect(JSON.parse(limited.err)).toEqual({
      error: { type: "RateLimited", message: "rate limited (status 429)", status: 429, requestId: null, retryable: true },
    });

    const offline = new FakeIo({ transport: new FakeTransport([connectionError("ENOTFOUND")]) });
    expect(await run(["yesno", "Q?", "-s", "x", "--json", "--max-retries", "0"], offline)).toBe(1);
    expect(JSON.parse(offline.err)).toEqual({
      error: { type: "TransportError", message: "transport error: fetch failed (ENOTFOUND)", retryable: true },
    });
  });

  it("lists providers, marking the one the environment selects", async () => {
    await withEnv({ TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: undefined }, async () => {
      const io = new FakeIo();
      expect(await run(["providers"], io)).toBe(0);
      expect(io.out).toBe(
        [
          "   NAME         ENV VAR             DEFAULT MODEL      API KEY",
          "   open-router  OPENROUTER_API_KEY  typesafe/jev-1.13  not set",
          "*  typesafe     TYPESAFE_API_KEY    jev-latest         set",
          "",
          "default: typesafe (TYPESAFE_API_KEY is set). Endpoints: decision-model providers -v",
          "",
        ].join("\n")
      );

      const verbose = new FakeIo();
      expect(await run(["providers", "-v"], verbose)).toBe(0);
      expect(verbose.out).toContain("URL");
      expect(verbose.out).toContain("https://api.typesafe.ai/v1/systemone");
      expect(verbose.out).toMatch(/is set\)\.\n$/);

      const tty = new FakeIo({ tty: true });
      expect(await run(["providers"], tty)).toBe(0);
      expect(tty.out).toContain("▸");
    });
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, async () => {
      const io = new FakeIo();
      expect(await run(["providers"], io)).toBe(0);
      expect(io.out).toContain("default: none. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.");
    });
  });
});
