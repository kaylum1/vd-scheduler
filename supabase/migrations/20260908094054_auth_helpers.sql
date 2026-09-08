-- 13_auth_helpers
--
-- App user / role security foundation. Everything downstream (RLS
-- policies, hardened RPCs, driver-safe views) reads its authorization
-- decision from here -- never from client-supplied role/driver_id/resort_id
-- parameters.

-- V1 needs an explicit "is this login active" flag independent of whether
-- the underlying driver record is active (a manager can deactivate a
-- login without touching the driver row, and vice versa). Additive ALTER
-- rather than editing the already-applied/pushed migration 04.
alter table app_users add column is_active boolean not null default true;

comment on column app_users.is_active is
  'Whether this login is currently allowed to authenticate/act, independent of drivers.is_active.';

-- ---------------------------------------------------------------------
-- current_app_user(): the single source of truth for "who is calling".
-- ---------------------------------------------------------------------
-- SECURITY DEFINER + owned by postgres (which has BYPASSRLS) is
-- deliberate: it lets this function read app_users/drivers without going
-- through app_users' own RLS policies, which is what avoids the classic
-- "RLS policy on app_users needs to query app_users to know the caller's
-- role" recursion problem. RLS policies elsewhere call this function
-- (under the querying role's own EXECUTE privilege) to get a trustworthy
-- answer without ever reading a client-supplied role/driver_id/resort_id.
create type app_user_context as (
  auth_user_id uuid,
  role text,
  driver_id uuid,
  resort_id uuid,
  is_active boolean
);

comment on type app_user_context is
  'Server-resolved identity for the current request: never derived from client input. resort_id is the driver''s actual resort for role=driver, or the manager''s (currently unused in V1 -- all resorts) scope for role=manager. is_active folds in both app_users.is_active and, for drivers, drivers.is_active.';

create or replace function current_app_user()
returns app_user_context
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    u.id,
    u.role,
    u.driver_id,
    coalesce(d.resort_id, u.resort_id),
    u.is_active and (u.role <> 'driver' or d.is_active)
  from app_users u
  left join drivers d on d.id = u.driver_id
  where u.id = auth.uid();
$$;

comment on function current_app_user() is
  'Resolves the calling auth.uid() to its app role/driver/resort/active-state. Returns NULL for an unauthenticated caller or one with no app_users row. SECURITY DEFINER to avoid recursive RLS on app_users/drivers.';

create or replace function is_active_manager()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select role = 'manager' and is_active from current_app_user()), false);
$$;

create or replace function is_active_driver()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select role = 'driver' and is_active from current_app_user()), false);
$$;

create or replace function current_driver_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select driver_id from current_app_user() where role = 'driver' and is_active;
$$;

create or replace function current_driver_resort_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select resort_id from current_app_user() where role = 'driver' and is_active;
$$;

comment on function is_active_manager() is 'True iff the caller is an active manager. Used throughout RLS policies.';
comment on function is_active_driver() is 'True iff the caller is an active driver. Used throughout RLS policies.';
comment on function current_driver_id() is 'The calling active driver''s own driver_id, or NULL if the caller is not an active driver.';
comment on function current_driver_resort_id() is 'The calling active driver''s own resort_id, or NULL if the caller is not an active driver.';

-- RLS policies (added in migration 16) call these functions under the
-- *querying* role's own privileges, so `authenticated` needs EXECUTE even
-- though the functions' bodies run as their SECURITY DEFINER owner.
-- anon gets none -- anon has no table grants that would ever reach a
-- policy calling these, and is never meant to identify as an app user.
revoke execute on function current_app_user() from public;
revoke execute on function is_active_manager() from public;
revoke execute on function is_active_driver() from public;
revoke execute on function current_driver_id() from public;
revoke execute on function current_driver_resort_id() from public;

grant execute on function current_app_user() to authenticated;
grant execute on function is_active_manager() to authenticated;
grant execute on function is_active_driver() to authenticated;
grant execute on function current_driver_id() to authenticated;
grant execute on function current_driver_resort_id() to authenticated;

-- ---------------------------------------------------------------------
-- Defense-in-depth: a driver (or anyone who isn't an active manager) must
-- never be able to change their own role or driver_id, regardless of
-- which RLS policy is in force. Migration 16 additionally gives drivers
-- no UPDATE policy on app_users at all, so this trigger is a second,
-- independent layer rather than the only protection.
-- ---------------------------------------------------------------------
create or replace function app_users_prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller app_user_context;
begin
  v_caller := current_app_user();
  if v_caller is not null and v_caller.role = 'manager' and v_caller.is_active then
    return new; -- active managers may change role/driver_id
  end if;

  if new.role is distinct from old.role or new.driver_id is distinct from old.driver_id then
    raise exception 'only an active manager may change app_users.role or app_users.driver_id' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger app_users_prevent_self_privilege_escalation_trg
  before update on app_users
  for each row
  execute function app_users_prevent_self_privilege_escalation();
