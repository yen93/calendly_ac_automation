// calendly-source-sync — copies the traffic source of NEW Calendly bookings onto the
// matching ActiveCampaign (AC) contact's "Src - *" fields (contact field ids 77-83).
//
// Background: since 5 Oct 2026 a WordPress script ("MAG Lead Source Capture") injects
// the visitor's source into the Calendly embeds on myadventuregroup.com.au/free-consult/.
// Calendly stores it per invitee under `tracking`: utm_source/medium/campaign/term/content
// and salesforce_uuid (which carries the ad click id as "gclid:XXXX" / "msclkid:XXXX").
// This function reads the last few days of bookings and writes that source to AC — but
// ONLY when the contact's field 77 is empty (never overwrites existing source data), and
// never creates contacts or touches tags/lists/deals. It complements new-paid-leads-sync,
// which later mirrors AC fields 77-87 into public.ac_new_leads for the dashboard.
//
// Runs Mon-Fri 06:00 Philippine time via pg_cron ('0 22 * * 0-4' UTC). Each run is logged
// to public.calendly_src_sync_runs.
//
// Invoke: GET/POST (bare = real run, days=3). Query params:
//   ?days=N      look back N days by booking created_at (default 3)
//   ?dryrun=1    do everything EXCEPT the AC writes (logs with dry_run=true)
// Secrets: CALENDLY_PAT, AC_API_URL, AC_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CALENDLY_PAT = Deno.env.get("CALENDLY_PAT") ?? "";
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 5 Oct 2026 00:00 Philippine time (UTC+8) in UTC — bookings created at/after this should
// carry tracking; one that doesn't may mean the embed lost the capture script.
const CAPTURE_LIVE_UTC = "2026-10-04T16:00:00Z";
const DAYS_DEFAULT = 3;
const INTERNAL_DOMAIN = "@myadventuregroup.com.au";
// Plain channel labels the capture script writes into utm_source when there's no real UTM.
const PLAIN_LABELS = new Set(["organic search", "direct", "referral", "ai assistant"]);

// AC contact custom field ids we write (84-87 left blank — Calendly has no
// landing-page / referrer / first-touch data).
const F_LEAD_CHANNEL = 77, F_UTM_SOURCE = 78, F_UTM_MEDIUM = 79, F_UTM_CAMPAIGN = 80,
  F_UTM_TERM = 81, F_GCLID = 82, F_MSCLKID = 83;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
const clean = (v: unknown): string => (v == null ? "" : String(v).trim());
const low = (v: unknown): string => String(v ?? "").toLowerCase().trim();

// ---- Calendly API --------------------------------------------------------
const calHeaders = { Authorization: `Bearer ${CALENDLY_PAT}`, "Content-Type": "application/json" };
async function calGet(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { headers: calHeaders });
      if (r.status === 429) { await sleep(2000); continue; }
      if (!r.ok) { console.warn(`Calendly ${r.status} for ${url}`); return null; }
      return await r.json();
    } catch (err) { console.warn(`Calendly fetch failed for ${url}: ${err}`); await sleep(1000); }
  }
  return null;
}

interface Invitee {
  email: string; name: string; created_at: string;
  utm_source: string; utm_medium: string; utm_campaign: string; utm_term: string; utm_content: string;
  salesforce_uuid: string;
}

