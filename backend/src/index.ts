
import "dotenv/config";
import express from "express";
import session from "express-session";
import passport from "passport";
import authRouter from "./auth.js";
import slackAuthRouter from "./slack-auth.js";
import cors from "cors";
import { Pool } from "pg";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { emailQueue } from "./email-queue.js";
import { elasticsearch, EMAIL_INDEX } from "./elasticsearch.js";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { repairDelayedJobs } from "./repair-delayed-jobs.js";


const app = express();
const PORT = Number(process.env.PORT || 3000);

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

app.use("/admin/queues", serverAdapter.getRouter());

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(
  session({
    name: "reachinbox.sid",
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use("/auth", authRouter);
app.use("/auth/slack", slackAuthRouter);
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Home route
app.get("/", (_req, res) => {
  res.json({
    message: "ReachInbox Email Scheduler API",
    status: "Backend is running",
  });
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
  });
});

// Retrieve only the logged-in user's email records from PostgreSQL
app.get("/api/emails", async (req, res) => {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ error: "Please log in with Google first." });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT
         e.id,
         e.recipient_email,
         e.subject,
         e.scheduled_at,
         e.sent_at,
         e.status
       FROM emails e
       JOIN campaigns c ON c.id = e.campaign_id
       WHERE LOWER(c.user_email) = LOWER($1)
       ORDER BY e.scheduled_at DESC
       LIMIT 100`,
      [req.user.email]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Failed to fetch emails:", error);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});
// Search only the logged-in user's indexed email records
app.get("/api/emails/search", async (req, res) => {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ error: "Please log in with Google first." });
    return;
  }
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      res.status(400).json({
        error: "Please provide a search query using ?q=",
      });
      return;
    }
    const indexExists = await elasticsearch.indices.exists({
      index: EMAIL_INDEX,
    });
    if (!indexExists) {
      res.json([]);
      return;
    }
    const result = await elasticsearch.search({
      index: EMAIL_INDEX,
      query: {
        multi_match: {
          query: q,
          fields: ["recipient_email", "subject", "body"],
        },
      },
      size: 100,
    });
    const campaignIds = await pool.query(
      "SELECT id FROM campaigns WHERE LOWER(user_email) = LOWER($1)",
      [req.user.email]
    );
    const allowedCampaignIds = new Set(
      campaignIds.rows.map((row: { id: string }) => String(row.id))
    );
    const hits = result.hits.hits
      .map((hit) => ({
        id: hit._id,
        ...(hit._source ?? {}),
      }))
      .filter((email: any) => allowedCampaignIds.has(String(email.campaign_id)));
    res.json(hits);
  } catch (error) {
    console.error("Email search failed:", error);
    res.status(500).json({ error: "Email search failed." });
  }
});
// Create a campaign and save recipients to PostgreSQL
app.post("/api/campaigns", upload.single("file"), async (req, res) => {
  let client;
  let transactionStarted = false;

  try {
    if (!req.file) {
      res.status(400).json({
        error: "Please upload a CSV or TXT file.",
      });
      return;
    }

    const subject = String(req.body.subject || "").trim();
    const body = String(req.body.body || "").trim();
    const startTime = new Date(req.body.startTime);
    const delaySeconds = Number(req.body.delaySeconds);
    const hourlyLimit = Number(req.body.hourlyLimit);
    const filename = req.file.originalname.toLowerCase();

    if (!subject || !body) {
      res.status(400).json({
        error: "Subject and body are required.",
      });
      return;
    }

    if (
      Number.isNaN(startTime.getTime()) ||
      startTime.getTime() < Date.now() ||
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 0 ||
      !Number.isInteger(hourlyLimit) ||
      hourlyLimit < 1
    ) {
      res.status(400).json({
        error:
          "Invalid campaign settings. Start time must be now or in the future, delay must be a non-negative integer, and hourly limit must be a positive integer.",
      });
      return;
    }

    if (!filename.endsWith(".csv") && !filename.endsWith(".txt")) {
      res.status(400).json({
        error: "Only CSV and TXT files are supported.",
      });
      return;
    }

    // Extract valid email addresses from the uploaded file.
    const content = req.file.buffer.toString("utf8");
    let recipients: string[];

    if (filename.endsWith(".csv")) {
      const rows = parse(content, {
        bom: true,
        skip_empty_lines: true,
        trim: true,
      }) as string[][];

      recipients = rows
        .flatMap((row) => row)
        .map((email) => email.trim())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    } else {
      recipients = content
        .split(/[\r\n,;\t ]+/)
        .map((email) => email.trim())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    }

    // Normalize and remove duplicate addresses.
    recipients = [
      ...new Set(recipients.map((email) => email.toLowerCase())),
    ];

    if (recipients.length === 0) {
      res.status(400).json({
        error: "No valid email addresses were found in the file.",
      });
      return;
    }

    if (!req.isAuthenticated() || !req.user) {
      res.status(401).json({ error: "Please log in with Google first." });
      return;
    }
    const userEmail = req.user.email;

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const campaignResult = await client.query(
      `INSERT INTO campaigns
        (user_email, subject, body, scheduled_start, delay_seconds, hourly_limit)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status`,
      [
        userEmail,
        subject,
        body,
        startTime,
        delaySeconds,
        hourlyLimit,
      ]
    );

    const campaign = campaignResult.rows[0];

    for (let i = 0; i < recipients.length; i++) {
      const scheduledAt = new Date(
        startTime.getTime() + i * delaySeconds * 1000
      );

      await client.query(
        `INSERT INTO emails
          (campaign_id, recipient_email, subject, body, scheduled_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          campaign.id,
          recipients[i],
          subject,
          body,
          scheduledAt,
        ]
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    // Read the saved email records.
    const savedEmails = await pool.query(
      `SELECT
         id,
         recipient_email,
         subject,
         body,
         scheduled_at,
         sent_at,
         status
       FROM emails
       WHERE campaign_id = $1
       ORDER BY scheduled_at ASC`,
      [campaign.id]
    );

    // Index emails in Elasticsearch. Indexing failures do not prevent
    // the campaign records from being saved.
    try {
      const indexExists = await elasticsearch.indices.exists({
        index: EMAIL_INDEX,
      });

      if (!indexExists) {
        await elasticsearch.indices.create({
          index: EMAIL_INDEX,
        });
      }

      for (const email of savedEmails.rows) {
        await elasticsearch.index({
          index: EMAIL_INDEX,
          id: String(email.id),
          document: {
            id: email.id,
            recipient_email: email.recipient_email,
            subject: email.subject,
            body: email.body,
            scheduled_at: email.scheduled_at,
            sent_at: email.sent_at,
            status: email.status,
            campaign_id: campaign.id,
          },
        });
      }

      await elasticsearch.indices.refresh({
        index: EMAIL_INDEX,
      });
    } catch (searchError) {
      console.error(
        "Emails were saved, but Elasticsearch indexing failed:",
        searchError
      );
    }

    // Schedule jobs in BullMQ using stable IDs.
    // If queue scheduling fails, startup recovery can add missing jobs.
    for (const email of savedEmails.rows) {
      const scheduledAt = new Date(email.scheduled_at).getTime();
      const delay = Math.max(0, scheduledAt - Date.now());

      await emailQueue.add(
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
    }

    res.status(201).json({
      message: "Campaign and recipient records saved successfully.",
      campaignId: campaign.id,
      status: campaign.status,
      recipientCount: recipients.length,
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Database rollback failed:", rollbackError);
      }
    }

    console.error("Failed to save campaign:", error);

    res.status(500).json({
      error: "Failed to save campaign.",
    });
  } finally {
    client?.release();
  }
});

// Recover missing jobs before accepting requests.
async function startServer() {
  try {
    await repairDelayedJobs();
    console.log("Email job recovery completed.");
  } catch (error) {
    console.error("Email job recovery failed:", error);
  }

  app.listen(PORT, () => {
    console.log(`ReachInbox backend running at http://localhost:${PORT}`);
    console.log(`Bull Board: http://localhost:${PORT}/admin/queues`);
  });
}

startServer();





