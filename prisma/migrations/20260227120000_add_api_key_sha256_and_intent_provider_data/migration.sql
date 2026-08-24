-- AlterTable: add providerData column to payment_intents
ALTER TABLE "payment_intents" ADD COLUMN "providerData" JSONB;

-- AlterTable: add keySha256 column to api_keys (nullable, unique)
ALTER TABLE "api_keys" ADD COLUMN "keySha256" TEXT;

-- CreateIndex: unique index on api_keys.keySha256
CREATE UNIQUE INDEX "api_keys_keySha256_key" ON "api_keys"("keySha256");
