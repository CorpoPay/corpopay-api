/**
 * reset-demo.ts — truncate + re-seed the demo tenant.
 *
 * Deletes every row belonging to the "demo" tenant in FK-safe order (children
 * before parents), then re-runs the idempotent demo seeder so demos and E2E
 * tests always start from a clean, known slate.
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… npx tsx prisma/reset-demo.ts
 *   # or via the package script:  npm run db:reset:demo
 */

import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { seedDemoData } from "./seed-demo";
import { DEMO_TENANT_ID, demoWebhookEvents } from "./seed-demo-data";

/** Delete the demo tenant's rows in FK-safe order. */
async function truncateDemoTenant(prisma: PrismaClient): Promise<void> {
  const tenantId = DEMO_TENANT_ID;

  // Children first — models that reference a parent which references the tenant.
  await prisma.billingEvent.deleteMany({ where: { subscription: { tenantId } } });
  await prisma.installmentCharge.deleteMany({ where: { agreement: { tenantId } } });
  await prisma.providerTransaction.deleteMany({ where: { paymentIntent: { tenantId } } });
  await prisma.webhookEvent.deleteMany({ where: { tenantId } });
  await prisma.refund.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });

  // Parents — delete in reverse-dependency order so referential actions resolve.
  await prisma.subscription.deleteMany({ where: { tenantId } });
  await prisma.installmentAgreement.deleteMany({ where: { tenantId } });
  await prisma.installmentPlan.deleteMany({ where: { tenantId } });
  await prisma.paymentIntent.deleteMany({ where: { tenantId } });
  await prisma.apiKey.deleteMany({ where: { tenantId } });
  await prisma.providerConfig.deleteMany({ where: { tenantId } });
  await prisma.paymentLink.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });

  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

async function main(): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) {
    console.error("❌ ENCRYPTION_KEY is required (64 hex chars) to re-seed demo credentials.");
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    console.log(`🗑  Truncating demo tenant (${DEMO_TENANT_ID})…`);
    await truncateDemoTenant(prisma);
    console.log(
      `✅ Demo tenant truncated (${demoWebhookEvents().length} webhook event(s) removed).`,
    );
    await seedDemoData(prisma);
  } catch (err) {
    console.error("❌ Demo reset failed:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  void main();
}
