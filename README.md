# calendly-source-sync

Daily Calendly booking source → ActiveCampaign. Copies the traffic source (UTMs + Google/
Bing click id) of new Calendly bookings onto the matching AC contact's **Src – \*** fields
(contact field ids **77–83**), only when field 77 is empty (never overwrites). Mirrors the
manual automation in `claude_task_prompt.txt`.

## Pieces
- **Edge function** `supabase/functions/calendly-source-sync/index.ts` (Supabase project
  `aivitcomiywiysrfwqxt`, deployed `verify_jwt:false`). Reads Calendly (`/users/me`,
  `/scheduled_events`, `{event}/invitees`), derives lead channel + gclid/msclkid from the
  invitee `tracking` object, finds the AC contact by email and writes fields 77–83 via
  `fieldValues` (POST new / PUT existing). Never creates contacts; read-only on everything
  in AC except those field values.
- **Log table** `public.calendly_src_sync_runs` — one row per run (totals, per-booking
  actions, anomaly flags, errors). Migration `supabase/migrations/20261006020000_*.sql`.
- **Cron** `calendly-source-sync-daily` — `0 22 * * 0-4` UTC = Mon–Fri 06:00 PHT.
  Migration `supabase/migrations/20261006020100_*.sql`.

## Secrets (Supabase function secrets)
`CALENDLY_PAT` (Calendly personal access token), `AC_API_URL`, `AC_API_TOKEN`
(shared with new-paid-leads-sync), plus the auto-injected `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY`.

## Manual invoke
- Dry run (no AC writes): `GET .../functions/v1/calendly-source-sync?dryrun=1&days=7`
- Real run: `GET .../functions/v1/calendly-source-sync?days=7`  (bare = real, days=3)

## Deploy / redeploy
Deploy via the Supabase MCP `deploy_edge_function` with `verify_jwt:false`, passing the
full `index.ts` content (there is no CLI inliner). Apply migrations via MCP
`apply_migration` / schedule cron via `execute_sql`.

## Channel ladder (from the spec)
`Google Ads` (gclid, or cpc/ppc/paid + google) · `Microsoft Ads` (msclkid, or cpc +
bing/microsoft) · `Email` (utm_medium=email) · a plain label (Organic search / Direct /
Referral / AI assistant) · else the utm_source · else `Unknown (no tracking)`.
Fields 84–87 (landing page, referrer, first-touch) are left blank — Calendly has no such data.
