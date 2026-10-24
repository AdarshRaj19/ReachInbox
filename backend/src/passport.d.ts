declare global {
  namespace Express {
    interface User {
      id: string;
      google_id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
    }
  }
}
export {};
