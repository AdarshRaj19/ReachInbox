
import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const router = Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

type SlackSession = Request["session"] & {
  slackOAuthState?: string;
};

function getUserId(req: Request): string | undefined {
  if (!req.isAuthenticated()) return undefined;

  const user = req.user as { id?: string } | undefined;
  return user?.id;
}

// Start Slack OAuth
router.get("/connect", (req: Request, res: Response) => {
  if (!getUserId(req)) {
    res.status(401).send("Please log in to ReachInbox first.");
    return;
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    res.status(500).send("Slack OAuth is not configured.");
    return;
  }

  const state = randomBytes(24).toString("hex");
  (req.session as SlackSession).slackOAuthState = state;

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "chat:write",
    redirect_uri: "http://localhost:3000/auth/slack/callback",
    state,
  });

  res.redirect(
    `https://slack.com/oauth/v2/authorize?${params.toString()}`
  );
});

// Slack OAuth callback
router.get("/callback", async (req: Request, res: Response) => {
  const session = req.session as SlackSession;
  const returnedState = String(req.query.state ?? "");

  if (
    !returnedState ||
    !session.slackOAuthState ||
    returnedState !== session.slackOAuthState
  ) {
    res.status(400).send("Invalid Slack OAuth state. Please try again.");
    return;
  }

  delete session.slackOAuthState;

  const userId = getUserId(req);
  if (!userId) {
    res.status(401).send("Please log in to ReachInbox and connect Slack again.");
    return;
  }

  const code = String(req.query.code ?? "");
  if (!code) {
    res.status(400).send("Slack authorization was cancelled or no code was returned.");
    return;
  }

  try {
    const body = new URLSearchParams({
      code,
      client_id: process.env.SLACK_CLIENT_ID ?? "",
      client_secret: process.env.SLACK_CLIENT_SECRET ?? "",
      redirect_uri: "http://localhost:3000/auth/slack/callback",
    });

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const result = await response.json() as {
      ok: boolean;
      error?: string;
      access_token?: string;
      scope?: string;
      team?: { id?: string; name?: string };
      authed_user?: { id?: string };
    };

    if (
      !response.ok ||
      !result.ok ||
      !result.access_token ||
      !result.team?.id ||
      !result.authed_user?.id
    ) {
      console.error("Slack OAuth failed:", result.error ?? "Invalid response");
      res.status(400).send("Slack connection failed. Check the app configuration.");
      return;
    }

    await pool.query(
      `INSERT INTO slack_connections
         (user_id, team_id, team_name, slack_user_id, access_token, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id)
       DO UPDATE SET
         team_id = EXCLUDED.team_id,
         team_name = EXCLUDED.team_name,
         slack_user_id = EXCLUDED.slack_user_id,
         access_token = EXCLUDED.access_token,
         scope = EXCLUDED.scope,
         updated_at = NOW()`,
      [
        userId,
        result.team.id,
        result.team.name ?? null,
        result.authed_user.id,
        result.access_token,
        result.scope ?? null,
      ]
    );

    res.send(
      "Slack connected successfully to ReachInbox. You can close this tab."
    );
  } catch (error) {
    console.error("Slack connection error:", error);
    res.status(500).send("Could not connect Slack. Please try again.");
  }
});

export default router;
