// Local development server: serves the site from public/ and the API from app.js.
// On Vercel, api/[...path].js runs the same app and Vercel's CDN serves public/.
import path from 'node:path';
import express from 'express';
import app from './app.js';
import { paths } from './paths.js';

const PORT = Number(process.env.PORT) || 3000;

app.use(express.static(path.join(paths.root, 'public'), { index: 'index.html', extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`North Carolina Sports Report running at http://localhost:${PORT}`);
  console.log(`Payments: ${process.env.STRIPE_SECRET_KEY ? 'Stripe key set' : 'not configured'}${process.env.DEMO_BILLING === '1' && process.env.NODE_ENV !== 'production' ? ' (demo unlocks enabled)' : ''}`);
});
