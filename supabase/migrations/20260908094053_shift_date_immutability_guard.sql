-- 12_shift_date_immutability_guard
--
-- Newly confirmed rule: shift_instances.date is immutable for normal
-- manager workflows. Moving a shift to a different date is modelled as
-- "cancel the old instance, create a new one" -- never "update its date" --
-- because date participates in the shift's stable identity
-- (UNIQUE(resort_id, shift_type_id, date)), in week_start (generated from
-- date), in every driver's availability answers, and in the stale-
-- confirmation trigger's resort/week scoping. Silently moving a shift's
-- date would drag availability answers across weeks and make the
-- stale-confirmation logic (migration 11) non-deterministic.
--
-- ENFORCEMENT CHOICE: a plain BEFORE UPDATE trigger that rejects any
-- change to `date`, full stop -- not a CHECK constraint (CHECK constraints
-- can't compare OLD vs NEW) and not a conditional/role-aware guard. A
-- database CHECK/trigger can't tell "legitimate seed data load" apart from
-- "an app bug", and over-engineering a role-aware exception here would
-- weaken the guarantee for the one case (manager UPDATEs) it exists to
-- protect. If a migration or one-off data-correction script ever
-- genuinely needs to bulk-fix a date (not a normal workflow operation),
-- the standard Postgres escape hatch already covers it:
-- `set local session_replication_role = replica;` disables all triggers
-- for that transaction, including this one -- no extra plumbing needed,
-- and it is not something an application role can reach through the API.
create or replace function shift_instances_prevent_date_change()
returns trigger
language plpgsql
as $$
begin
  if new.date is distinct from old.date then
    raise exception 'shift_instances.date is immutable; cancel this shift and create a new one on the new date instead'
      using errcode = '23514'; -- check_violation
  end if;
  return new;
end;
$$;

comment on function shift_instances_prevent_date_change() is
  'Rejects any change to shift_instances.date. Moving a shift = cancel + create new, never an UPDATE. Bypassable only via session_replication_role=replica for genuine one-off data fixes (not reachable through the API).';

create trigger shift_instances_prevent_date_change_trg
  before update on shift_instances
  for each row
  execute function shift_instances_prevent_date_change();
