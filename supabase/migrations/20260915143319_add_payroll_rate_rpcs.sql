-- 28_add_payroll_rate_rpcs
--
-- Stage 2D Payroll Checkpoint B: atomic manager RPCs for configuring
-- shift_base_pay_rules / driver_delivery_rates (Payroll Checkpoint A schema).
-- Neither table has ever had a manager-facing write path before this --
-- Checkpoint A only ever populated them via raw SQL/tests.
--
-- Both RPCs share one shape, mirroring the exact "reconcile against the
-- current still-open row" idiom _apply_shift_weekdays established in
-- Checkpoint 3, adapted for a single effective-dated rate rather than a
-- weekday set:
--
--   - No existing rule at all -> plain insert.
--   - An existing OPEN-ENDED rule (effective_to IS NULL -- there is always
--     at most one per shift_type_id/driver_id, guaranteed by the table's
--     own exclusion constraint) that has not yet taken effect as of the
--     resort's own operational "today" (i.e. it is still an editable future
--     plan, never real history) -> replaced in place: no spurious extra
--     row, and safe because nothing has been paid out under it yet.
--   - An existing open-ended rule that IS already in effect (its own
--     effective_from is on/before today) -> the new rate must start
--     strictly after that rule's own start date; the old rule's effective
--     period is closed the day before the new one begins (never UPDATEd
--     into the new value -- a fresh row is inserted instead), and a manager
--     attempt to backdate on/before an already-real rule's start is
--     rejected outright (23514) rather than silently rewriting history.
--   - Any other overlap (e.g. colliding with an already-closed historical
--     period, or an already-scheduled further-future change) is caught by
--     the table's own GIST exclusion constraint (23P01) -- never
--     pre-validated in application code, per the "don't rely solely on
--     React/app code to maintain the no-overlap invariant" requirement.
--
-- FUTURE SAFETY NOTE (do not build this now -- see Payroll Checkpoint A's
-- own review, item 16): once `driver_shift_payroll` (financial
-- finalisation) exists, this RPC's backdate guard will need an additional
-- check -- a new effective_from must never fall within a date range that
-- already has a FINALISED payroll line depending on the rate it would
-- retroactively change. That check has no meaning yet (no payroll exists to
-- finalise), so it is deliberately not implemented here; this comment
-- exists so the future checkpoint that adds finalisation knows exactly
-- where to add it.

-- =======================================================================
-- 1. SET_SHIFT_BASE_PAY_RATE
-- =======================================================================
create function set_shift_base_pay_rate(
  p_resort_id uuid,
  p_shift_type_id uuid,
  p_base_pay_chf numeric,
  p_effective_from date default null
)
returns table (
  rule_id uuid,
  resort_id uuid,
  shift_type_id uuid,
  base_pay_chf numeric,
  effective_from date,
  effective_to date
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_effective_from date;
  v_today date;
  v_open shift_base_pay_rules%rowtype;
  v_new_id uuid;
begin
  perform assert_active_manager();

  if p_base_pay_chf is null or p_base_pay_chf < 0 then
    raise exception 'Base pay cannot be negative.' using errcode = '23514';
  end if;

  v_today := operational_today(p_resort_id);
  v_effective_from := coalesce(p_effective_from, v_today);

  -- Belt-and-suspenders: shift_base_pay_rules_shift_type_resort_fk already
  -- enforces this via the insert/update below, but a clear up-front check
  -- gives a friendlier error than a raw FK violation.
  if not exists (select 1 from shift_types st where st.id = p_shift_type_id and st.resort_id = p_resort_id) then
    raise exception 'That Shift does not belong to this resort.' using errcode = '23503';
  end if;

  select * into v_open
  from shift_base_pay_rules
  where shift_type_id = p_shift_type_id
    and resort_id = p_resort_id
    and is_active
    and effective_to is null;

  if not found then
    -- No rule at all yet (first time this Shift's base pay is configured).
    insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from)
    values (p_resort_id, p_shift_type_id, p_base_pay_chf, v_effective_from)
    returning id into v_new_id;
  elsif v_open.effective_from > v_today then
    -- The current open-ended rule is itself still a genuine future plan
    -- (its own start is strictly after today -- nothing has taken effect
    -- under it yet) -- safe to replace in place rather than opening a
    -- redundant row, regardless of whether the newly-requested date is
    -- earlier, later, or the same. A rule that already started TODAY is
    -- deliberately NOT included here -- it is already the real, in-effect
    -- rate as of right now and must be preserved by the branch below, not
    -- silently replaced. The exclusion constraint still protects this
    -- branch against colliding with an earlier, already-closed period.
    update shift_base_pay_rules
      set base_pay_chf = p_base_pay_chf,
          effective_from = v_effective_from
      where id = v_open.id
      returning id into v_new_id;
  else
    -- The current open-ended rule already covers real elapsed time. A new
    -- rate may only start strictly after it did -- never on/before, which
    -- would silently rewrite what was already paid/payable under it.
    if v_effective_from <= v_open.effective_from then
      raise exception 'A new base-pay rate cannot start before the currently active rate already took effect.' using errcode = '23514';
    end if;

    update shift_base_pay_rules
      set effective_to = v_effective_from - 1
      where id = v_open.id;

    insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from)
    values (p_resort_id, p_shift_type_id, p_base_pay_chf, v_effective_from)
    returning id into v_new_id;
  end if;

  return query
  select r.id, r.resort_id, r.shift_type_id, r.base_pay_chf, r.effective_from, r.effective_to
  from shift_base_pay_rules r where r.id = v_new_id;
