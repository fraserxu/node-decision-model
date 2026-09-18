import type { Answer, DecisionResponse, Provider, Usage } from "../index.js";

/** Pads every column to its widest cell and joins with two spaces. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd()
  );
}

function number(value: number): string {
  return value.toFixed(3);
}

function headline(answer: Answer): [value: string, detail: string] {
  switch (answer.type) {
    case "noul":
      return [number(answer.noul), ""];
    case "choice":
      return [answer.choice, `confidence ${number(answer.confidence)}`];
    case "score":
      return [number(answer.score), `confidence ${number(answer.confidence)}`];
  }
}

function distribution(answer: Answer): string {
  const entries = Object.entries(answer.probabilities);
  if (entries.length === 0) return "(no probabilities reported)";
  return entries
    .map(([key, probability]) => {
      const label = answer.type === "score" ? legendLabel(key, answer.legend[key]) : key;
      return `${label} ${number(probability)}`;
    })
    .join("  ");
}

function legendLabel(key: string, description: unknown): string {
  if (description === undefined || description === null) return key;
  const text = typeof description === "string" ? description : JSON.stringify(description);
  return `${key} (${text})`;
}

function usageSummary(usage: Usage): string[] {
  const parts: string[] = [];
  if (usage.inputTokens !== null || usage.outputTokens !== null) {
    parts.push(`tokens: ${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out`);
  }
  if (usage.cost !== null) parts.push(`cost: ${usage.cost}`);
  return parts;
}

/** One line per answer, a distribution line under each when verbose, then a summary line. */
export function formatHuman(response: DecisionResponse, options: { verbose: boolean }): string {
  const answers = Object.entries(response.answers as Record<string, Answer>);
  const lines = table(answers.map(([id, answer]) => [id, answer.type, ...headline(answer)]));

  const output: string[] = [];
  answers.forEach(([, answer], index) => {
    output.push(lines[index] ?? "");
    if (options.verbose) output.push(`    ${distribution(answer)}`);
  });

  const summary = [
    response.model === null ? null : `model: ${response.model}`,
    response.id === null ? null : `id: ${response.id}`,
    response.requestId === null ? null : `request id: ${response.requestId}`,
    ...usageSummary(response.usage),
  ].filter((part): part is string => part !== null);
  if (summary.length > 0) output.push("", summary.join("  "));

  return `${output.join("\n")}\n`;
}

export function formatJson(response: DecisionResponse): string {
  const body = {
    id: response.id,
    model: response.model,
    requestId: response.requestId,
    usage: response.usage,
    answers: response.answers,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** `envVarsInPriority` is the order the library consults them when no provider is named. */
export function formatProviders(
  providers: readonly Provider[],
  selected: Provider | null,
  envVarsInPriority: readonly string[]
): string {
  const rows = [
    ["NAME", "ENV VAR", "DEFAULT MODEL", "URL", "API KEY"],
    ...providers.map((provider) => [
      provider.name,
      provider.envVar,
      provider.defaultModel,
      provider.url,
      provider.hasApiKey() ? "set" : "not set",
    ]),
  ];
  const footer =
    selected === null
      ? `default: none (set ${envVarsInPriority.join(" or ")})`
      : `default: ${selected.name} (${selected.envVar} is set)`;
  return `${[...table(rows), "", footer].join("\n")}\n`;
}
