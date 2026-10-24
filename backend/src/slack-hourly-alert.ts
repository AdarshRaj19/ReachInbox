
import { WebClient } from "@slack/web-api";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

type SlackAlertDependencies = {
  pool: Pool;
  connection: Redis;
};

export async function notifySlackHourlyLimit(
  emailId: string,
  { pool, connection }: SlackAlertDependencies,
): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT c.id AS campaign_id, c.user_email, c.hourly_limit,
              s.access_token, s.team_name
       FROM emails e
       JOIN campaigns c ON c.id = e.campaign_id
       JOIN users u ON LOWER(u.email) = LOWER(c.user_email)
       JOIN slack_connections s ON s.user_id = u.id
       WHERE e.id = $1
       LIMIT 1`,
      [emailId],
    );

    if (result.rows.length === 0) {
      console.log("No Slack connection found for this campaign owner.");
      return;
    }

    const owner = result.rows[0] as {
      campaign_id: string;
      user_email: string;
      hourly_limit: number;
      access_token: string;
      team_name: string | null;
    };

    const hourWindow = Math.floor(Date.now() / 3_600_000);
    const key =
      `reachinbox:slack-hourly-alert:${owner.campaign_id}:${hourWindow}`;

    const claimed = await connection.set(key, "1", "EX", 7200, "NX");

    if (claimed !== "OK") {
      console.log(
        `Slack hourly-limit alert already sent or claimed for campaign ${owner.campaign_id}.`,
      );
      return;
    }

    const slack = new WebClient(owner.access_token);

    try {
      await slack.chat.postMessage({
        channel: "C0CBNMG9B27",
        text:
          `ReachInbox hourly email limit reached for ${owner.user_email}. ` +
          `The campaign limit is ${owner.hourly_limit} emails per hour. ` +
          `Pending emails will be rescheduled for the next hour.`,
      });

      console.log(
        `Slack hourly-limit alert sent for campaign ${owner.campaign_id}.`,
      );
    } catch (slackError) {
      await connection.del(key);
      throw slackError;
    }
  } catch (error) {
    console.error(
      "Slack hourly-limit notification failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
