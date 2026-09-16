-- 27_correct_payroll_rate_ownership
--
-- Stage 2D Payroll Checkpoint A: corrects the payroll-rate ownership model
-- established (provisionally) in Checkpoint 3, following an architecture
-- review. The authoritative business rule, confirmed:
--
--   PER DRIVER + WORKED SHIFT:
--     final shift pay = MAX(shift base guarantee, total delivery earnings)
--   (not additive; only `worked` attendance earns the base guarantee.)
--
-- Two corrections to ownership:
--
--   1. Shift base pay stays owned by the Shift (shift_type_id), which
--      Checkpoint 3's `payroll_rules` already got right -- renamed here to
--      `shift_base_pay_rules` now that it owns exactly one rate, while no
--      Payroll Rules UI, repository writer, or real payroll engine exists
--      yet to migrate off the old name (confirmed by inspection).
--
--   2. Delivery rate belongs to the DRIVER, not the Shift -- `payroll_rules.
--      delivery_rate_chf` was wrong ownership from the start. Removed here;
--      a new effective-dated `driver_delivery_rates` table takes its place.
--
-- A further, more fundamental simplification: `shift_instances` stops
-- snapshotting ANY financial rate at all (not just delivery rate). A shift
-- may be materialised weeks before its base-pay rule is configured or
-- corrected, before attendance exists, or before payroll is calculated --
-- keeping a pay snapshot on shift_instances creates stale/NULL financial
-- state on what should be a purely operational schedule/rota record, and
-- would eventually need its own payroll-refresh mechanism (mirroring the
-- template-refresh workflow) purely to keep it current. Instead, both rates
-- are resolved once, at actual payroll-calculation time, against the
-- driver+shift's real date -- inside the future `driver_shift_payroll`
-- financial snapshot (Payroll Checkpoint E), not here. `shift_instances`
-- keeps only schedule + staffing + high-value/fairness: purely operational.
--
-- materialise_shift_instances therefore loses ALL payroll-rate
-- responsibility: no join to the rate table(s), no base_pay_chf/
-- delivery_rate_chf resolution or insert, and no missing_payroll_rule_count
-- in its result -- that coupling between shift generation and payroll
-- configuration is removed outright, not weakened. Missing-rate visibility
-- becomes Payroll's own concern once it exists (Checkpoint B/E), not Shift
-- Setup's. missing_rota_rule_count is retained: staffing remains a
-- genuine materialisation/operational concern.
--
-- This is a one-step, no-deprecation-period change: inspection confirmed
-- there is no live consumer anywhere (no RPC, view, repository, or UI) of
-- shift_instances.base_pay_chf/delivery_rate_chf or payroll_rules.
-- delivery_rate_chf, so there is nothing to migrate away from first, and
-- this is pre-launch/local-development data throughout.
--
-- Not touched by this migration (out of scope for Checkpoint A):
--   - shift_templates.{base_pay_chf,delivery_rate_chf,required_drivers,
--     is_premium}: already fully deprecated/inert since Checkpoint 3
--     (nullable, never read by materialisation, no new schedule UI reads or
--     writes them). Left exactly as-is -- no correctness reason to touch
--     them in this checkpoint, and doing so would be an unrelated cleanup.
--   - attendance, rota_assignments, payroll_adjustments, driver_onfleet_
--     mappings: unaffected by this rate-ownership correction.
--   - driver_shift_payroll: the future financial-snapshot/finalisation
--     table. Deliberately NOT created here -- Checkpoint A is rate
--     *configuration* only.

-- =======================================================================
-- 1. RENAME payroll_rules -> shift_base_pay_rules, and its dependent
--    objects, so no `payroll_rules_*` name is left behind implying it still
--    owns delivery rate.
-- =======================================================================
alter table payroll_rules rename to shift_base_pay_rules;

alter table shift_base_pay_rules
  rename constraint payroll_rules_pkey to shift_base_pay_rules_pkey;
alter table shift_base_pay_rules
  rename constraint payroll_rules_base_pay_chf_check to shift_base_pay_rules_base_pay_chf_check;
alter table shift_base_pay_rules
  rename constraint payroll_rules_effective_range_check to shift_base_pay_rules_effective_range_check;
alter table shift_base_pay_rules
  rename constraint payroll_rules_shift_type_resort_fk to shift_base_pay_rules_shift_type_resort_fk;
alter table shift_base_pay_rules
  rename constraint payroll_rules_no_overlap to shift_base_pay_rules_no_overlap;

alter index payroll_rules_shift_type_id_idx rename to shift_base_pay_rules_shift_type_id_idx;
alter index payroll_rules_resort_id_idx rename to shift_base_pay_rules_resort_id_idx;

alter trigger payroll_rules_set_updated_at on shift_base_pay_rules rename to shift_base_pay_rules_set_updated_at;
alter trigger payroll_rules_audit_trg on shift_base_pay_rules rename to shift_base_pay_rules_audit_trg;

