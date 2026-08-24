import { sendDistributionMetric } from "datadog-lambda-js";

/**
 * Custom business metrics. Distribution metrics are the recommended type for
 * Lambda-originated custom metrics: they aggregate as counts *and* percentiles,
 * so a value of `1` per event doubles as an event counter.
 *
 * Metrics are opt-in: unless Datadog is configured (`DD_API_KEY` is set), every
 * call is a no-op, so self-hosters who don't run Datadog are unaffected. Base
 * tags are configurable via `METRICS_BASE_TAGS` (comma-separated), e.g.
 * `team:corpopay,product:corpopay`.
 */
const BASE_TAGS = (process.env.METRICS_BASE_TAGS ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

export function trackMetric(name: string, value = 1, tags: string[] = []): void {
  if (!process.env.DD_API_KEY) return;
  try {
    sendDistributionMetric(name, value, ...BASE_TAGS, ...tags);
  } catch {
    // Metrics are best-effort.
  }
}
