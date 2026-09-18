import { parseArgs } from "node:util";
import { choice, noul, score } from "../index.js";
import type { ChoiceCriteria, Description, Question, Questions } from "../index.js";

/** A mistake on the command line. Reported with usage and exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface AskOptions {
  /** Text, `@path`, or `@-`. Undefined means stdin when it is not a terminal. */
  state: string | undefined;
  /** Parse the state as JSON instead of sending it as text. */
  jsonState: boolean;
  noul: string[];
  choice: string[];
  score: string[];
  /** A questions map as JSON text, `@path`, or `@-`. */
  questions: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
  timeout: number | undefined;
  maxRetries: number | undefined;
  json: boolean;
  verbose: boolean;
}

export type HelpTopic = "main" | "ask" | "providers";

export type Command =
  | { kind: "help"; topic: HelpTopic; exitCode: number }
  | { kind: "version" }
  | { kind: "ask"; options: AskOptions }
  | { kind: "providers" };

const ASK_OPTIONS = {
  state: { type: "string" },
  "json-state": { type: "boolean", default: false },
  noul: { type: "string", multiple: true },
  choice: { type: "string", multiple: true },
  score: { type: "string", multiple: true },
  questions: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  timeout: { type: "string" },
  "max-retries": { type: "string" },
  json: { type: "boolean", default: false },
  verbose: { type: "boolean", short: "v", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

const HELP_ONLY_OPTIONS = {
  help: { type: "boolean", short: "h", default: false },
} as const;

/** Turns `process.argv.slice(2)` into a command, or throws UsageError. */
export function parseArgv(argv: readonly string[]): Command {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
      return { kind: "help", topic: "main", exitCode: 2 };
    case "-h":
    case "--help":
    case "help":
      return { kind: "help", topic: helpTopic(rest[0]), exitCode: 0 };
    case "-V":
    case "--version":
    case "version":
      return { kind: "version" };
    case "ask":
      return parseAsk(rest);
    case "providers": {
      const { values, positionals } = guarded(() =>
        parseArgs({ args: rest, options: HELP_ONLY_OPTIONS, allowPositionals: true, strict: true })
      );
      if (values.help) return { kind: "help", topic: "providers", exitCode: 0 };
      if (positionals.length > 0) {
        throw new UsageError(`unexpected argument ${JSON.stringify(positionals[0])}`);
      }
      return { kind: "providers" };
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

function helpTopic(name: string | undefined): HelpTopic {
  return name === "ask" || name === "providers" ? name : "main";
}

function parseAsk(args: readonly string[]): Command {
  const { values, positionals } = guarded(() =>
    parseArgs({ args: [...args], options: ASK_OPTIONS, allowPositionals: true, strict: true })
  );
  if (values.help) return { kind: "help", topic: "ask", exitCode: 0 };

  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[1])}`);
  }
  const positionalState = positionals[0];
  if (positionalState !== undefined && values.state !== undefined) {
    throw new UsageError("state was given twice: as an argument and as --state");
  }

  return {
    kind: "ask",
    options: {
      state: values.state ?? positionalState,
      jsonState: values["json-state"],
      noul: values.noul ?? [],
      choice: values.choice ?? [],
      score: values.score ?? [],
      questions: values.questions,
      provider: values.provider,
      model: values.model,
      baseUrl: values["base-url"],
      timeout: parseNonNegativeInteger("--timeout", values.timeout),
      maxRetries: parseNonNegativeInteger("--max-retries", values["max-retries"]),
      json: values.json,
      verbose: values.verbose,
    },
  };
}

/** Runs parseArgs, surfacing its errors as UsageError. */
function guarded<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    // parseArgs reports unknown options and missing values with a readable
    // message; keep it and only change how it is surfaced.
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(message.replace(/\.\s+To specify.*$/s, ""));
  }
}

function parseNonNegativeInteger(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value < 0) {
    throw new UsageError(`${flag} expects a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export type QuestionFlag = "noul" | "choice" | "score";

const ID_PATTERN = /^[^\s=]+$/;

/**
 * Parses one `--noul`, `--choice`, or `--score` value. The syntax is
 * `id=instructions` for noul and `id=instructions|label,label,...` for choice
 * and score. The last `|` separates instructions from labels, so instructions
 * may contain `|` and labels may not.
 */
export function parseQuestionSpec(flag: QuestionFlag, spec: string): [string, Question] {
  const shape = flag === "noul" ? "id=instructions" : "id=instructions|label,label,...";
  const equals = spec.indexOf("=");
  if (equals === -1) {
    throw new UsageError(`--${flag} expects ${shape}, got ${JSON.stringify(spec)}`);
  }

  const id = spec.slice(0, equals).trim();
  if (!ID_PATTERN.test(id)) {
    throw new UsageError(`--${flag} expects ${shape}; the id must not be empty or contain spaces`);
  }
  const rest = spec.slice(equals + 1);

  if (flag === "noul") {
    return [id, build(id, () => noul(rest.trim()))];
  }

  const pipe = rest.lastIndexOf("|");
  if (pipe === -1) {
    throw new UsageError(`--${flag} expects ${shape}, got ${JSON.stringify(spec)}`);
  }
  const instructions = rest.slice(0, pipe).trim();
  const labels = rest.slice(pipe + 1).split(",").map((label) => label.trim());
  if (labels.some((label) => label === "")) {
    throw new UsageError(`question ${JSON.stringify(id)}: labels must not be empty`);
  }

  if (flag === "choice") {
    const duplicate = labels.find((label, index) => labels.indexOf(label) !== index);
    if (duplicate !== undefined) {
      throw new UsageError(
        `question ${JSON.stringify(id)}: label ${JSON.stringify(duplicate)} is listed twice`
      );
    }
    const criteria: ChoiceCriteria = Object.fromEntries(labels.map((label) => [label, null]));
    return [id, build(id, () => choice(instructions, criteria))];
  }

  return [id, build(id, () => score(instructions, labels))];
}

/**
 * Parses a questions map written in the wire format, e.g.
 * `{"urgent": {"type": "noul", "instructions": "Is this urgent?"}}`. Every
 * entry goes through the same builders as the flags, so the same rules apply.
 */
export function parseQuestionsJson(text: string): Questions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`--questions is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new UsageError("--questions must be a JSON object keyed by question id");
  }

  const questions: Questions = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!ID_PATTERN.test(id)) {
      throw new UsageError(`question ${JSON.stringify(id)}: ids must not be empty or contain spaces`);
    }
    if (!isRecord(value)) {
      throw new UsageError(`question ${JSON.stringify(id)}: must be an object with a "type"`);
    }
    questions[id] = questionFromRecord(id, value);
  }
  return questions;
}

function questionFromRecord(id: string, value: Record<string, unknown>): Question {
  const instructions = value.instructions as Parameters<typeof noul>[0];
  switch (value.type) {
    case "noul":
      return build(id, () =>
        value.criteria === undefined
          ? noul(instructions)
          : noul(instructions, value.criteria as Parameters<typeof noul>[1])
      );
    case "choice":
      return build(id, () => choice(instructions, value.criteria as ChoiceCriteria));
    case "score":
      return build(id, () => score(instructions, value.criteria as readonly Description[]));
    default:
      throw new UsageError(
        `question ${JSON.stringify(id)}: "type" must be "noul", "choice", or "score"`
      );
  }
}

/** Runs a question builder, turning its TypeError into a UsageError naming the question. */
function build<Q extends Question>(id: string, builder: () => Q): Q {
  try {
    return builder();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new UsageError(`question ${JSON.stringify(id)}: ${error.message}`);
    }
    throw error;
  }
}

/** Merges questions from every source, rejecting an id that appears twice. */
export function mergeQuestions(sources: readonly (readonly [string, Question])[]): Questions {
  const questions: Questions = {};
  for (const [id, question] of sources) {
    if (id in questions) {
      throw new UsageError(`question ${JSON.stringify(id)} is defined twice`);
    }
    questions[id] = question;
  }
  return questions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
