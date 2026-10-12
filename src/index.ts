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
  CloudflareProvider,
  CelerisProvider,
  CELERIS_DEFAULT_MAX_SOFT_TOKENS,
  CELERIS_MAX_EXPLAINED_QUESTIONS,
  CELERIS_MAX_QUESTIONS,
  CELERIS_MAX_SOFT_TOKENS,
  buildProvider,
  providerFromEnv,
  providerNames,
  providerEnvVars,
} from "./providers/index.js";
export type {
  CelerisWireExtensions,
  CloudflareProviderOptions,
  ProviderName,
  ProviderOptions,
  RequestBodyArgs,
  RequestExtensions,
} from "./providers/index.js";
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
export type { ImageSource } from "./images.js";
export { CELERIS_MAX_IMAGES, CELERIS_MAX_PIXELS, CELERIS_MAX_BODY_BYTES } from "./images.js";
export type { AudioSource, VideoSource, MediaInputs } from "./media.js";
