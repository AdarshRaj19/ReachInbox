
import "dotenv/config";
import { Pool } from "pg";
import { emailQueue } from "./email-queue.js";

export async function repairDelayedJobs() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const result = await pool.query(
      `SELECT id, scheduled_at, status
       FROM emails
       WHERE status IN ('scheduled', 'queued')
       ORDER BY scheduled_at ASC`
    );

    let restored = 0;
    let alreadyPresent = 0;

    for (const email of result.rows) {
      const jobId = `email-${email.id}`;
      const existingJob = await emailQueue.getJob(jobId);

      if (existingJob) {
        alreadyPresent++;
        continue;
      }

      const scheduledAt = new Date(email.scheduled_at).getTime();
      const delay = Math.max(0, scheduledAt - Date.now());

      await emailQueue.add(
        "send-email",
        { emailId: email.id },
        {
          jobId,
          delay,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        }
      );

      restored++;
      console.log(`Restored job: ${jobId}`);
    }

    const summary = {
      checked: result.rowCount,
      restored,
      alreadyPresent,
    };

    console.log("Email job recovery:", summary);
    return summary;
  } finally {
    await pool.end();
  }
}
