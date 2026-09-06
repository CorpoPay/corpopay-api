/**
 * Metrics hook.
 *
 * Cloud-agnostic by design: the OSS ships with no metrics backend, so every
 * call is a no-op. To emit metrics, replace the body of `trackMetric` with your
 * own exporter (Prometheus, Datadog, OpenTelemetry, StatsD, …) — the call
 * sites across the API are already in place and don't need to change.
 */
export function trackMetric(_name: string, _value = 1, _tags: string[] = []): void {
  // Intentionally empty — plug your metrics backend in here.
}
