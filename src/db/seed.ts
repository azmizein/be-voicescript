import { pool } from './index';

function getSeedTranscript(caseName: string) {
  return `DEPOSITION OF THE WITNESS
PROCEEDINGS OF THE COURT OF JAKARTA

In Re: ${caseName}

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
A: Yes. At approximately 14:30 hours, I received a discrepancy notification regarding the container seals. Upon inspection, I noticed that three of the seals had been severed and replaced with generic plastic ties.
MS. DEWI LESTARI: Objection. Assumes facts not in evidence regarding who severed the seals.
MR. BUDI SANTOSO: I am simply asking what he observed. Mr. Wijaya, please continue.
A: I photographed the ties and reported the matter to the safety supervisor.
Q: Did you see anyone near the cargo containers prior to this observation?
A: I observed a white utility van exiting the main gate at high speed around 14:15, but I could not identify the driver.
Q: Thank you, Mr. Wijaya. That is all for now.

[END OF DRAFT TRANSCRIPT EXCERPT - SEEDED BY AUTOSCRIPT]`;
}

export async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // WIPE existing data to ensure a fresh, consistent local seed run
    await client.query('TRUNCATE TABLE payments, jobs, reporters, editors CASCADE');

    // Reporters
    await client.query(`
      INSERT INTO reporters (name, city, is_available, rate_per_minute) VALUES
        ('Budi Santoso',  'Jakarta',   TRUE,  2000),
        ('Siti Rahayu',   'Surabaya',  TRUE,  2000),
        ('Ahmad Fauzi',   'Jakarta',   TRUE,  2500),
        ('Dewi Lestari',  'Bandung',   FALSE, 2000),
        ('Reza Pratama',  'Surabaya',  TRUE,  1800)
    `);

    // Editors
    await client.query(`
      INSERT INTO editors (name, flat_fee) VALUES
        ('Maya Indah',     75000),
        ('Hendra Wijaya',  60000),
        ('Rina Kusuma',    80000)
    `);

    // Jobs (reference reporters/editors by position, populating transcript for advanced statuses)
    await client.query(`
      INSERT INTO jobs (case_name, duration, location_type, city, status, reporter_id, editor_id, transcript)
      VALUES
        ('Perkara Perdata No. 123/2024', 90,  'physical', 'Jakarta',  'COMPLETED',   (SELECT id FROM reporters WHERE name='Budi Santoso'), (SELECT id FROM editors WHERE name='Maya Indah'), $1),
        ('Perkara Pidana No. 456/2024',  60,  'remote',   NULL,       'REVIEWED',    (SELECT id FROM reporters WHERE name='Siti Rahayu'),  (SELECT id FROM editors WHERE name='Hendra Wijaya'), $2),
        ('Gugatan Perdata No. 789/2024', 45,  'physical', 'Surabaya', 'TRANSCRIBED', (SELECT id FROM reporters WHERE name='Siti Rahayu'),  NULL, $3),
        ('Sengketa Tanah No. 321/2024',  120, 'physical', 'Jakarta',  'ASSIGNED',    (SELECT id FROM reporters WHERE name='Ahmad Fauzi'),  NULL, NULL),
        ('Perkara Niaga No. 654/2024',   30,  'remote',   NULL,       'NEW',         NULL,                                                 NULL, NULL),
        ('Cerai Gugat No. 987/2024',     75,  'physical', 'Bandung',  'NEW',         NULL,                                                 NULL, NULL)
    `, [
      getSeedTranscript('Perkara Perdata No. 123/2024'),
      getSeedTranscript('Perkara Pidana No. 456/2024'),
      getSeedTranscript('Gugatan Perdata No. 789/2024')
    ]);

    // Payments for completed/reviewed jobs
    await client.query(`
      INSERT INTO payments (job_id, reporter_payout, editor_payout, total_payout, rate_per_minute)
      VALUES
        ((SELECT id FROM jobs WHERE case_name='Perkara Perdata No. 123/2024'), 180000, 75000, 255000, 2000),
        ((SELECT id FROM jobs WHERE case_name='Perkara Pidana No. 456/2024'),  120000, 60000, 180000, 2000)
    `);

    await client.query('COMMIT');
    console.log('✅ Database seeded successfully with mock transcripts!');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
