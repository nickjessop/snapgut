-- SnapGut — Supabase schema for the prod backend (USERS_BACKEND=supabase).
-- Run this in the Supabase SQL editor. The server connects with the SERVICE ROLE
-- key (bypasses RLS); RLS is enabled with no policies so the anon/public key can't
-- read or write these tables. Never expose the service role key to the client.

-- ---- users / entitlement ----
create table if not exists public.users (
  email         text primary key,
  pro           boolean not null default false,
  pro_until     bigint,                       -- epoch ms; null = lifetime / none
  free_ai_used  integer not null default 0,
  stripe_customer_id text,                     -- Stripe customer id (for billing portal)
  created_at    bigint  not null
);
-- If upgrading an existing deployment:
--   alter table public.users add column if not exists stripe_customer_id text;

-- ---- passwordless verification codes (one active per email) ----
create table if not exists public.auth_codes (
  email       text primary key,
  hash        text    not null,               -- HMAC of the 6-digit code
  expires_at  bigint  not null,               -- epoch ms
  attempts    integer not null default 0
);

-- ---- shared fixed-window rate limits ----
create table if not exists public.rate_limits (
  key           text   not null,
  window_start  bigint not null,              -- epoch seconds, floored to window
  count         integer not null default 0,
  primary key (key, window_start)
);

-- Atomically increment the current window's counter; returns true if <= max.
create or replace function public.rate_limit_hit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
as $$
declare
  v_bucket bigint := floor(extract(epoch from now()) / p_window_seconds)::bigint * p_window_seconds;
  v_count  int;
begin
  insert into public.rate_limits(key, window_start, count)
  values (p_key, v_bucket, 1)
  on conflict (key, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;

  -- opportunistic cleanup of this key's older windows
  delete from public.rate_limits where key = p_key and window_start < v_bucket;

  return v_count <= p_max;
end;
$$;

-- Atomically bump a user's free-AI counter; returns the new value.
create or replace function public.inc_free_ai(p_email text)
returns integer
language plpgsql
as $$
declare
  v int;
begin
  update public.users set free_ai_used = free_ai_used + 1
   where email = p_email
   returning free_ai_used into v;
  return coalesce(v, 0);
end;
$$;

-- ---- lock down: RLS on, no policies → only the service role can touch these ----
alter table public.users       enable row level security;
alter table public.auth_codes  enable row level security;
alter table public.rate_limits enable row level security;

-- Optional housekeeping (run occasionally or via pg_cron):
--   delete from public.auth_codes  where expires_at < (extract(epoch from now())*1000);
--   delete from public.rate_limits where window_start < (extract(epoch from now()) - 3600);
