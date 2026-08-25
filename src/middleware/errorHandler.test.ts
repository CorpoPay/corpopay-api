import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, errorHandler } from "./errorHandler";

/**
 * Minimal Express `res` mock: `status()` returns an object that exposes `json()`
 * so `res.status(x).json(body)` chains exactly like the real middleware uses it.
 */
function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

describe("errorHandler", () => {
  it("renders an AppError with its own status + code", () => {
    const res = makeRes();
    errorHandler(new AppError(403, "FORBIDDEN", "no access"), {}, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "no access", code: "FORBIDDEN" });
  });

  it("renders a ZodError as 422 VALIDATION_ERROR with issue details", () => {
    const parsed = z.object({ amount: z.number() }).safeParse({ amount: "nope" });
    const res = makeRes();
    errorHandler(parsed.error, {}, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(422);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toBe("Validation failed");
    expect(body.details).toEqual([{ path: "amount", message: expect.any(String) }]);
  });

  it("renders an unknown error as 500 INTERNAL_ERROR", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    errorHandler(new Error("boom"), {}, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });

    log.mockRestore();
  });
});
