/**
 * Stripe adapter — stub.
 *
 * All methods throw until Stripe is implemented. The structure matches
 * ProviderAdapter so it can be registered in the factory.
 *
 * Implementation guide (when ready):
 *   - createCheckoutSession  → Stripe Checkout Sessions API
 *   - capturePayment         → stripe.paymentIntents.capture(id)
 *   - cancelPayment          → stripe.paymentIntents.cancel(id)
 *   - refund                 → stripe.refunds.create({ payment_intent: id, amount })
 *   - queryTransactionStatus → stripe.paymentIntents.retrieve(id)
 *   - verifyWebhookSignature → stripe.webhooks.constructEvent(body, sig, secret)
 */
import { PaymentIntentStatus } from '@prisma/client';
import {
  ProviderAdapter,
  StripeCredentials,
  CreateCheckoutParams,
  CreateCheckoutResult,
  CaptureResult,
  CancelResult,
  QueryStatusResult,
  RefundResult,
  TestConnectionResult,
} from './types';

export class StripeAdapter implements ProviderAdapter {
  readonly name = 'STRIPE';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly _credentials: StripeCredentials) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createCheckoutSession(_params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    throw new Error('Stripe adapter is not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async capturePayment(_providerRef: string, _amount: number, _currency: string): Promise<CaptureResult> {
    throw new Error('Stripe adapter is not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cancelPayment(_providerRef: string, _amount: number, _currency: string): Promise<CancelResult> {
    throw new Error('Stripe adapter is not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async queryTransactionStatus(_providerRef: string): Promise<QueryStatusResult> {
    throw new Error('Stripe adapter is not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async refund(_providerRef: string, _amount: number, _currency: string): Promise<RefundResult> {
    throw new Error('Stripe adapter is not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  verifyWebhookSignature(_rawBody: Buffer, _headers: Record<string, string>): boolean {
    throw new Error('Stripe adapter is not yet implemented');
  }

  mapStatusToInternal(_providerStatus: string): PaymentIntentStatus {
    throw new Error('Stripe adapter is not yet implemented');
  }

  async testConnection(): Promise<TestConnectionResult> {
    return { connected: false, error: 'Stripe adapter is not yet implemented' };
  }
}
