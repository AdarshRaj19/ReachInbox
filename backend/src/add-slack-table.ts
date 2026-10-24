import "dotenv/config";
import { Pool } from "pg";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
async function main() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slack_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        team_id VARCHAR(255) NOT NULL,
        team_name VARCHAR(255),
        slack_user_id VARCHAR(255),
        access_token TEXT NOT NULL,
        scope TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("Slack connections table is ready.");
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error("Could not create Slack table:", error.message);
  process.exitCode = 1;
});
