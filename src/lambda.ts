/**
 * AWS Lambda entry point.
 * Wraps the Express app with serverless-http so it can run as a Lambda function
 * behind API Gateway (HTTP API or REST API).
 */

import type { Handler } from "aws-lambda";
import serverlessHttp from "serverless-http";
import { loadSecrets } from "./lib/secrets";
import { validateEnv } from "./lib/validateEnv";

// Resolve secrets from SSM Parameter Store at cold-start,
// then validate all required environment variables.
//
// NOTE: this must run *before* `app` is imported. The Prisma adapter
// (src/lib/prisma.ts) and the Inngest client (src/lib/inngest.ts) read their
// secrets from `process.env` at module-evaluation time, and ESM hoists static
// imports above this top-level await. So `app` is imported dynamically below,
// after the secrets have been merged into `process.env`.
await loadSecrets();
validateEnv();

const { default: app } = await import("./app");

const handler = serverlessHttp(app, {
  // Pass raw body through for webhook signature verification
  binary: false,
});

export { handler };
export const lambdaHandler: Handler = handler as Handler;
