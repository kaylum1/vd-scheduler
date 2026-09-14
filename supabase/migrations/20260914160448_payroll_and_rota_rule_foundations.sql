-- 24_payroll_and_rota_rule_foundations
--
-- Stage 2D Checkpoint 3: schema & atomic-RPC foundations for the approved
-- "New Manager Mental Model" simplification. The manager-visible Shift
-- Setup UI itself is NOT touched in this checkpoint (that is Checkpoint 4)
-- -- this migration only lays the ground underneath it:
--
--   1. PAY and REQUIRED DRIVERS/HIGH-VALUE move out of shift_templates'
--      ownership into two new, purpose-built rule families:
--        - payroll_rules            (pay: base_pay_chf, delivery_rate_chf)
--        - rota_rules_default/
--          rota_rules_weekday/
--          rota_rules_date          (staffing: required_drivers, is_premium)
--      shift_templates/shift_instances keep their old pay/headcount/premium
--      columns for now (nullable, deprecated -- see comments below) purely
--      so the *existing* Shift Setup form keeps compiling/working until
--      Checkpoint 4 removes them from the UI and a later migration drops
--      the columns outright. materialise_shift_instances no longer reads
--      them from shift_templates at all.
--
--   2. Three separate rota-rule tables, not one polymorphic table, because
--      each tier has a genuinely different effective-dating shape:
--        - DEFAULT and WEEKDAY rules are effective-dated (a manager can
--          schedule a seasonal change ahead of time) and use the same
--          GIST-exclusion "no two active overlapping periods" idiom as
--          shift_templates.
--        - DATE rules are an exact-date override (e.g. "25 December
--          Dinner: 3 drivers") -- explicitly NOT an effective-dated range
--          (no "always-current weekday toggle") -- so they use a plain
--          unique-partial-index on (shift_type_id, specific_date) instead.
--      Precedence at materialisation time is date > weekday > default.
--
--   3. Materialisation must never invent a configured value: a missing
--      payroll rule leaves pay NULL (never CHF 0); a missing rota rule
--      leaves required_drivers/is_premium NULL (never 1 / never false).
--      Neither missing rule blocks the shift from being scheduled --
--      both surface as "Needs Attention" via the new
--      missing_payroll_rule_count/missing_rota_rule_count result columns.
--
--   4. Multi-day manager actions (Add/Edit/Deactivate/Reactivate Shift)
--      must be atomic -- one manager action commits or rolls back as a
--      whole, never partially. Postgres gives this for free at the
--      function-body level: create_shift/revise_shift/deactivate_shift/
--      reactivate_shift are single plpgsql functions, so an exception
--      anywhere inside (e.g. one invalid weekday) rolls back everything
--      the function did, with no client-side transaction management
--      needed. All four share the internal _apply_shift_weekdays() helper,
--      which reconciles a shift's active shift_templates rows against a
--      new weekday/time selection in one pass.

-- =======================================================================
-- 1. PAYROLL_RULES -- effective-dated pay, per shift type.
-- =======================================================================
create table payroll_rules (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null,
  shift_type_id uuid not null,
  base_pay_chf numeric(10, 2) not null check (base_pay_chf >= 0),
  delivery_rate_chf numeric(10, 2) not null check (delivery_rate_chf >= 0),
  effective_from date not null,
  -- null = open-ended (still the current version).
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payroll_rules_effective_range_check
    check (effective_to is null or effective_to >= effective_from),

  constraint payroll_rules_shift_type_resort_fk
    foreign key (shift_type_id, resort_id) references shift_types (id, resort_id),

  -- No two active payroll rules for the same shift type may have
  -- overlapping effective-date ranges. Requires btree_gist (migration 01),
  -- same idiom as shift_templates_no_overlap.
  constraint payroll_rules_no_overlap
    exclude using gist (
      shift_type_id with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    ) where (is_active)
);

comment on table payroll_rules is
  'Effective-dated pay configuration per shift type (Configuration -> Payroll Rules, UI deferred). A shift type with no applicable row here has NO configured pay -- materialise_shift_instances leaves base_pay_chf/delivery_rate_chf NULL, never 0.';

create index payroll_rules_shift_type_id_idx on payroll_rules (shift_type_id);
create index payroll_rules_resort_id_idx on payroll_rules (resort_id);

create trigger payroll_rules_set_updated_at
  before update on payroll_rules
  for each row
  execute function set_updated_at();

-- =======================================================================
-- 2a. ROTA_RULES_DEFAULT -- effective-dated default staffing/fairness
--     configuration per shift type (applies to every weekday the shift
--     operates on, unless a weekday or date override wins instead).
-- =======================================================================
create table rota_rules_default (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null,
  shift_type_id uuid not null,
  required_drivers integer not null check (required_drivers > 0),
  -- Internal fairness/rota concept ("High-value shift" to managers,
  -- invisible to drivers). Not null: once a rule row exists, high-value
  -- status must be explicitly stated one way or the other -- see the
  -- table comment for what happens when NO rule exists at all.
  is_premium boolean not null,
  effective_from date not null,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rota_rules_default_effective_range_check
    check (effective_to is null or effective_to >= effective_from),

  constraint rota_rules_default_shift_type_resort_fk
    foreign key (shift_type_id, resort_id) references shift_types (id, resort_id),

  constraint rota_rules_default_no_overlap
    exclude using gist (
      shift_type_id with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    ) where (is_active)
);

comment on table rota_rules_default is
  'Effective-dated default staffing (required_drivers) and fairness (is_premium/"High-value") per shift type. Lowest-precedence tier -- overridden by rota_rules_weekday, then rota_rules_date. A shift type with no applicable row at any tier has NO configured staffing -- materialise_shift_instances leaves required_drivers/is_premium NULL, never 1 / never false.';

create index rota_rules_default_shift_type_id_idx on rota_rules_default (shift_type_id);
create index rota_rules_default_resort_id_idx on rota_rules_default (resort_id);

create trigger rota_rules_default_set_updated_at
  before update on rota_rules_default
  for each row
  execute function set_updated_at();

-- =======================================================================
-- 2b. ROTA_RULES_WEEKDAY -- effective-dated per-weekday override (e.g.
--     "Saturday Dinner: 2 drivers"). Beats the default tier; beaten by an
--     exact-date override.
-- =======================================================================
create table rota_rules_weekday (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null,
  shift_type_id uuid not null,
  -- Monday = 0 .. Sunday = 6, matching the DB-wide convention (app_weekday).
  weekday smallint not null check (weekday between 0 and 6),
  required_drivers integer not null check (required_drivers > 0),
  is_premium boolean not null,
  effective_from date not null,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rota_rules_weekday_effective_range_check
    check (effective_to is null or effective_to >= effective_from),

  constraint rota_rules_weekday_shift_type_resort_fk
    foreign key (shift_type_id, resort_id) references shift_types (id, resort_id),

  constraint rota_rules_weekday_no_overlap
    exclude using gist (
      shift_type_id with =,
      weekday with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    ) where (is_active)
);

comment on table rota_rules_weekday is
  'Effective-dated per-weekday staffing/fairness override (e.g. "Saturday Dinner: 2 drivers"), seasonal via effective_from/effective_to like rota_rules_default. Beats rota_rules_default; beaten by rota_rules_date.';

create index rota_rules_weekday_shift_type_id_idx on rota_rules_weekday (shift_type_id);
create index rota_rules_weekday_resort_id_idx on rota_rules_weekday (resort_id);

create trigger rota_rules_weekday_set_updated_at
  before update on rota_rules_weekday
  for each row
  execute function set_updated_at();

-- =======================================================================
-- 2c. ROTA_RULES_DATE -- EXACT-DATE override (e.g. "25 December Dinner: 3
--     drivers"). Deliberately NOT effective-dated -- a specific calendar
--     date, not an always-current weekday toggle. Highest precedence.
-- =======================================================================
create table rota_rules_date (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null,
  shift_type_id uuid not null,
  specific_date date not null,
  required_drivers integer not null check (required_drivers > 0),
  is_premium boolean not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rota_rules_date_shift_type_resort_fk
    foreign key (shift_type_id, resort_id) references shift_types (id, resort_id)
);

comment on table rota_rules_date is
  'Exact-date staffing/fairness override, e.g. "25 December Dinner: 3 drivers". Not effective-dated by design (see migration header) -- specific_date is a single calendar date. Highest precedence tier at materialisation: date > weekday > default.';

create index rota_rules_date_shift_type_id_idx on rota_rules_date (shift_type_id);
create index rota_rules_date_resort_id_idx on rota_rules_date (resort_id);

-- At most one active override per shift type + exact date (a correction
-- replaces the old row's is_active, it never leaves two active rows for
-- the same date).
create unique index rota_rules_date_active_unique
  on rota_rules_date (shift_type_id, specific_date)
  where (is_active);

create trigger rota_rules_date_set_updated_at
  before update on rota_rules_date
  for each row
  execute function set_updated_at();

-- =======================================================================
-- 3. RLS -- manager-only configuration, zero driver access (same pattern
--    as driver_onfleet_mappings / shift_types / shift_templates: no
--    driver-facing policy at all, so drivers get zero rows regardless of
--    query, including is_premium/pay which must never reach a driver).
-- =======================================================================
alter table payroll_rules enable row level security;
alter table payroll_rules force row level security;
revoke all on payroll_rules from anon, authenticated;
grant select, insert, update on payroll_rules to authenticated;

create policy payroll_rules_manager_all on payroll_rules for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

alter table rota_rules_default enable row level security;
alter table rota_rules_default force row level security;
revoke all on rota_rules_default from anon, authenticated;
grant select, insert, update on rota_rules_default to authenticated;

create policy rota_rules_default_manager_all on rota_rules_default for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

alter table rota_rules_weekday enable row level security;
alter table rota_rules_weekday force row level security;
revoke all on rota_rules_weekday from anon, authenticated;
grant select, insert, update on rota_rules_weekday to authenticated;

create policy rota_rules_weekday_manager_all on rota_rules_weekday for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

alter table rota_rules_date enable row level security;
alter table rota_rules_date force row level security;
revoke all on rota_rules_date from anon, authenticated;
grant select, insert, update on rota_rules_date to authenticated;

create policy rota_rules_date_manager_all on rota_rules_date for all to authenticated
  using (is_active_manager()) with check (is_active_manager());

-- =======================================================================
-- 4. AUDIT -- same generic audit_log_row_change() trigger used everywhere
--    else (migration 15); no redefinition needed, just attaching it here.
-- =======================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'payroll_rules', 'rota_rules_default', 'rota_rules_weekday', 'rota_rules_date'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function audit_log_row_change();',
      t || '_audit_trg', t
    );
  end loop;
end $$;

-- =======================================================================
-- 5. DEPRECATE shift_templates'/shift_instances' pay/headcount/premium
--    columns: make them nullable so ownership can move to the tables
--    above without a destructive column drop. A CHECK constraint already
--    treats NULL as satisfied (Postgres: NULL/"unknown" passes a CHECK,
--    only FALSE fails it) so `check (required_drivers > 0)` etc. keep
--    validating any value that IS present without any changes needed --
--    only NOT NULL/DEFAULT need to go.
--
--    Columns are kept (not dropped) purely so the current Shift Setup
--    form -- unchanged until Checkpoint 4 -- keeps writing real values to
--    them without any migration of in-flight UI code. They are dead
--    weight from materialise_shift_instances' perspective from this
--    migration onward: schedule (start_time/end_time) still comes from
--    shift_templates, but pay/staffing/premium are resolved from the
--    rule tables above instead, never read back off shift_templates.
-- =======================================================================
alter table shift_templates
  alter column required_drivers drop not null,
  alter column base_pay_chf drop not null,
  alter column delivery_rate_chf drop not null,
  alter column is_premium drop not null,
  alter column is_premium drop default;

comment on column shift_templates.required_drivers is
  'DEPRECATED (Stage 2D Checkpoint 3): superseded by rota_rules_default/weekday/date. Nullable; no longer read by materialise_shift_instances. Kept only until Checkpoint 4 removes it from the Shift Setup form and a later migration drops the column.';
comment on column shift_templates.base_pay_chf is
  'DEPRECATED (Stage 2D Checkpoint 3): superseded by payroll_rules. Nullable; no longer read by materialise_shift_instances.';
comment on column shift_templates.delivery_rate_chf is
  'DEPRECATED (Stage 2D Checkpoint 3): superseded by payroll_rules. Nullable; no longer read by materialise_shift_instances.';
comment on column shift_templates.is_premium is
  'DEPRECATED (Stage 2D Checkpoint 3): superseded by rota_rules_default/weekday/date. Nullable, no default (never silently false); no longer read by materialise_shift_instances.';

alter table shift_instances
  alter column required_drivers drop not null,
  alter column base_pay_chf drop not null,
  alter column delivery_rate_chf drop not null,
  alter column is_premium drop not null,
  alter column is_premium drop default;

comment on column shift_instances.required_drivers is
  'NULL = staffing not configured for this instance (no applicable rota_rules_* row at materialisation time) -- a distinct "Needs Attention" state from both "no service" (no instance at all) and "uncovered" (configured but under-assigned). Never coalesced to a default; see docs/business-rules.md.';
comment on column shift_instances.base_pay_chf is
  'NULL = no payroll rule was configured for this shift type at materialisation time. Never coalesced to 0 -- payroll calculation must hard-stop on NULL rather than treat it as free.';
comment on column shift_instances.delivery_rate_chf is
  'NULL = no payroll rule was configured for this shift type at materialisation time. Never coalesced to 0.';
comment on column shift_instances.is_premium is
  'NULL = no rota rule was configured for this shift type/date at materialisation time, so high-value/fairness status is not yet known. Never coalesced to false.';

-- =======================================================================
-- 6. MATERIALISE_SHIFT_INSTANCES -- schedule from shift_templates, pay
--    from payroll_rules, staffing/high-value from rota_rules_date >
--    rota_rules_weekday > rota_rules_default. A missing payroll or rota
--    rule never blocks materialisation and never invents a value -- it
--    shows up in the new missing_payroll_rule_count/missing_rota_rule_count
--    result columns instead. Both counts are computed over the full
--    `governing` set (every date/shift-type this call considered), so a
--    repeated call against the same range returns the same counts whether
--    or not new rows were actually inserted (idempotent, per Checkpoint 3
--    testing requirements) -- not just over newly-created rows.
-- =======================================================================
-- The RETURNS TABLE shape is changing (two new columns), which Postgres
-- will not let CREATE OR REPLACE do in place -- drop first.
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
  missing_payroll_rule_count integer,
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
  v_missing_payroll integer;
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
      pr.base_pay_chf as resolved_base_pay_chf,
      pr.delivery_rate_chf as resolved_delivery_rate_chf,
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
    left join payroll_rules pr
      on pr.shift_type_id = st.id
     and pr.resort_id = p_resort_id
     and pr.is_active
     and pr.effective_from <= cd.date
     and (pr.effective_to is null or pr.effective_to >= cd.date)
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
       start_time, end_time, required_drivers, base_pay_chf, delivery_rate_chf, is_premium,
       status, origin)
    select
      p_resort_id, g.date, g.shift_type_id, g.template_id, g.key, g.name, g.sort_order,
      g.start_time, g.end_time, g.resolved_required_drivers, g.resolved_base_pay_chf, g.resolved_delivery_rate_chf, g.resolved_is_premium,
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
    (select count(*) from governing where resolved_base_pay_chf is null),
    (select count(*) from governing where resolved_required_drivers is null)
  into v_created, v_total_governing, v_missing_payroll, v_missing_rota;

  return query select v_created, (v_total_governing - v_created), v_from_date, v_to_date, v_missing_payroll, v_missing_rota;
