/**
 * seed-demo.ts — idempotent demo seeder.
 *
 * Creates (or no-ops on) the complete "Demo Merchant" tenant graph from
 * `seed-demo-data.ts`. Safe to run repeatedly: every row is upserted by a
 * stable unique key (tenant slug, user email, provider composite, payment-link
 * slug, intent correlationId, or a fixed `id`), so re-running never duplicates
 * and never clobbers demo data the user may have edited.
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… npx tsx prisma/seed-demo.ts
 *   # or via the package script:  npm run db:seed:demo
 *
 * Requires `ENCRYPTION_KEY` (64-hex) for credential/profile encryption, the
 * same way `prisma/seed.ts` does.
 */

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import {
  PrismaClient,
  type PrismaClient as PrismaClientType,
} from "../src/generated/prisma/client";
import { encrypt, encryptCredentials } from "../src/lib/encryption";
import {
  DEMO_TENANT_ID,
  demoApiKeys,
  demoBillingEvents,
  demoDisputes,
  demoFeeSchedules,
  demoInstallmentAgreement,
  demoInstallmentCharges,
  demoInstallmentPlans,
  demoLedgerEntries,
  demoMerchantOnboardings,
  demoPaymentIntents,
  demoPaymentLinks,
  demoPayoutItems,
  demoPayouts,
  demoProviderConfigs,
  demoProviderTransactions,
  demoReconciliationLines,
  demoReconciliationReports,
  demoRecoveries,
  demoRefunds,
  demoSettlementPolicies,
  demoSettlementStatementItems,
  demoSettlementStatements,
  demoSplitParties,
  demoSplitRules,
  demoSplits,
  demoSubscriptions,
  demoTenant,
  demoUsers,
  demoWebhookEvents,
} from "./seed-demo-data";

/**
 * Materialise the demo graph into `prisma`. Extracted so `reset-demo.ts` can
 * reuse it after truncation.
 */
