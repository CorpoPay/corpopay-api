/**
 * Metrics hook (cloud-agnostic).
 *
 * OSS ships no metrics backend, so `trackMetric` is a no-op by default. A
 * private fork can register an exporter at bootstrap (e.g. its Lambda entry
 * calls `setMetricImpl` with a Datadog/Prometheus/OpenTelemetry implementation)
 * — the call sites across the API don't change.
 */
export type MetricImpl = (name: string, value?: number, tags?: string[]) => void;

let impl: MetricImpl = () => {};

export function setMetricImpl(fn: MetricImpl): void {
  impl = fn;
}

export function trackMetric(name: string, value = 1, tags: string[] = []): void {
  impl(name, value, tags);
}
