import { describe, expect, it, vi } from "vitest";
import { type DunningLadderConfig, runDunningLadder } from "./dunning";

interface Attempt {
  success: boolean;
  n: number;
}

/** A step emulator that executes `run` callbacks synchronously and records calls. */
function makeStep() {
  const runs: string[] = [];
  const sleeps: string[] = [];
  return {
    runs,
    sleeps,
    step: {
      run: vi.fn(async (_name: string, fn: () => unknown) => {
        runs.push(_name);
        return fn();
      }),
      sleep: vi.fn(async (_name: string, duration: string) => {
        sleeps.push(`${_name}:${duration}`);
      }),
    },
  };
}

function makeConfig(
  step: ReturnType<typeof makeStep>["step"],
  outcomes: boolean[],
  overrides: Partial<DunningLadderConfig<Attempt, string>> = {},
): DunningLadderConfig<Attempt, string> {
  const calls: Attempt[] = [];
  return {
    step,
    maxAttempts: outcomes.length,
    delays: Array.from({ length: Math.max(outcomes.length - 1, 0) }, (_, i) => `${i + 1}d`),
    stepNames: {
      attempt: (n) => `attempt-${n}`,
      wait: (n) => `wait-${n}`,
      check: (n) => `check-${n}`,
    },
    attempt: async (n) => {
      const success = outcomes[n - 1];
      const result = { success, n };
      calls.push(result);
      return result;
    },
    shouldStop: async () => ({ stop: false, reason: "" }),
    onSuccess: async (_s, n) => `success-at-${n}`,
    onFailure: async () => undefined,
    onExhausted: async () => "exhausted",
    ...overrides,
  };
}

describe("runDunningLadder", () => {
  it("returns onSuccess without retrying when the first attempt succeeds", async () => {
    const { step, runs, sleeps } = makeStep();
    const result = await runDunningLadder(makeConfig(step, [true]));

    expect(result).toBe("success-at-1");
    expect(runs).toEqual(["attempt-1"]);
    expect(sleeps).toEqual([]);
  });

  it("retries after a failure, then succeeds on a later attempt", async () => {
    const { step, runs, sleeps } = makeStep();
    const result = await runDunningLadder(makeConfig(step, [false, false, true]));

    expect(result).toBe("success-at-3");
    // attempt 1 → fail → onFailure → sleep(wait-2) → check-2 → attempt 2 → fail → sleep(wait-3) → check-3 → attempt 3 → success
    expect(runs).toEqual(["attempt-1", "check-2", "attempt-2", "check-3", "attempt-3"]);
    expect(sleeps).toEqual(["wait-2:1d", "wait-3:2d"]);
  });

  it("returns onExhausted when every attempt fails", async () => {
    const { step } = makeStep();
    const result = await runDunningLadder(makeConfig(step, [false, false, false, false]));

    expect(result).toBe("exhausted");
  });

  it("aborts with { skipped, reason } when shouldStop returns stop:true", async () => {
    const { step } = makeStep();
    const result = await runDunningLadder(
      makeConfig(step, [false, false], {
        shouldStop: async (n) =>
          n === 2
            ? { stop: true, reason: "Cancelled before retry 2" }
            : { stop: false, reason: "" },
      }),
    );

    expect(result).toEqual({ skipped: true, reason: "Cancelled before retry 2" });
  });

  it("does not call onFailure after the final attempt (onExhausted owns it)", async () => {
    const { step } = makeStep();
    const onFailure = vi.fn(async () => undefined);
    const result = await runDunningLadder(makeConfig(step, [false, false], { onFailure }));

    expect(result).toBe("exhausted");
    // onFailure should only have been called for the first (non-final) failure.
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
