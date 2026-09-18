export { Client, getDefaultClient, setDefaultClient } from "./client.js";
export type { ClientOptions, Transport } from "./client.js";
export { DecisionResponse } from "./response.js";
export { noul, choice, score, Questions as QuestionBuilders } from "./questions.js";
export { RetryPolicy } from "./retry-policy.js";
export type { RetryPolicyOptions } from "./retry-policy.js";
export {
  Provider,
  OpenRouterProvider,
  TypesafeProvider,
  buildProvider,
  providerFromEnv,
  providerNames,
  providerEnvVars,
} from "./providers/index.js";
export type { ProviderName, ProviderOptions } from "./providers/index.js";
export {
  DecisionModelError,
  ConfigurationError,
  RequestError,
  TransportError,
  TimeoutError,
  ApiError,
  Unauthorized,
  PayloadTooLarge,
  UnprocessableEntity,
  RateLimited,
  Overloaded,
  InvalidResponse,
  MissingAnswers,
} from "./errors.js";
export type {
  Answer,
  AnswerFor,
  AnswersFor,
  ChoiceAnswer,
  ChoiceCriteria,
  ChoiceQuestion,
  Description,
  EntryValue,
  JsonValue,
  NoulAnswer,
  NoulCriteria,
  NoulQuestion,
  Question,
  Questions,
  ScoreAnswer,
  ScoreCriteria,
  ScoreQuestion,
  Usage,
} from "./types.js";
export { VERSION } from "./version.js";
