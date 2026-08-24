import { Provider } from "@/generated/prisma/client";
import { decryptCredentials } from "../lib/encryption";
import { NapsCredentials, VpsCredentials, StripeCredentials, ProviderAdapter } from "./types";
import { NapsAdapter } from "./naps.adapter";
import { VpsAdapter } from "./vps.adapter";
import { StripeAdapter } from "./stripe.adapter";

/**
 * Given a ProviderConfig row, decrypt its credentials and return the
 * appropriate adapter instance.
 */
export function getAdapter(provider: Provider, encryptedCredentials: string): ProviderAdapter {
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
