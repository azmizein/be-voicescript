import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db';

const router = Router();

// GET /api/payments
router.get('/', async (_req: Request, res: Response) => {
  try {
    const all = await queryAll(`
      SELECT
        p.id, p.job_id, p.reporter_payout, p.editor_payout,
        p.total_payout, p.rate_per_minute, p.calculated_at,
        j.case_name, j.duration,
        r.name AS reporter_name,
        e.name AS editor_name
      FROM payments p
      INNER JOIN jobs      j ON p.job_id      = j.id
      LEFT JOIN  reporters r ON j.reporter_id = r.id
      LEFT JOIN  editors   e ON j.editor_id   = e.id
      ORDER BY p.calculated_at DESC
    `);
    res.json({ data: all });
  } catch {
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// GET /api/payments/summary
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const result = await queryOne<{
      total_reporter: string;
      total_editor: string;
      grand_total: string;
      job_count: string;
    }>(`
      SELECT
        COALESCE(SUM(reporter_payout), 0)::text AS total_reporter,
        COALESCE(SUM(editor_payout),   0)::text AS total_editor,
        COALESCE(SUM(total_payout),    0)::text AS grand_total,
        COUNT(*)::text                          AS job_count
      FROM payments
    `);

    res.json({
      data: {
        total_reporter: Number(result?.total_reporter ?? 0),
        total_editor:   Number(result?.total_editor   ?? 0),
        grand_total:    Number(result?.grand_total     ?? 0),
        job_count:      Number(result?.job_count       ?? 0),
      }
    });
  } catch {
    res.status(500).json({ error: 'Failed to calculate summary' });
  }
});

// POST /api/payments/calculate/:jobId
router.post('/calculate/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId;

    const job = await queryOne<any>(`
      SELECT j.id, j.duration, j.status, j.reporter_id, j.editor_id,
             r.rate_per_minute,
             e.flat_fee
      FROM jobs j
      LEFT JOIN reporters r ON j.reporter_id = r.id
      LEFT JOIN editors   e ON j.editor_id   = e.id
      WHERE j.id = $1
    `, [jobId]);

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.reporter_id) {
      return res.status(400).json({ error: 'Job has no reporter assigned' });
    }

    const ratePerMinute  = Number(job.rate_per_minute ?? 2000);
    const reporterPayout = job.duration * ratePerMinute;
    const editorPayout   = Number(job.flat_fee ?? 0);
    const totalPayout    = reporterPayout + editorPayout;

    // Upsert: delete old record then insert fresh
    await execute('DELETE FROM payments WHERE job_id = $1', [jobId]);
    const payment = await queryOne(
      `INSERT INTO payments (job_id, reporter_payout, editor_payout, total_payout, rate_per_minute)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [jobId, reporterPayout, editorPayout, totalPayout, ratePerMinute]
    );

    res.status(201).json({ data: payment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate payment' });
  }
});

export default router;
