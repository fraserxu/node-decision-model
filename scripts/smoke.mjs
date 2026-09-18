// Live end-to-end check against the real API, through the built bundle in
// dist/ (run `npm run build` first). Reads TYPESAFE_API_KEY or
// OPENROUTER_API_KEY from the environment; pass --provider to force one.
//
//   npm run build && node --env-file=.env scripts/smoke.mjs
//   npm run build && node --env-file=.env scripts/smoke.mjs --provider open-router

import { Client, choice, noul, score, ApiError } from "../dist/index.js";

const providerFlag = process.argv.indexOf("--provider");
const provider = providerFlag === -1 ? undefined : process.argv[providerFlag + 1];

const client = new Client(provider ? { provider } : {});
console.log(`provider: ${client.provider.name}  model: ${client.model}  url: ${client.provider.url}`);

const started = performance.now();
try {
  const response = await client.ask({
    state: {
      title: "Server returns 500 on checkout",
      body: "Every customer hitting /checkout since 09:00 gets an error page. Revenue is at zero.",
      reporter: "support",
    },
    questions: {
      urgent: noul("Is this issue urgent?"),
      team: choice("Which team should own this?", {
        billing: "payments, invoices, refunds",
        auth: "login, sessions, SSO",
        infra: "servers, deploys, outages",
      }),
      severity: score("How severe is this issue?", ["cosmetic", "minor", "major", "critical"]),
    },
  });

  console.log(`ok in ${Math.round(performance.now() - started)}ms`);
  console.log(`id: ${response.id}  model: ${response.model}  requestId: ${response.requestId}`);
  console.log("usage:", response.usage);
  console.log("urgent:", response.answers.urgent);
  console.log("team:", response.answers.team);
  console.log("severity:", response.answers.severity);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(`${error.name} (${error.status}):`, error.body);
  } else {
    console.error(error);
  }
  process.exit(1);
}