// Pull bookings whose invitee.created_at is within the last `days`.
async function fetchBookings(days: number, errors: string[]): Promise<Invitee[]> {
  const me = await calGet("https://api.calendly.com/users/me");
  const userUri = me?.resource?.uri;
  const org = me?.resource?.current_organization;
  if (!userUri || !org) { errors.push("Calendly /users/me returned no user/org"); return []; }

  const now = Date.now();
  const cutoffMs = now - days * 86400_000;
  const minStart = new Date(now - 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const maxStart = new Date(now + 366 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const out: Invitee[] = [];
  let url: string | null =
    `https://api.calendly.com/scheduled_events?` + new URLSearchParams({
      user: userUri, organization: org, status: "active", sort: "start_time:desc",
      count: "100", min_start_time: minStart, max_start_time: maxStart,
    }).toString();

  while (url) {
    const data: any = await calGet(url);
    if (!data) break;
    for (const ev of (data.collection ?? [])) {
      // "created in the last N days" filter, done locally per the automation spec.
      const evCreated = Date.parse(ev.created_at ?? "");
      if (Number.isFinite(evCreated) && evCreated < cutoffMs) continue;
      // Invitees for this event (paginated).
      let invUrl: string | null = `${ev.uri}/invitees?` + new URLSearchParams({ count: "100", status: "active" }).toString();
      while (invUrl) {
        const inv: any = await calGet(invUrl);
        if (!inv) break;
        for (const i of (inv.collection ?? [])) {
          const t = i.tracking ?? {};
          out.push({
            email: clean(i.email).toLowerCase(),
            name: clean(i.name),
            created_at: i.created_at ?? ev.created_at ?? "",
            utm_source: clean(t.utm_source), utm_medium: clean(t.utm_medium),
            utm_campaign: clean(t.utm_campaign), utm_term: clean(t.utm_term),
            utm_content: clean(t.utm_content), salesforce_uuid: clean(t.salesforce_uuid),
          });
        }
        invUrl = inv.pagination?.next_page ?? null;
        if (invUrl) await sleep(200);
      }
      await sleep(200);
    }
    url = data.pagination?.next_page ?? null;
  }
  // Keep only invitees created within the window (an old event can hold a recent invitee).
  return out.filter((i) => {
    const ms = Date.parse(i.created_at);
    return !Number.isFinite(ms) || ms >= cutoffMs;
  });
}

// ---- ActiveCampaign API --------------------------------------------------
const acHeaders = { "Api-Token": AC_API_TOKEN, "Content-Type": "application/json" };
async function acGet(path: string): Promise<any | null> {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/${path}`, { headers: acHeaders });
    if (!r.ok) { if (r.status === 429) { await sleep(1500); return acGet(path); } console.warn(`AC ${r.status} for ${path}`); return null; }
    return await r.json();
  } catch (err) { console.warn(`AC fetch failed for ${path}: ${err}`); return null; }
}
async function acWrite(method: "POST" | "PUT", path: string, body: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${AC_API_URL}/api/3/${path}`, { method, headers: acHeaders, body: JSON.stringify(body) });
      if (r.status === 429) { await sleep(1500); continue; }
      if (!r.ok) { console.warn(`AC ${method} ${r.status} for ${path}: ${await r.text()}`); return false; }
      return true;
    } catch (err) { console.warn(`AC ${method} failed for ${path}: ${err}`); await sleep(1000); }
  }
  return false;
}

// ---- Derivation ----------------------------------------------------------
function clickId(salesforceUuid: string, key: "gclid" | "msclkid"): string {
  const m = salesforceUuid.match(new RegExp(`${key}:([^;,\\s]+)`, "i"));
  return m ? m[1].trim() : "";
}
function deriveChannel(i: Invitee, gclid: string, msclkid: string): string {
  const src = low(i.utm_source), med = low(i.utm_medium);
  const paidMed = med === "cpc" || med === "ppc" || med === "paid";
  if (gclid || (paidMed && src.includes("google"))) return "Google Ads";
  if (msclkid || (med === "cpc" && (src.includes("bing") || src.includes("microsoft")))) return "Microsoft Ads";
  if (med === "email") return "Email";
  if (src && PLAIN_LABELS.has(src)) return i.utm_source; // keep original casing
  const anyTracking = i.utm_source || i.utm_medium || i.utm_campaign || i.utm_term || i.utm_content || i.salesforce_uuid;
  if (!anyTracking) return "Unknown (no tracking)";
  return i.utm_source || "Other";
}
// Bucket a derived channel into the report totals.
function bucket(channel: string): "google_ads" | "microsoft_ads" | "organic" | "unknown" | "other" {
  if (channel === "Google Ads") return "google_ads";
  if (channel === "Microsoft Ads") return "microsoft_ads";
  if (/^organic/i.test(channel)) return "organic";
  if (channel.startsWith("Unknown")) return "unknown";
  return "other";
}
function maskName(name: string, email: string): string {
  const n = name.trim();
  if (n) { const p = n.split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; }
  return email.split("@")[0] || "(no name)";
}

interface Summary {
  fn: string; ran_at: string; days_window: number; dry_run: boolean;
  bookings_processed: number;
  total_google_ads: number; total_microsoft_ads: number; total_organic: number;
  total_other: number; total_unknown: number;
  written: number; skipped_existing: number; no_ac_contact: number;
  flags: string[]; report: any[]; errors: string[]; message?: string;
}

