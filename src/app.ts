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

// Routers
import authRouter from './routes/auth';
import tenantRouter, { adminTenantRouter } from './routes/tenant';
import usersRouter from './routes/users';
import providerConfigRouter, { adminProviderConfigRouter } from './routes/providerConfig';
import paymentLinksRouter, { publicCheckoutRouter } from './routes/paymentLinks';
import paymentIntentsRouter, { publicPayRouter } from './routes/paymentIntents';
import transactionsRouter from './routes/transactions';
import refundsRouter from './routes/refunds';
import exportsRouter from './routes/exports';
import webhooksRouter from './routes/webhooks';
import adminRouter from './routes/admin';
import apiKeysRouter from './routes/apiKeys';

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

// ─── Logging (dev only) ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ─── Rate limiting ────────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api', apiLimiter);

const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/public', publicLimiter);

// ─── Health check ─────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── Public routes (no auth) ──────────────────────────────────────────────────────
app.use('/public/checkout', publicCheckoutRouter);   // GET /public/checkout/:slug
app.use('/public/checkout', publicPayRouter);         // POST /public/checkout/:slug/pay

// ─── Webhook routes ───────────────────────────────────────────────────────────────
app.use('/webhooks', webhooksRouter);

// ─── Merchant API routes ──────────────────────────────────────────────────────────
app.use('/auth',             authRouter);
app.use('/tenant',           tenantRouter);
app.use('/users',            usersRouter);
app.use('/provider-configs', providerConfigRouter);
app.use('/payment-links',    paymentLinksRouter);
app.use('/payment-intents',  paymentIntentsRouter);
app.use('/transactions',     transactionsRouter);
app.use('/transactions',     refundsRouter);          // POST /transactions/:id/refund
app.use('/exports',          exportsRouter);
app.use('/api-keys',         apiKeysRouter);

// ─── Admin routes ─────────────────────────────────────────────────────────────────
app.use('/admin/tenants',                            adminTenantRouter);
app.use('/admin/tenants/:id/provider-configs',       adminProviderConfigRouter);
app.use('/admin',                                    adminRouter);
// ─── Inngest job handler ─────────────────────────────────────────────────────
// Receives events from Inngest Cloud (or the local Dev Server on port 8288).
// Endpoint: POST /api/inngest
app.use(
  '/api/inngest',
  serve({
    client:    inngest,
    functions: [webhookProcessor, paymentPoller, notifications],
  }),
);
// ─── 404 handler ─────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// ─── Global error handler ─────────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
