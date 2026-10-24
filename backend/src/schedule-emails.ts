
import "dotenv/config";
import { Pool } from "pg";
import { emailQueue, connection } from "./email-queue.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function scheduleEmails() {
  try {
    const result = await pool.query(
      `SELECT id, scheduled_at
       FROM emails
       WHERE status = 'scheduled'
       ORDER BY scheduled_at ASC`
    );

    let addedCount = 0;

    for (const email of result.rows) {
      const scheduledAt = new Date(email.scheduled_at).getTime();
      const delay = Math.max(0, scheduledAt - Date.now());

      const job = await emailQueue.add(
        "send-email",
        { emailId: email.id },
        {
          jobId: `email-${email.id}`,
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

      if (job) {
        addedCount++;
      }
    }

    console.log(`Found ${result.rowCount} scheduled emails.`);
    console.log(`Queue scheduling check finished. Processed ${addedCount} records.`);
  } catch (error) {
    console.error("Failed to schedule emails:", error);
    throw error;
  } finally {
    await pool.end();
    await emailQueue.close();
    await connection.quit();
  }
}

scheduleEmails().catch(() => {
  process.exitCode = 1;
});
