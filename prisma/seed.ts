/**
 * Master seed — runs on every `npm run db:seed` and on every `docker compose up`
 * (via the api container's startup command). Fully idempotent.
 *
 * Covers:
 *   - CorpoPay Internal super-admin
 *   - Acme Commerce sample tenant (dev/demo)
 *   - Jabadoor production tenant + VPS/Payzone SANDBOX config
 *   - Provider health defaults
 */
import { PrismaClient, UserRole, Environment, Provider, ProviderConfigStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { encrypt } from '../src/lib/encryption';

const prisma = new PrismaClient();

// ─── Jabadoor VPS / Payzone credentials (SANDBOX) ───────────────────────────────
const JABADOOR_VPS_CREDENTIALS = {
  merchantAccount:     'Int_jabadoor_Test',
  paywallSecretKey:    'YK6Y3PXiT3px7EzM',
  paywallUrl:          'https://payment-sandbox.payzone.ma/pwthree/launch',
  skin:                'vps-1-vue',
  doFundsAuthOnly:     true,
  paymentMethod:       'CREDIT_CARD',
  showPaymentProfiles: 'false',
  mode:                'test',
  apiUrl:              'https://payment-sandbox.payzone.ma',
  callerName:          '$apicaller',
  callerPassword:      '!hRhEge9B$U!9znc',
  notificationKey:     'ixMzjOkfT5qw4Lo4',
  callbackTestMode:    false,
};

async function main() {
  console.log('⏳ Seeding database...');

  // ─── Sample tenant ───────────────────────────────────────────────────────────────
  const tenantEmail = 'owner@acme-commerce.ma';
  const existingOwner = await prisma.user.findFirst({ where: { email: tenantEmail } });

  if (!existingOwner) {
    const tenant = await prisma.tenant.create({
      data: { name: 'Acme Commerce', slug: 'acme-commerce' },
    });

    await prisma.user.create({
      data: {
        tenantId:     tenant.id,
        email:        tenantEmail,
        passwordHash: await bcrypt.hash('password123', 12),
        role:         UserRole.OWNER,
      },
    });

    console.log(`✅ Tenant created: ${tenant.name} (id: ${tenant.id})`);
    console.log(`   Owner: ${tenantEmail} / password123`);
  } else {
    console.log('⏭  Sample tenant already exists, skipping.');
  }

  // ─── Super Admin user ────────────────────────────────────────────────────────────
  // Super Admins belong to a special internal tenant
  const adminEmail = 'admin@corpopay.ma';
  const existingAdmin = await prisma.user.findFirst({ where: { email: adminEmail } });

  if (!existingAdmin) {
    const adminTenant = await prisma.tenant.upsert({
      where:  { slug: 'corpopay-internal' },
      create: { name: 'CorpoPay Internal', slug: 'corpopay-internal' },
      update: {},
    });

    await prisma.user.create({
      data: {
        tenantId:     adminTenant.id,
        email:        adminEmail,
        passwordHash: await bcrypt.hash('AdminPass123!', 12),
        role:         UserRole.SUPER_ADMIN,
      },
    });

    console.log(`✅ Super Admin created: ${adminEmail} / AdminPass123!`);
  } else {
    console.log('⏭  Super Admin already exists, skipping.');
  }

  // ─── Jabadoor tenant ──────────────────────────────────────────────────────────────
  let jabadoor = await prisma.tenant.findUnique({ where: { slug: 'jabadoor' } });

  if (!jabadoor) {
    jabadoor = await prisma.tenant.create({
      data: { name: 'Jabadoor', slug: 'jabadoor', status: 'ACTIVE', environment: Environment.SANDBOX },
    });
    console.log(`✅ Tenant created: ${jabadoor.name} (id: ${jabadoor.id})`);
  } else {
    console.log(`⏭  Jabadoor tenant already exists.`);
  }

  const existingJabadoorOwner = await prisma.user.findFirst({
    where: { tenantId: jabadoor.id, email: 'ayman.errarhiche@jabadoor.com' },
  });

  if (!existingJabadoorOwner) {
    await prisma.user.create({
      data: {
        tenantId:     jabadoor.id,
        email:        'ayman.errarhiche@jabadoor.com',
        passwordHash: await bcrypt.hash('Jabadoor@2026!', 12),
        role:         UserRole.OWNER,
      },
    });
    console.log('✅ Jabadoor owner created: ayman.errarhiche@jabadoor.com');
  } else {
    console.log('⏭  Jabadoor owner already exists.');
  }

  await prisma.providerConfig.upsert({
    where:  { tenantId_provider: { tenantId: jabadoor.id, provider: Provider.VPS } },
    create: {
      tenantId:             jabadoor.id,
      provider:             Provider.VPS,
      encryptedCredentials: encrypt(JSON.stringify(JABADOOR_VPS_CREDENTIALS)),
      status:               ProviderConfigStatus.CONNECTED,
      environment:          Environment.SANDBOX,
    },
    update: {
      encryptedCredentials: encrypt(JSON.stringify(JABADOOR_VPS_CREDENTIALS)),
      status:               ProviderConfigStatus.CONNECTED,
    },
  });
  console.log('✅ Jabadoor VPS/Payzone config upserted.');

  // ─── Provider health defaults ────────────────────────────────────────────────────
  for (const provider of ['NAPS', 'VPS'] as const) {
    await prisma.providerHealth.upsert({
      where:  { provider },
      create: { provider, status: 'NORMAL' },
      update: {},
    });
  }
  console.log('✅ Provider health defaults set.');

  console.log('✅ Seed complete.');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
