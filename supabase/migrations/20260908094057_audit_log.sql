-- 15_audit_log
--
-- Append-only audit trail, written exclusively by database triggers (never
-- relying on repository/React code to remember to log anything). Answers:
-- what changed, what operation, who, when, before/after, which fields, and
-- whether the change was user/service/system initiated.

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_role text,
  actor_source text not null check (actor_source in ('user', 'service', 'system')),
  before jsonb,
  after jsonb,
  changed_fields text[],
  occurred_at timestamptz not null default now()
);

comment on table audit_log is
  'Append-only. Written only by audit_log_row_change() triggers. No client role has INSERT/UPDATE/DELETE; managers get SELECT via RLS (migration 16), drivers get none.';

create index audit_log_table_row_idx on audit_log (table_name, row_id);
create index audit_log_occurred_at_idx on audit_log (occurred_at);

-- ---------------------------------------------------------------------
-- Generic trigger body, attached per-table below.
-- ---------------------------------------------------------------------
-- SECURITY DEFINER + owned by postgres: lets the trigger write to
-- audit_log regardless of the firing role's own grants on that table (no
-- client role is ever granted INSERT on audit_log -- see migration 16).
-- Actor identity is taken from the verified Supabase auth context
-- (auth.uid()/auth.role()), never from any client-supplied column such as
-- a "created_by" field on the audited row.
create or replace function audit_log_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_row_id uuid;
  v_actor_user_id uuid;
  v_actor_role text;
  v_actor_source text;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old);
    v_after := null;
    v_row_id := old.id;
  elsif tg_op = 'INSERT' then
    v_before := null;
    v_after := to_jsonb(new);
    v_row_id := new.id;
  else
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
    v_row_id := new.id;
  end if;

  if tg_op = 'UPDATE' then
    select array_agg(a.key order by a.key) into v_changed
    from jsonb_each(v_after) a
    where a.value is distinct from (v_before -> a.key);
  else
    v_changed := null;
  end if;

  v_actor_user_id := auth.uid();
  v_actor_role := auth.role();
  v_actor_source := case
    when v_actor_user_id is not null then 'user'
    when v_actor_role = 'service_role' then 'service'
    else 'system'
  end;

  insert into audit_log (table_name, row_id, action, actor_user_id, actor_role, actor_source, before, after, changed_fields)
  values (tg_table_name, v_row_id, lower(tg_op), v_actor_user_id, v_actor_role, v_actor_source, v_before, v_after, v_changed);

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

comment on function audit_log_row_change() is
  'Generic AFTER INSERT/UPDATE/DELETE trigger body: writes one audit_log row per change. Actor comes from auth.uid()/auth.role(), never a client-supplied column.';

do $$
declare
  t text;
begin
  foreach t in array array[
    'app_users', 'drivers', 'driver_onfleet_mappings', 'shift_types',
    'shift_templates', 'shift_instances', 'rota_publications',
    'rota_assignments', 'attendance', 'payroll_adjustments'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function audit_log_row_change();',
      t || '_audit_trg', t
    );
  end loop;
end $$;

-- No client role -- including authenticated -- gets any write access.
-- The trigger above writes as its SECURITY DEFINER owner (postgres),
-- independent of these grants.
revoke all on audit_log from anon, authenticated;
grant select on audit_log to authenticated;
