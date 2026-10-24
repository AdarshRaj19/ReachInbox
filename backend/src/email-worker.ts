
import "dotenv/config";
import { Worker, DelayedError } from "bullmq";
import { Pool } from "pg";
import nodemailer from "nodemailer";
import { WebClient } from "@slack/web-api";
import { connection } from "./email-queue.js";
import { notifySlackHourlyLimit } from "./slack-hourly-alert.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

const requiredSettings = [
  "DATABASE_URL",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
] as const;

for (const setting of requiredSettings) {
  if (!process.env[setting]) {
    throw new Error(`Missing ${setting} in .env`);
  }
}

const smtpPort = positiveInteger("SMTP_PORT", 587);
const concurrency = positiveInteger("WORKER_CONCURRENCY", 5);
const maxEmailsPerHour = positiveInteger("MAX_EMAILS_PER_HOUR", 200);
const minDelayMs = positiveInteger("MIN_DELAY_MS", 2000);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/*
 * Atomically reserves one hourly sending slot and one spacing slot.
 *
 * Returns:
 *   {-1, nextHourMs} = hourly cap reached
 *   {waitMs, 0}      = slot reserved; wait before sending if necessary
 *
 * Redis coordinates reservations across worker instances.
 */
const reserveSendSlotScript = `
local hourlyKey = KEYS[1]
local spacingKey = KEYS[2]

local maxCount = tonumber(ARGV[1])
local nowMs = tonumber(ARGV[2])
local minDelay = tonumber(ARGV[3])

local hourMs = 3600000
local nextHour = (math.floor(nowMs / hourMs) + 1) * hourMs
local ttlSeconds = math.max(1, math.ceil((nextHour - nowMs) / 1000))

local count = tonumber(redis.call("GET", hourlyKey) or "0")

if count >= maxCount then
  return {-1, nextHour}
end

local lastReserved = tonumber(redis.call("GET", spacingKey) or "0")
local sendAt = math.max(nowMs, lastReserved)
local nextAllowed = sendAt + minDelay

redis.call("INCR", hourlyKey)

if count == 0 then
  redis.call("EXPIRE", hourlyKey, ttlSeconds)
end

redis.call("SET", spacingKey, nextAllowed, "PX", 7200000)

return {math.max(0, sendAt - nowMs), 0}
`;

type SendSlot = {
  waitMs: number;
  nextHourMs: number;
};

async function reserveSendSlot(): Promise<SendSlot> {
  const now = Date.now();
  const hourWindow = Math.floor(now / 3_600_000);

  const result = (await connection.eval(
    reserveSendSlotScript,
    2,
    `reachinbox:hourly-sends:${hourWindow}`,
    "reachinbox:next-send-at",
    String(maxEmailsPerHour),
    String(now),
    String(minDelayMs),
  )) as [number | string, number | string];

  const first = Number(result[0]);
  const second = Number(result[1]);

  if (first === -1) {
    return {
      waitMs: 0,
      nextHourMs: second,
    };
  }

  return {
    waitMs: first,
    nextHourMs: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const worker = new Worker(
  "email-scheduler",
  async (job, token) => {
    const emailId = String(job.data.emailId || "");

    if (!emailId) {
      throw new Error("Job is missing emailId.");
    }

    const result = await pool.query(
      `SELECT id, recipient_email, subject, body, status
       FROM emails
       WHERE id = $1`,
      [emailId],
    );

    if (result.rowCount === 0) {
      throw new Error(`Email ${emailId} was not found.`);
    }

    const email = result.rows[0];

    if (email.status === "sent") {
      console.log(`Email ${emailId} was already sent.`);
      return;
    }

    if (email.status === "sending" || email.status === "failed") {
      console.log(
        `Skipping email ${emailId}; current status is ${email.status}.`,
      );
      return;
    }

    /*
     * Claim the email in PostgreSQL before processing it.
     */
    const claim = await pool.query(
      `UPDATE emails
       SET status = 'sending', error_message = NULL
       WHERE id = $1
         AND status IN ('scheduled', 'queued')
       RETURNING id`,
      [emailId],
    );

    if (claim.rowCount === 0) {
      console.log(`Email ${emailId} was not claimed; skipping.`);
      return;
    }

    let slot: SendSlot;

    try {
      slot = await reserveSendSlot();
    } catch (error) {
      await pool.query(
        `UPDATE emails
         SET status = 'queued'
         WHERE id = $1 AND status = 'sending'`,
        [emailId],
      );

      throw error;
    }

    /*
     * If the hourly cap is reached, keep the email queued
     * and reschedule it for the next UTC hour.
     */
    if (slot.nextHourMs > 0) {
      await pool.query(
        `UPDATE emails
         SET status = 'queued'
         WHERE id = $1 AND status = 'sending'`,
        [emailId],
      );

      if (!token) {
        throw new Error(
          "Cannot reschedule job without its BullMQ lock token.",
        );
      }

      await job.moveToDelayed(slot.nextHourMs, token);
      await notifySlackHourlyLimit(emailId, { pool, connection });

      console.warn(
        `Hourly limit reached. Email ${emailId} rescheduled for ` +
          `${new Date(slot.nextHourMs).toISOString()}`,
      );

      throw new DelayedError();
    }

    /*
     * A slot has already been reserved in Redis.
     * Wait for that slot instead of rescheduling the job
     * and consuming another hourly reservation.
     */
    if (slot.waitMs > 0) {
      console.log(
        `Waiting ${slot.waitMs}ms before sending email ${emailId}.`,
      );

      await sleep(slot.waitMs);
    }

    /*
     * Send using SMTP after the reserved slot becomes available.
     */
    try {
      const info = await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: email.recipient_email,
        subject: email.subject,
        text: email.body,
      });

      await pool.query(
        `UPDATE emails
         SET status = 'sent',
             sent_at = NOW(),
             error_message = NULL
         WHERE id = $1`,
        [emailId],
      );

      console.log(
        `Email accepted by SMTP for ${email.recipient_email}.`,
      );

      console.log(
        `Ethereal preview: ${
          nodemailer.getTestMessageUrl(info) || "Not available"
        }`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      const currentAttempt = job.attemptsMade + 1;
      const maxAttempts = Number(job.opts.attempts ?? 1);
      const finalFailure = currentAttempt >= maxAttempts;

      try {
        await pool.query(
          `UPDATE emails
           SET status = $2,
               error_message = $3
           WHERE id = $1
             AND status = 'sending'`,
          [emailId, finalFailure ? "failed" : "queued", message],
        );
      } catch (dbError) {
        console.error(
          `Could not update failure status for email ${emailId}:`,
          dbError,
        );
      }

      throw error;
    }
  },
  {
    connection,
    concurrency,
  },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed.`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed:`, error);
  console.error("Error stack:", error.stack);
  console.error("Attempts made:", job?.attemptsMade);
  console.error("Job data:", job?.data);
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

console.log(
  `Email worker running. Concurrency=${concurrency}, ` +
    `hourly limit=${maxEmailsPerHour}, min interval=${minDelayMs}ms.`,
);

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("Shutting down email worker...");

  try {
    await worker.close();
    await transporter.close();
    await pool.end();
    await connection.quit();

    console.log("Email worker shut down successfully.");
  } catch (error) {
    console.error("Error during worker shutdown:", error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});


