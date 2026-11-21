import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

// Shared by the functions that must know who is calling. It lives outside the functions
// folder so Netlify does not deploy it as a function of its own.

const supabaseAdmin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Same address the app treats as the admin. Override with ADMIN_EMAIL in Netlify if it changes.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "carlwhalliday@icloud.com").toLowerCase();

/** Checks the caller's Supabase sign-in token. Returns null if it isn't valid. */
export const authorize = async (authorization?: string) => {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  const email = (data.user.email ?? "").toLowerCase();
  return { id: data.user.id, email, isAdmin: email === ADMIN_EMAIL };
};

/** A secret only our own functions can work out, for one function calling another. */
export const internalKey = () =>
  createHash("sha256").update(`bonus-ball-internal:${process.env.SUPABASE_SERVICE_ROLE_KEY}`).digest("hex");

export { supabaseAdmin };
