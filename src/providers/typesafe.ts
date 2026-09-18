import { Provider } from "./base.js";

const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "typesafe/jev-1.13": "jev-latest",
  jev: "jev-latest",
});

export class TypesafeProvider extends Provider {
  override get name(): string {
    return "typesafe";
  }

  override get envVar(): string {
    return "TYPESAFE_API_KEY";
  }

  override get defaultBaseUrl(): string {
    return "https://api.typesafe.ai";
  }

  override get endpointPath(): string {
    return "/v1/systemone";
  }

  override get defaultModel(): string {
    return "jev-latest";
  }

  override get aliases(): Readonly<Record<string, string>> {
    return ALIASES;
  }
}
