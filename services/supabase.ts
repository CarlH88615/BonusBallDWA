import { createClient } from "@supabase/supabase-js";
import { createDemoClient, DEMO_ADMIN_EMAIL } from "./demoSupabase";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Local-only demo: `npm run dev`, then open /?demo (member) or /?demo=admin. It runs on
// made-up data held in memory, so nothing reaches the real database. import.meta.env.DEV
// is false in the production build, so this can never switch on for the live site.
const demoParam =
  import.meta.env.DEV && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("demo")
    : null;
export const DEMO_ROLE: "member" | "admin" | null =
  demoParam === null ? null : demoParam === "admin" ? "admin" : "member";
export { DEMO_ADMIN_EMAIL };

export const supabase: any = DEMO_ROLE
  ? createDemoClient(DEMO_ROLE)
  : createClient(
      supabaseUrl!,
      supabaseAnonKey!,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: localStorage,
        },
      }
    );
