/**
 * Load secrets from AWS SSM Parameter Store at Lambda cold-start.
 *
 * Secrets are stored in SSM under a stable prefix (default
 * `/corpopay/stg/`). Instead of baking those values into the Lambda environment
 * at deploy time, the handler fetches them here and merges them into
 * `process.env` before `validateEnv()` runs.
 *
 * Each parameter's trailing path segment maps to an UPPER_SNAKE env var name,
 * so `/corpopay/stg/DATABASE_URL` → `DATABASE_URL`.
 *
 * Best-effort: when `SSM_SECRETS_PREFIX` is unset (local dev / tests) or the
 * fetch fails, this is a no-op and the process continues with whatever is
 * already in `process.env` (e.g. injected by the environment). `validateEnv()`
 * still surfaces any missing required variable.
 */
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";

export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const prefix = env.SSM_SECRETS_PREFIX;
  if (!prefix) return;

  const path = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const client = new SSMClient({});

  try {
    let nextToken: string | undefined;
    let loaded = 0;
    do {
      const result = await client.send(
        new GetParametersByPathCommand({
          Path: path,
          Recursive: true,
          WithDecryption: true,
          NextToken: nextToken,
        }),
      );
      for (const param of result.Parameters ?? []) {
        if (!param.Name || param.Value === undefined) continue;
        const name = param.Name.slice(path.length)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "_");
        if (!name) continue;
        env[name] = param.Value;
        loaded += 1;
      }
      nextToken = result.NextToken;
    } while (nextToken);

    console.info(`[secrets] loaded ${loaded} secret(s) from SSM prefix ${path}`);
  } catch (err) {
    // Non-fatal — validateEnv() will fail loudly if a required var is missing.
    console.warn(`[secrets] failed to load SSM secrets from ${path}: ${(err as Error).message}`);
  }
}
