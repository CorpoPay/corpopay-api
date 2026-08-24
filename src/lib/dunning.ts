/**
 * Shared dunning (retry ladder) utilities for recurring billing + BNPL charges.
 *
 * The four Inngest billing jobs (billingRenewal, billingSimulation,
 * installmentCharge, installmentSimulation) previously re-implemented the same
 * "attempt → sleep → retry → … → terminal" ladder, plus near-identical charge
 * helpers.  This module is the single source of truth for both, so a fix in one
 * place applies everywhere.
 *
 * Inngest step names are caller-supplied (via `stepNames`) so existing in-flight
 * runs keep their memoized steps.  Behavior is otherwise unchanged.
 */
import { centimes, centimesToMad } from "./money";
import { prisma } from "./prisma";
import { decrypt } from "./encryption";
import { getAdapter } from "../adapters/registry";
import { VpsAdapter } from "../adapters/vps.adapter";
import { maskObject } from "./mask";

/**
 * Structural subset of Inngest's step object used by the ladder helper.
 * Inngest's `step.run` JSON-serializes results and carries a complex generic
 * return type, so we use `any` at this boundary to stay compatible across SDK
 * versions without losing the behavior of the underlying step.
 */
interface DunningStep {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(name: string, fn: () => any): Promise<any>;
  sleep(name: string, duration: string): Promise<void>;
}

export interface ChargeAttemptResult {
  success: boolean;
  vpsTransactionId?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
}

/**
 * Attempt a single VPS renewal charge for a subscription.
 *
 * `recordMode` controls whether the BillingEvent is upserted (production —
 * idempotent against the attempt id) or created (simulation — throwaway records).
 */
export async function chargeSubscription(params: {
  subscriptionId: string;
  tenantId: string;
  chargeId: string;
  idempotencyId: string;
  amountCentimes: number;
  currency: string;
  attemptNumber: number;
  recordMode: "upsert" | "create";
}): Promise<ChargeAttemptResult> {
  const {
    subscriptionId,
    tenantId,
    chargeId,
    idempotencyId,
    amountCentimes,
    currency,
    attemptNumber,
    recordMode,
  } = params;

  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });
  if (subscription.status === "CANCELLED" || subscription.status === "EXPIRED") {
    return { success: false, errorMessage: `Subscription is ${subscription.status}`, raw: {} };
  }

  const config = await prisma.providerConfig.findFirst({
    where: { tenantId, provider: "VPS", status: "CONNECTED" },
  });
  if (!config) {
    return {
      success: false,
      errorMessage: "VPS provider config not found or disconnected",
      raw: {},
    };
  }

  const adapter = getAdapter("VPS", config.encryptedCredentials) as VpsAdapter;
  const profileId = decrypt(subscription.encryptedStoredProfileId);

  const result = await adapter.chargeRenewal(
    profileId,
    amountCentimes,
    currency,
    chargeId,
    idempotencyId,
  );

  const failureMessage = (result.rawResponse["message"] as string) ?? "Charge declined";

  const eventData = {
    subscriptionId,
    chargeId,
    vpsTransactionId: result.providerTransactionId,
    amount: centimesToMad(centimes(amountCentimes)),
    currency,
    status: result.success ? "CHARGED" : "DECLINED",
    attemptNumber,
    processedAt: new Date(),
    errorMessage: result.success ? null : failureMessage,
  };

  if (recordMode === "upsert") {
    const eventId = `${subscriptionId}-${idempotencyId}-${attemptNumber}`.slice(0, 25);
    await prisma.billingEvent
      .upsert({
        where: { id: eventId },
        create: { id: eventId, ...eventData },
        update: {
          vpsTransactionId: eventData.vpsTransactionId,
          status: eventData.status,
          processedAt: eventData.processedAt,
          errorMessage: eventData.errorMessage,
        },
      })
      .catch(() => prisma.billingEvent.create({ data: eventData }));
  } else {
    await prisma.billingEvent.create({ data: eventData });
  }

  return {
    success: result.success,
    vpsTransactionId: result.providerTransactionId,
    errorMessage: result.success ? undefined : failureMessage,
    raw: maskObject(result.rawResponse) as Record<string, unknown>,
  };
}

/**
 * Attempt a single VPS renewal charge for one BNPL installment.
 */
