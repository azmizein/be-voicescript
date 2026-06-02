import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute, pool } from '../db';
import multer from 'multer';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // limit to 25MB (Whisper audio limit)
});


const STATUS_TRANSITIONS: Record<string, string> = {
  NEW: 'ASSIGNED',
  ASSIGNED: 'TRANSCRIBED',
  TRANSCRIBED: 'REVIEWED',
  REVIEWED: 'COMPLETED',
};

// ── Helper: auto-calculate payment (called internally) ────────────────────
async function autoCalculatePayment(jobId: string | number): Promise<void> {
  const job = await queryOne<any>(`
    SELECT j.id, j.duration, j.reporter_id, j.editor_id,
           r.rate_per_minute, e.flat_fee
    FROM jobs j
    LEFT JOIN reporters r ON j.reporter_id = r.id
    LEFT JOIN editors   e ON j.editor_id   = e.id
    WHERE j.id = $1
  `, [jobId]);

  if (!job?.reporter_id) return; // no reporter, skip

  const rate           = Number(job.rate_per_minute ?? 2000);
  const reporterPayout = job.duration * rate;
  const editorPayout   = Number(job.flat_fee ?? 0);
  const totalPayout    = reporterPayout + editorPayout;

  await execute('DELETE FROM payments WHERE job_id = $1', [jobId]);
  await execute(
    `INSERT INTO payments (job_id, reporter_payout, editor_payout, total_payout, rate_per_minute)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, reporterPayout, editorPayout, totalPayout, rate]
  );
}

// ── Helper: fetch full job with JOINs (names populated) ───────────────────
async function fetchFullJob(jobId: string | number): Promise<any> {
  return await queryOne(`
    SELECT
      j.id, j.case_name, j.duration, j.location_type, j.city,
      j.status, j.reporter_id, j.editor_id, j.transcript,
      j.created_at, j.updated_at,
      r.name  AS reporter_name,
      r.city  AS reporter_city,
      e.name  AS editor_name
    FROM jobs j
    LEFT JOIN reporters r ON j.reporter_id = r.id
    LEFT JOIN editors   e ON j.editor_id   = e.id
    WHERE j.id = $1
  `, [jobId]);
}


// ── GET /api/jobs ─────────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const jobs = await queryAll(`
      SELECT
        j.id, j.case_name, j.duration, j.location_type, j.city,
        j.status, j.reporter_id, j.editor_id, j.transcript,
        j.created_at, j.updated_at,
        r.name  AS reporter_name,
        r.city  AS reporter_city,
        e.name  AS editor_name
      FROM jobs j
      LEFT JOIN reporters r ON j.reporter_id = r.id
      LEFT JOIN editors   e ON j.editor_id   = e.id
      ORDER BY j.created_at DESC
    `);
    res.json({ data: jobs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// ── GET /api/jobs/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const job = await queryOne(`
      SELECT
        j.id, j.case_name, j.duration, j.location_type, j.city,
        j.status, j.reporter_id, j.editor_id, j.transcript,
        j.created_at, j.updated_at,
        r.name             AS reporter_name,
        r.city             AS reporter_city,
        r.rate_per_minute,
        e.name             AS editor_name,
        e.flat_fee         AS editor_flat_fee
      FROM jobs j
      LEFT JOIN reporters r ON j.reporter_id = r.id
      LEFT JOIN editors   e ON j.editor_id   = e.id
      WHERE j.id = $1
    `, [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ data: job });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ── POST /api/jobs ────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const { caseName, duration, locationType, city } = req.body;
    if (!caseName || !duration || !locationType) {
      return res.status(400).json({ error: 'caseName, duration, and locationType are required' });
    }
    if (locationType === 'physical' && !city) {
      return res.status(400).json({ error: 'city is required for physical jobs' });
    }

    const job = await queryOne(`
      INSERT INTO jobs (case_name, duration, location_type, city, status)
      VALUES ($1, $2, $3, $4, 'NEW')
      RETURNING *
    `, [caseName, Number(duration), locationType, locationType === 'physical' ? city : null]);

    res.status(201).json({ data: job });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// ── PATCH /api/jobs/:id/status — advance + auto-payment on COMPLETED ──────
router.patch('/:id/status', async (req: Request, res: Response) => {
  try {
    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'COMPLETED') return res.status(400).json({ error: 'Job is already completed' });

    if (job.status === 'NEW' && !job.reporter_id) {
      return res.status(400).json({ error: 'Assign a reporter before advancing status' });
    }
    if (job.status === 'TRANSCRIBED' && !job.editor_id) {
      return res.status(400).json({ error: 'Assign an editor before advancing to REVIEWED' });
    }

    const nextStatus = STATUS_TRANSITIONS[job.status];

    await execute(
      'UPDATE jobs SET status = $1 WHERE id = $2',
      [nextStatus, req.params.id]
    );

    // ── AUTO-PAYMENT when job reaches COMPLETED ───────────────────────────
    if (nextStatus === 'COMPLETED') {
      await autoCalculatePayment(req.params.id);
    }

    const fullJob = await fetchFullJob(req.params.id);
    res.json({ data: fullJob, autoPayment: nextStatus === 'COMPLETED' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});


// ── POST /api/jobs/:id/assign-reporter (manual) ───────────────────────────
router.post('/:id/assign-reporter', async (req: Request, res: Response) => {
  try {
    const { reporterId } = req.body;
    if (!reporterId) return res.status(400).json({ error: 'reporterId is required' });

    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['NEW', 'ASSIGNED'].includes(job.status)) {
      return res.status(400).json({ error: `Cannot assign reporter on a ${job.status} job` });
    }

    const reporter = await queryOne<any>('SELECT * FROM reporters WHERE id = $1', [reporterId]);
    if (!reporter) return res.status(404).json({ error: 'Reporter not found' });
    if (!reporter.is_available) return res.status(400).json({ error: 'Reporter is not available' });

    await execute(
      "UPDATE jobs SET reporter_id = $1, status = 'ASSIGNED' WHERE id = $2",
      [reporterId, req.params.id]
    );
    const fullJob = await fetchFullJob(req.params.id);
    res.json({ data: fullJob });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign reporter' });
  }
});


// ── POST /api/jobs/:id/assign-editor (manual) ─────────────────────────────
router.post('/:id/assign-editor', async (req: Request, res: Response) => {
  try {
    const { editorId } = req.body;
    if (!editorId) return res.status(400).json({ error: 'editorId is required' });

    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['ASSIGNED', 'TRANSCRIBED', 'REVIEWED'].includes(job.status)) {
      return res.status(400).json({ error: `Cannot assign editor on a ${job.status} job` });
    }

    const editor = await queryOne<any>('SELECT * FROM editors WHERE id = $1', [editorId]);
    if (!editor) return res.status(404).json({ error: 'Editor not found' });

    await execute(
      'UPDATE jobs SET editor_id = $1 WHERE id = $2',
      [editorId, req.params.id]
    );
    const fullJob = await fetchFullJob(req.params.id);
    res.json({ data: fullJob });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign editor' });
  }
});


// ── POST /api/jobs/:id/auto-assign-reporter ───────────────────────────────
// Smart auto-pick: available + same city (physical) + load balanced
router.post('/:id/auto-assign-reporter', async (req: Request, res: Response) => {
  try {
    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['NEW', 'ASSIGNED'].includes(job.status)) {
      return res.status(400).json({ error: `Cannot auto-assign reporter on a ${job.status} job` });
    }

    // Pick best available reporter:
    // 1. Must be available
    // 2. Same city preferred for physical jobs
    // 3. Fewest active (non-completed) jobs for load balancing
    const reporter = await queryOne<any>(`
      SELECT r.*,
        COUNT(j.id) FILTER (WHERE j.status NOT IN ('COMPLETED')) AS active_jobs,
        CASE WHEN r.city = $1 THEN 0 ELSE 1 END AS city_rank
      FROM reporters r
      LEFT JOIN jobs j ON j.reporter_id = r.id
      WHERE r.is_available = TRUE
      GROUP BY r.id
      ORDER BY city_rank ASC, active_jobs ASC, r.name ASC
      LIMIT 1
    `, [job.city ?? '']);

    if (!reporter) {
      return res.status(422).json({ error: 'No available reporters found' });
    }

    await execute(
      "UPDATE jobs SET reporter_id = $1, status = 'ASSIGNED' WHERE id = $2",
      [reporter.id, req.params.id]
    );

    const fullJob = await fetchFullJob(req.params.id);

    res.json({
      data: fullJob,
      assignedReporter: { id: reporter.id, name: reporter.name, city: reporter.city },
      message: `Auto-assigned to ${reporter.name} (${reporter.city})`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to auto-assign reporter' });
  }
});


// ── POST /api/jobs/:id/auto-assign-editor ─────────────────────────────────
// Smart auto-pick: editor with fewest active jobs
router.post('/:id/auto-assign-editor', async (req: Request, res: Response) => {
  try {
    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['ASSIGNED', 'TRANSCRIBED', 'REVIEWED'].includes(job.status)) {
      return res.status(400).json({ error: `Cannot auto-assign editor on a ${job.status} job` });
    }

    // Pick editor with fewest active jobs (load balancing)
    const editor = await queryOne<any>(`
      SELECT e.*,
        COUNT(j.id) FILTER (WHERE j.status NOT IN ('COMPLETED')) AS active_jobs
      FROM editors e
      LEFT JOIN jobs j ON j.editor_id = e.id
      GROUP BY e.id
      ORDER BY active_jobs ASC, e.flat_fee ASC, e.name ASC
      LIMIT 1
    `);

    if (!editor) {
      return res.status(422).json({ error: 'No editors found' });
    }

    await execute(
      'UPDATE jobs SET editor_id = $1 WHERE id = $2',
      [editor.id, req.params.id]
    );

    const fullJob = await fetchFullJob(req.params.id);

    res.json({
      data: fullJob,
      assignedEditor: { id: editor.id, name: editor.name, flatFee: editor.flat_fee },
      message: `Auto-assigned to ${editor.name}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to auto-assign editor' });
  }
});


