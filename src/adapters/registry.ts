import { Provider } from "@/generated/prisma/client";
import { decryptCredentials } from "../lib/encryption";
import { FakeAdapter } from "./fake.adapter";
import { NapsAdapter } from "./naps.adapter";
import { StripeAdapter } from "./stripe.adapter";
import type { NapsCredentials, ProviderAdapter, StripeCredentials, VpsCredentials } from "./types";
import { VpsAdapter } from "./vps.adapter";

/**
 * Given a ProviderConfig row, decrypt its credentials and return the
 * appropriate adapter instance.
 */
export function getAdapter(provider: Provider, encryptedCredentials: string): ProviderAdapter {
  // Demo mode: return the deterministic in-memory adapter regardless of the
  // provider/credentials, so `docker compose up` works with zero PSP secrets.
  if (process.env.DEMO_MODE === "true") {
    return new FakeAdapter();
  }

  const credentials = decryptCredentials(encryptedCredentials);

  switch (provider) {
    case Provider.NAPS:
      return new NapsAdapter(credentials as unknown as NapsCredentials);

    case Provider.VPS:
      return new VpsAdapter(credentials as unknown as VpsCredentials);

    case Provider.STRIPE:
      return new StripeAdapter(credentials as unknown as StripeCredentials);

    case Provider.PAYPAL:
    case Provider.ADYEN:
      throw new Error(`Provider ${provider} is not yet implemented`);

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