end;
$$;

comment on function materialise_shift_instances(uuid, date, date) is
  'Manager-only, insert-only. Schedule (start/end time) comes from active shift_templates; pay comes from payroll_rules; staffing/high-value comes from rota_rules_date > rota_rules_weekday > rota_rules_default. A missing payroll or rota rule never blocks materialisation -- the corresponding snapshot is left NULL and counted in missing_payroll_rule_count/missing_rota_rule_count, never guessed. Never modifies an existing instance of any origin/status.';

revoke execute on function materialise_shift_instances(uuid, date, date) from public;
grant execute on function materialise_shift_instances(uuid, date, date) to authenticated;

-- =======================================================================
-- 7. NARROW THE REFRESH WORKFLOW to schedule-owned fields only
--    (start_time, end_time, name, sort_order). Pay/staffing/high-value
--    changes are no longer template-refresh concerns at all -- they will
--    get their own Payroll/Rota Rule refresh workflows later, entirely
--    separate from this one (Checkpoint 2 decision #7: keep these as
--    separate review flows, never one combined review).
-- =======================================================================
-- Column set is shrinking (pay/required_drivers/is_premium removed), which
-- CREATE OR REPLACE VIEW cannot do in place -- drop first.
drop view if exists v_refreshable_instances;

create view v_refreshable_instances as
select
  si.id as shift_instance_id,
  si.resort_id,
  si.date,
  si.week_start,
  si.shift_type_id,
  si.shift_key,
  si.name as current_name,
  si.sort_order as current_sort_order,
  si.start_time as current_start_time,
  si.end_time as current_end_time,
  si.template_id as current_template_id,
  t.id as governing_template_id,
  st.name as new_name,
  st.sort_order as new_sort_order,
  t.start_time as new_start_time,
  t.end_time as new_end_time
