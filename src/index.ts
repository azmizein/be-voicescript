import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { testConnection } from './db';
import { migrate } from './db/migrate';
import { seed } from './db/seed';
import jobsRouter from './routes/jobs';
import reportersRouter from './routes/reporters';
import editorsRouter from './routes/editors';
import paymentsRouter from './routes/payments';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:5173', 'http://localhost:5174',
    'http://127.0.0.1:5173', 'http://127.0.0.1:5174',
  ]
}));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/api/jobs',      jobsRouter);
app.use('/api/reporters', reportersRouter);
app.use('/api/editors',   editorsRouter);
app.use('/api/payments',  paymentsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', db: 'postgresql', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async () => {
  try {
    await testConnection();
    await migrate();
    await seed();
    app.listen(PORT, () => {
      console.log(`🚀 VoiceScript API running on http://localhost:${PORT} (PostgreSQL)`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
})();

export default app;
