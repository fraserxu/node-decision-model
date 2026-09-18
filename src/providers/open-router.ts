import { Provider } from "./base.js";

const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  jev: "typesafe/jev-1.13",
  "jev-latest": "typesafe/jev-1.13",
});

export class OpenRouterProvider extends Provider {
  override get name(): string {
    return "open-router";
  }

  override get envVar(): string {
    return "OPENROUTER_API_KEY";
  }

  override get defaultBaseUrl(): string {
    return "https://openrouter.ai/api/alpha";
  }

  override get endpointPath(): string {
    return "/decisions";
  }

  override get defaultModel(): string {
    return "typesafe/jev-1.13";
  }

  override get aliases(): Readonly<Record<string, string>> {
    return ALIASES;
  }

  override get reportsCost(): boolean {
    return true;
  }
}
