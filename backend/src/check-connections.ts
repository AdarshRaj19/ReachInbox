import "dotenv/config";
import { Pool } from "pg";
import { Redis } from "ioredis";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: 1,
});

async function checkConnections() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("PostgreSQL connected:", result.rows[0]);

    const reply = await redis.ping();
    console.log("Redis connected:", reply);
  } catch (error) {
    console.error("Connection test failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
    redis.disconnect();
  }
}

checkConnections();