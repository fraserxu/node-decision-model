import { parseArgs } from "node:util";
import { choice, noul, score } from "../index.js";
import type { ChoiceCriteria, Description, Question, Questions } from "../index.js";

/**
 * A mistake on the command line. Reported with exit code 2. `hints` are the
 * lines printed under the message that say what to type instead.
 */
export class UsageError extends Error {
  readonly hints: readonly string[];

  constructor(message: string, hints: readonly string[] = []) {
    super(message);
    this.name = "UsageError";
    this.hints = hints;
  }
}

/** Options shared by every command that sends a request. */
export interface CommonOptions {
  /** `-s`: the state as text. */
  state: string | undefined;
  /** `-f`: a path, or `-` for stdin. A `.json` extension parses the file as JSON. */
  file: string | undefined;
  /** Parse the state as JSON wherever it came from. */
  jsonState: boolean;
  provider: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
  timeout: number | undefined;
  maxRetries: number | undefined;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
  dryRun: boolean;
}

export interface AskOptions extends CommonOptions {
  /** Kept for one-liners: `ask "text"`. `@path` and `@-` are accepted as `-f`. */
  positionalState: string | undefined;
  noul: string[];
  choice: string[];
  score: string[];
  /** A questions map: inline JSON, a path, or `-` for stdin. */
  questions: string | undefined;
  /** One `{ state, questions }` document: a path or `-` for stdin. */
  input: string | undefined;
}

export type Verb = "yesno" | "choose" | "score";

export interface SingleOptions extends CommonOptions {
  verb: Verb;
  question: string;
  /** Labels for choose, levels for score, empty for yesno. */
  labels: string[];
  /** Where yes becomes no. Only yesno reads it. */
  threshold: number;
  /** yesno only: print nothing and exit 0 for yes, 1 for no. */
  check: boolean;
}

export type HelpTopic = "main" | "ask" | "yesno" | "choose" | "score" | "providers" | "all";

export type Command =
  | { kind: "help"; topic: HelpTopic; exitCode: number }
  | { kind: "version" }
  | { kind: "providers"; verbose: boolean }
  | { kind: "ask"; options: AskOptions }
  | { kind: "single"; options: SingleOptions };

export const COMMANDS = ["yesno", "choose", "score", "ask", "providers", "help", "version"] as const;

const HELP_TOPICS: readonly HelpTopic[] = ["ask", "yesno", "choose", "score", "providers", "all"];