async function run(days: number, dryRun: boolean): Promise<Summary> {
  const s: Summary = {
    fn: "calendly-source-sync", ran_at: new Date().toISOString(), days_window: days, dry_run: dryRun,
    bookings_processed: 0, total_google_ads: 0, total_microsoft_ads: 0, total_organic: 0,
    total_other: 0, total_unknown: 0, written: 0, skipped_existing: 0, no_ac_contact: 0,
    flags: [], report: [], errors: [],
  };
  if (!CALENDLY_PAT) s.errors.push("missing CALENDLY_PAT");
  if (!AC_API_URL || !AC_API_TOKEN) s.errors.push("missing AC credentials");

  const bookings = await fetchBookings(days, s.errors);
  const captureLiveMs = Date.parse(CAPTURE_LIVE_UTC);
  // Dedup by email, keeping the earliest booking (most representative first-touch).
  const seen = new Set<string>();

  for (const i of bookings) {
    if (!i.email) continue;
    if (i.email.endsWith(INTERNAL_DOMAIN)) continue;
    if (i.email.includes("test") || low(i.name).includes("test")) continue;
    if (seen.has(i.email)) continue;
    seen.add(i.email);
    s.bookings_processed++;

    const gclid = clickId(i.salesforce_uuid, "gclid");
    const msclkid = clickId(i.salesforce_uuid, "msclkid");
    const channel = deriveChannel(i, gclid, msclkid);
    s[`total_${bucket(channel)}` as const] = (s as any)[`total_${bucket(channel)}`] + 1 as any;

    const domain = i.email.split("@")[1] ?? "";
    const bookingDate = (i.created_at || "").slice(0, 10);
    const line: any = { name: maskName(i.name, i.email), domain, booking_date: bookingDate, channel };

    // Anomaly: booking after capture went live but no tracking at all.
    const createdMs = Date.parse(i.created_at);
    const anyTracking = i.utm_source || i.utm_medium || i.utm_campaign || i.utm_term || i.utm_content || i.salesforce_uuid;
    if (!anyTracking && Number.isFinite(createdMs) && createdMs >= captureLiveMs) {
      s.flags.push(`${line.name} (${domain}) booked ${bookingDate} with no tracking after 5 Oct — embed may have lost the capture script`);
    }

    // Find AC contact by email (with field values embedded).
    const c = await acGet(`contacts?email=${encodeURIComponent(i.email)}&include=fieldValues`);
    const contact = c?.contacts?.[0];
    if (!contact) { line.action = "no AC contact"; s.no_ac_contact++; s.report.push(line); continue; }
    const contactId = String(contact.id);

    // Existing field values for THIS contact: fieldId -> {id, value}.
    const existing = new Map<number, { id: string; value: string }>();
    for (const fv of (c.fieldValues ?? [])) {
      if (String(fv.contact) === contactId) existing.set(Number(fv.field), { id: String(fv.id), value: clean(fv.value) });
    }
    // Never overwrite: only write when field 77 is currently empty.
    if (existing.get(F_LEAD_CHANNEL)?.value) { line.action = "skipped – already had source"; s.skipped_existing++; s.report.push(line); continue; }

    const toWrite: Array<[number, string]> = [
      [F_LEAD_CHANNEL, channel],
      [F_UTM_SOURCE, i.utm_source], [F_UTM_MEDIUM, i.utm_medium], [F_UTM_CAMPAIGN, i.utm_campaign],
      [F_UTM_TERM, i.utm_term], [F_GCLID, gclid], [F_MSCLKID, msclkid],
    ].filter(([f, v]) => f === F_LEAD_CHANNEL || v); // 77 always; 78-83 only if non-empty

    if (dryRun) { line.action = `would write ${channel}`; s.written++; s.report.push(line); continue; }

    let ok = true;
    for (const [field, value] of toWrite) {
      const ex = existing.get(field);
      const done = ex
        ? await acWrite("PUT", `fieldValues/${ex.id}`, { fieldValue: { value } })
        : await acWrite("POST", "fieldValues", { fieldValue: { contact: contactId, field, value } });
      if (!done) ok = false;
      await sleep(250); // stay under AC's rate limit
    }
    line.action = ok ? `wrote ${channel}` : `wrote ${channel} (with errors)`;
    if (!ok) s.errors.push(`partial write for contact ${contactId} (${i.email})`);
    s.written++;
    s.report.push(line);
  }

  if (s.bookings_processed === 0) s.message = "No new Calendly bookings in the last 3 days";

  // Persist the run.
  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: runRow, error } = await db.from("calendly_src_sync_runs").insert({
      days_window: s.days_window, dry_run: s.dry_run, bookings_processed: s.bookings_processed,
      total_google_ads: s.total_google_ads, total_microsoft_ads: s.total_microsoft_ads,
      total_organic: s.total_organic, total_other: s.total_other, total_unknown: s.total_unknown,
      written: s.written, skipped_existing: s.skipped_existing, no_ac_contact: s.no_ac_contact,
      flags: s.flags, errors: s.errors,
    }).select("id").single();
    if (error) s.errors.push(`log insert: ${error.message}`);
    // One row per booking in the child table (so detail is queryable, no JSON array).
    else if (runRow && s.report.length) {
      const rows = s.report.map((r: any) => ({
        run_id: runRow.id, name: r.name, domain: r.domain,
        booking_date: r.booking_date || null, channel: r.channel, action: r.action,
      }));
      const { error: bErr } = await db.from("calendly_src_sync_bookings").insert(rows);
      if (bErr) s.errors.push(`bookings insert: ${bErr.message}`);
    }
  } catch (err) { s.errors.push(`log insert failed: ${err}`); }

  console.log("calendly-source-sync summary:", JSON.stringify({ ...s, report: `${s.report.length} lines` }));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const daysRaw = parseInt(params.get("days") ?? "", 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : DAYS_DEFAULT;
  const dryRun = params.get("dryrun") === "1" || params.get("dryrun") === "true";
  const summary = await run(days, dryRun);
  return json(summary, summary.errors.length ? 207 : 200);
});
