import { Router, Request, Response } from 'express';
import { queryAll, queryOne } from '../db';

const router = Router();

// GET /api/reporters
router.get('/', async (_req: Request, res: Response) => {
  try {
    const all = await queryAll('SELECT * FROM reporters ORDER BY name ASC');
    res.json({ data: all });
  } catch {
    res.status(500).json({ error: 'Failed to fetch reporters' });
  }
});

// POST /api/reporters
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, city, ratePerMinute } = req.body;
    if (!name || !city) return res.status(400).json({ error: 'name and city are required' });

    const reporter = await queryOne(
      'INSERT INTO reporters (name, city, is_available, rate_per_minute) VALUES ($1, $2, TRUE, $3) RETURNING *',
      [name, city, ratePerMinute ? Number(ratePerMinute) : 2000]
    );
    res.status(201).json({ data: reporter });
  } catch {
    res.status(500).json({ error: 'Failed to create reporter' });
  }
});

// PATCH /api/reporters/:id
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { isAvailable, ratePerMinute, name, city } = req.body;

    const setParts: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (isAvailable !== undefined) { setParts.push(`is_available = $${i++}`); params.push(isAvailable); }
    if (ratePerMinute !== undefined) { setParts.push(`rate_per_minute = $${i++}`); params.push(Number(ratePerMinute)); }
    if (name !== undefined) { setParts.push(`name = $${i++}`); params.push(name); }
    if (city !== undefined) { setParts.push(`city = $${i++}`); params.push(city); }

    if (setParts.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const updated = await queryOne(
      `UPDATE reporters SET ${setParts.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (!updated) return res.status(404).json({ error: 'Reporter not found' });
    res.json({ data: updated });
  } catch {
    res.status(500).json({ error: 'Failed to update reporter' });
  }
});

// DELETE /api/reporters/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await queryOne('DELETE FROM reporters WHERE id = $1', [req.params.id]);
    res.json({ message: 'Reporter deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete reporter' });
  }
});

export default router;
