import type { Handler } from "@netlify/functions";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE);

webpush.setVapidDetails("mailto:admin@yourapp.local", VAPID_PUBLIC, VAPID_PRIVATE);

export const handler: Handler = async () => {
  const nowIso = new Date().toISOString();

  // Pull pending reminders that are due
  const { data: reminders, error: remErr } = await supabaseAdmin
    .from("reminders")
    .select("id,user_id,title,body,scheduled_for")
    .eq("status", "pending")
    .is("sent_at", null)
    .lte("scheduled_for", nowIso)
    .limit(50);

  if (remErr) {
    return { statusCode: 500, body: remErr.message };
  }

  const due = reminders ?? [];
  let sent = 0;
  let failed = 0;

  for (const r of due) {
    // Fetch subscriptions for that user
    const { data: subs, error: subErr } = await supabaseAdmin
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth")
      .eq("user_id", r.user_id);

    if (subErr) {
      failed++;
      await supabaseAdmin
        .from("reminders")
        .update({ status: "failed", error: subErr.message })
        .eq("id", r.id);
      continue;
    }

    const payload = JSON.stringify({ title: r.title, body: r.body });

    const results = await Promise.allSettled(
      (subs ?? []).map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        )
      )
    );

    const ok = results.filter((x) => x.status === "fulfilled").length;

    if (ok > 0) {
      sent++;
      await supabaseAdmin
        .from("reminders")
        .update({ status: "sent", sent_at: new Date().toISOString(), error: null })
        .eq("id", r.id);
    } else {
      failed++;
      const firstErr = results.find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
      await supabaseAdmin
        .from("reminders")
        .update({
          status: "failed",
          error: firstErr?.reason?.message ?? "No subscriptions or push failed",
        })
        .eq("id", r.id);
    }
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checked: due.length, sent, failed }),
  };
};
