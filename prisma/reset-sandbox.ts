/**
 * reset-sandbox.ts — truncate + re-seed the full sandbox (demo + themes).
 *
 * Deletes every row belonging to the sandbox tenants in FK-safe order
 * (children before parents), then re-runs the idempotent sandbox seeder so
 * local dev, demos and E2E tests always start from a clean, known slate.
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… npx tsx prisma/reset-sandbox.ts
 *   # or via the package script:  npm run db:reset:sandbox
 */

import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { SANDBOX_TENANT_IDS, seedSandboxData } from "./seed-sandbox";

/** Delete all sandbox tenants' rows in FK-safe order. */
async function truncateSandboxTenants(prisma: PrismaClient): Promise<void> {
  const ids = SANDBOX_TENANT_IDS;
  const tenantIdIn = { tenantId: { in: ids } };

  // Children first — models whose tenant link goes through a parent relation.
  await prisma.billingEvent.deleteMany({ where: { subscription: { tenantId: { in: ids } } } });
  await prisma.installmentCharge.deleteMany({ where: { agreement: { tenantId: { in: ids } } } });
  await prisma.providerTransaction.deleteMany({
    where: { paymentIntent: { tenantId: { in: ids } } },
  });
  await prisma.webhookEvent.deleteMany({ where: tenantIdIn });
  await prisma.refund.deleteMany({ where: tenantIdIn });
  await prisma.auditLog.deleteMany({ where: tenantIdIn });

  // Parents — reverse-dependency order so referential actions resolve.
  await prisma.subscription.deleteMany({ where: tenantIdIn });
  await prisma.installmentAgreement.deleteMany({ where: tenantIdIn });
  await prisma.installmentPlan.deleteMany({ where: tenantIdIn });
  await prisma.paymentIntent.deleteMany({ where: tenantIdIn });
  await prisma.apiKey.deleteMany({ where: tenantIdIn });
  await prisma.providerConfig.deleteMany({ where: tenantIdIn });
  await prisma.paymentLink.deleteMany({ where: tenantIdIn });
  await prisma.user.deleteMany({ where: tenantIdIn });

  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function main(): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) {
    console.error("❌ ENCRYPTION_KEY is required (64 hex chars) to re-seed sandbox credentials.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is required.");
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    console.log(`🗑  Truncating ${SANDBOX_TENANT_IDS.length} sandbox tenant(s)…`);
    await truncateSandboxTenants(prisma);
    await seedSandboxData(prisma);
    console.log("✅ Sandbox reset complete.");
  } catch (err) {
    console.error("❌ Sandbox reset failed:", err);
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
