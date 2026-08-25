import { check, sleep } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.API_BASE_URL ?? "http://localhost:4000";
const CHECKOUT_SLUG = __ENV.CHECKOUT_SLUG ?? "demo";

export const options = {
  scenarios: {
    health_constant: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
    },
    checkout_burst: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 50 },
        { duration: "15s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<500"],
  },
};

// The checkout endpoint sits behind a 10 req/min carding limiter, so a burst
// legitimately returns 429 for most requests. 404 (unknown link) and 410
// (cancelled / expired / paid link) are also valid outcomes. Treat all four as
// expected so they don't count toward http_req_failed.
const CHECKOUT_EXPECTED = http.expectedStatuses(200, 404, 410, 429);

export default function () {
  const health = http.get(`${BASE_URL}/health`);
  check(health, { "health is 200": (r) => r.status === 200 });

  const checkout = http.get(`${BASE_URL}/public/checkout/${CHECKOUT_SLUG}`, {
    responseCallback: CHECKOUT_EXPECTED,
  });
  check(checkout, {
    "checkout responds (200 | 404 | 410 | 429)": (r) =>
      r.status === 200 || r.status === 404 || r.status === 410 || r.status === 429,
  });

  sleep(1);
}
