import type { Handler } from "@netlify/functions";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE);

webpush.setVapidDetails(
  "https://clever-eclair-5bc08f.netlify.app",
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// Returns the Saturday 20:00 UTC for the current week (or next week if today is past it).
function upcomingSaturday20(): Date {
  const now = new Date();
  // getUTCDay: 0=Sun ... 6=Sat
  const day = now.getUTCDay();
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    19, 0, 0, 0 // 19:00 UTC ≈ 20:00 BST; close enough for "is this week's draw"
  ));
  if (day === 6 && now < candidate) return candidate;
  const daysToAdd = day === 6 ? 7 : (6 - day + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysToAdd);
  return candidate;
}

async function sendPushToUser(userId: string, title: string, body: string) {
  const { data: subs } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth")
    .eq("user_id", userId)
    .eq("active", true);
  if (!subs?.length) return { sent: 0, failed: 0 };
  const payload = JSON.stringify({ title, body });
  const results = await Promise.allSettled(
    subs.map((s: any) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      )
    )
  );
  const sent = results.filter((r) => r.status === "fulfilled").length;
  return { sent, failed: results.length - sent };
}

export const handler: Handler = async () => {
  const today = new Date();
  const dow = today.getUTCDay(); // 0=Sun..6=Sat

  // Only act on Thursday (4) and Saturday (6). Skip silently otherwise.
  if (dow !== 4 && dow !== 6) {
    return { statusCode: 200, body: JSON.stringify({ note: "Not a reminder day", dow }) };
  }

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("bonus_ball_data")
    .select("state")
    .limit(1)
    .single();

  if (rowErr || !row) {
    return { statusCode: 500, body: JSON.stringify({ error: rowErr?.message ?? "no row" }) };
  }

  const balls: any[] = (row as any)?.state?.balls ?? [];
  const draw = upcomingSaturday20();

  let pushed = 0;
  let failed = 0;
  let skipped = 0;

  for (const b of balls) {
    if (!b?.userId) {
      skipped++;
      continue;
    }
    const paid = b.paidUntil ? new Date(b.paidUntil) : null;
    const isCovered = paid !== null && paid >= draw;

    let title: string | null = null;
    let body: string | null = null;

    if (dow === 4) {
      // Thursday: nudge owners who aren't covered
      if (b.owner && !isCovered) {
        title = "Your ball isn't covered for Saturday";
        body = `Ball #${b.number} expires before the next draw. Pay £2 to stay in.`;
      }
    } else if (dow === 6) {
      // Saturday: hype-build for covered owners
      if (b.owner && isCovered) {
        title = "Draw tonight at 8pm";
        body = `You're in with Ball #${b.number}. Good luck!`;
      }
    }

    if (!title || !body) {
      skipped++;
      continue;
    }

    const { sent, failed: f } = await sendPushToUser(b.userId, title, body);
    pushed += sent;
    failed += f;
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dow, pushed, failed, skipped, totalBalls: balls.length }),
  };
};
