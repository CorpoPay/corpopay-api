import helmet from "helmet";

/**
 * Security headers (Helmet).
 *
 * The public Payzone relay page serves a small HTML page that auto-submits a
 * signed form to Payzone's paywall. Helmet's default CSP (`script-src 'self'`
 * + `form-action 'self'`) blocks both the inline auto-submit script and the
 * cross-origin form POST, so we relax `script-src` (unsafe-inline) and
 * `form-action`/`frame-src` for the two Payzone paywall origins.
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "form-action": ["'self'", "https://payment-sandbox.payzone.ma", "https://payment.payzone.ma"],
      "frame-src": ["'self'", "https://payment-sandbox.payzone.ma", "https://payment.payzone.ma"],
    },
  },
});
