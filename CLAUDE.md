# CLAUDE.md — calendly_ac_automation

## What this is
A single Supabase edge function, `calendly-source-sync`, that copies the traffic
source of new Calendly bookings onto the matching ActiveCampaign (AC) contact's
**Src - \*** custom fields (contact field ids **77-83**). It mirrors the manual
spec in `claude_task_prompt.txt`. Runs unattended Mon-Fri 06:00 Philippine time.
This folder is its own git repo (remote `github.com/yen93/calendly_ac_automation`),
nested inside the larger `google_ads_leads_tracking` repo.

See `as_built.txt` for the current component inventory; this file is the
conventions/gotchas a future session needs.

## Core rules the function enforces (don't regress these)
- **Only write field 77 when it is currently EMPTY** — never overwrite existing
  source data. If 77 is set, the booking is "skipped - already had source".
- **Create the contact if no email match** (from the Calendly name + email), then
  write its Src fields. (Changed 2026-10-06; it used to skip unmatched bookings.)
- **Tag the contact**: `supabase_calendly_ac_automation_new_contact` (AC tag id 205)
  when it was created, `supabase_calendly_ac_automation_update` (id 206) when an
  existing contact was updated. Tags are get-or-created by name each real run
  (`ensureTag`), so the ids aren't hardcoded. Not applied to skipped contacts.
- Write **77 always** (even "Unknown (no tracking)"), **78-83 only when non-empty**,
  **84-87 never** (Calendly has no landing-page/referrer/first-touch data).
- Beyond creating the contact, writing those field values, and the one automation
  tag, touch nothing else — no lists/deals, no other fields/tags.
- **Process EVERY active booking** — no internal (`@myadventuregroup.com.au`) or
  `test`-name/email filtering (both skips were removed 2026-10-14 per the user:
  "capture all calendly bookings regardless if it looks legit or not"). The only
  skip left is a missing email (can't look up / create an AC contact without one).
- `?dryrun=1` must do everything EXCEPT the AC writes/creates/tags (still logs,
  dry_run=true); it also does NOT get-or-create the tags.

## Key IDs / endpoints
- Supabase project `aivitcomiywiysrfwqxt` (MAGTestProject),
  base `https://aivitcomiywiysrfwqxt.supabase.co`.
- Function URL: `.../functions/v1/calendly-source-sync` (verify_jwt:false).
- Cron `calendly-source-sync-daily`, pg_cron jobid 10, `0 22 * * 0-4` UTC = Mon-Fri
  06:00 PHT (same cadence as the dashboard repo's new-paid-leads-sync-daily etc.).
- Calendly REST v2 (`https://api.calendly.com`, Bearer PAT): `/users/me` ->
  user uri + current_organization, `/scheduled_events`, `{event.uri}/invitees`.
- AC REST v3 (`https://myadventuregroup.api-us1.com/api/3`, `Api-Token` header):
  `contacts?email=...&include=fieldValues` to look up; `fieldValues` POST (new) /
  `fieldValues/{id}` PUT (existing) to write.
- AC "Src - *" contact field ids: 77 lead channel · 78 utm_source · 79 utm_medium ·
  80 utm_campaign · 81 utm_term · 82 gclid · 83 msclkid · 84-87 (unused here).

## Data model (Supabase, public, RLS on / no policies, service-role writes)
- `calendly_src_sync_runs` — one SUMMARY row per run (totals, `created`, `updated`,
  `skipped_existing`, flags, errors).
- `calendly_src_sync_bookings` — one row per UNIQUE booking email (`email` has a unique
  index; the function UPSERTs on it, so re-processing an email updates its row in place).
  Columns run_id/ran_at/name/email/ac_contact_id/domain/booking_date/channel/action. The
  per-booking detail lives here, NOT as a JSON array on the runs table. Dry runs do NOT
  write booking rows (previews only); they still log a runs summary row.

## Deploy / run / test
- **Deploy a code change**: Supabase MCP `deploy_edge_function`, `verify_jwt:false`,
  passing the FULL `index.ts` content (there is no CLI inliner). A `git push` does
  NOT redeploy — the live function only changes via this MCP call.
- **Migrations / cron**: applied to the live DB via Supabase MCP (`apply_migration`
  / `execute_sql`). Don't rely on `supabase db push` — `SUPABASE_DB_URL` doesn't
  connect from this box; the `.sql` files here are the record, MCP is the applier.
- **Secrets**: `CALENDLY_PAT`, `AC_API_URL`, `AC_API_TOKEN` are Supabase function
  secrets. Set/rotate via the Supabase Management API
  (`POST /v1/projects/{ref}/secrets`, Bearer = repo-root `supabase-access-token.txt`)
  or the dashboard. `AC_API_URL`/`AC_API_TOKEN` are shared with the other MAG
  functions — don't clobber them.
- **Test safely**: `curl "<fn-url>?dryrun=1&days=7"` (quotes REQUIRED in CMD so `&`
  doesn't split the command). Verify a real write by re-running dry and checking
  `skipped_existing` rose, and by querying AC `contacts?email=...&include=fieldValues`.
  See `invoke_commands.txt`.

## Gotchas
- Calendly `/scheduled_events` needs `user` or `organization`; the function passes
  both and a wide `min/max_start_time` window, then filters to the last N days by
  **event created_at locally** (bookings are created near-term but can be for future
  events, so you can't just window on start_time).
- gclid/msclkid are carried inside `tracking.salesforce_uuid` as `gclid:XXXX` /
  `msclkid:XXXX` (not separate fields) — parsed by regex.
- "Unknown (no tracking)" IS written to field 77 per spec, which permanently fills it.
  Bookings before 5 Oct 2026 legitimately have no tracking (the capture script went
  live then). If the user ever wants 77 left open for a later real capture, gate the
  write on real tracking existing — it's a one-line change.
- Credentials (`ac_creds.txt`, repo-root `calendly_personal_access_token.txt`,
  repo-root `supabase-access-token.txt`) are gitignored — keep it that way; the push
  history is clean.
- **Function secrets are write-only and their listed digest is SALTED** — you can
  `GET /v1/projects/{ref}/secrets` but each value comes back as a digest you CANNOT
  reproduce by hashing the plaintext (verified against a known `AC_API_URL` value).
  So you can't confirm a secret equals a local file by hashing. To be sure a secret
  matches a token, just re-set it (idempotent), or compare behaviour/scopes instead.
- **`CALENDLY_PAT` must carry `users:read` + `scheduled_events:read`** (plus invitee
  read). A narrower Calendly token (e.g. a `webhooks:*`/`organizations:read`-only one)
  will 403 the sync. Decode a PAT's JWT payload to check its `scope`/`iat`/`jti`
  before deploying it. Generating a new Calendly token does NOT revoke existing ones —
  the old one keeps working until explicitly revoked. (A stray limited-scope token,
  `121026_calendly_personal_access_token.txt`, is sitting in this folder — NOT the
  function's PAT; see `as_built.txt`.)

## Working rules from the user
- The user commits & pushes THIS repo themselves — do not run git commit/push here.
  (Deploying the function / applying SQL via the Supabase MCP is fine.)
