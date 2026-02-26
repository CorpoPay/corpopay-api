/// <reference path="./types/express-augment.ts" />
import './types/express-augment'; // loads Express Request augmentation (req.user)
// Env vars are injected by Doppler (doppler run -- npm run dev).
import app from './app';

const PORT = parseInt(process.env.API_PORT ?? '4000', 10);

app.listen(PORT, () => {
  console.log(`[corpopay-api] Server running on http://localhost:${PORT}`);
  console.log(`[corpopay-api] ENV: ${process.env.NODE_ENV ?? 'development'}`);
});
