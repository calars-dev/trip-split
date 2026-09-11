// "누가 얼마 썼는지" — tell everyone else in the trip the moment an expense lands.
//
// The app calls this right after a new expense saves, fire-and-forget: a push that
// fails must never make a save look like it failed. There is no database trigger
// on purpose — a trigger would need a key written into SQL to reach this function.
//
// Deployed with --no-verify-jwt so the browser's CORS preflight (which carries no
// token) gets through; the caller is checked here instead, against the seat they
// hold in the expense's trip.
//
// Secrets (set once, never in code): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendPush } from "./webpush.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { expense_id } = await req.json();
    if (!expense_id) return json({ error: "expense_id required" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } });

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(jwt);
    if (!who?.user) return json({ error: "unauthorized" }, 401);

    const { data: e } = await admin.from("expenses")
      .select("id, room_id, payer_id, amount, currency, note, category")
      .eq("id", expense_id).maybeSingle();
    if (!e) return json({ error: "not found" }, 404);

    // Only someone sitting in that trip may ring its phones.
    // The pot can be parked on the manager's account too; their seat is the one
    // that isn't the pot.
    const { data: seats } = await admin.from("members").select("id, is_ledger")
      .eq("room_id", e.room_id).eq("user_id", who.user.id);
    const me = (seats ?? []).find((m) => !m.is_ledger);
    if (!me) return json({ error: "forbidden" }, 403);

    const { data: payer } = await admin.from("members").select("name").eq("id", e.payer_id).maybeSingle();
    // Everyone but the person who just typed it — they already know.
    const { data: subs } = await admin.from("push_subscriptions")
      .select("endpoint, p256dh, auth_key").eq("room_id", e.room_id).neq("member_id", me.id);

    const amount = (e.currency === "JPY" ? "¥" : "₩") + Number(e.amount).toLocaleString("en-US");
    const message = {
      title: `${payer?.name ?? "누군가"} · ${amount}`,
      body: e.note || e.category || "지출",
      url: `/trip-split/?r=${encodeURIComponent(e.room_id)}&e=${encodeURIComponent(e.id)}`,
    };
    const vapid = {
      publicKey: Deno.env.get("VAPID_PUBLIC_KEY")!,
      privateD: Deno.env.get("VAPID_PRIVATE_KEY")!,
      subject: Deno.env.get("VAPID_SUBJECT") ?? "https://calars-dev.github.io",
    };

    let sent = 0;
    const gone: string[] = [];
    await Promise.all((subs ?? []).map(async (s) => {
      try {
        const r = await sendPush(s, message, vapid);
        if (r.ok) sent++;
        else if (r.status === 404 || r.status === 410) gone.push(s.endpoint);
      } catch (_) { /* one phone failing must not stop the others */ }
    }));
    if (gone.length) await admin.from("push_subscriptions").delete().in("endpoint", gone);

    return json({ sent, total: (subs ?? []).length, removed: gone.length });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