const COMMON_OPTIONS = {
  state: { type: "string", short: "s" },
  file: { type: "string", short: "f" },
  "json-state": { type: "boolean", default: false },
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  timeout: { type: "string" },
  "max-retries": { type: "string" },
  json: { type: "boolean", default: false },
  quiet: { type: "boolean", short: "q", default: false },
  verbose: { type: "boolean", short: "v", default: false },
  "no-color": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

const ASK_OPTIONS = {
  ...COMMON_OPTIONS,
  noul: { type: "string", multiple: true },
  choice: { type: "string", multiple: true },
  score: { type: "string", multiple: true },
  questions: { type: "string" },
  input: { type: "string" },
} as const;

const YESNO_OPTIONS = {
  ...COMMON_OPTIONS,
  threshold: { type: "string" },
  check: { type: "boolean", default: false },
} as const;

const PROVIDERS_OPTIONS = {
  verbose: { type: "boolean", short: "v", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** The subset of parsed values every request command reads. */
interface CommonValues {
  state?: string | undefined;
  file?: string | undefined;
  "json-state"?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  "base-url"?: string | undefined;
  timeout?: string | undefined;
  "max-retries"?: string | undefined;
  json?: boolean | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  "no-color"?: boolean | undefined;
  "dry-run"?: boolean | undefined;
  help?: boolean | undefined;
}

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
    case "yesno":
    case "choose":
    case "score":
      return parseSingle(command, rest);
    case "providers": {
      const { values, positionals } = guarded(() =>
        parseArgs({ args: [...rest], options: PROVIDERS_OPTIONS, allowPositionals: true, strict: true })
      );
      if (values.help) return { kind: "help", topic: "providers", exitCode: 0 };
      if (positionals.length > 0) {
        throw new UsageError(`providers takes no arguments, got ${JSON.stringify(positionals[0])}`);
      }
      return { kind: "providers", verbose: values.verbose === true };
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`, unknownCommandHints(command));
  }
}

function helpTopic(name: string | undefined): HelpTopic {
  if (name === undefined) return "main";
  const topic = HELP_TOPICS.find((candidate) => candidate === name);
  if (topic !== undefined) return topic;
  throw new UsageError(`no help topic ${JSON.stringify(name)}`, [
    `Topics: ${HELP_TOPICS.join(", ")}`,
  ]);
}

function unknownCommandHints(command: string): string[] {
  const suggestion = closest(command, COMMANDS);
  return suggestion === null
    ? [`Commands: ${COMMANDS.join(", ")}`]
    : [`Did you mean ${JSON.stringify(suggestion)}?`];
}

/** The candidate within two edits of `input`, or null. */
function closest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

function parseAsk(args: readonly string[]): Command {
  const { values, positionals } = guarded(() =>
    parseArgs({ args: [...args], options: ASK_OPTIONS, allowPositionals: true, strict: true })
  );
  if (values.help) return { kind: "help", topic: "ask", exitCode: 0 };

  if (positionals.length > 1) {
    throw new UsageError(`ask takes at most one state argument, got ${JSON.stringify(positionals[1])}`, [
      "Questions go in --noul, --choice, --score, or --questions.",
      'For one question without flags: decision-model choose "Which team?" billing auth infra',
    ]);
  }
  const positionalState = positionals[0];
  if (positionalState !== undefined && values.state !== undefined) {
    throw new UsageError("the state was given twice: as an argument and with --state");
  }

  const common = commonOptions(values);
  const options: AskOptions = {
    ...common,
    positionalState,
    noul: values.noul ?? [],
    choice: values.choice ?? [],
    score: values.score ?? [],
    questions: values.questions,
    input: values.input,
  };

  if (options.input !== undefined) {
    const conflicts: string[] = [];
    if (positionalState !== undefined || common.state !== undefined) conflicts.push("a state");
    if (common.file !== undefined) conflicts.push("--file");
    if (common.jsonState) conflicts.push("--json-state");
    if (options.noul.length + options.choice.length + options.score.length > 0) {
      conflicts.push("question flags");
    }
    if (options.questions !== undefined) conflicts.push("--questions");
    if (conflicts.length > 0) {
      throw new UsageError(`--input cannot be combined with ${conflicts.join(", ")}`, [
        "--input carries both the state and the questions in one JSON document.",
      ]);
    }
  }

  return { kind: "ask", options };
}

function parseSingle(verb: Verb, args: readonly string[]): Command {
  const parsed = parseVerbArgs(verb, args);
  if (parsed.values.help) return { kind: "help", topic: verb, exitCode: 0 };

  const [question, ...labels] = parsed.positionals;
  if (question === undefined || question.trim() === "") {
    throw new UsageError(`${verb} needs a question as its first argument`, [
      `Example: ${VERB_EXAMPLES[verb]}`,
    ]);
  }

  switch (verb) {
    case "yesno":
      if (labels.length > 0) {
        throw new UsageError(
          `yesno takes only a question, got an extra argument ${JSON.stringify(labels[0])}`,
          ["Pass the state with -s, -f, or on stdin.", `Example: ${VERB_EXAMPLES.yesno}`]
        );
      }
      break;
    case "choose":
      if (labels.length === 0) {
        throw new UsageError("choose needs at least one label after the question", [
          `Example: ${VERB_EXAMPLES.choose}`,
        ]);
      }
      rejectDuplicates(labels, "label");
      break;
    case "score":
      if (labels.length < 2 || labels.length > 10) {
        throw new UsageError(
          `score needs 2 to 10 levels after the question, in order from lowest to highest, got ${labels.length}`,
          [`Example: ${VERB_EXAMPLES.score}`]
        );
      }
      rejectDuplicates(labels, "level");
      break;
  }

  return {
    kind: "single",
    options: {
      ...commonOptions(parsed.values),
      verb,
      question,
      labels,
      threshold: parseThreshold(parsed.threshold),
      check: parsed.check,
    },
  };
}

export const VERB_EXAMPLES: Readonly<Record<Verb, string>> = {
  yesno: 'cat issue.json | decision-model yesno "Is this urgent?"',
  choose: 'decision-model choose "Which team owns this?" billing auth infra -f issue.json',
  score: 'decision-model score "How severe is this?" cosmetic minor major critical -s "500 on checkout"',
};

function parseVerbArgs(
  verb: Verb,
  args: readonly string[]
): { values: CommonValues; positionals: string[]; threshold: string | undefined; check: boolean } {
  if (verb === "yesno") {
    const { values, positionals } = guarded(() =>
      parseArgs({ args: [...args], options: YESNO_OPTIONS, allowPositionals: true, strict: true })
    );
    return { values, positionals, threshold: values.threshold, check: values.check === true };
  }
  const { values, positionals } = guarded(() =>
    parseArgs({ args: [...args], options: COMMON_OPTIONS, allowPositionals: true, strict: true })
  );
  return { values, positionals, threshold: undefined, check: false };
}

function rejectDuplicates(labels: readonly string[], noun: string): void {
  const duplicate = labels.find((label, index) => labels.indexOf(label) !== index);
  if (duplicate !== undefined) {
    throw new UsageError(`${noun} ${JSON.stringify(duplicate)} is listed twice`);
  }
  const blank = labels.find((label) => label.trim() === "");
  if (blank !== undefined) throw new UsageError(`${noun}s must not be empty`);
}

function commonOptions(values: CommonValues): CommonOptions {
  if (values.state !== undefined && values.file !== undefined) {
    throw new UsageError("the state was given twice: with --state and with --file");
  }
  return {
    state: values.state,
    file: values.file,
    jsonState: values["json-state"] === true,
    provider: values.provider,
    model: values.model,
    baseUrl: values["base-url"],
    timeout: parseNonNegativeInteger("--timeout", values.timeout),
    maxRetries: parseNonNegativeInteger("--max-retries", values["max-retries"]),
    json: values.json === true,
    quiet: values.quiet === true,
    verbose: values.verbose === true,
    noColor: values["no-color"] === true,
    dryRun: values["dry-run"] === true,
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

export const DEFAULT_THRESHOLD = 0.5;

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_THRESHOLD;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError(`--threshold expects a number between 0 and 1, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export type QuestionFlag = "noul" | "choice" | "score";

const ID_PATTERN = /^[^\s=]+$/;

const FLAG_EXAMPLES: Readonly<Record<QuestionFlag, string>> = {
  noul: '--noul urgent="Is this urgent?"',
  choice: '--choice team="Which team owns this?|billing,auth,infra"',
  score: '--score severity="How severe is this?|cosmetic,minor,major,critical"',
};

const FLAG_VERBS: Readonly<Record<QuestionFlag, Verb>> = {
  noul: "yesno",
  choice: "choose",
  score: "score",
};

/**
 * Parses one `--noul`, `--choice`, or `--score` value. The syntax is
 * `id=instructions` for noul and `id=instructions|label,label,...` for choice
 * and score. The last `|` separates instructions from labels, so instructions
 * may contain `|` and labels may not.
 */
export function parseQuestionSpec(flag: QuestionFlag, spec: string): [string, Question] {
  const hints = [
    `Example: ${FLAG_EXAMPLES[flag]}`,
    `For one question, no quoting is needed: ${VERB_EXAMPLES[FLAG_VERBS[flag]]}`,
  ];
  const equals = spec.indexOf("=");
  if (equals === -1) {
    throw new UsageError(`--${flag} needs an id before "=", got ${JSON.stringify(spec)}`, hints);
  }

  const id = spec.slice(0, equals).trim();
  if (!ID_PATTERN.test(id)) {
    throw new UsageError(`--${flag}: the id before "=" must not be empty or contain spaces`, hints);
  }
  const rest = spec.slice(equals + 1);

  if (flag === "noul") {
    return [id, build(id, () => noul(rest.trim()))];
  }

  const pipe = rest.lastIndexOf("|");
  if (pipe === -1) {
    throw new UsageError(`--${flag} needs labels after a "|", got ${JSON.stringify(spec)}`, hints);
  }
  const instructions = rest.slice(0, pipe).trim();
  const labels = rest.slice(pipe + 1).split(",").map((label) => label.trim());
  if (labels.some((label) => label === "")) {
    throw new UsageError(`question ${JSON.stringify(id)}: labels must not be empty`, hints);
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
export function parseQuestionsJson(text: string, source = "--questions"): Questions {
  return parseQuestionsValue(parseJson(text, source), source);
}

export function parseQuestionsValue(parsed: unknown, source = "--questions"): Questions {
  if (!isRecord(parsed)) {
    throw new UsageError(`${source} must be a JSON object keyed by question id`);
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

/** Parses one `--input` document: `{ "state": ..., "questions": { ... } }`. */
export function parseInputJson(text: string): { state: unknown; questions: Questions } {
  const parsed = parseJson(text, "--input");
  if (!isRecord(parsed)) {
    throw new UsageError('--input must be a JSON object with "state" and "questions"');
  }
  if (!("state" in parsed)) {
    throw new UsageError('--input is missing "state"');
  }
  if (parsed.state === null) {
    throw new UsageError('--input "state" must not be null', ['Use "" or {} to ask with no state.']);
  }
  if (!("questions" in parsed)) {
    throw new UsageError('--input is missing "questions"');
  }
  return { state: parsed.state, questions: parseQuestionsValue(parsed.questions, '--input "questions"') };
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${source} is not valid JSON: ${message}`);
  }
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
export function build<Q extends Question>(id: string, builder: () => Q): Q {
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
