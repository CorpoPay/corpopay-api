/// <reference path="./types/express-augment.ts" />
import "./types/express-augment"; // loads Express Request augmentation (req.user)
// Env vars are injected via the environment.
import { validateEnv } from "./lib/validateEnv";
import app from "./app";

// Validate all required environment variables before starting the server.
// Throws synchronously if anything is missing so the process never starts
// in a broken state.
validateEnv();

const PORT = parseInt(process.env.API_PORT ?? "4000", 10);

app.listen(PORT, () => {
  console.log(`[corpopay-api] Server running on http://localhost:${PORT}`);
  console.log(`[corpopay-api] ENV: ${process.env.NODE_ENV ?? "development"}`);
});
