-- 29_add_payroll_rate_correction_rpcs
--
-- Stage 2D Payroll Checkpoint B.1: an explicit, manager-only CORRECTION
-- workflow for shift_base_pay_rules/driver_delivery_rates, distinct from
-- set_shift_base_pay_rate/set_driver_delivery_rate (Checkpoint B).
--
-- Checkpoint B deliberately never lets a manager change an already-in-effect
-- rate's own value in place -- any "change" from that point on is a new,
-- later-dated period, preserving the old one as history. That is correct
-- for a genuine rate CHANGE, but too restrictive for a genuine data-entry
-- MISTAKE: "I meant to type 12, I typed 13" is not a rate change at all --
-- there was never a real CHF 13 period, just an error. Effective dating
-- protects historical RATE PERIODS; payroll FINALISATION (a future
-- checkpoint) will protect actual historical PAYROLL. Those are different
-- guarantees. Until a driver_shift_payroll line is finalised, an authorised
-- manager must be able to correct an erroneous rate -- deliberately, on a
-- separate action from the ordinary future-change workflow, atomically, and
-- audited.
--
-- correct_shift_base_pay_rate/correct_driver_delivery_rate therefore:
--   - take the target rule's own id directly (already known to the
--     frontend from its own list query -- never manager-typed), rather than
--     re-deriving "which row is current" server-side, so the same operation
--     unambiguously handles BOTH "correct the currently-applicable rule"
--     and "correct an already-scheduled future rule" (Checkpoint B.1 §1/§6)
--     without inventing two separate RPCs for what is the same update.
--   - UPDATE ONLY the amount column -- never effective_from/effective_to/
--     is_active -- so History continues to show only genuine effective
--     periods, never a fake one-day period invented to record a typo
--     (Checkpoint B.1 §7). The generic audit_log_row_change() trigger
--     (already attached to both tables since Checkpoint A) captures the
--     before/after amount automatically -- no bespoke audit code needed.
--   - refuse to touch an already-CLOSED period (effective_to is not null):
--     correction only ever targets an OPEN period (current or scheduled,
--     i.e. exactly the two states set_*_rate's own "still open" concept
--     already covers) -- a genuinely past, closed period is real history by
--     now and out of scope for this checkpoint ("do not overbuild arbitrary
--     period editing").
--
-- FUTURE FINALISATION GUARD (do not build this now -- no driver_shift_payroll
-- exists yet, so there is nothing to enforce): once it exists, add a check
-- here -- before the UPDATE -- for whether any FINALISED driver_shift_payroll
-- row was calculated using this exact rule/period; if one exists, reject the
-- correction outright (a distinct error code, e.g. 55006) rather than
-- silently rewriting already-finalised financial history. The financial
-- snapshot on driver_shift_payroll remains authoritative once it exists;
-- configuration corrections must never reach back into it. This comment
-- marks exactly where that check belongs so this workflow does not need
-- replacing later, only extending.

-- =======================================================================
-- 1. CORRECT_SHIFT_BASE_PAY_RATE
-- =======================================================================
create function correct_shift_base_pay_rate(
  p_resort_id uuid,
  p_shift_type_id uuid,
  p_rule_id uuid,
  p_new_base_pay_chf numeric
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
  v_rule shift_base_pay_rules%rowtype;
begin
  perform assert_active_manager();

  if p_new_base_pay_chf is null or p_new_base_pay_chf < 0 then
    raise exception 'Base pay cannot be negative.' using errcode = '23514';
  end if;

  select * into v_rule
  from shift_base_pay_rules
  where id = p_rule_id
    and shift_type_id = p_shift_type_id
    and resort_id = p_resort_id
    and is_active;

  if not found then
    raise exception 'That base-pay rate could not be found for this Shift.' using errcode = 'P0002';
  end if;

  if v_rule.effective_to is not null then
    raise exception 'Only the current or an upcoming scheduled rate can be corrected here -- a closed historical period is not editable.' using errcode = '55006';
  end if;

  -- FUTURE FINALISATION GUARD -- see migration header. Nothing to check yet.

  update shift_base_pay_rules
    set base_pay_chf = p_new_base_pay_chf
    where id = p_rule_id;

  return query
  select r.id, r.resort_id, r.shift_type_id, r.base_pay_chf, r.effective_from, r.effective_to
  from shift_base_pay_rules r where r.id = p_rule_id;
end;
$$;

comment on function correct_shift_base_pay_rate(uuid, uuid, uuid, numeric) is
  'Manager-only, atomic. Corrects the AMOUNT of an existing, still-open (current or scheduled) shift_base_pay_rules row -- a data-entry-mistake fix, distinct from set_shift_base_pay_rate''s "schedule a genuine future change" (Checkpoint B). Never touches effective_from/effective_to/is_active, so it can never fabricate a fake historical period. Rejects (55006) an attempt to correct an already-closed period. Audited via the table''s existing generic trigger (before/after base_pay_chf).';

revoke execute on function correct_shift_base_pay_rate(uuid, uuid, uuid, numeric) from public;
grant execute on function correct_shift_base_pay_rate(uuid, uuid, uuid, numeric) to authenticated;

-- =======================================================================
-- 2. CORRECT_DRIVER_DELIVERY_RATE -- same shape, keyed by driver_id.
-- =======================================================================
create function correct_driver_delivery_rate(
  p_driver_id uuid,
  p_rule_id uuid,
  p_new_rate_chf numeric
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
  v_rule driver_delivery_rates%rowtype;
begin
  perform assert_active_manager();

  if p_new_rate_chf is null or p_new_rate_chf < 0 then
    raise exception 'Delivery rate cannot be negative.' using errcode = '23514';
  end if;

  select * into v_rule
  from driver_delivery_rates
  where id = p_rule_id
    and driver_id = p_driver_id
    and is_active;

  if not found then
    raise exception 'That delivery rate could not be found for this driver.' using errcode = 'P0002';
  end if;

  if v_rule.effective_to is not null then
    raise exception 'Only the current or an upcoming scheduled rate can be corrected here -- a closed historical period is not editable.' using errcode = '55006';
  end if;

  -- FUTURE FINALISATION GUARD -- see migration header. Nothing to check yet.

  update driver_delivery_rates
    set rate_chf = p_new_rate_chf
    where id = p_rule_id;

  return query
  select r.id, r.resort_id, r.driver_id, r.rate_chf, r.effective_from, r.effective_to
  from driver_delivery_rates r where r.id = p_rule_id;
end;
$$;

comment on function correct_driver_delivery_rate(uuid, uuid, numeric) is
  'Manager-only, atomic. Corrects the AMOUNT of an existing, still-open (current or scheduled) driver_delivery_rates row -- see correct_shift_base_pay_rate''s comment for the full reasoning (identical shape, keyed by driver instead of Shift).';

revoke execute on function correct_driver_delivery_rate(uuid, uuid, numeric) from public;
grant execute on function correct_driver_delivery_rate(uuid, uuid, numeric) to authenticated;
