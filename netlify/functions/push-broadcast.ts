import type { Handler } from "@netlify/functions";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE);

webpush.setVapidDetails("https://clever-eclair-5bc08f.netlify.app", VAPID_PUBLIC, VAPID_PRIVATE);

export const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const { title, body, target } = JSON.parse(event.body || "{}");
    if (!title || !body) {
      return { statusCode: 400, body: "Missing title/body" };
    }

    // Fetch subscriptions (optionally filter to unpaid users)
    let subsQuery = supabaseAdmin
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .eq("active", true);

    if (target === "unpaid") {
      const { data: bonusData, error: bonusErr } = await supabaseAdmin
        .from("bonus_ball_data")
        .select("state")
        .eq("id", 1)
        .single();

      if (bonusErr) {
        console.error("Supabase bonus_ball_data error:", bonusErr);
        return {
          statusCode: 500,
          body: JSON.stringify({
            supabaseError: bonusErr.message,
            code: bonusErr.code,
            details: bonusErr.details,
          }),
        };
      }

      const balls = (bonusData as any)?.state?.balls ?? [];
      const now = new Date();
      const unpaidUserIds = Array.from(
        new Set(
          balls
            .filter((b: any) => {
              if (!b?.paidUntil) return true;
              const paidDate = new Date(b.paidUntil);
              return paidDate < now;
            })
            .map((b: any) => b.userId)
            .filter((id: any) => !!id)
        )
      );

      if (unpaidUserIds.length === 0) {
        return {
          statusCode: 200,
          body: JSON.stringify({ sent: 0, failed: 0, total: 0, note: "No unpaid users" }),
          headers: { "content-type": "application/json" },
        };
      }

      subsQuery = subsQuery.in("user_id", unpaidUserIds);
    }

    const { data, error } = await subsQuery;

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
