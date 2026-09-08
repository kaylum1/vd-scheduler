-- 16_row_level_security
--
-- Enables RLS (+ FORCE) on every application table and replaces the
-- wide-open default grants (Supabase grants anon/authenticated full
-- arwdDxtm on every public table by default -- confirmed on this project)
-- with the minimum command-level grant each table needs, then uses RLS
-- policies to filter rows within that. The anon/publishable key is not a
-- security boundary here; RLS is.
--
-- Note on FORCE ROW LEVEL SECURITY: it only changes behaviour for a
-- table's *owner* (here, postgres) when that owner lacks BYPASSRLS --
-- postgres has BYPASSRLS in this Supabase setup regardless, so FORCE is
-- currently a no-op in practice. It's applied anyway as defense-in-depth
-- and to keep the security posture correct if ownership/role attributes
-- ever change.

-- ---------------------------------------------------------------------
-- Shared helper for the availability "unpublished" write window.
-- ---------------------------------------------------------------------
create or replace function shift_instance_week_is_published(p_shift_instance_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from shift_instances si
    join rota_publications rp
      on rp.resort_id = si.resort_id
     and rp.week_start = si.week_start
     and rp.published_at is not null
     and rp.unpublished_at is null
    where si.id = p_shift_instance_id
  );
$$;

comment on function shift_instance_week_is_published(uuid) is
  'True iff the resort/week that this shift_instance belongs to is currently published. Used to gate driver availability writes.';

revoke execute on function shift_instance_week_is_published(uuid) from public;
grant execute on function shift_instance_week_is_published(uuid) to authenticated;

-- =======================================================================
-- RESORTS
-- =======================================================================
alter table resorts enable row level security;
alter table resorts force row level security;
revoke all on resorts from anon, authenticated;
grant select, update on resorts to authenticated;

create policy resorts_manager_select on resorts for select to authenticated
  using (is_active_manager());
create policy resorts_manager_update on resorts for update to authenticated
  using (is_active_manager()) with check (is_active_manager());
create policy resorts_driver_select_active on resorts for select to authenticated
  using (is_active_driver() and is_active);

-- =======================================================================
-- APP_USERS
-- =======================================================================
alter table app_users enable row level security;
alter table app_users force row level security;
revoke all on app_users from anon, authenticated;
grant select, update on app_users to authenticated;

create policy app_users_manager_select on app_users for select to authenticated
  using (is_active_manager());
create policy app_users_manager_update on app_users for update to authenticated
  using (is_active_manager()) with check (is_active_manager());
-- Drivers get SELECT of their own row only, and NO update policy at all --
-- there is currently no app_users column a driver is meant to self-edit
-- (role/driver_id/resort_id/is_active are all manager-controlled).
-- app_users_prevent_self_privilege_escalation() (migration 13) is a
-- second, independent layer against role/driver_id changes regardless.
create policy app_users_driver_select_own on app_users for select to authenticated
  using (id = auth.uid());

-- =======================================================================
-- DRIVERS
-- =======================================================================
alter table drivers enable row level security;
alter table drivers force row level security;
revoke all on drivers from anon, authenticated;
grant select, insert, update on drivers to authenticated; -- no delete: historical-safe deactivation only

create policy drivers_manager_all on drivers for all to authenticated
  using (is_active_manager()) with check (is_active_manager());
create policy drivers_driver_select_own on drivers for select to authenticated
  using (id = current_driver_id());

-- =======================================================================
-- DRIVER_ONFLEET_MAPPINGS -- manager only, no driver access at all
-- =======================================================================
alter table driver_onfleet_mappings enable row level security;
alter table driver_onfleet_mappings force row level security;
revoke all on driver_onfleet_mappings from anon, authenticated;
grant select, insert, update on driver_onfleet_mappings to authenticated;

create policy driver_onfleet_mappings_manager_all on driver_onfleet_mappings for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- =======================================================================
-- SHIFT_TYPES / SHIFT_TEMPLATES -- manager-only config, no driver SELECT
-- =======================================================================
alter table shift_types enable row level security;
alter table shift_types force row level security;
revoke all on shift_types from anon, authenticated;
grant select, insert, update on shift_types to authenticated;

create policy shift_types_manager_all on shift_types for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

alter table shift_templates enable row level security;
alter table shift_templates force row level security;
revoke all on shift_templates from anon, authenticated;
grant select, insert, update on shift_templates to authenticated;

