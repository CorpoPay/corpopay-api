/**
 * AWS Lambda entry point.
 * Wraps the Express app with serverless-http so it can run as a Lambda function
 * behind API Gateway (HTTP API or REST API).
 */
import serverlessHttp from 'serverless-http';
import type { Handler } from 'aws-lambda';
import app from './app';

const handler = serverlessHttp(app, {
  // Pass raw body through for webhook signature verification
  binary: false,
});

export { handler };
export const lambdaHandler: Handler = handler as Handler;
