-- Schedule calendly-source-sync Mon-Fri 06:00 Philippine time.
-- '0 22 * * 0-4' = 22:00 UTC Sun-Thu = 06:00 PHT (UTC+8) Mon-Fri.
-- No Authorization header: the function is deployed verify_jwt:false. Requires pg_cron + pg_net.
select cron.schedule(
  'calendly-source-sync-daily',
  '0 22 * * 0-4',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/calendly-source-sync',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
  $$
);
