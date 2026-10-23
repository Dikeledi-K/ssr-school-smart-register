// SSR – School Smart Register : administrator actions
// Deploy:  supabase functions deploy ssr-admin
// Actions (POST JSON):
//   {action:"create",  username, main_class, password}
//   {action:"update",  id, username?, main_class?, password?}
//   {action:"delete",  id}
//   {action:"read_list", image (base64 JPEG), media_type}   ← photo of a paper class list
// Only a logged-in administrator can call it, and only for their own school.

import { createClient } from "npm:@supabase/supabase-js@2";

// Must match TEACHER_DOMAIN in web/config.js. Teachers never see or use this address.
const TEACHER_DOMAIN = "teachers.ssr.local";
const CLASS_RE = /^(R|[1-9]|1[0-2])[A-Z]{0,3}$/;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });
const keyOf = (u: string) => u.toLowerCase().replace(/[^a-z0-9]+/g, "");
const emailOf = (u: string, code: string) => `${keyOf(u)}.${code.toLowerCase()}@${TEACHER_DOMAIN}`;
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ---- who is calling? ----
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: ud } = await db.auth.getUser(jwt);
    if (!ud?.user) return json({ error: "Please log in again." }, 401);
    const { data: me } = await db.from("profiles").select("school_id, role, main_class").eq("id", ud.user.id).maybeSingle();
    if (!me) return json({ error: "Your account is not linked to a school." }, 403);
    const { data: school } = await db.from("schools").select("code, name, sms_enabled, sms_both, sms_template").eq("id", me.school_id).single();
    const code: string = school!.code;

    const b = await req.json().catch(() => ({}));

    // ---- SMS parents of absent learners (class teacher for own class, or administrator) ----
    if (b.action === "sms_absent") return json(...(await smsAbsent(db, me, school!, ud.user.id, b)));

    if (me.role !== "admin") return json({ error: "Only the administrator can do this." }, 403);

    // ---- helpers ----
    const usernameTaken = async (username: string, exceptId?: string) => {
      const { data } = await db.from("profiles").select("id, username")
        .eq("school_id", me.school_id).eq("username_key", keyOf(username));
      return (data || []).find((r) => r.id !== exceptId);
    };
    const classTaken = async (cls: string, exceptId?: string) => {
      const { data } = await db.from("profiles").select("id, username")
        .eq("school_id", me.school_id).eq("role", "teacher").eq("main_class", cls);
      return (data || []).find((r) => r.id !== exceptId);
    };
    const checkUsername = (u: string) =>
      u.length < 2 || u.length > 60 || keyOf(u).length < 2
        ? "Username must be the surname and initials, e.g. Baloyi TK." : "";
    const checkPassword = (p: string) => (p.length < 6 ? "Password must be 6 or more characters." : "");
    const loadTeacher = async (id: string) => {
      const { data } = await db.from("profiles").select("*").eq("id", id).maybeSingle();
      return data && data.school_id === me.school_id && data.role === "teacher" ? data : null;
    };

    // ---- create teacher ----
    if (b.action === "create") {
      const username = clean(b.username), cls = clean(b.main_class).toUpperCase(), pw = String(b.password || "");
      const err = checkUsername(username) || (CLASS_RE.test(cls) ? "" : "Choose a grade and class.") || checkPassword(pw);
      if (err) return json({ error: err }, 400);
      const u = await usernameTaken(username);
      if (u) return json({ error: `The username “${u.username}” already exists. Try a new username.` }, 409);
      const c = await classTaken(cls);
      if (c) return json({ error: `Grade ${cls} already has a class teacher (${c.username}). Reassign them first.` }, 409);

      const { data: cu, error: ce } = await db.auth.admin.createUser({
        email: emailOf(username, code), password: pw, email_confirm: true,
        app_metadata: { ssr_school: code, ssr_role: "teacher" },
      });
      if (ce || !cu?.user) return json({ error: ce?.message || "Could not create the login." }, 400);
      const { error: pe } = await db.from("profiles").insert({
        id: cu.user.id, school_id: me.school_id, role: "teacher", username, main_class: cls,
      });
      if (pe) { await db.auth.admin.deleteUser(cu.user.id); return json({ error: pe.message }, 400); }
      return json({ ok: true, id: cu.user.id });
    }

    // ---- reassign / rename / reset password ----
    if (b.action === "update") {
      const t = await loadTeacher(String(b.id || ""));
      if (!t) return json({ error: "Teacher not found." }, 404);
      const username = b.username != null ? clean(b.username) : t.username;
      const cls = b.main_class != null ? clean(b.main_class).toUpperCase() : t.main_class;
      const pw = b.password ? String(b.password) : "";
      const err = checkUsername(username) || (CLASS_RE.test(cls) ? "" : "Choose a grade and class.") || (pw ? checkPassword(pw) : "");
      if (err) return json({ error: err }, 400);
      const u = await usernameTaken(username, t.id);
      if (u) return json({ error: `The username “${u.username}” already exists. Try a new username.` }, 409);
      const c = await classTaken(cls, t.id);
      if (c) return json({ error: `Grade ${cls} already has a class teacher (${c.username}).` }, 409);

      const authUpd: Record<string, unknown> = {};
      if (keyOf(username) !== keyOf(t.username)) authUpd.email = emailOf(username, code), authUpd.email_confirm = true;
      if (pw) authUpd.password = pw;
      if (Object.keys(authUpd).length) {
        const { error } = await db.auth.admin.updateUserById(t.id, authUpd);
        if (error) return json({ error: error.message }, 400);
      }
      const { error: pe } = await db.from("profiles").update({ username, main_class: cls }).eq("id", t.id);
      if (pe) return json({ error: pe.message }, 400);
      return json({ ok: true });
    }

    // ---- delete teacher (registers already saved stay) ----
    if (b.action === "delete") {
      const t = await loadTeacher(String(b.id || ""));
      if (!t) return json({ error: "Teacher not found." }, 404);
      const { error } = await db.auth.admin.deleteUser(t.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---- read a photo of a paper class list ----
    if (b.action === "read_list") {
      const key = Deno.env.get("ANTHROPIC_API_KEY");
      if (!key) return json({ error: "Photo reading is not switched on. Add ANTHROPIC_API_KEY to the function secrets, or use CSV / typing." }, 501);
      const img = String(b.image || "");
      if (!img || img.length > 7_000_000) return json({ error: "Photo missing or too large." }, 400);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
          max_tokens: 8000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: b.media_type || "image/jpeg", data: img } },
              { type: "text", text:
                'This image is a South African school class list. For every learner return an object ' +
                '{"s": surname, "f": first name(s), "g": "M" for male/boy or "F" for female/girl or "" if not shown, ' +
                '"c1": first parent/guardian phone number, "c2": second phone number}. Use "" for anything not shown. ' +
                "Names are usually written surname first; follow column headings if there are any. " +
                "Reply with ONLY a JSON array, no other text." },
            ],
          }],
        }),
      });
      const out = await r.json();
      if (!r.ok) return json({ error: "Photo reader error: " + (out?.error?.message || r.status) }, 502);
      const text = (out.content || []).map((c: { text?: string }) => c.text || "").join("");
      const m = text.match(/\[[\s\S]*\]/);
      let rows: unknown[] = [];
      try { rows = m ? JSON.parse(m[0]) : []; } catch { rows = []; }
      return json({ ok: true, learners: Array.isArray(rows) ? rows : [] });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// ===================== SMS =====================
