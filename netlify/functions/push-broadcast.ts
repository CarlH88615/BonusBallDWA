import type { Handler } from "@netlify/functions";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE);

webpush.setVapidDetails("mailto:admin@yourapp.local", VAPID_PUBLIC, VAPID_PRIVATE);

export const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const { title, body } = JSON.parse(event.body || "{}");
    if (!title || !body) {
      return { statusCode: 400, body: "Missing title/body" };
    }

    // Fetch all subscriptions
    const { data, error } = await supabaseAdmin
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth");

    if (error) {
      console.error("Supabase error:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          supabaseError: error.message,
          code: error.code,
          details: error.details
        })
      };
    }

    const subs = data || [];

    const payload = JSON.stringify({ title, body });

    const results = await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: s.endpoint,
              keys: { p256dh: s.p256dh, auth: s.auth },
            },
            payload
          );
          return { success: true };
        } catch (err: any) {
          console.error("Push failed for endpoint:", s.endpoint);
          console.error("Status:", err?.statusCode);
          console.error("Body:", err?.body);
          throw err;
        }
      })
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;

    return {
      statusCode: 200,
      body: JSON.stringify({ sent: ok, failed: fail, total: results.length }),
      headers: { "content-type": "application/json" },
    };
  } catch (e: any) {
    return { statusCode: 500, body: e?.message ?? "Server error" };
  }
};