export async function chargeInstallment(params: {
  agreementId: string;
  tenantId: string;
  chargeId: string;
  idempotencyId: string;
  installmentNumber: number;
  attemptNumber: number;
}): Promise<{ success: boolean; vpsTransactionId?: string; errorMessage?: string }> {
  const { agreementId, tenantId, chargeId, idempotencyId, installmentNumber, attemptNumber } =
    params;

  const agreement = await prisma.installmentAgreement.findUniqueOrThrow({
    where: { id: agreementId },
  });
  if (
    agreement.status === "CANCELLED" ||
    agreement.status === "COMPLETED" ||
    agreement.status === "DEFAULTED"
  ) {
    return { success: false, errorMessage: `Agreement is ${agreement.status}` };
  }

  const config = await prisma.providerConfig.findFirst({
    where: { tenantId, provider: "VPS", status: "CONNECTED" },
  });
  if (!config) {
    return { success: false, errorMessage: "VPS provider config not found or disconnected" };
  }

  const adapter = getAdapter("VPS", config.encryptedCredentials) as VpsAdapter;
  const profileId = decrypt(agreement.encryptedStoredProfileId);
  const amountCentimes = Math.round(Number(agreement.installmentAmount) * 100);

  const result = await adapter.chargeRenewal(
    profileId,
    amountCentimes,
    agreement.currency,
    chargeId,
    idempotencyId,
  );

  const chargeData = {
    status: result.success ? "CHARGED" : "DECLINED",
    vpsTransactionId: result.providerTransactionId ?? null,
    attemptNumber,
    processedAt: new Date(),
    errorMessage: result.success
      ? null
      : ((result.rawResponse["message"] as string) ?? "Charge declined"),
  };

  const existing = await prisma.installmentCharge.findFirst({
    where: { agreementId, installmentNumber },
  });
  if (existing) {
    await prisma.installmentCharge.update({ where: { id: existing.id }, data: chargeData });
  } else {
    await prisma.installmentCharge.create({
      data: {
        agreementId,
        installmentNumber,
        dueDate: new Date(),
        amount: agreement.installmentAmount,
        currency: agreement.currency,
        chargeId,
        ...chargeData,
      },
    });
  }

  return {
    success: result.success,
    vpsTransactionId: result.providerTransactionId,
    errorMessage: result.success
      ? undefined
      : ((result.rawResponse["message"] as string) ?? "Charge declined"),
  };
}

export interface DunningLadderConfig<TAttempt extends { success: boolean }, TResult> {
  step: DunningStep;
  maxAttempts: number;
  /** Sleep durations before attempts 2..maxAttempts (length must be maxAttempts - 1). */
  delays: string[];
  stepNames: {
    attempt: (n: number) => string;
    wait: (n: number) => string;
    check: (n: number) => string;
  };
  attempt: (n: number) => Promise<TAttempt>;
  /** Called before each retry (attempts 2..maxAttempts). Return `stop: true` to abort. */
  shouldStop: (nextAttemptNumber: number) => Promise<{ stop: boolean; reason: string }>;
  onSuccess: (step: DunningStep, n: number, result: TAttempt) => Promise<TResult>;
  onFailure: (step: DunningStep, n: number, result: TAttempt) => Promise<void>;
  onExhausted: (step: DunningStep) => Promise<TResult>;
}

/**
 * Run a dunning ladder: attempt, then on failure sleep and retry up to
 * `maxAttempts` times, stopping early if `shouldStop` says so.  Side effects
 * (`onSuccess` / `onFailure` / `onExhausted`) own their own Inngest step names.
 */
export async function runDunningLadder<TAttempt extends { success: boolean }, TResult>(
  config: DunningLadderConfig<TAttempt, TResult>,
): Promise<TResult | { skipped: true; reason: string }> {
  const {
    step,
    maxAttempts,
    delays,
    stepNames,
    attempt,
    shouldStop,
    onSuccess,
    onFailure,
    onExhausted,
  } = config;

  for (let n = 1; n <= maxAttempts; n++) {
    const result = (await step.run(stepNames.attempt(n), () => attempt(n))) as TAttempt;

    if (result.success) {
      return await onSuccess(step, n, result);
    }

    // The final failed attempt is handled by `onExhausted`, not `onFailure`.
    if (n < maxAttempts) {
      await onFailure(step, n, result);
      await step.sleep(stepNames.wait(n + 1), delays[n - 1]);
      const stopped = await step.run(stepNames.check(n + 1), () => shouldStop(n + 1));
      if (stopped.stop) {
        return { skipped: true, reason: stopped.reason };
      }
    }
  }

  return await onExhausted(step);
}
