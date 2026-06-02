import { Router, Request, Response } from 'express';
import { queryAll, queryOne } from '../db';

const router = Router();

// GET /api/editors
router.get('/', async (_req: Request, res: Response) => {
  try {
    const all = await queryAll('SELECT * FROM editors ORDER BY name ASC');
    res.json({ data: all });
  } catch {
    res.status(500).json({ error: 'Failed to fetch editors' });
  }
});

// POST /api/editors
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, flatFee } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const editor = await queryOne(
      'INSERT INTO editors (name, flat_fee) VALUES ($1, $2) RETURNING *',
      [name, flatFee ? Number(flatFee) : 50000]
    );
    res.status(201).json({ data: editor });
  } catch {
    res.status(500).json({ error: 'Failed to create editor' });
  }
});

// PATCH /api/editors/:id
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name, flatFee } = req.body;
    const setParts: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (name !== undefined) { setParts.push(`name = $${i++}`); params.push(name); }
    if (flatFee !== undefined) { setParts.push(`flat_fee = $${i++}`); params.push(Number(flatFee)); }

    if (setParts.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const updated = await queryOne(
      `UPDATE editors SET ${setParts.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (!updated) return res.status(404).json({ error: 'Editor not found' });
    res.json({ data: updated });
  } catch {
    res.status(500).json({ error: 'Failed to update editor' });
  }
});

// DELETE /api/editors/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await queryOne('DELETE FROM editors WHERE id = $1', [req.params.id]);
    res.json({ message: 'Editor deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete editor' });
  }
});

export default router;
