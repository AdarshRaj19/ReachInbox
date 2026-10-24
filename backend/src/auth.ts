
import { Router, type Request, type Response } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Pool } from "pg";

const router = Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

type GoogleProfile = {
  id: string;
  displayName: string;
  emails?: Array<{ value: string; verified?: boolean }>;
  photos?: Array<{ value: string }>;
};

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: process.env.GOOGLE_CALLBACK_URL!,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const googleProfile = profile as GoogleProfile;
        const email = googleProfile.emails?.[0]?.value?.toLowerCase();

        if (!email || googleProfile.emails?.[0]?.verified !== true) {
          return done(new Error("A verified Google email is required."));
        }

        const result = await pool.query(
          `INSERT INTO users (google_id, email, display_name, avatar_url)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (google_id)
           DO UPDATE SET
             email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url,
             updated_at = NOW()
           RETURNING id, google_id, email, display_name, avatar_url`,
          [
            googleProfile.id,
            email,
            googleProfile.displayName,
            googleProfile.photos?.[0]?.value ?? null,
          ]
        );

        return done(null, result.rows[0]);
      } catch (error) {
        return done(error as Error);
      }
    }
  )
);

passport.serializeUser((user: Express.User, done) => {
  done(null, (user as { id: string }).id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const result = await pool.query(
      `SELECT id, google_id, email, display_name, avatar_url
       FROM users
       WHERE id = $1`,
      [id]
    );

    done(null, result.rows[0] ?? false);
  } catch (error) {
    done(error);
  }
});

router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/auth/failed",
  }),
  (_req: Request, res: Response) => {
    res.redirect(`${process.env.FRONTEND_URL}/`);
  }
);

router.get("/failed", (_req, res) => {
  res.status(401).send("Google login failed. Please try again.");
});

router.get("/me", (req, res) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  res.json({ user: req.user });
});

router.post("/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) {
      next(error);
      return;
    }

    req.session.destroy((sessionError) => {
      if (sessionError) {
        next(sessionError);
        return;
      }

      res.clearCookie("reachinbox.sid");
      res.json({ message: "Logged out successfully" });
    });
  });
});

export default router;
