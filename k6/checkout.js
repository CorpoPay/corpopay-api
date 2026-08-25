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
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export default function () {
  const health = http.get(`${BASE_URL}/health`);
  check(health, { "health is 200": (r) => r.status === 200 });

  const checkout = http.get(`${BASE_URL}/public/checkout/${CHECKOUT_SLUG}`);
  check(checkout, {
    "checkout responds (200 | 404 | 410)": (r) =>
      r.status === 200 || r.status === 404 || r.status === 410,
  });

  sleep(1);
}
