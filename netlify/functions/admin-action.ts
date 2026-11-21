import type { Handler } from "@netlify/functions";
import { authorize, supabaseAdmin } from "../lib/auth";
import { recordPayment, recordResult, undoResult, undoStatus } from "../../services/ops";

// Runs the money operations on the server for the signed-in admin. The phone makes one
// request; every database write then happens here, so a dropped signal can't leave the
// books half-written.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const who = await authorize(event.headers["authorization"]);
  if (!who) return { statusCode: 401, body: "Sign in again, then retry." };
  if (!who.isAdmin) return { statusCode: 403, body: "Only the admin can do that." };

  try {
    const { action, ...input } = JSON.parse(event.body || "{}");
    let result: unknown;
    if (action === "payment") result = await recordPayment(supabaseAdmin, input);
    else if (action === "result") result = await recordResult(supabaseAdmin, input);
    else if (action === "undo_result") result = await undoResult(supabaseAdmin);
    else if (action === "undo_status") result = await undoStatus(supabaseAdmin);
    else return { statusCode: 400, body: "Unknown action." };
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
  } catch (e: any) {
    return { statusCode: 422, body: e?.message ?? "Something went wrong. Nothing was changed." };
  }
};
