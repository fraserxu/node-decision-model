import type { Answer, DecisionResponse, Provider, Usage } from "../index.js";
import type { Style } from "./color.js";

/**
 * Pads every column but the last to its widest cell and joins with two
 * spaces. Widths are measured on the plain cells; `stylers` are applied to
 * each column after padding so escape codes never skew the alignment.
 */
export function table(
  rows: readonly (readonly string[])[],
  stylers: readonly ((text: string) => string)[] = []
): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => {
        const padded = index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0);
        const style = stylers[index];
        return style === undefined ? padded : style(padded);
      })
      .join("  ")
      .trimEnd()
  );
}

export function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

const HIGH_CONFIDENCE = 0.8;
const RUNNERS_UP = 4;
const DETAIL_FLOOR = 0.05;
const BAR_WIDTH = 20;
const SHORT_REQUEST_ID = 12;

interface Headline {
  /** What the model answered: yes/no, the label, or the level. */
  answer: string;
  /** Probability of that answer. */
  confidence: number;
  /** Runners-up, or the numeric score. Empty when there is nothing to add. */
  detail: string;
  /** Every option with its probability, in display order. */
  distribution: { label: string; probability: number }[];
}

export function isYes(answer: Extract<Answer, { type: "noul" }>, threshold: number): boolean {
  return answer.noul >= threshold;
}

export function headline(answer: Answer, threshold: number): Headline {
  switch (answer.type) {
    case "noul": {
      const yes = isYes(answer, threshold);
      return {
        answer: yes ? "yes" : "no",
        confidence: yes ? answer.noul : 1 - answer.noul,
        detail: "",
        distribution: [
          { label: "yes", probability: answer.noul },
          { label: "no", probability: 1 - answer.noul },
        ],
      };
    }
    case "choice": {
      const entries = Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a);
      const runnersUp = entries.filter(([label]) => label !== answer.choice).slice(0, RUNNERS_UP);
      return {
        answer: answer.choice,
        confidence: answer.probabilities[answer.choice] ?? answer.confidence,
        detail: runnersUp.map(([label, p]) => `${label} ${percent(p)}`).join(" · "),
        distribution:
          entries.length === 0
            ? [{ label: answer.choice, probability: answer.confidence }]
            : entries.map(([label, probability]) => ({ label, probability })),
      };
    }
    case "score": {
      const keys = [...new Set([...Object.keys(answer.legend), ...Object.keys(answer.probabilities)])]
        .map(Number)
        .filter((key) => Number.isInteger(key) && key >= 0)
        .sort((a, b) => a - b);
      const top = keys.length === 0 ? Math.max(0, Math.round(answer.score)) : keys[keys.length - 1]!;
      const level = Math.min(top, Math.max(0, Math.round(answer.score)));
      const label = levelLabel(level, answer.legend);
      const others = keys
        .filter((key) => key !== level && (answer.probabilities[String(key)] ?? 0) >= DETAIL_FLOOR)
        .sort((a, b) => (answer.probabilities[String(b)] ?? 0) - (answer.probabilities[String(a)] ?? 0))
        .map((key) => `${levelLabel(key, answer.legend)} ${percent(answer.probabilities[String(key)] ?? 0)}`);
      return {
        answer: label,
        confidence: answer.probabilities[String(level)] ?? answer.confidence,
        detail: [`${answer.score.toFixed(2)} on a 0–${top} scale`, ...others].join(" · "),
        distribution: keys.map((key) => ({
          label: `${key} ${levelLabel(key, answer.legend)}`,
          probability: answer.probabilities[String(key)] ?? 0,
        })),
      };
    }
  }
}

function levelLabel(level: number, legend: Readonly<Record<string, unknown>>): string {
  const description = legend[String(level)];
  if (description === undefined || description === null) return `level ${level}`;
  return typeof description === "string" ? description : JSON.stringify(description);
}

export interface HumanOptions {
  style: Style;
  verbose: boolean;
  /** True for `ask`, where the id column tells the answers apart. */
  showIds: boolean;
  threshold: number;
  provider: string;
  elapsedMs: number;
}

