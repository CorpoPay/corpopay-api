/**
 * Master seed — runs on every `npm run db:seed` and on every `docker compose up`
 * (via the api container's startup command). Fully idempotent.
 *
 * Covers:
 *   - Internal super-admin
 *   - "Acme Commerce" sample tenant (dev/demo)
 *   - Demo VPS/Payzone SANDBOX config + installment plans (only when sandbox secrets are set)
 *   - Provider health defaults
 */
import {
  PrismaClient,
  UserRole,
  Environment,
  Provider,
  ProviderConfigStatus,
} from "../src/generated/prisma/client";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { encrypt } from "../src/lib/encryption";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// ─── Demo VPS / Payzone credentials (SANDBOX) ───────────────────────────────
const DEMO_VPS_CREDENTIALS = {
  merchantAccount: "Int_demo_Test",
  paywallSecretKey: process.env.SEED_VPS_PAYWALL_SECRET ?? "",
  paywallUrl: "https://payment-sandbox.payzone.ma/pwthree/launch",
  skin: "vps-1-vue",
  doFundsAuthOnly: true,
  // paymentMethod intentionally omitted — in DEEP_LINK mode Payzone presents
  // all available methods; setting 'CREDIT_CARD' causes 400 "method is not available".
  // showPaymentProfiles=false — with no saved profiles, "true" makes the paywall
  // render an empty saved-profiles list instead of the card-entry form.
  showPaymentProfiles: "false",
  mode: "DEEP_LINK",
  apiUrl: "https://payment-sandbox.payzone.ma",
  callerName: "$apicaller",
  callerPassword: process.env.SEED_VPS_CALLER_PASSWORD ?? "",
  notificationKey: process.env.SEED_VPS_NOTIFICATION_KEY ?? "",
  callbackTestMode: false,
};

// Skip the demo VPS config + installment plans unless the sandbox secrets are
// provided via env. Without them the config would be created with empty
// credentials and fail at connection-test time.
const hasDemoVpsSecrets =
  !!process.env.SEED_VPS_PAYWALL_SECRET &&
  !!process.env.SEED_VPS_CALLER_PASSWORD &&
  !!process.env.SEED_VPS_NOTIFICATION_KEY;

async function main() {
  console.log("⏳ Seeding database...");

  // ─── Demo tenant ─────────────────────────────────────────────────────────────
  const tenantEmail = "owner@acme-commerce.ma";
  const tenantPassword = "password123";
  let tenant = await prisma.tenant.findUnique({ where: { slug: "acme-commerce" } });

  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: "Acme Commerce",
        slug: "acme-commerce",
        status: "ACTIVE",
        environment: Environment.SANDBOX,
      },
    });
    console.log(`✅ Tenant created: ${tenant.name} (id: ${tenant.id})`);
  } else {
    console.log("⏭  Demo tenant already exists.");
  }

  const existingOwner = await prisma.user.findFirst({ where: { email: tenantEmail } });
  if (!existingOwner) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: tenantEmail,
        passwordHash: await bcrypt.hash(tenantPassword, 12),
        role: UserRole.OWNER,
      },
    });
    console.log(`✅ Owner created: ${tenantEmail} / ${tenantPassword}`);
  } else {
    console.log("⏭  Demo owner already exists.");
  }

  // ─── Super Admin user ────────────────────────────────────────────────────────
  const adminEmail = "admin@example.com";
  const existingAdmin = await prisma.user.findFirst({ where: { email: adminEmail } });

  if (!existingAdmin) {
    const adminTenant = await prisma.tenant.upsert({
      where: { slug: "corpopay-internal" },
      create: { name: "Internal", slug: "corpopay-internal" },
      update: {},
    });

    await prisma.user.create({
      data: {
        tenantId: adminTenant.id,
        email: adminEmail,
        passwordHash: await bcrypt.hash("AdminPass123!", 12),
        role: UserRole.SUPER_ADMIN,
      },
    });

    console.log(`✅ Super Admin created: ${adminEmail} / AdminPass123!`);
  } else {
    console.log("⏭  Super Admin already exists, skipping.");
  }

  // ─── Demo VPS/Payzone config + installment plans ────────────────────────────
  if (hasDemoVpsSecrets) {
    await prisma.providerConfig.upsert({
      where: {
        tenantId_provider: { tenantId: tenant.id, provider: Provider.VPS },
      },
      create: {
        tenantId: tenant.id,
        provider: Provider.VPS,
        encryptedCredentials: encrypt(JSON.stringify(DEMO_VPS_CREDENTIALS)),
        status: ProviderConfigStatus.CONNECTED,
        environment: Environment.SANDBOX,
      },
      update: {
        encryptedCredentials: encrypt(JSON.stringify(DEMO_VPS_CREDENTIALS)),
        status: ProviderConfigStatus.CONNECTED,
      },
    });
    console.log("✅ Demo VPS/Payzone config upserted.");

    // ─── Demo installment plans (3 / 6 / 12 months) ──────────────────────────
    const plans = [
      { name: "Pay in 3", durationMonths: 3, annualInterestRate: 8.99 },
      { name: "Pay in 6", durationMonths: 6, annualInterestRate: 12.99 },
      { name: "Pay in 12", durationMonths: 12, annualInterestRate: 18.99 },
    ];

    for (const p of plans) {
      const existing = await prisma.installmentPlan.findFirst({
        where: { tenantId: tenant.id, durationMonths: p.durationMonths },
      });
      if (!existing) {
        await prisma.installmentPlan.create({
          data: { tenantId: tenant.id, isActive: true, ...p },
        });
        console.log(`✅ Created plan: ${p.name} (${p.annualInterestRate}% APR)`);
      } else {
        await prisma.installmentPlan.update({
          where: { id: existing.id },
          data: {
            name: p.name,
            annualInterestRate: p.annualInterestRate,
            isActive: true,
          },
        });
        console.log(`⏭  Plan "${p.name}" updated to ${p.annualInterestRate}% APR.`);
      }
    }
    console.log("✅ Demo installment plans seeded.");
  } else {
    console.warn(
      "⚠️  Skipping demo VPS config + installment plans — set SEED_VPS_PAYWALL_SECRET, SEED_VPS_CALLER_PASSWORD and SEED_VPS_NOTIFICATION_KEY to seed a working sandbox config.",
    );
  }

  // ─── Provider health defaults ────────────────────────────────────────────────
  for (const provider of ["NAPS", "VPS"] as const) {
    await prisma.providerHealth.upsert({
      where: { provider },
      create: { provider, status: "NORMAL" },
      update: {},
    });
  }
  console.log("✅ Provider health defaults set.");

  console.log("✅ Seed complete.");
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