create policy shift_templates_manager_all on shift_templates for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- =======================================================================
-- SHIFT_INSTANCES -- manager CRUD/override; drivers use the safe view
-- (migration 17) instead, never this base table.
-- =======================================================================
alter table shift_instances enable row level security;
alter table shift_instances force row level security;
revoke all on shift_instances from anon, authenticated;
grant select, insert, update on shift_instances to authenticated; -- no delete: cancellation model, not deletion

create policy shift_instances_manager_all on shift_instances for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- =======================================================================
-- AVAILABILITY
-- =======================================================================
alter table availability enable row level security;
alter table availability force row level security;
revoke all on availability from anon, authenticated;
grant select, insert, update, delete on availability to authenticated;

create policy availability_manager_all on availability for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- Read own answers at any time (including after publication -- "My Rota"
-- supersedes availability once published, but nothing requires hiding a
-- driver's own past answers from them).
create policy availability_driver_select_own on availability for select to authenticated
  using (driver_id = current_driver_id());

-- Write own answers only while that shift's resort/week is unpublished.
-- A published week rejects driver writes even via direct API calls.
create policy availability_driver_insert_own_unpublished on availability for insert to authenticated
  with check (
    driver_id = current_driver_id()
    and not shift_instance_week_is_published(shift_instance_id)
  );
create policy availability_driver_update_own_unpublished on availability for update to authenticated
  using (
    driver_id = current_driver_id()
    and not shift_instance_week_is_published(shift_instance_id)
  )
  with check (
    driver_id = current_driver_id()
    and not shift_instance_week_is_published(shift_instance_id)
  );
create policy availability_driver_delete_own_unpublished on availability for delete to authenticated
  using (
    driver_id = current_driver_id()
    and not shift_instance_week_is_published(shift_instance_id)
  );

-- =======================================================================
-- AVAILABILITY_SUBMISSIONS -- read-only for every client role. All
-- mutation goes through confirm_availability_week/reopen_availability_week
-- (SECURITY DEFINER, migration 14), which bypass these grants entirely by
-- running as their owner. This is what stops a driver from bypassing
-- Confirm Week completeness by writing the row directly.
-- =======================================================================
alter table availability_submissions enable row level security;
alter table availability_submissions force row level security;
revoke all on availability_submissions from anon, authenticated;
grant select on availability_submissions to authenticated;

create policy availability_submissions_manager_select on availability_submissions for select to authenticated
  using (is_active_manager());
create policy availability_submissions_driver_select_own on availability_submissions for select to authenticated
  using (driver_id = current_driver_id());

-- =======================================================================
-- ROTA_PUBLICATIONS
-- =======================================================================
alter table rota_publications enable row level security;
alter table rota_publications force row level security;
revoke all on rota_publications from anon, authenticated;
grant select, insert, update on rota_publications to authenticated;

create policy rota_publications_manager_all on rota_publications for all to authenticated
  using (is_active_manager()) with check (is_active_manager());
create policy rota_publications_driver_select_own_resort on rota_publications for select to authenticated
  using (resort_id = current_driver_resort_id());

-- =======================================================================
-- ROTA_ASSIGNMENTS -- manager only on the base table; drivers use the
-- safe view (migration 17), which also hides co-assigned colleagues.
-- =======================================================================
alter table rota_assignments enable row level security;
alter table rota_assignments force row level security;
revoke all on rota_assignments from anon, authenticated;
grant select, insert, update, delete on rota_assignments to authenticated;

create policy rota_assignments_manager_all on rota_assignments for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- =======================================================================
-- ATTENDANCE -- manager only in V1, no driver access at all.
-- =======================================================================
alter table attendance enable row level security;
alter table attendance force row level security;
revoke all on attendance from anon, authenticated;
grant select, insert, update, delete on attendance to authenticated;

create policy attendance_manager_all on attendance for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- =======================================================================
-- PAYROLL_ADJUSTMENTS -- manager only, no driver access at all.
-- =======================================================================
alter table payroll_adjustments enable row level security;
alter table payroll_adjustments force row level security;
revoke all on payroll_adjustments from anon, authenticated;
grant select, insert, update on payroll_adjustments to authenticated; -- no delete: voiding model, not deletion

create policy payroll_adjustments_manager_all on payroll_adjustments for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- =======================================================================
-- AUDIT_LOG -- manager read-only; no client role has any write access
-- (see migration 15; the trigger writes as its own SECURITY DEFINER
-- owner, independent of these grants).
-- =======================================================================
alter table audit_log enable row level security;
alter table audit_log force row level security;

create policy audit_log_manager_select on audit_log for select to authenticated
  using (is_active_manager());