from shift_instances si
join shift_types st on st.id = si.shift_type_id
join shift_templates t
  on t.shift_type_id = si.shift_type_id
 and t.resort_id = si.resort_id
 and t.is_active
 and t.weekday = app_weekday(si.date)
 and t.effective_from <= si.date
 and (t.effective_to is null or t.effective_to >= si.date)
where si.origin = 'template'
  and si.status = 'active'
  and si.date >= operational_today(si.resort_id)
  and not shift_instance_week_is_published(si.id)
  and not exists (select 1 from attendance a where a.shift_instance_id = si.id);

comment on view v_refreshable_instances is
  'Template-origin, active, future (in the resort''s own timezone), unpublished, un-attended instances that currently have a governing active template. Schedule fields ONLY (name/sort_order/start_time/end_time) -- Stage 2D Checkpoint 3 narrowed this away from pay/required_drivers/is_premium, which are no longer schedule-template concerns. The safety-checked eligible set for both preview_template_refresh and apply_template_refresh. Internal only -- never granted to a client role directly.';

-- Both RETURNS TABLE shapes below are shrinking -- drop first.
drop function if exists preview_template_refresh(uuid, date);
drop function if exists apply_template_refresh(uuid, date);

create function preview_template_refresh(p_resort_id uuid, p_from_date date default null)
returns table (
  shift_instance_id uuid,
  date date,
  shift_type_id uuid,
  shift_key text,
  name text,
  current_template_id uuid,
  new_template_id uuid,
  will_change boolean,
  changed_fields jsonb,
  assignment_count integer,
  time_would_change boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_from_date date;
begin
  perform assert_active_manager();
  v_from_date := coalesce(p_from_date, operational_today(p_resort_id));

  return query
  select
    r.shift_instance_id,
    r.date,
    r.shift_type_id,
    r.shift_key,
    r.current_name,
    r.current_template_id,
    r.governing_template_id,
    (r.current_start_time, r.current_end_time, r.current_name, r.current_sort_order)
      is distinct from
    (r.new_start_time, r.new_end_time, r.new_name, r.new_sort_order),
    jsonb_strip_nulls(jsonb_build_object(
      'start_time', case when r.current_start_time is distinct from r.new_start_time then jsonb_build_object('old', r.current_start_time, 'new', r.new_start_time) end,
      'end_time', case when r.current_end_time is distinct from r.new_end_time then jsonb_build_object('old', r.current_end_time, 'new', r.new_end_time) end,
      'name', case when r.current_name is distinct from r.new_name then jsonb_build_object('old', r.current_name, 'new', r.new_name) end,
      'sort_order', case when r.current_sort_order is distinct from r.new_sort_order then jsonb_build_object('old', r.current_sort_order, 'new', r.new_sort_order) end
    )),
    coalesce(a.cnt, 0)::integer,
    (r.current_start_time is distinct from r.new_start_time) or (r.current_end_time is distinct from r.new_end_time)
  from v_refreshable_instances r
  left join (
    select shift_instance_id, count(*) as cnt from rota_assignments group by shift_instance_id
  ) a on a.shift_instance_id = r.shift_instance_id
  where r.resort_id = p_resort_id
    and r.date >= v_from_date;
end;
$$;

comment on function preview_template_refresh(uuid, date) is
  'Manager-only, read-only. Shows what apply_template_refresh would change for the eligible (v_refreshable_instances) set -- schedule fields only (name/sort_order/start_time/end_time) since Stage 2D Checkpoint 3. Never modifies data. Default from_date resolves to "today" in the resort''s own timezone.';

create function apply_template_refresh(p_resort_id uuid, p_from_date date default null)
returns table (
  updated_count integer,
  reopened_submission_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_from_date date;
  v_row record;
  v_updated integer := 0;
  v_touched_weeks date[] := array[]::date[];
  v_reopened integer;
  v_previously_confirmed_weeks date[];
begin
  perform assert_active_manager();
  v_from_date := coalesce(p_from_date, operational_today(p_resort_id));

  -- Snapshot which weeks were confirmed *before* this apply, so the
  -- reopened-count below reflects an actual state transition rather than a
  -- timestamp comparison -- now() is frozen at transaction start (not
  -- clock_timestamp()), so comparing it against a clock_timestamp()
  -- captured here would be wrong by construction, not just under a test
  -- transaction.
  select array_agg(distinct week_start) into v_previously_confirmed_weeks
  from availability_submissions
  where resort_id = p_resort_id and submitted_at is not null;

  for v_row in
    select * from v_refreshable_instances where resort_id = p_resort_id and date >= v_from_date
  loop
    update shift_instances
      set name = v_row.new_name,
          sort_order = v_row.new_sort_order,
          start_time = v_row.new_start_time,
          end_time = v_row.new_end_time,
          template_id = v_row.governing_template_id
      where id = v_row.shift_instance_id;

    v_updated := v_updated + 1;

    if (v_row.current_start_time is distinct from v_row.new_start_time)
       or (v_row.current_end_time is distinct from v_row.new_end_time) then
      if not (v_row.week_start = any(v_touched_weeks)) then
        v_touched_weeks := array_append(v_touched_weeks, v_row.week_start);
      end if;
    end if;
  end loop;

  if v_touched_weeks is not null and array_length(v_touched_weeks, 1) is not null
     and v_previously_confirmed_weeks is not null then
    select count(*) into v_reopened
    from availability_submissions s
    where s.resort_id = p_resort_id
      and s.week_start = any(v_touched_weeks)
      and s.week_start = any(v_previously_confirmed_weeks)
      and s.submitted_at is null
      and s.reopened_reason = 'shift_time_changed';
  else
    v_reopened := 0;
  end if;

  return query select v_updated, v_reopened;
end;
$$;

comment on function apply_template_refresh(uuid, date) is
  'Manager-only. Updates exactly the v_refreshable_instances set: schedule snapshot fields (name/sort_order/start_time/end_time) + template_id from the current governing template -- pay/required_drivers/is_premium are untouched by this action since Stage 2D Checkpoint 3 (they belong to payroll_rules/rota_rules now, refreshed separately in future work). Assignments are always retained regardless of any staffing-rule change elsewhere. Relies on the existing shift_instances triggers for audit logging and stale-confirmation reopening. Default from_date resolves to "today" in the resort''s own timezone.';

revoke execute on function preview_template_refresh(uuid, date) from public;
grant execute on function preview_template_refresh(uuid, date) to authenticated;
revoke execute on function apply_template_refresh(uuid, date) from public;
grant execute on function apply_template_refresh(uuid, date) to authenticated;

-- preview_template_cancellation/apply_template_cancellation are unchanged:
-- they already operate at (resort_id, shift_type_id) granularity and carry
-- no pay/staffing fields, so nothing about this checkpoint affects them.

-- =======================================================================
-- 8. ATOMIC MANAGER RPCS -- one manager-facing action = one transaction.
--    All four share _apply_shift_weekdays(), which reconciles a shift
--    type's active shift_templates rows against a new weekday/time
--    selection:
--      - a currently-active weekday no longer selected is retired
--        (is_active=false, effective_to = the day before the new
--        effective date);
--      - a currently-active weekday's row whose own effective_from has
--        not yet started as of the new effective date (i.e. it is a
--        still-editable future plan, not real history) is replaced in
--        place -- no spurious history row;
--      - otherwise, the current row is retired and a fresh active row is
--        inserted from the new effective date.
--    This is also where the Checkpoint 2 "min effective date" bug is
--    fixed authoritatively: retiring a row sets its effective_to to the
--    day before the new version starts, and shift_templates'
--    pre-existing effective_range_check (effective_to >= effective_from)
--    naturally rejects a new effective date that does not come after the
--    row it would retire -- no separate validation needed here.
-- =======================================================================
create or replace function _apply_shift_weekdays(
  p_shift_type_id uuid,
  p_resort_id uuid,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_effective_from date,
  p_effective_to date default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_weekday smallint;
  v_dropped record;
  v_current record;
begin
  if p_weekdays is null or array_length(p_weekdays, 1) is null then
    raise exception 'Select at least one day of the week.' using errcode = '23514';
  end if;

  -- Weekdays this shift currently operates on but the new selection
  -- drops entirely: end their active period the day before the change.
  for v_dropped in
    select distinct weekday from shift_templates
    where shift_type_id = p_shift_type_id
      and resort_id = p_resort_id
      and is_active
      and weekday <> all (p_weekdays)
  loop
    update shift_templates
      set is_active = false,
          effective_to = greatest(effective_from, p_effective_from - 1)
      where shift_type_id = p_shift_type_id
        and resort_id = p_resort_id
        and weekday = v_dropped.weekday
        and is_active;
  end loop;

  -- Weekdays in the new selection: reconcile against whatever is
  -- currently active for that weekday, then (re)establish it with the
  -- new time from p_effective_from.
  foreach v_weekday in array p_weekdays loop
    select * into v_current
    from shift_templates
    where shift_type_id = p_shift_type_id
      and resort_id = p_resort_id
      and weekday = v_weekday
      and is_active;

    if found and v_current.effective_from >= p_effective_from then
      -- This version has never taken effect before the new date -- it is
      -- still a future plan, not history. Replace it in place rather
      -- than opening a second row that would zero-width-collide with it.
      update shift_templates
        set start_time = p_start_time,
            end_time = p_end_time,
            effective_from = p_effective_from,
            effective_to = p_effective_to
        where id = v_current.id;
    else
      if found then
        update shift_templates
          set is_active = false,
              effective_to = p_effective_from - 1
          where id = v_current.id;
      end if;

      insert into shift_templates (
        resort_id, shift_type_id, weekday, start_time, end_time, effective_from, effective_to, is_active
      ) values (
        p_resort_id, p_shift_type_id, v_weekday, p_start_time, p_end_time, p_effective_from, p_effective_to, true
      );
    end if;
  end loop;
end;
$$;

comment on function _apply_shift_weekdays(uuid, uuid, time, time, smallint[], date, date) is
  'Internal helper shared by create_shift/revise_shift/reactivate_shift. Reconciles shift_templates for one shift type against a new weekday+time selection in a single atomic pass. Never called directly by clients.';

revoke execute on function _apply_shift_weekdays(uuid, uuid, time, time, smallint[], date, date) from public;

-- CREATE SHIFT: name/start/end/weekdays/effective dates only -- no pay, no
-- required drivers, no high-value. `key` is the shift's stable internal
-- identity but is never manager-supplied: it is generated here from the
-- name (slugified, disambiguated on collision) since Checkpoint 2's
-- product decision keeps shift_types.key fully internal.
create or replace function create_shift(
  p_resort_id uuid,
  p_name text,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_effective_from date default null,
  p_effective_to date default null
)
returns table (shift_type_id uuid, key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift_type_id uuid;
  v_base_key text;
  v_key text;
  v_suffix int := 1;
  v_sort_order int;
  v_effective_from date;
begin
  perform assert_active_manager();

  if p_name is null or btrim(p_name) = '' then
    raise exception 'A shift needs a name.' using errcode = '23514';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time.' using errcode = '23514';
  end if;

  v_effective_from := coalesce(p_effective_from, operational_today(p_resort_id));

  v_base_key := trim(both '_' from regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '_', 'g'));
  if v_base_key = '' then
    v_base_key := 'shift';
  end if;
  v_key := v_base_key;
  while exists (select 1 from shift_types st where st.resort_id = p_resort_id and st.key = v_key) loop
    v_suffix := v_suffix + 1;
    v_key := v_base_key || '_' || v_suffix;
  end loop;

  select coalesce(max(sort_order), -1) + 1 into v_sort_order
  from shift_types where resort_id = p_resort_id;

  insert into shift_types (resort_id, key, name, sort_order, is_active)
  values (p_resort_id, v_key, btrim(p_name), v_sort_order, true)
  returning id into v_shift_type_id;

  -- Atomic with the shift_types insert above: any failure here (e.g. an
  -- invalid weekday) rolls back the shift_types row too, so a shift is
  -- never left half-created.
  perform _apply_shift_weekdays(v_shift_type_id, p_resort_id, p_start_time, p_end_time, p_weekdays, v_effective_from, p_effective_to);

  return query select v_shift_type_id, v_key;
end;
$$;

comment on function create_shift(uuid, text, time, time, smallint[], date, date) is
  'Manager-only, atomic. Creates a new shift (stable shift_type + its weekday schedule rows) in one transaction -- no pay/required-drivers/high-value inputs; those belong to payroll_rules/rota_rules, configured separately. A failure partway through (e.g. an empty weekday selection) rolls back the whole action, never a partially-created shift.';

revoke execute on function create_shift(uuid, text, time, time, smallint[], date, date) from public;
grant execute on function create_shift(uuid, text, time, time, smallint[], date, date) to authenticated;

-- REVISE SHIFT: name/time/weekdays/effective dates. One shift has one
-- standard time across all its active weekdays -- day-varying times are a
-- separately-named shift, never a per-weekday time on this one.
create or replace function revise_shift(
  p_shift_type_id uuid,
  p_resort_id uuid,
  p_name text,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_effective_from date default null,
  p_effective_to date default null
)
returns table (shift_type_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_from date;
  v_is_active boolean;
begin
  perform assert_active_manager();

  select is_active into v_is_active from shift_types
  where id = p_shift_type_id and resort_id = p_resort_id;

  if not found then
    raise exception 'Shift not found.' using errcode = 'P0002';
  end if;
  if not v_is_active then
    raise exception 'An inactive shift must be reactivated before it can be revised.' using errcode = '55006';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'A shift needs a name.' using errcode = '23514';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time.' using errcode = '23514';
  end if;

  v_effective_from := coalesce(p_effective_from, operational_today(p_resort_id));

  update shift_types set name = btrim(p_name) where id = p_shift_type_id;

  perform _apply_shift_weekdays(p_shift_type_id, p_resort_id, p_start_time, p_end_time, p_weekdays, v_effective_from, p_effective_to);

  return query select p_shift_type_id;
end;
$$;

comment on function revise_shift(uuid, uuid, text, time, time, smallint[], date, date) is
  'Manager-only, atomic. Revises an active shift''s name/time/weekdays/effective dates in one transaction, diffing the current weekday set against the new one via _apply_shift_weekdays. Never rewrites history: a weekday version that already governs real dates is retired (effective_to = the day before the change), not overwritten in place.';

revoke execute on function revise_shift(uuid, uuid, text, time, time, smallint[], date, date) from public;
grant execute on function revise_shift(uuid, uuid, text, time, time, smallint[], date, date) to authenticated;

-- DEACTIVATE SHIFT: ends all active schedule days and marks the shift
-- inactive, atomically. Already-materialised future shift_instances are
-- untouched here -- cancelling those remains the separate
-- preview_template_cancellation/apply_template_cancellation workflow.
create or replace function deactivate_shift(
  p_shift_type_id uuid,
  p_resort_id uuid,
  p_effective_to date default null
)
returns table (shift_type_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_to date;
begin
  perform assert_active_manager();

  if not exists (
    select 1 from shift_types where id = p_shift_type_id and resort_id = p_resort_id and is_active
  ) then
    raise exception 'Shift not found or already inactive.' using errcode = 'P0002';
  end if;

  v_effective_to := coalesce(p_effective_to, operational_today(p_resort_id));

  -- Templates must be retired before the shift type itself is deactivated
  -- -- shift_types_prevent_unsafe_deactivation_trg (Checkpoint 1) blocks
  -- is_active true->false while any active template remains, by design.
  -- Table alias required: the RETURNS TABLE (shift_type_id uuid) OUT
  -- parameter would otherwise make a bare `shift_type_id` ambiguous here.
  update shift_templates t
    set is_active = false,
        -- A template that had not started yet as of v_effective_to closes
        -- on its own effective_from instead (it never actually ran).
        effective_to = greatest(t.effective_from, v_effective_to)
    where t.shift_type_id = p_shift_type_id
      and t.resort_id = p_resort_id
      and t.is_active;

  update shift_types set is_active = false
  where id = p_shift_type_id and resort_id = p_resort_id;

  return query select p_shift_type_id;
end;
$$;

comment on function deactivate_shift(uuid, uuid, date) is
  'Manager-only, atomic. Ends every active weekday for this shift (effective_to = p_effective_to, default today in the resort''s timezone) and marks the shift itself inactive, in one transaction. Historical template rows are retained (is_active=false), never deleted. Does not cancel already-materialised future shift_instances -- use preview/apply_template_cancellation separately for that.';

revoke execute on function deactivate_shift(uuid, uuid, date) from public;
grant execute on function deactivate_shift(uuid, uuid, date) to authenticated;

-- REACTIVATE SHIFT: same stable shift_type_id, fresh schedule rows from
-- the reactivation date -- never resurrects/reopens old historical rows.
create or replace function reactivate_shift(
  p_shift_type_id uuid,
  p_resort_id uuid,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_effective_from date default null,
  p_effective_to date default null
)
returns table (shift_type_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_from date;
  v_is_active boolean;
begin
  perform assert_active_manager();

  select is_active into v_is_active from shift_types
  where id = p_shift_type_id and resort_id = p_resort_id;

  if not found then
    raise exception 'Shift not found.' using errcode = 'P0002';
  end if;
  if v_is_active then
    raise exception 'This shift is already active.' using errcode = '23514';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time.' using errcode = '23514';
  end if;

  v_effective_from := coalesce(p_effective_from, operational_today(p_resort_id));

  update shift_types set is_active = true where id = p_shift_type_id;

  -- Every prior template row for this shift type is inactive at this
  -- point (the shift was fully deactivated), so _apply_shift_weekdays'
  -- "reconcile against the current active row" logic finds nothing to
  -- retire/replace for any weekday and always inserts fresh rows --
  -- satisfying "never resurrect old historical rows" by construction.
  perform _apply_shift_weekdays(p_shift_type_id, p_resort_id, p_start_time, p_end_time, p_weekdays, v_effective_from, p_effective_to);

  return query select p_shift_type_id;
end;
$$;

comment on function reactivate_shift(uuid, uuid, time, time, smallint[], date, date) is
  'Manager-only, atomic. Reactivates an inactive shift under the same stable shift_type_id, creating brand-new active shift_templates rows from p_effective_from (default today in the resort''s timezone). Never flips an old historical row back to active.';

revoke execute on function reactivate_shift(uuid, uuid, time, time, smallint[], date, date) from public;
grant execute on function reactivate_shift(uuid, uuid, time, time, smallint[], date, date) to authenticated;