/** One line per answer, distributions under each when verbose, then a dim footer. */
export function formatHuman(response: DecisionResponse, options: HumanOptions): string {
  const { style } = options;
  const answers = Object.entries(response.answers as Record<string, Answer>);
  const headlines = answers.map(([id, answer]) => [id, headline(answer, options.threshold)] as const);

  const confidenceStyle = (text: string) =>
    /^\s*(\d+)%/.test(text) && Number(/(\d+)%/.exec(text)![1]) >= HIGH_CONFIDENCE * 100
      ? style.green(text)
      : style.yellow(text);
  const cells = headlines.map(([id, line]) => [
    ...(options.showIds ? [id] : []),
    line.answer,
    percent(line.confidence),
    line.detail,
  ]);
  const stylers = [...(options.showIds ? [style.dim] : []), style.bold, confidenceStyle, style.dim];
  const lines = table(cells, stylers);

  // Distribution rows sit under the answer column: past the id column and its gap.
  const indent = " ".repeat(options.showIds ? Math.max(...answers.map(([id]) => id.length)) + 2 : 2);
  const output: string[] = [];
  headlines.forEach(([, line], index) => {
    output.push(lines[index]!);
    if (options.verbose) output.push(...distributionLines(line, indent, style));
  });

  output.push(style.dim(footer(response, options)));
  return `${output.join("\n")}\n`;
}

function distributionLines(line: Headline, indent: string, style: Style): string[] {
  const rows = line.distribution.map(({ label, probability }) => [
    label,
    percent(probability),
    style.enabled ? bar(probability, style) : "",
  ]);
  return table(rows, [style.dim, (text) => text]).map((row) => `${indent}${row}`);
}

function bar(probability: number, style: Style): string {
  const filled = Math.round(Math.min(1, Math.max(0, probability)) * BAR_WIDTH);
  return style.cyan("█".repeat(filled)) + style.dim("░".repeat(BAR_WIDTH - filled));
}

function footer(response: DecisionResponse, options: HumanOptions): string {
  const requestId =
    response.requestId === null
      ? null
      : options.verbose
        ? response.requestId
        : response.requestId.slice(0, SHORT_REQUEST_ID);
  return [
    options.verbose ? options.provider : null,
    response.model,
    ...usageParts(response.usage),
    `${(options.elapsedMs / 1000).toFixed(1)}s`,
    requestId,
    response.id === null ? null : `id ${response.id}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function usageParts(usage: Usage): string[] {
  const parts: string[] = [];
  if (usage.inputTokens !== null || usage.outputTokens !== null) {
    parts.push(`${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out tokens`);
  }
  if (usage.cost !== null) parts.push(`cost ${usage.cost}`);
  return parts;
}

/** Only the answers: one per line, prefixed by the id and a tab for `ask`. */
export function formatQuiet(
  response: DecisionResponse,
  options: { showIds: boolean; threshold: number }
): string {
  const lines = Object.entries(response.answers as Record<string, Answer>).map(([id, answer]) => {
    const { answer: text } = headline(answer, options.threshold);
    return options.showIds ? `${id}\t${text}` : text;
  });
  return `${lines.join("\n")}\n`;
}

export function formatJson(
  response: DecisionResponse,
  options: { provider: string; elapsedMs: number }
): string {
  const body = {
    provider: options.provider,
    model: response.model,
    id: response.id,
    requestId: response.requestId,
    elapsedMs: options.elapsedMs,
    usage: response.usage,
    answers: response.answers,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function formatDryRun(args: {
  provider: Provider;
  model: string;
  state: unknown;
  questions: unknown;
}): string {
  const body = {
    provider: args.provider.name,
    model: args.model,
    url: args.provider.url,
    request: JSON.parse(
      args.provider.requestBody({
        model: args.model,
        state: args.state,
        questions: args.questions as Parameters<Provider["requestBody"]>[0]["questions"],
      })
    ) as unknown,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** `envVarsInPriority` is the order the library consults them when no provider is named. */
export function formatProviders(
  providers: readonly Provider[],
  selected: Provider | null,
  envVarsInPriority: readonly string[],
  options: { verbose: boolean; style: Style }
): string {
  const { style, verbose } = options;
  const marker = style.enabled ? "▸" : "*";
  const rows = [
    ["", "NAME", "ENV VAR", "DEFAULT MODEL", ...(verbose ? ["URL"] : []), "API KEY"],
    ...providers.map((provider) => [
      selected !== null && provider.name === selected.name ? marker : "",
      provider.name,
      provider.envVar,
      provider.defaultModel,
      ...(verbose ? [provider.url] : []),
      provider.hasApiKey() ? "set" : "not set",
    ]),
  ];
  const lines = table(rows).map((line, index) => (index === 0 ? style.dim(line) : line));
  const footerLine =
    selected === null
      ? `default: none. Set ${envVarsInPriority.join(" or ")}.`
      : `default: ${selected.name} (${selected.envVar} is set).`;
  const hint = verbose ? "" : " Endpoints: decision-model providers -v";
  return `${[...lines, "", `${footerLine}${hint}`].join("\n")}\n`;
}
