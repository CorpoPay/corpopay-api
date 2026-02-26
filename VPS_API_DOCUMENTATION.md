# Payzone API Calls Documentation

All API calls made to the Payzone VPS payment gateway.

---

## 1. GET TRANSACTION STATUS

**File:** `view_transaction.php`  
**HTTP Method:** GET  
**Endpoint:** `/api/v3/charges/{chargeId}`  
**Full URL:** `https://payment-sandbox.payzone.ma/api/v3/charges/{chargeId}`

### Headers
```
X-MerchantAccount: Int_jabadoor_Test
X-CallerName: $apicaller
X-HMAC-Timestamp: {timestamp}
X-HMAC-Signature: {HMAC-SHA256 signature}
Content-Type: application/json
```

### Request Body
Empty for GET requests

### Response
```json
{
  "status": "AUTHORIZED|CHARGED|REFUNDED|AUTH_REVERSED|DECLINED|ERROR",
  "id": "{transactionId}",
  "orderId": "{orderId}",
  "amount": {amount},
  "currency": "MAD",
  "transactions": [
    {
      "type": "AUTHORIZE|SETTLE|REFUND|AUTH_REVERSAL",
      "state": "APPROVED|DECLINED|PENDING",
      "resultCode": 0
    }
  ]
}
```

---

## 2. SETTLE PAYMENT (Capture Pre-Authorization)

**File:** `settle_payment.php`  
**HTTP Method:** POST  
**Endpoint:** `/api/v3/charges/{transactionId}`  
**Full URL:** `https://payment-sandbox.payzone.ma/api/v3/charges/{transactionId}`  
**Purpose:** Converts AUTHORIZED → CHARGED (captures pre-authorized funds)

### Headers
```
X-MerchantAccount: Int_jabadoor_Test
X-CallerName: $apicaller
X-HMAC-Timestamp: {timestamp}
X-HMAC-Signature: {HMAC-SHA256 signature}
Content-Type: application/json
```

### Request Body
```json
{
  "command": "SETTLE",
  "amount": 1500.00
}
```

### Response
```json
{
  "status": "CHARGED",
  "id": "{transactionId}",
  "amount": 1500.00,
  "message": "Payment settled successfully"
}
```

---

## 3. REFUND PAYMENT

**File:** `refund_payment.php`  
**HTTP Method:** POST  
**Endpoint:** `/api/v3/charges/{transactionId}`  
**Full URL:** `https://payment-sandbox.payzone.ma/api/v3/charges/{transactionId}`  
**Purpose:** Converts CHARGED → REFUNDED (returns funds to customer)

### Headers
```
X-MerchantAccount: Int_jabadoor_Test
X-CallerName: $apicaller
X-HMAC-Timestamp: {timestamp}
X-HMAC-Signature: {HMAC-SHA256 signature}
Content-Type: application/json
```

### Request Body
```json
{
  "command": "REFUND",
  "amount": 1500.00
}
```

### Response
```json
{
  "status": "REFUNDED",
  "id": "{transactionId}",
  "amount": 1500.00,
  "message": "Payment refunded successfully"
}
```

---

## 4. CANCEL AUTHORIZATION (Auth Reversal)

**File:** `cancel_authorization.php`  
**HTTP Method:** POST  
**Endpoint:** `/api/v3/charges/{transactionId}`  
**Full URL:** `https://payment-sandbox.payzone.ma/api/v3/charges/{transactionId}`  
**Purpose:** Converts AUTHORIZED → AUTH_REVERSED (releases pre-authorized funds)

### Headers
```
X-MerchantAccount: Int_jabadoor_Test
X-CallerName: $apicaller
X-HMAC-Timestamp: {timestamp}
X-HMAC-Signature: {HMAC-SHA256 signature}
Content-Type: application/json
```

### Request Body
```json
{
  "command": "AUTH_REVERSAL",
  "amount": 1500.00
}
```

### Response
```json
{
  "status": "AUTH_REVERSED",
  "id": "{transactionId}",
  "amount": 1500.00,
  "message": "Authorization cancelled successfully"
}
```

---

## 5. LAUNCH PAYWALL (Pre-Authorization/Direct Payment)

**File:** `launch_preauth.php`  
**HTTP Method:** POST  
**URL:** `https://payment-sandbox.payzone.ma/pwthree/launch`  
**Purpose:** Initiates payment gateway session (AUTHORIZE or PAYMENT mode)

### Form Data
```
payload: {JSON-encoded payload}
signature: {SHA256 signature}
```