// ── POST /api/jobs/batch/auto-assign ─────────────────────────────────────
// Bulk: auto-assign reporter to NEW jobs, and editor to TRANSCRIBED jobs
router.post('/batch/auto-assign', async (req: Request, res: Response) => {
  try {
    const unassignedReporters = await queryAll<any>(`
      SELECT * FROM jobs WHERE status = 'NEW' AND reporter_id IS NULL
    `);

    const unassignedEditors = await queryAll<any>(`
      SELECT * FROM jobs WHERE status IN ('ASSIGNED', 'TRANSCRIBED', 'REVIEWED') AND editor_id IS NULL
    `);

    if (unassignedReporters.length === 0 && unassignedEditors.length === 0) {
      return res.json({ data: [], message: 'No eligible jobs for auto-assignment found' });
    }

    const results: any[] = [];
    let reportersAssigned = 0;
    let editorsAssigned = 0;

    // 1. Assign Reporters to NEW jobs
    for (const job of unassignedReporters) {
      const reporter = await queryOne<any>(`
        SELECT r.*,
          COUNT(j.id) FILTER (WHERE j.status NOT IN ('COMPLETED')) AS active_jobs,
          CASE WHEN r.city = $1 THEN 0 ELSE 1 END AS city_rank
        FROM reporters r
        LEFT JOIN jobs j ON j.reporter_id = r.id
        WHERE r.is_available = TRUE
        GROUP BY r.id
        ORDER BY city_rank ASC, active_jobs ASC
        LIMIT 1
      `, [job.city ?? '']);

      if (!reporter) {
        results.push({ jobId: job.id, caseName: job.case_name, role: 'reporter', status: 'skipped', reason: 'No available reporter' });
        continue;
      }

      await execute(
        "UPDATE jobs SET reporter_id = $1, status = 'ASSIGNED' WHERE id = $2",
        [reporter.id, job.id]
      );
      reportersAssigned++;
      results.push({
        jobId: job.id,
        caseName: job.case_name,
        role: 'reporter',
        status: 'assigned',
        reporter: { id: reporter.id, name: reporter.name, city: reporter.city },
      });
    }

    // 2. Assign Editors to TRANSCRIBED jobs
    for (const job of unassignedEditors) {
      const editor = await queryOne<any>(`
        SELECT e.*,
          COUNT(j.id) FILTER (WHERE j.status NOT IN ('COMPLETED')) AS active_jobs
        FROM editors e
        LEFT JOIN jobs j ON j.editor_id = e.id
        GROUP BY e.id
        ORDER BY active_jobs ASC, e.flat_fee ASC, e.name ASC
        LIMIT 1
      `);

      if (!editor) {
        results.push({ jobId: job.id, caseName: job.case_name, role: 'editor', status: 'skipped', reason: 'No editors found' });
        continue;
      }

      await execute(
        'UPDATE jobs SET editor_id = $1 WHERE id = $2',
        [editor.id, job.id]
      );
      editorsAssigned++;
      results.push({
        jobId: job.id,
        caseName: job.case_name,
        role: 'editor',
        status: 'assigned',
        editor: { id: editor.id, name: editor.name, flatFee: editor.flat_fee },
      });
    }

    res.json({
      data: results,
      message: `Bulk auto-assign complete: assigned ${reportersAssigned} reporters and ${editorsAssigned} editors.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk auto-assign' });
  }
});

// ── GET /api/jobs/:id/reporters/suggested ────────────────────────────────
router.get('/:id/reporters/suggested', async (req: Request, res: Response) => {
  try {
    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const reporters = await queryAll<any>(`
      SELECT r.*,
        COUNT(j.id) FILTER (WHERE j.status NOT IN ('COMPLETED')) AS active_jobs,
        CASE WHEN r.city = $1 THEN true ELSE false END AS city_match
      FROM reporters r
      LEFT JOIN jobs j ON j.reporter_id = r.id
      GROUP BY r.id
      ORDER BY
        CASE WHEN r.is_available THEN 0 ELSE 1 END ASC,
        CASE WHEN r.city = $1 THEN 0 ELSE 1 END ASC,
        active_jobs ASC,
        r.name ASC
    `, [job.city ?? '']);

    res.json({ data: reporters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

// ── POST /api/jobs/:id/generate-transcript ────────────────────────────────
// Smart AI deposition generator using Groq Chat API
router.post('/:id/generate-transcript', async (req: Request, res: Response) => {
  try {
    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    let transcriptText = '';
    const apiKey = process.env.GROQ_API_KEY;

    if (apiKey) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              {
                role: 'system',
                content: 'You are an expert legal court reporter. Generate a realistic, professional, and authentic legal deposition transcript excerpt in Q&A format. Focus on high realism, court formatting, attorney questioning, witness testimony, objections, and official court reporter notes.'
              },
              {
                role: 'user',
                content: `Generate a realistic, professional legal deposition transcript excerpt for the case: "${job.case_name}". The duration of the session was ${job.duration} minutes. Include attorney appearances, witness swearing-in, objections, and detailed Q&A testimony. Keep it under 600 words.`
              }
            ],
            temperature: 0.7
          })
        });

        if (response.ok) {
          const json = await response.json() as any;
          transcriptText = json.choices?.[0]?.message?.content || '';
        } else {
          console.warn('Groq API call failed, falling back to template');
        }
      } catch (err) {
        console.error('Groq connection error:', err);
      }
    }

    if (!transcriptText) {
      transcriptText = `DEPOSITION OF THE WITNESS
PROCEEDINGS OF THE COURT OF JAKARTA

In Re: ${job.case_name}

Deposition of WITNESS, taken on behalf of the Plaintiff, pursuant to notice.

APPEARANCES:
  For the Plaintiff:
    Budi Santoso, Esq. (Legal Counsel)
  For the Defendant:
    Dewi Lestari, Esq. (Legal Counsel)

---

THE COURT: Please swear in the witness.
COURT REPORTER: Do you solemnly swear that the testimony you shall give in this matter shall be the truth, the whole truth, and nothing but the truth?
WITNESS: I do.

EXAMINATION BY MR. BUDI SANTOSO:
Q: Please state your full name for the record.
A: My name is Hendra Wijaya.
Q: What is your current occupation, Mr. Wijaya?
A: I am a senior logistics manager at the shipping firm.
Q: And how long have you been employed in this capacity?
A: It has been approximately seven years.
Q: Let's direct your attention to the events of November 12th, 2024. Can you describe in your own words what transpired at the cargo depot?
A: Yes. At approximately 14:30 hours, I received a discrepancy notification regarding the container seals. Upon inspection, I noticed that three of the seals had been severed.
MS. DEWI LESTARI: Objection. Assumes facts not in evidence regarding who severed the seals.
MR. BUDI SANTOSO: I am simply asking what he observed. Mr. Wijaya, please continue.
A: I photographed the ties and reported the matter to the safety supervisor.
Q: Did you see anyone near the cargo containers prior to this observation?
A: I observed a white utility van exiting the main gate at high speed around 14:15, but I could not identify the driver.
Q: Thank you, Mr. Wijaya. That is all for now.

[END OF DRAFT TRANSCRIPT EXCERPT - PRODUCED BY AUTOSCRIPT AI]`;
    }

    await execute(
      "UPDATE jobs SET transcript = $1, status = 'TRANSCRIBED' WHERE id = $2",
      [transcriptText, req.params.id]
    );

    const fullJob = await fetchFullJob(req.params.id);
    res.json({ data: fullJob, message: 'AI Transcript Draft generated successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate transcript' });
  }
});

// ── POST /api/jobs/:id/transcribe-audio ───────────────────────────────────
// Real-time audio upload and transcription using Groq Whisper-large-v3
router.post('/:id/transcribe-audio', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    const job = await queryOne<any>('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    let transcriptText = '';
    const apiKey = process.env.GROQ_API_KEY;

    if (apiKey) {
      try {
        const formData = new FormData();
        const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
        formData.append('file', blob, req.file.originalname);
        formData.append('model', 'whisper-large-v3');

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`
          },
          body: formData
        });

        if (response.ok) {
          const json = await response.json() as any;
          const rawText = json.text || '';

          // LLaMA to format/tidy up the transcript
          const chatResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [
                {
                  role: 'system',
                  content: 'You are an expert legal court reporter and editor. Your job is to take the raw transcription from an audio file and format it professionally into a clean legal deposition transcript in Q&A format. Fix grammatical errors, add proper punctuation, identify speakers where obvious (e.g., Q:, A:, THE COURT:), and ensure high realism and court formatting.'
                },
                {
                  role: 'user',
                  content: `Here is the raw transcription for the case "${job.case_name}". Please format it into a professional legal transcript:\n\n${rawText}`
                }
              ],
              temperature: 0.3
            })
          });

          if (chatResponse.ok) {
            const chatJson = await chatResponse.json() as any;
            transcriptText = chatJson.choices?.[0]?.message?.content || rawText;
          } else {
            console.warn('Groq LLaMA formatting failed, using raw Whisper text');
            transcriptText = rawText;
          }

        } else {
          const errText = await response.text();
          console.warn('Groq Whisper API call failed:', errText);
          throw new Error('Groq Whisper API error');
        }
      } catch (err: any) {
        console.error('Groq Whisper connection error:', err);
        return res.status(500).json({ error: `Groq Whisper failed: ${err.message || err}` });
      }
    } else {
      transcriptText = `[AUDIO TRANSCRIPTION BY MOCK AUTOSCRIPT AI WHISPER-LARGE-V3]
The user uploaded an audio file named "${req.file.originalname}" (${(req.file.size / 1024).toFixed(1)} KB).
This is a live transcription of the legal proceedings for the case: "${job.case_name}".
The witness was sworn in and testified regarding the logistical sealing discrepancy of container shipping manifests on November 12th.
The court adjourned the hearing to be continued at a later date.`;
    }

    await execute(
      "UPDATE jobs SET transcript = $1, status = 'TRANSCRIBED' WHERE id = $2",
      [transcriptText, req.params.id]
    );

    const fullJob = await fetchFullJob(req.params.id);
    res.json({
      data: fullJob,
      message: apiKey ? 'Real Whisper audio transcription complete!' : 'Mock Whisper audio transcription complete! (Set GROQ_API_KEY in .env for real transcription)',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

// ── PATCH /api/jobs/:id/transcript ────────────────────────────────────────
// Edit/scope transcript contents (for Scoper/Editor roles)
router.patch('/:id/transcript', async (req: Request, res: Response) => {
  try {
    const { transcript } = req.body;
    await execute('UPDATE jobs SET transcript = $1 WHERE id = $2', [transcript, req.params.id]);
    const fullJob = await fetchFullJob(req.params.id);
    res.json({ data: fullJob, message: 'Transcript updated successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update transcript' });
  }
});

// ── DELETE /api/jobs/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const job = await queryOne('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Delete associated payments first
    await execute('DELETE FROM payments WHERE job_id = $1', [req.params.id]);
    // Delete the job
    await execute('DELETE FROM jobs WHERE id = $1', [req.params.id]);

    res.json({ message: 'Job deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

export default router;
