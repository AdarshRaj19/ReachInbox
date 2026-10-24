
import "dotenv/config";
import { Pool } from "pg";
import { elasticsearch, EMAIL_INDEX } from "./elasticsearch.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function syncEmails() {
  try {
    const exists = await elasticsearch.indices.exists({
      index: EMAIL_INDEX,
    });

    if (!exists) {
      await elasticsearch.indices.create({
        index: EMAIL_INDEX,
      });
    }

    const result = await pool.query(
      `SELECT
         id,
         recipient_email,
         subject,
         body,
         scheduled_at,
         sent_at,
         status,
         campaign_id
       FROM emails`
    );

    for (const email of result.rows) {
      await elasticsearch.index({
        index: EMAIL_INDEX,
        id: String(email.id),
        document: email,
      });
    }

    await elasticsearch.indices.refresh({
      index: EMAIL_INDEX,
    });

    console.log(`Successfully indexed ${result.rows.length} emails.`);
  } catch (error) {
    console.error("Email synchronization failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
    await elasticsearch.close();
  }
}

await syncEmails();
