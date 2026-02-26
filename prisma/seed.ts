/**
 * Seed script: creates a SUPER_ADMIN user and a sample SANDBOX tenant + OWNER user.
 * Run with: npm run db:seed
 */
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

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