### Payload Structure
```json
{
  "merchantAccount": "Int_jabadoor_Test",
  "timestamp": 1645555200,
  "skin": "vps-1-vue",
  "doFundsAuthOnly": true,
  "customerId": "cust-1234567890",
  "customerCountry": "MA",
  "customerLocale": "en_US",
  "customerName": "John Doe",
  "customerEmail": "john@example.com",
  "chargeId": "charge-abc123",
  "orderId": "order-xyz789",
  "price": "1500.00",
  "currency": "MAD",
  "description": "Product Name (Pre-Auth)",
  "memo": "Mode: AUTHORIZE | Order: order-xyz789",
  "mode": "DEEP_LINK",
  "paymentMethod": "CREDIT_CARD",
  "showPaymentProfiles": "false",
  "successUrl": "http://yourdomain.com/success_preauth.php?orderId=order-xyz789",
  "failureUrl": "http://yourdomain.com/failure_preauth.php?orderId=order-xyz789",
  "callbackUrl": "http://yourdomain.com/callback_preauth.php",
  "cancelUrl": "http://yourdomain.com/index.php"
}
```

### Response
Redirects user to Payzone payment gateway UI

---

## 6. CALLBACK NOTIFICATION (Incoming from Payzone)

**File:** `callback_preauth.php`  
**HTTP Method:** POST  
**Endpoint:** Server callback URL (configured in launch payload)

### Headers (Incoming from Payzone)
```
X-Callback-Signature: {HMAC-SHA256 signature}
Content-Type: application/json
```

### Request Body (from Payzone)
```json
{
  "status": "AUTHORIZED|CHARGED|REFUNDED|AUTH_REVERSED|DECLINED|AUTHORIZE_PENDING",
  "id": "{payzone-transaction-id}",
  "internalId": "{internal-id}",
  "orderId": "order-xyz789",
  "amount": 1500.00,
  "currency": "MAD",
  "customerId": "cust-1234567890",
  "transactions": [
    {
      "type": "AUTHORIZE",
      "state": "APPROVED",
      "resultCode": 0,
      "resultMessage": "Approved"
    }
  ]
}
```

### Response
```json
{
  "status": "OK",
  "message": "Notification received and processed"
}
```

---

## HMAC Signature Calculation

### For API Requests (GET/POST to /api/v3/)
```
Message = CallerName + MerchantAccount + Timestamp + Path + Body
Signature = HMAC-SHA256(message, callerPassword in uppercase)
```

**Example:**
```
CallerName: $apicaller
MerchantAccount: Int_jabadoor_Test
Timestamp: 1645555200
Path: /api/v3/charges/charge-abc123
Body: {"command":"SETTLE","amount":1500.00}
CallerPassword: !hRhEge9B$U!9znc

Message = "$apicallerInt_jabadoor_Test1645555200/api/v3/charges/charge-abc123{\"command\":\"SETTLE\",\"amount\":1500.00}"
Signature = HMAC-SHA256(Message, !hRhEge9B$U!9znc)
```

### For Paywall Launch
```
Signature = SHA256(paywallSecretKey + payload)
```

### For Callback Validation
```
Signature = HMAC-SHA256(raw_request_body, notificationKey)
Compare with X-Callback-Signature header
```

---

## Credentials (from credentials.inc)

```
Merchant Account: Int_jabadoor_Test
API Caller Name: $apicaller
API Caller Password: !hRhEge9B$U!9znc
Paywall Secret Key: YK6Y3PXiT3px7EzM
Notification Key: ixMzjOkfT5qw4Lo4

Sandbox URLs:
- Paywall: https://payment-sandbox.payzone.ma/pwthree/launch
- API: https://payment-sandbox.payzone.ma
```

---

## Transaction Status Flow

```
PAYMENT Mode:
Customer → Paywall → CHARGED (immediate payment)

PRE-AUTH Mode:
Customer → Paywall → AUTHORIZED (funds reserved)
           ↓
      SETTLE → CHARGED (capture)
           ↓
      AUTH_REVERSAL → AUTH_REVERSED (release)

CHARGED Status:
           ↓
      REFUND → REFUNDED (refund)
```

---

## Required Parameters by Endpoint

### GET Transaction Status
- `chargeId` (from URL)

### Settle Payment
- `transactionId` (POST/GET)
- `amount` (POST/GET)
- `orderId` (optional, POST/GET)

### Refund Payment
- `transactionId` (POST/GET)
- `amount` (POST/GET)
- `orderId` (optional, POST/GET)

### Cancel Authorization
- `transactionId` (POST/GET)
- `amount` (POST/GET)
- `orderId` (optional, POST/GET)

### Launch Paywall
All fields in payload (see Payload Structure above)

---

## Error Handling

All API responses include:
- `httpCode` (HTTP status code)
- `status` (KO or endpoint-specific status)
- `message` (error description)

Common error codes:
- `400` - Missing required parameters
- `401` - Invalid signature
- `404` - Transaction not found
- `500` - Server error

---

## Security Notes

1. Always validate callback signatures using notification key
2. Store transaction ID from Payzone for future operations
3. SSL verification is disabled in curl (due to sandbox certificate)
4. All sensitive data should be handled server-side only
5. Never expose API credentials in client-side code

---

Generated: February 26, 2026
