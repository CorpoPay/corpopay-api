/**
 * One-off idempotent seed: creates the Jabadoor tenant, its OWNER user,
 * and a fully configured VPS / Payzone ProviderConfig on Neon production.
 *
 * Run via Doppler (production config):
 *   doppler run --config prd -- npx ts-node prisma/seed-jabadoor.ts
 *
 * Safe to re-run — all inserts are guarded by existence checks.
 */
import { PrismaClient, UserRole, Environment, Provider, ProviderConfigStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { encrypt } from '../src/lib/encryption';

const prisma = new PrismaClient();

// ─── Jabadoor tenant config ───────────────────────────────────────────────────

const TENANT_NAME  = 'Jabadoor';
const TENANT_SLUG  = 'jabadoor';
const OWNER_EMAIL  = 'ayman.errarhiche@jabadoor.com';
const OWNER_PASS   = 'Jabadoor@2026!';

/**
 * VPS / Payzone credentials for Jabadoor (SANDBOX).
 * Stored AES-256 encrypted — matches VpsCredentials shape in src/adapters/types.ts
 */
const VPS_CREDENTIALS = {
  // Paywall (front-end redirect)
  merchantAccount:     'Int_jabadoor_Test',
  paywallSecretKey:    'YK6Y3PXiT3px7EzM',
  paywallUrl:          'https://payment-sandbox.payzone.ma/pwthree/launch',
  skin:                'vps-1-vue',
  doFundsAuthOnly:     true,
  paymentMethod:       'CREDIT_CARD',
  showPaymentProfiles: 'false',
  mode:                'test',

  // Server-to-server API (capture / cancel / refund)
  apiUrl:          'https://payment-sandbox.payzone.ma',
  callerName:      '$apicaller',
  callerPassword:  '!hRhEge9B$U!9znc',

  // Webhook signature verification
  notificationKey:    'ixMzjOkfT5qw4Lo4',
  callbackTestMode:   false,
};

// ─── Seed ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('⏳ Seeding Jabadoor tenant…');

  // 1. Tenant
  let tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });

  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name:        TENANT_NAME,
        slug:        TENANT_SLUG,
        status:      'ACTIVE',
        environment: Environment.SANDBOX,
      },
    });
    console.log(`✅ Tenant created: ${tenant.name}  (id: ${tenant.id})`);
  } else {
    console.log(`⏭  Tenant already exists: ${tenant.name}  (id: ${tenant.id})`);
  }

  // 2. Owner user
  const existingOwner = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email: OWNER_EMAIL },
  });

  if (!existingOwner) {
    const user = await prisma.user.create({
      data: {
        tenantId:     tenant.id,
        email:        OWNER_EMAIL,
        passwordHash: await bcrypt.hash(OWNER_PASS, 12),
        role:         UserRole.OWNER,
      },
    });
    console.log(`✅ Owner created: ${user.email}`);
    console.log(`   Password: ${OWNER_PASS}`);
  } else {
    console.log(`⏭  Owner already exists: ${OWNER_EMAIL}`);
  }

  // 3. VPS ProviderConfig (encrypted)
  const existingConfig = await prisma.providerConfig.findUnique({
    where: { tenantId_provider: { tenantId: tenant.id, provider: Provider.VPS } },
  });

  if (!existingConfig) {
    const encryptedCredentials = encrypt(JSON.stringify(VPS_CREDENTIALS));

    const config = await prisma.providerConfig.create({
      data: {
        tenantId:             tenant.id,
        provider:             Provider.VPS,
        encryptedCredentials,
        status:               ProviderConfigStatus.CONNECTED,
        environment:          Environment.SANDBOX,
      },
    });
    console.log(`✅ VPS ProviderConfig created  (id: ${config.id})`);
  } else {
    console.log(`⏭  VPS ProviderConfig already exists  (id: ${existingConfig.id})`);
  }

  console.log('\n✅ Jabadoor seed complete.');
  console.log(`   Tenant : ${TENANT_NAME} / ${TENANT_SLUG}`);
  console.log(`   Login  : ${OWNER_EMAIL}  /  ${OWNER_PASS}`);
  console.log(`   Provider: VPS (Payzone SANDBOX — Int_jabadoor_Test)`);
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