end;
$$;

comment on function set_shift_base_pay_rate(uuid, uuid, numeric, date) is
  'Manager-only, atomic. Sets a Shift''s base-pay guarantee, effective-dated. Never overwrites an already-real historical or in-effect period''s own values -- a genuine future change closes the current open-ended rule (effective_to = the day before the new one starts) and inserts a fresh row; a not-yet-started future plan is corrected in place instead of accumulating redundant rows. Rejects (23514) an attempt to backdate on/before an already-in-effect rule''s own start, and rejects (23P01, via the table''s own exclusion constraint) any other overlap.';

revoke execute on function set_shift_base_pay_rate(uuid, uuid, numeric, date) from public;
grant execute on function set_shift_base_pay_rate(uuid, uuid, numeric, date) to authenticated;

-- =======================================================================
-- 2. SET_DRIVER_DELIVERY_RATE -- same shape, keyed by driver_id. resort_id
--    is always resolved server-side from the driver''s own row, mirroring
--    set_driver_onfleet_mapping (migration 23) -- never trusted from the
--    caller, so there is no "wrong resort" input to even attempt.
-- =======================================================================
create function set_driver_delivery_rate(
  p_driver_id uuid,
  p_rate_chf numeric,
  p_effective_from date default null
)
returns table (
  rule_id uuid,
  resort_id uuid,
  driver_id uuid,
  rate_chf numeric,
  effective_from date,
  effective_to date
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_resort_id uuid;
  v_effective_from date;
  v_today date;
  v_open driver_delivery_rates%rowtype;
  v_new_id uuid;
begin
  perform assert_active_manager();

  if p_rate_chf is null or p_rate_chf < 0 then
    raise exception 'Delivery rate cannot be negative.' using errcode = '23514';
  end if;

  select resort_id into v_resort_id from drivers where id = p_driver_id;
  if v_resort_id is null then
    raise exception 'Driver not found.' using errcode = 'P0002';
  end if;

  v_today := operational_today(v_resort_id);
  v_effective_from := coalesce(p_effective_from, v_today);

  select * into v_open
  from driver_delivery_rates
  where driver_id = p_driver_id
    and is_active
    and effective_to is null;

  if not found then
    insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from)
    values (p_driver_id, v_resort_id, p_rate_chf, v_effective_from)
    returning id into v_new_id;
  elsif v_open.effective_from > v_today then
    update driver_delivery_rates
      set rate_chf = p_rate_chf,
          effective_from = v_effective_from
      where id = v_open.id
      returning id into v_new_id;
  else
    if v_effective_from <= v_open.effective_from then
      raise exception 'A new delivery rate cannot start before the currently active rate already took effect.' using errcode = '23514';
    end if;

    update driver_delivery_rates
      set effective_to = v_effective_from - 1
      where id = v_open.id;

    insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from)
    values (p_driver_id, v_resort_id, p_rate_chf, v_effective_from)
    returning id into v_new_id;
  end if;

  return query
  select r.id, r.resort_id, r.driver_id, r.rate_chf, r.effective_from, r.effective_to
  from driver_delivery_rates r where r.id = v_new_id;
end;
$$;

comment on function set_driver_delivery_rate(uuid, numeric, date) is
  'Manager-only, atomic. Sets a driver''s delivery rate, effective-dated. resort_id is always resolved from the driver''s own row, never client-supplied. Same historical-safety shape as set_shift_base_pay_rate -- see its comment.';

revoke execute on function set_driver_delivery_rate(uuid, numeric, date) from public;
grant execute on function set_driver_delivery_rate(uuid, numeric, date) to authenticated;
