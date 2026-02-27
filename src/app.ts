import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { serve } from 'inngest/express';

// Inngest
import { inngest }           from './lib/inngest';
import { webhookProcessor }  from './jobs/webhookProcessor.inngest';
import { paymentPoller }     from './jobs/paymentPoller.inngest';
import { notifications }     from './jobs/notifications.inngest';
import { onSubscriptionCreated } from './jobs/subscriptionActivated.inngest';
import { billingRenewal }    from './jobs/billingRenewal.inngest';
import { billingDailySweep } from './jobs/billingDailySweep.inngest';
import { billingSimulation } from './jobs/billingSimulation.inngest';
import { installmentCharge }    from './jobs/installmentCharge.inngest';
import { installmentSimulation } from './jobs/installmentSimulation.inngest';

// Routers
import authRouter from './routes/auth';
import tenantRouter, { adminTenantRouter } from './routes/tenant';
import usersRouter from './routes/users';
import providerConfigRouter, { adminProviderConfigRouter } from './routes/providerConfig';
import paymentLinksRouter, { publicCheckoutRouter } from './routes/paymentLinks';
import paymentIntentsRouter, { publicPayRouter, publicRelayRouter } from './routes/paymentIntents';
import transactionsRouter from './routes/transactions';
import refundsRouter from './routes/refunds';
import exportsRouter from './routes/exports';
import webhooksRouter from './routes/webhooks';
import adminRouter from './routes/admin';
import apiKeysRouter from './routes/apiKeys';
import subscriptionsRouter from './routes/subscriptions';
import simulationRouter from './routes/simulation';
import installmentPlansRouter, { publicInstallmentPlansRouter } from './routes/installmentPlans';
import installmentAgreementsRouter from './routes/installmentAgreements';

import { errorHandler } from './middleware/errorHandler';


const app = express();

// ─── Security headers ─────────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      process.env.WEB_BASE_URL ?? 'http://localhost:3000',
      'http://localhost:3000',
    ],
    credentials: true,
  }),
);

// ─── Body parsing ─────────────────────────────────────────────────────────────────
// Webhook routes need raw body — we capture it before parsing JSON
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks')) {
    let data: Buffer[] = [];
    req.on('data', (chunk: Buffer) => data.push(chunk));
    req.on('end', () => {
      (req as any).rawBody = Buffer.concat(data);
      try {
        req.body = JSON.parse((req as any).rawBody.toString('utf-8'));
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    express.json({ limit: '1mb' })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true }));

// ─── Logging ─────────────────────────────────────────────────────────────────────
// 'combined' format on Lambda → structured lines in CloudWatch
// 'dev' format locally for human-readable colourised output
// Disabled entirely during tests
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ─── Rate limiting ────────────────────────────────────────────────────────────────
// H-5: Applied in all deployment modes (VPS/Docker + Lambda).
// On Lambda, API Gateway throttling is the outer defence; these limits are the
// inner, per-process defence (important during scale-down / cold starts).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 20,                      // 20 login/register attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'RATE_LIMITED' },
  skip: () => process.env.NODE_ENV === 'test',
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 10,                      // 10 checkout initiations per IP per minute (carding guard)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'RATE_LIMITED' },
  skip: () => process.env.NODE_ENV === 'test',
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 120,                     // 120 authenticated API requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'RATE_LIMITED' },
  skip: () => process.env.NODE_ENV === 'test',
});

// ─── Health check ─────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── Public routes (no auth) ──────────────────────────────────────────────────────
app.use('/public/checkout', checkoutLimiter, publicCheckoutRouter);                   // GET  /public/checkout/:slug
app.use('/public/checkout', checkoutLimiter, publicPayRouter);                        // POST /public/checkout/:slug/pay
app.use('/public/installment-plans', publicInstallmentPlansRouter);  // GET  /public/installment-plans/:slug
app.use('/public/pay', checkoutLimiter, publicRelayRouter);                           // GET  /public/pay/:correlationId  (relay)

// ─── Webhook routes ───────────────────────────────────────────────────────────────
app.use('/webhooks', webhooksRouter);

// ─── Merchant API routes ──────────────────────────────────────────────────────────
app.use('/auth',             authLimiter, authRouter);
app.use('/tenant',           apiLimiter, tenantRouter);
app.use('/users',            apiLimiter, usersRouter);
app.use('/provider-configs', apiLimiter, providerConfigRouter);
app.use('/payment-links',    apiLimiter, paymentLinksRouter);
app.use('/payment-intents',  apiLimiter, paymentIntentsRouter);
app.use('/transactions',     apiLimiter, transactionsRouter);
app.use('/transactions',     apiLimiter, refundsRouter);          // POST /transactions/:id/refund
app.use('/exports',          apiLimiter, exportsRouter);
app.use('/api-keys',         apiLimiter, apiKeysRouter);
app.use('/subscriptions',          apiLimiter, subscriptionsRouter);
app.use('/installment-plans',      apiLimiter, installmentPlansRouter);
app.use('/installment-agreements', apiLimiter, installmentAgreementsRouter);

// ─── Admin routes ─────────────────────────────────────────────────────────────────
app.use('/admin/tenants',                            apiLimiter, adminTenantRouter);
app.use('/admin/tenants/:id/provider-configs',       apiLimiter, adminProviderConfigRouter);
app.use('/admin/simulation',                         apiLimiter, simulationRouter);
app.use('/admin',                                    apiLimiter, adminRouter);
// ─── Inngest job handler ─────────────────────────────────────────────────────
// Receives events from Inngest Cloud (or the local Dev Server on port 8288).
// Endpoint: POST /api/inngest
app.use(
  '/api/inngest',
  serve({
    client:    inngest,
    functions: [webhookProcessor, paymentPoller, notifications, onSubscriptionCreated, billingRenewal, billingDailySweep, billingSimulation, installmentCharge, installmentSimulation],
  }),
);
// ─── 404 handler ─────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// ─── Global error handler ─────────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