alter policy payroll_rules_manager_all on shift_base_pay_rules rename to shift_base_pay_rules_manager_all;

-- =======================================================================
-- 2. REMOVE delivery_rate_chf from shift_base_pay_rules -- delivery rate is
--    a driver property (see driver_delivery_rates below), never a Shift
--    property. No live reader/writer exists for this column (confirmed by
--    inspection), so a direct drop needs no deprecation period.
-- =======================================================================
alter table shift_base_pay_rules drop column delivery_rate_chf;

comment on table shift_base_pay_rules is
  'Effective-dated Shift base-pay guarantee (Configuration -> Payroll Rules, UI deferred -- Stage 2D Payroll Checkpoint B). Resolved at payroll-calculation time against the driver+shift''s actual date (Payroll Checkpoint E) -- never snapshotted onto shift_instances (Payroll Checkpoint A), since a shift may be scheduled long before its rate is configured or corrected. A shift type with no applicable row here simply has no configured base pay yet; that gap is Payroll''s concern to surface, not shift generation''s.';

-- =======================================================================
-- 3. DRIVER_DELIVERY_RATES -- effective-dated pay-per-completed-delivery,
--    owned by the driver, independent of any Shift. Structurally a mirror
--    of shift_base_pay_rules (same effective-dating/no-overlap/RLS/audit
--    idiom), keyed on driver_id instead of shift_type_id. No permanent
--    global default rate exists in schema -- CHF 12 today is an
--    operational configuration value, never a hardcoded system default.
-- =======================================================================
create table driver_delivery_rates (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null,
  resort_id uuid not null,
  rate_chf numeric(10, 2) not null check (rate_chf >= 0),
  effective_from date not null,
  -- null = open-ended (still the current version).
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint driver_delivery_rates_effective_range_check
    check (effective_to is null or effective_to >= effective_from),

  -- Ensures the rate's resort always matches the resort of the driver it
  -- points to (relies on drivers_id_resort_unique, migration 03).
  constraint driver_delivery_rates_driver_resort_fk
    foreign key (driver_id, resort_id) references drivers (id, resort_id),

  -- No two active delivery-rate rows for the same driver may have
  -- overlapping effective-date ranges. Same GIST-exclusion idiom as
  -- shift_base_pay_rules/shift_templates/rota_rules_default.
  constraint driver_delivery_rates_no_overlap
    exclude using gist (
      driver_id with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    ) where (is_active)
);

comment on table driver_delivery_rates is
  'Effective-dated per-driver delivery rate (Configuration -> Payroll Rules, UI deferred -- Stage 2D Payroll Checkpoint B). Resolved at payroll-calculation time against the driver+shift''s actual date (Payroll Checkpoint E) -- never resolved at materialisation time and never snapshotted onto shift_instances, since a driver may not even be assigned to a shift yet when it is materialised, and multiple drivers working one shift each have their own independent rate. No permanent global default rate exists in schema; a driver with no applicable row here simply has no configured delivery rate yet.';

create index driver_delivery_rates_driver_id_idx on driver_delivery_rates (driver_id);
create index driver_delivery_rates_resort_id_idx on driver_delivery_rates (resort_id);

create trigger driver_delivery_rates_set_updated_at
  before update on driver_delivery_rates
  for each row
  execute function set_updated_at();

-- RLS: manager-only configuration, zero driver access (same pattern as
-- shift_base_pay_rules/driver_onfleet_mappings/shift_types -- no
-- driver-facing policy at all, so a driver session gets zero rows
-- regardless of query; a driver's own delivery rate is never something the
-- driver can read or write themselves).
alter table driver_delivery_rates enable row level security;
alter table driver_delivery_rates force row level security;
revoke all on driver_delivery_rates from anon, authenticated;
grant select, insert, update on driver_delivery_rates to authenticated;

create policy driver_delivery_rates_manager_all on driver_delivery_rates for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- Audit: same generic audit_log_row_change() trigger used everywhere else.
create trigger driver_delivery_rates_audit_trg
  after insert or update or delete on driver_delivery_rates
  for each row execute function audit_log_row_change();

-- =======================================================================
-- 4. REMOVE pay snapshots from shift_instances entirely -- it becomes a
--    purely operational schedule/staffing/high-value record. One-step drop
--    (no deprecation period): confirmed no RPC, view, repository, or UI
--    anywhere reads either column today.
-- =======================================================================
alter table shift_instances
  drop column base_pay_chf,
  drop column delivery_rate_chf;

