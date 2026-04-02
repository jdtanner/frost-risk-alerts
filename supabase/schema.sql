-- Frost Alerts: Supabase schema
-- Run this in the Supabase SQL editor for your project.

-- 1. Subscribers table
CREATE TABLE IF NOT EXISTS subscribers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  location_name    text NOT NULL,
  lat              numeric(9,6) NOT NULL,
  lon              numeric(9,6) NOT NULL,
  threshold        text NOT NULL DEFAULT 'high'
                   CHECK (threshold IN ('high', 'medium', 'low')),
  token            text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  last_alerted_date date,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT unique_email_location UNIQUE (email, lat, lon)
);

-- 2. Row Level Security
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to insert (subscribe) but never read or update directly
CREATE POLICY "anon_insert" ON subscribers
  FOR INSERT TO anon
  WITH CHECK (true);

-- 3. Unsubscribe function — called from the unsubscribe page via RPC
--    SECURITY DEFINER so it can delete rows despite RLS denying SELECT/DELETE to anon
CREATE OR REPLACE FUNCTION unsubscribe(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM subscribers WHERE token = p_token;
END;
$$;

-- 4. Index for the nightly job (looks up by lat/lon) and for unsubscribe (by token)
CREATE INDEX IF NOT EXISTS idx_subscribers_location ON subscribers (lat, lon);
CREATE INDEX IF NOT EXISTS idx_subscribers_token    ON subscribers (token);