export async function seedDemoData(prisma: PrismaClientType): Promise<void> {
  // ── Tenant ────────────────────────────────────────────────────────────────
  const tenantData = demoTenant();
  await prisma.tenant.upsert({
    where: { slug: tenantData.slug },
    create: tenantData,
    update: { name: tenantData.name, environment: tenantData.environment },
  });
  console.log("✅ Demo tenant upserted.");

  // ── Users ─────────────────────────────────────────────────────────────────
  for (const spec of demoUsers()) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: DEMO_TENANT_ID, email: spec.email } },
      create: {
        id: spec.id,
        tenantId: DEMO_TENANT_ID,
        email: spec.email,
        passwordHash: await bcrypt.hash(spec.password, 12),
        role: spec.role,
      },
      // Preserve any role/password changes made after seeding.
      update: {},
    });
  }
  console.log(`✅ ${demoUsers().length} demo users upserted.`);

  // ── Provider configs ──────────────────────────────────────────────────────
  for (const spec of demoProviderConfigs()) {
    await prisma.providerConfig.upsert({
      where: { tenantId_provider: { tenantId: DEMO_TENANT_ID, provider: spec.provider } },
      create: {
        id: spec.id,
        tenantId: DEMO_TENANT_ID,
        provider: spec.provider,
        encryptedCredentials: encryptCredentials(spec.credentials),
        status: spec.status,
        environment: spec.environment,
      },
      update: { status: spec.status },
    });
  }
  console.log(`✅ ${demoProviderConfigs().length} provider configs upserted.`);

  // ── Payment links ─────────────────────────────────────────────────────────
  for (const link of demoPaymentLinks()) {
    await prisma.paymentLink.upsert({
      where: { slug: link.slug },
      create: link,
      update: { status: link.status },
    });
  }
  console.log(`✅ ${demoPaymentLinks().length} payment links upserted.`);

  // ── Payment intents ───────────────────────────────────────────────────────
  for (const intent of demoPaymentIntents()) {
    await prisma.paymentIntent.upsert({
      where: { correlationId: intent.correlationId },
      create: intent,
      update: { status: intent.status },
    });
  }
  console.log(`✅ ${demoPaymentIntents().length} payment intents upserted.`);

  // ── Provider transactions ─────────────────────────────────────────────────
  for (const ptx of demoProviderTransactions()) {
    await prisma.providerTransaction.upsert({
      where: { id: ptx.id },
      create: ptx,
      update: {},
    });
  }
  console.log(`✅ ${demoProviderTransactions().length} provider transactions upserted.`);

  // ── Refunds ───────────────────────────────────────────────────────────────
  for (const refund of demoRefunds()) {
    await prisma.refund.upsert({
      where: { id: refund.id },
      create: refund,
      update: {},
    });
  }
  console.log(`✅ ${demoRefunds().length} refunds upserted.`);

  // ── Subscriptions + billing events ────────────────────────────────────────
  for (const spec of demoSubscriptions()) {
    await prisma.subscription.upsert({
      where: { id: spec.id },
      create: {
        id: spec.id,
        tenantId: DEMO_TENANT_ID,
        customerId: spec.customerId,
        encryptedStoredProfileId: encrypt(spec.storedProfileId),
        initialPaymentIntentId: spec.initialPaymentIntentId,
        paymentLinkId: spec.paymentLinkId,
        status: spec.status,
        amount: spec.amount,
        currency: spec.currency,
        intervalType: spec.intervalType,
        intervalValue: spec.intervalValue,
        nextBillingDate: spec.nextBillingDate,
        currentPeriodStart: spec.currentPeriodStart,
        currentPeriodEnd: spec.currentPeriodEnd,
        retryCount: spec.retryCount,
        maxRetries: 3,
      },
      update: { status: spec.status },
    });
  }
  console.log(`✅ ${demoSubscriptions().length} subscriptions upserted.`);

  for (const event of demoBillingEvents()) {
    await prisma.billingEvent.upsert({
      where: { id: event.id },
      create: event,
      update: {},
    });
  }
  console.log(`✅ ${demoBillingEvents().length} billing events upserted.`);

  // ── Installment plan + agreement + charges ────────────────────────────────
  for (const plan of demoInstallmentPlans()) {
    await prisma.installmentPlan.upsert({
      where: { id: plan.id },
      create: plan,
      update: {},
    });
  }
  console.log(`✅ ${demoInstallmentPlans().length} installment plan(s) upserted.`);

  const agreement = demoInstallmentAgreement();
  await prisma.installmentAgreement.upsert({
    where: { id: agreement.id },
    create: {
      id: agreement.id,
      tenantId: DEMO_TENANT_ID,
      customerId: agreement.customerId,
      planId: agreement.planId,
      paymentLinkId: agreement.paymentLinkId,
      initialPaymentIntentId: agreement.initialPaymentIntentId,
      encryptedStoredProfileId: encrypt(agreement.storedProfileId),
      status: agreement.status,
      principalAmount: agreement.principalAmount,
      downPayment: agreement.downPayment,
      installmentAmount: agreement.installmentAmount,
      totalInstallments: agreement.totalInstallments,
      paidCount: agreement.paidCount,
      currency: agreement.currency,
      nextChargeDate: agreement.nextChargeDate,
    },
    update: { status: agreement.status },
  });
  console.log("✅ Installment agreement upserted.");

  for (const charge of demoInstallmentCharges()) {
    await prisma.installmentCharge.upsert({
      where: { id: charge.id },
      create: charge,
      update: {},
    });
  }
  console.log(`✅ ${demoInstallmentCharges().length} installment charges upserted.`);

  // ── API keys ──────────────────────────────────────────────────────────────
  for (const spec of demoApiKeys()) {
    const keySha256 = crypto.createHash("sha256").update(spec.rawKey).digest("hex");
    await prisma.apiKey.upsert({
      where: { id: spec.id },
      create: {
        id: spec.id,
        tenantId: DEMO_TENANT_ID,
        name: spec.name,
        keyHash: await bcrypt.hash(spec.rawKey, 10),
        keySha256,
        keyPrefix: spec.rawKey.slice(0, 16),
        revokedAt: spec.revokedAt,
      },
      update: {},
    });
  }
  console.log(`✅ ${demoApiKeys().length} API keys upserted.`);

  // ── Webhook events ────────────────────────────────────────────────────────
  for (const event of demoWebhookEvents()) {
    await prisma.webhookEvent.upsert({
      where: { id: event.id },
      create: event,
      update: {},
    });
  }
  console.log(`✅ ${demoWebhookEvents().length} webhook events upserted.`);

  // ── PayFac settlement layer ────────────────────────────────────────────────
  // Insert order follows FK dependencies: fee schedule → policy; split parties
  // → ledger (partyId) → split; payout + ledger → payout item; dispute → recovery;
  // report → line; statement → item.

  for (const fee of demoFeeSchedules()) {
    await prisma.feeSchedule.upsert({
      where: { tenantId_version: { tenantId: DEMO_TENANT_ID, version: fee.version } },
      create: fee,
      update: { name: fee.name, feeType: fee.feeType, percentageBps: fee.percentageBps },
    });
  }
  console.log(`✅ ${demoFeeSchedules().length} fee schedule(s) upserted.`);

  for (const policy of demoSettlementPolicies()) {
    await prisma.settlementPolicy.upsert({
      where: { tenantId_version: { tenantId: DEMO_TENANT_ID, version: policy.version } },
      create: policy,
      update: { name: policy.name, payoutSchedule: policy.payoutSchedule },
    });
  }
  console.log(`✅ ${demoSettlementPolicies().length} settlement polic(ies) upserted.`);

  for (const onboarding of demoMerchantOnboardings()) {
    await prisma.merchantOnboarding.upsert({
      where: { tenantId: DEMO_TENANT_ID },
      create: onboarding,
      update: { status: onboarding.status },
    });
  }
  console.log(`✅ ${demoMerchantOnboardings().length} merchant onboarding(s) upserted.`);

  for (const party of demoSplitParties()) {
    await prisma.splitParty.upsert({
      where: { tenantId_slug: { tenantId: DEMO_TENANT_ID, slug: party.slug } },
      create: party,
      update: { name: party.name },
    });
  }
  console.log(`✅ ${demoSplitParties().length} split part(ies) upserted.`);

  for (const rule of demoSplitRules()) {
    await prisma.splitRule.upsert({
      where: { id: rule.id },
      create: rule,
      update: {},
    });
  }
  console.log(`✅ ${demoSplitRules().length} split rule(s) upserted.`);

  for (const entry of demoLedgerEntries()) {
    await prisma.ledgerEntry.upsert({
      where: { id: entry.id },
      create: entry,
      update: {},
    });
  }
  console.log(`✅ ${demoLedgerEntries().length} ledger entries upserted.`);

  for (const split of demoSplits()) {
    await prisma.split.upsert({
      where: { id: split.id },
      create: split,
      update: {},
    });
  }
  console.log(`✅ ${demoSplits().length} split(s) upserted.`);

  for (const payout of demoPayouts()) {
    await prisma.payout.upsert({
      where: {
        tenantId_idempotencyKey: {
          tenantId: DEMO_TENANT_ID,
          idempotencyKey: payout.idempotencyKey,
        },
      },
      create: payout,
      update: { status: payout.status },
    });
  }
  console.log(`✅ ${demoPayouts().length} payout(s) upserted.`);

  for (const item of demoPayoutItems()) {
    await prisma.payoutItem.upsert({
      where: { id: item.id },
      create: item,
      update: {},
    });
  }
  console.log(`✅ ${demoPayoutItems().length} payout item(s) upserted.`);

  for (const dispute of demoDisputes()) {
    await prisma.dispute.upsert({
      where: {
        tenantId_providerDisputeId: {
          tenantId: DEMO_TENANT_ID,
          providerDisputeId: dispute.providerDisputeId,
        },
      },
      create: dispute,
      update: { status: dispute.status },
    });
  }
  console.log(`✅ ${demoDisputes().length} dispute(s) upserted.`);

  for (const recovery of demoRecoveries()) {
    await prisma.recovery.upsert({
      where: { disputeId: recovery.disputeId },
      create: recovery,
      update: { status: recovery.status },
    });
  }
  console.log(`✅ ${demoRecoveries().length} recover(ies) upserted.`);

  for (const report of demoReconciliationReports()) {
    await prisma.reconciliationReport.upsert({
      where: { id: report.id },
      create: report,
      update: {},
    });
  }
  console.log(`✅ ${demoReconciliationReports().length} reconciliation report(s) upserted.`);

  for (const line of demoReconciliationLines()) {
    await prisma.reconciliationLine.upsert({
      where: { id: line.id },
      create: line,
      update: {},
    });
  }
  console.log(`✅ ${demoReconciliationLines().length} reconciliation line(s) upserted.`);

  for (const statement of demoSettlementStatements()) {
    await prisma.settlementStatement.upsert({
      where: { id: statement.id },
      create: statement,
      update: {},
    });
  }
  console.log(`✅ ${demoSettlementStatements().length} settlement statement(s) upserted.`);

  for (const item of demoSettlementStatementItems()) {
    await prisma.settlementStatementItem.upsert({
      where: { id: item.id },
      create: item,
      update: {},
    });
  }
  console.log(`✅ ${demoSettlementStatementItems().length} settlement statement item(s) upserted.`);

  console.log("✅ Demo seed complete.");
}

async function main(): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) {
    console.error("❌ ENCRYPTION_KEY is required (64 hex chars) to seed demo credentials.");
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    await seedDemoData(prisma);
  } catch (err) {
    console.error("❌ Demo seed failed:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run directly when invoked as a script; stay inert when imported (e.g. by
// reset-demo.ts, which calls seedDemoData() itself after truncation).
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  void main();
}