-- =======================================================================
-- 5. MATERIALISE_SHIFT_INSTANCES -- schedule from shift_templates,
--    staffing/high-value from rota_rules_date > rota_rules_weekday >
--    rota_rules_default. ZERO payroll-rate responsibility: no join to
--    shift_base_pay_rules or driver_delivery_rates, no pay resolution, no
--    missing_payroll_rule_count. missing_rota_rule_count is retained --
--    staffing remains a genuine materialisation/operational concern.
-- =======================================================================
-- The RETURNS TABLE shape is shrinking (missing_payroll_rule_count
-- removed), which CREATE OR REPLACE cannot do in place -- drop first.
drop function if exists materialise_shift_instances(uuid, date, date);

create function materialise_shift_instances(
  p_resort_id uuid,
  p_from_date date default null,
  p_to_date date default null
)
returns table (
  created_count integer,
  skipped_existing_count integer,
  from_date date,
  to_date date,
  missing_rota_rule_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_from_date date;
  v_to_date date;
  v_created integer;
  v_total_governing integer;
  v_missing_rota integer;
begin
  perform assert_active_manager();
  v_from_date := coalesce(p_from_date, operational_today(p_resort_id));
  v_to_date := coalesce(p_to_date, end_of_following_month(v_from_date));
  if v_from_date > v_to_date then
    raise exception 'from_date (%) must not be after the computed to_date (%)', v_from_date, v_to_date;
  end if;

  with candidate_dates as (
    select generate_series(v_from_date, v_to_date, interval '1 day')::date as date
  ),
  governing as (
    select
      cd.date,
      st.id as shift_type_id,
      st.key,
      st.name,
      st.sort_order,
      t.id as template_id,
      t.start_time,
      t.end_time,
      coalesce(rd.required_drivers, rw.required_drivers, rdef.required_drivers) as resolved_required_drivers,
      coalesce(rd.is_premium, rw.is_premium, rdef.is_premium) as resolved_is_premium
    from candidate_dates cd
    join shift_types st
      on st.resort_id = p_resort_id
     and st.is_active
    join shift_templates t
      on t.shift_type_id = st.id
     and t.resort_id = p_resort_id
     and t.is_active
     and t.weekday = app_weekday(cd.date)
     and t.effective_from <= cd.date
     and (t.effective_to is null or t.effective_to >= cd.date)
    left join rota_rules_date rd
      on rd.shift_type_id = st.id
     and rd.resort_id = p_resort_id
     and rd.is_active
     and rd.specific_date = cd.date
    left join rota_rules_weekday rw
      on rw.shift_type_id = st.id
     and rw.resort_id = p_resort_id
     and rw.is_active
     and rw.weekday = app_weekday(cd.date)
     and rw.effective_from <= cd.date
     and (rw.effective_to is null or rw.effective_to >= cd.date)
    left join rota_rules_default rdef
      on rdef.shift_type_id = st.id
     and rdef.resort_id = p_resort_id
     and rdef.is_active
     and rdef.effective_from <= cd.date
     and (rdef.effective_to is null or rdef.effective_to >= cd.date)
  ),
  inserted as (
    insert into shift_instances
      (resort_id, date, shift_type_id, template_id, shift_key, name, sort_order,
       start_time, end_time, required_drivers, is_premium,
       status, origin)
    select
      p_resort_id, g.date, g.shift_type_id, g.template_id, g.key, g.name, g.sort_order,
      g.start_time, g.end_time, g.resolved_required_drivers, g.resolved_is_premium,
      'active', 'template'
    from governing g
    -- Belt-and-suspenders alongside ON CONFLICT: never even attempt a row
    -- that already exists for this identity.
    where not exists (
      select 1 from shift_instances si
      where si.resort_id = p_resort_id
        and si.shift_type_id = g.shift_type_id
        and si.date = g.date
    )
    on conflict (resort_id, shift_type_id, date) do nothing
    returning 1
  )
  select
    (select count(*) from inserted),
    (select count(*) from governing),
    (select count(*) from governing where resolved_required_drivers is null)
  into v_created, v_total_governing, v_missing_rota;

  return query select v_created, (v_total_governing - v_created), v_from_date, v_to_date, v_missing_rota;
end;
$$;

comment on function materialise_shift_instances(uuid, date, date) is
  'Manager-only, insert-only. Schedule (start/end time) comes from active shift_templates; staffing/high-value comes from rota_rules_date > rota_rules_weekday > rota_rules_default. Pay is never resolved here (Stage 2D Payroll Checkpoint A): shift_base_pay_rules/driver_delivery_rates are resolved later, at actual payroll-calculation time, against the driver+shift''s real date -- shift_instances is a purely operational schedule/staffing/high-value record. A missing rota rule never blocks materialisation -- required_drivers/is_premium are left NULL and counted in missing_rota_rule_count, never guessed. Never modifies an existing instance of any origin/status.';

revoke execute on function materialise_shift_instances(uuid, date, date) from public;
grant execute on function materialise_shift_instances(uuid, date, date) to authenticated;
