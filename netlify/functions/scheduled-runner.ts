import { schedule } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const handler = schedule("*/1 * * * *", async () => {
  const now = new Date().toISOString();

  const { data: dueNotifications, error } = await supabase
    .from("scheduled_notifications")
    .select("*")
    .eq("active", true)
    .not("send_at", "is", null)
    .lte("send_at", now);

  if (error || !dueNotifications) return;

  for (const notification of dueNotifications) {
    await fetch(`${process.env.URL}/.netlify/functions/push-broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: notification.title,
        body: notification.body,
        target: notification.target,
        deliveryMode: notification.delivery_mode
      })
    });

    await supabase
      .from("scheduled_notifications")
      .update({ active: false })
      .eq("id", notification.id);
  }
});
