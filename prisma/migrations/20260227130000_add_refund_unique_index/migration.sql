-- C-2: Prevent double refunds at the database level.
-- A given PaymentIntent can only have one active (PENDING or SUCCEEDED) refund at a time.
-- FAILED refunds are excluded so retries can be attempted after a failure.
CREATE UNIQUE INDEX IF NOT EXISTS refund_one_active_per_intent
    ON refunds("paymentIntentId")
    WHERE status IN ('PENDING', 'SUCCEEDED');
