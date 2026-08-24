import { Inngest } from "inngest";

/**
 * Shared Inngest client. Import this everywhere you need to send events or
 * define functions rather than creating multiple instances.
 */
export const inngest = new Inngest({
  id: "corpopay",
  eventKey: process.env.INNGEST_EVENT_KEY,
  signingKey: process.env.INNGEST_SIGNING_KEY,
  // INNGEST_BASE_URL is set in Docker Compose so the API container sends
  // events to the local inngest container instead of Inngest Cloud.
  // Leave unset outside Docker — the SDK defaults to cloud.
  baseUrl: process.env.INNGEST_BASE_URL,
});