// Provider is chosen with the SMS_PROVIDER secret:
//   bulksms   → BULKSMS_TOKEN_ID + BULKSMS_TOKEN_SECRET   (bulksms.com, Basic auth API token)
//   smsportal → SMSPORTAL_CLIENT_ID + SMSPORTAL_SECRET    (smsportal.com REST API)
//   test      → nothing is sent; messages are only written to the log (for trying it out)
// Numbers are converted to international format: 082 123 4567 → 27821234567

const saToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());
function intl(n: string): string {
  let d = String(n || "").replace(/[^0-9+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "27" + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : "";
}

type Msg = { to: string; body: string };
async function sendSms(msgs: Msg[]): Promise<{ ok: boolean; error?: string }[]> {
  const prov = (Deno.env.get("SMS_PROVIDER") || "").toLowerCase();
  if (prov === "test") { msgs.forEach((m) => console.log("SMS(test)", m.to, m.body)); return msgs.map(() => ({ ok: true })); }
  if (prov === "bulksms") {
    const id = Deno.env.get("BULKSMS_TOKEN_ID"), sec = Deno.env.get("BULKSMS_TOKEN_SECRET");
    if (!id || !sec) throw new Error("BulkSMS token is not set in the function secrets.");
    const r = await fetch("https://api.bulksms.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic " + btoa(`${id}:${sec}`) },
      body: JSON.stringify(msgs.map((m) => ({ to: "+" + m.to, body: m.body }))),
    });
    if (!r.ok) { const t = await r.text(); return msgs.map(() => ({ ok: false, error: `BulkSMS ${r.status}: ${t.slice(0, 200)}` })); }
    return msgs.map(() => ({ ok: true }));
  }
  if (prov === "smsportal") {
    const id = Deno.env.get("SMSPORTAL_CLIENT_ID"), sec = Deno.env.get("SMSPORTAL_SECRET");
    if (!id || !sec) throw new Error("SMSPortal keys are not set in the function secrets.");
    const a = await fetch("https://rest.smsportal.com/v1/Authentication", { headers: { authorization: "Basic " + btoa(`${id}:${sec}`) } });
    if (!a.ok) throw new Error("SMSPortal login failed (" + a.status + "). Check the API keys.");
    const { token } = await a.json();
    const r = await fetch("https://rest.smsportal.com/v1/bulkmessages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ messages: msgs.map((m) => ({ content: m.body, destination: m.to })) }),
    });
    if (!r.ok) { const t = await r.text(); return msgs.map(() => ({ ok: false, error: `SMSPortal ${r.status}: ${t.slice(0, 200)}` })); }
    return msgs.map(() => ({ ok: true }));
  }
  throw new Error("SMS is not set up yet. Add SMS_PROVIDER (bulksms or smsportal) and its keys to the function secrets.");
}

