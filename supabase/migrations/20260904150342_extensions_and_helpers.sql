-- 01_extensions_and_helpers
-- Extensions and shared helper functions used across the Stage 2A schema.

-- pgcrypto provides gen_random_uuid() (also digest()/crypt() for later use).
-- Supabase's base image already installs this in the `extensions` schema,
-- but declare it explicitly so this migration set is portable/self-contained.
create extension if not exists pgcrypto with schema extensions;

-- btree_gist is required for the EXCLUDE USING gist constraint that prevents
-- overlapping effective-dated shift_templates (migration 05).
create extension if not exists btree_gist with schema extensions;

-- app_weekday: project-wide weekday convention, Monday = 0 .. Sunday = 6.
-- Postgres's ISODOW returns Monday = 1 .. Sunday = 7; shift down by one.
create or replace function app_weekday(d date)
returns smallint
language sql
immutable
parallel safe
as $$
  select (extract(isodow from d)::smallint - 1);
$$;

comment on function app_weekday(date) is
  'Weekday number for d using the Monday=0..Sunday=6 convention used throughout this schema.';

-- set_updated_at: generic BEFORE UPDATE trigger to keep an updated_at column current.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'Generic BEFORE UPDATE trigger function: sets updated_at = now() on every row update.';
