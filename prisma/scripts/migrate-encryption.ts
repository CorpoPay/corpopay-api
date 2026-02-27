/**
 * One-shot migration: re-encrypt all ProviderConfig.encryptedCredentials rows
 * from the legacy AES-256-CBC format (crypto-js) to the new AES-256-GCM format.
 *
 * USAGE (run once against production before deploying the new encryption code):
 *
 *   # 1. Ensure Doppler has both keys set:
 *   #      ENCRYPTION_KEY    = new 64-char hex key   (openssl rand -hex 32)
 *   #      ENCRYPTION_KEY_V1 = old UTF-8 key          (whatever was in ENCRYPTION_KEY before)
 *   #
 *   # 2. Run the script:
 *   doppler run --config prd -- npx ts-node --project tsconfig.json prisma/scripts/migrate-encryption.ts
 *
 * The script is idempotent: rows already in v2: format are skipped.
 * Run it again if interrupted — it will pick up where it left off.
 */

import { PrismaClient } from '@prisma/client';

// We need both encrypt and decrypt. Import them directly from source so we
// don't have to rebuild. The decrypt() function handles both v2: (new GCM) and
// legacy (old CBC) formats automatically.
import { encrypt, decrypt } from '../../src/lib/encryption';

const prisma = new PrismaClient();

const BATCH_SIZE = 50;

async function main() {
  console.log('[migrate-encryption] Starting…');
  console.log(`[migrate-encryption] ENCRYPTION_KEY set:    ${!!process.env.ENCRYPTION_KEY}`);
  console.log(`[migrate-encryption] ENCRYPTION_KEY_V1 set: ${!!process.env.ENCRYPTION_KEY_V1}`);

  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is not set. Aborting.');
  }
  if (!process.env.ENCRYPTION_KEY_V1) {
    console.warn(
      '[migrate-encryption] WARNING: ENCRYPTION_KEY_V1 is not set. ' +
      'If any rows use the old CBC format they will fail to decrypt.',
    );
  }

  let cursor: string | undefined;
  let migrated = 0;
  let skipped  = 0;
  let errors   = 0;

  while (true) {
    const rows = await prisma.providerConfig.findMany({
      take:    BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select:  { id: true, encryptedCredentials: true },
    });

    if (rows.length === 0) break;

    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      if (row.encryptedCredentials.startsWith('v2:')) {
        skipped++;
        continue;
      }

      try {
        // Decrypt using the old CBC key (ENCRYPTION_KEY_V1)
        const plaintext = decrypt(row.encryptedCredentials);

        // Verify it round-trips — should be valid JSON
        JSON.parse(plaintext);

        // Re-encrypt with the new GCM key (ENCRYPTION_KEY)
        const reEncrypted = encrypt(plaintext);

        await prisma.providerConfig.update({
          where: { id: row.id },
          data:  { encryptedCredentials: reEncrypted },
        });

        migrated++;
        console.log(`[migrate-encryption] ✓ Migrated provider config ${row.id}`);
      } catch (err) {
        errors++;
        console.error(`[migrate-encryption] ✗ FAILED for ${row.id}:`, (err as Error).message);
      }
    }
  }

  console.log(
    `[migrate-encryption] Done. migrated=${migrated} skipped=${skipped} errors=${errors}`,
  );

  if (errors > 0) {
    console.error('[migrate-encryption] Some rows failed — DO NOT deploy until resolved.');
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error('[migrate-encryption] Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