// deno-lint-ignore no-explicit-any
async function smsAbsent(db: any, me: any, school: any, uid: string, b: any): Promise<[unknown, number]> {
  if (!school.sms_enabled) return [{ error: "SMS alerts are switched off. The administrator can switch them on under School." }, 400];
  const cls = me.role === "admin" ? String(b.class || "") : me.main_class;
  const day = String(b.day || "");
  if (!cls) return [{ error: "Choose a class." }, 400];
  if (day !== saToday()) return [{ error: "SMS alerts can only be sent for today's register." }, 400];

  const { data: att } = await db.from("attendance").select("absent")
    .eq("school_id", me.school_id).eq("kind", "D").eq("class", cls).eq("day", day).maybeSingle();
  if (!att) return [{ error: "Save today's daily register first." }, 400];
  const ids: string[] = att.absent || [];
  if (!ids.length) return [{ ok: true, sent: 0, failed: 0, already: 0, no_number: 0 }, 200];

  const { data: learners } = await db.from("learners").select("id, surname, name, contact1, contact2")
    .eq("school_id", me.school_id).eq("class", cls).in("id", ids);
  const { data: prev } = await db.from("sms_log").select("learner_id, recipient, status, error")
    .eq("school_id", me.school_id).eq("day", day).in("learner_id", ids);
  type P = { learner_id: string; recipient: string; status: string; error: string };
  const done = new Set((prev || []).filter((p: P) => p.status === "sent").map((p: P) => p.learner_id + "|" + p.recipient));
  const noNumLogged = new Set((prev || []).filter((p: P) => p.error === "no_number").map((p: P) => p.learner_id));
  const noNumRows: Record<string, unknown>[] = [];

  const dateTxt = new Date(day + "T12:00:00").toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
  const out: (Msg & { learner_id: string })[] = [];
  let already = 0, noNumber = 0;
  for (const l of learners || []) {
    const nums = [intl(l.contact1), school.sms_both ? intl(l.contact2) : ""].filter(Boolean);
    const uniq = [...new Set(nums)];
    if (!uniq.length) {
      noNumber++;
      if (!noNumLogged.has(l.id)) noNumRows.push({ school_id: me.school_id, class: cls, learner_id: l.id, day, recipient: "", status: "failed", error: "no_number", sent_by: uid });
      continue;
    }
    const body = String(school.sms_template)
      .replaceAll("{school}", school.name).replaceAll("{name}", l.name).replaceAll("{surname}", l.surname)
      .replaceAll("{class}", cls).replaceAll("{date}", dateTxt).slice(0, 320);
    let any = false;
    for (const to of uniq) {
      if (done.has(l.id + "|" + to)) continue;
      out.push({ to, body, learner_id: l.id }); any = true;
    }
    if (!any) already++;
  }
  if (noNumRows.length) await db.from("sms_log").insert(noNumRows);
  if (!out.length) return [{ ok: true, sent: 0, failed: 0, already, no_number: noNumber }, 200];

  const res = await sendSms(out);
  await db.from("sms_log").insert(out.map((m, i) => ({
    school_id: me.school_id, class: cls, learner_id: m.learner_id, day, recipient: m.to,
    status: res[i].ok ? "sent" : "failed", error: res[i].error || "", sent_by: uid,
  })));
  const sent = res.filter((r) => r.ok).length;
  return [{ ok: true, sent, failed: res.length - sent, already, no_number: noNumber, error: sent ? undefined : res[0]?.error }, 200];
}
