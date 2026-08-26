import { apiReference } from "@scalar/express-api-reference";
import express, { type Request, type RequestHandler, type Response } from "express";
import morgan from "morgan";
import { corsMiddleware } from "./config/cors";
import { inngestHandler } from "./config/inngest";
import { apiLimiter, authLimiter, checkoutLimiter } from "./config/rate-limit";
// ─── Config modules ────────────────────────────────────────────────────────────────
import { securityHeaders } from "./config/security";
import { errorHandler } from "./middleware/errorHandler";
import { buildOpenApiDocument } from "./openapi-document";
import adminRouter from "./routes/admin";
import apiKeysRouter from "./routes/apiKeys";
// ─── Routers ───────────────────────────────────────────────────────────────────────
import authRouter from "./routes/auth";
import dashboardRouter from "./routes/dashboard";
import disputesRouter from "./routes/disputes";
import exportsRouter from "./routes/exports";
import feeSchedulesRouter from "./routes/fee-schedules";
import installmentAgreementsRouter from "./routes/installmentAgreements";
import installmentPlansRouter, { publicInstallmentPlansRouter } from "./routes/installmentPlans";
import ledgerRouter from "./routes/ledger";
import paymentIntentsRouter, { publicPayRouter, publicRelayRouter } from "./routes/paymentIntents";
import paymentLinksRouter, { publicCheckoutRouter } from "./routes/paymentLinks";
import payoutsRouter from "./routes/payouts";
import providerConfigRouter, { adminProviderConfigRouter } from "./routes/providerConfig";
import refundsRouter from "./routes/refunds";
import settlementPoliciesRouter from "./routes/settlement-policies";
import simulationRouter from "./routes/simulation";
import subscriptionsRouter from "./routes/subscriptions";
import tenantRouter, { adminTenantRouter } from "./routes/tenant";
import transactionsRouter from "./routes/transactions";
import usersRouter from "./routes/users";
import webhooksRouter from "./routes/webhooks";

const app = express();

// ─── Trust proxy ──────────────────────────────────────────────────────────────────
// Behind API Gateway (Lambda) and any reverse proxy the X-Forwarded-For header is
// set by AWS. Express must be told to trust it so that express-rate-limit can
// correctly identify client IPs (otherwise it throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
app.set("trust proxy", 1);

// ─── Security headers + CORS ──────────────────────────────────────────────────────
app.use(securityHeaders);
app.use(corsMiddleware);

// ─── Body parsing ─────────────────────────────────────────────────────────────────
// Webhook routes need raw body — we capture it before parsing JSON.
app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks")) {
    const data: Buffer[] = [];
    req.on("data", (chunk: Buffer) => data.push(chunk));
    req.on("end", () => {
      (req as any).rawBody = Buffer.concat(data);
      try {
        req.body = JSON.parse((req as any).rawBody.toString("utf-8"));
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    express.json({ limit: "1mb" })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true }));

// ─── Logging ─────────────────────────────────────────────────────────────────────
// 'combined' format on Lambda → structured lines in CloudWatch.
// 'dev' format locally for human-readable colourised output.
// Disabled entirely during tests.
// Route morgan through console so the Datadog Lambda layer (1) prepends
// `[dd.trace_id=... dd.span_id=...]` for trace correlation, and (2) maps the log
// level to `status` (5xx -> error, 4xx -> warn, else info). Routing by response
// status needs no facet/category-processor (the facet API is plan-gated).
const requestLogger =
  (format: string): RequestHandler =>
  (req, res, next) => {
    morgan(format, {
      stream: {
        write: (message: string) => {
          const line = message.trimEnd();
          if (res.statusCode >= 500) console.error(line);
          else if (res.statusCode >= 400) console.warn(line);
          else console.log(line);
        },
      },
    })(req, res, next);
  };

if (process.env.NODE_ENV === "production") {
  app.use(requestLogger("combined"));
} else if (process.env.NODE_ENV !== "test") {
  app.use(requestLogger("dev"));
}

// ─── Health check ─────────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ─── Public routes (no auth) ──────────────────────────────────────────────────────
app.use("/public/checkout", checkoutLimiter, publicCheckoutRouter); // GET  /public/checkout/:slug
app.use("/public/checkout", checkoutLimiter, publicPayRouter); // POST /public/checkout/:slug/pay
app.use("/public/installment-plans", publicInstallmentPlansRouter); // GET  /public/installment-plans/:slug
app.use("/public/pay", checkoutLimiter, publicRelayRouter); // GET  /public/pay/:correlationId  (relay)

// ─── Webhook routes ───────────────────────────────────────────────────────────────
app.use("/webhooks", webhooksRouter);

// ─── Merchant API routes ──────────────────────────────────────────────────────────
app.use("/auth", authLimiter, authRouter);
app.use("/tenant", apiLimiter, tenantRouter);
app.use("/users", apiLimiter, usersRouter);
app.use("/provider-configs", apiLimiter, providerConfigRouter);
app.use("/payment-links", apiLimiter, paymentLinksRouter);
app.use("/payment-intents", apiLimiter, paymentIntentsRouter);
app.use("/transactions", apiLimiter, transactionsRouter);
app.use("/dashboard", apiLimiter, dashboardRouter);
app.use("/transactions", apiLimiter, refundsRouter); // POST /transactions/:id/refund
app.use("/exports", apiLimiter, exportsRouter);
app.use("/api-keys", apiLimiter, apiKeysRouter);
app.use("/subscriptions", apiLimiter, subscriptionsRouter);
app.use("/installment-plans", apiLimiter, installmentPlansRouter);
app.use("/installment-agreements", apiLimiter, installmentAgreementsRouter);
app.use("/ledger", apiLimiter, ledgerRouter);
app.use("/fee-schedules", apiLimiter, feeSchedulesRouter);
app.use("/settlement-policies", apiLimiter, settlementPoliciesRouter);
app.use("/payouts", apiLimiter, payoutsRouter);
app.use("/disputes", apiLimiter, disputesRouter);

// ─── Admin routes ─────────────────────────────────────────────────────────────────
app.use("/admin/tenants", apiLimiter, adminTenantRouter);
app.use("/admin/tenants/:id/provider-configs", apiLimiter, adminProviderConfigRouter);
app.use("/admin/simulation", apiLimiter, simulationRouter);
app.use("/admin", apiLimiter, adminRouter);

// ─── Inngest job handler (POST /api/inngest) ─────────────────────────────────────
app.use("/api/inngest", inngestHandler);

// ─── API reference (Scalar) ──────────────────────────────────────────────────────
// Interactive OpenAPI docs, rendered from the same zod-to-openapi registry that
// generates `openapi.json` for the @corpopay/contract package.
app.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(buildOpenApiDocument());
});
app.use("/docs", apiReference({ spec: { url: "/openapi.json" } }));

// ─── 404 handler ─────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
});

// ─── Global error handler ─────────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
