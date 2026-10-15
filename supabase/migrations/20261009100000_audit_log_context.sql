-- Manual Rota MR-A, migration 1 of 2: audit_log.context.
--
-- The generic audit trigger records WHAT changed (before/after row, actor)
-- but not WHY or under what circumstances. Manual Rota needs the latter for
-- assignment actions -- e.g. "this driver was assigned while marked
-- unavailable, with the manager's explicit override and an optional reason".
-- That intent must NOT live on the business row (rota_assignments gets no
-- reason column), so it rides on the audit row instead.
--
-- Mechanism: a trusted SECURITY DEFINER RPC sets the transaction-local
-- setting `app.audit_context` to a JSON object immediately before its audited
-- write and clears it immediately afterwards. The trigger copies it into the
-- audit row's new `context` column.
--
-- Safety properties, each covered by supabase/tests/85_manual_rota_assignments.sql:
--   * Existing audit rows, and every audited write made WITHOUT a context
--     set, behave exactly as before (context = NULL).
--   * Unset, empty, or malformed (non-JSON / non-object) context never
--     blocks or fails the underlying write -- it is simply recorded as NULL.
--     An audit side-channel must never be able to break a business write.
--   * The setting is transaction-local (set_config(..., is_local => true)),
--     so it cannot outlive its transaction, and a subtransaction rollback
--     (e.g. a failed statement caught by an exception handler) reverts it.
--     RPCs additionally clear it themselves right after the write so a LATER
--     unrelated audited write in the same transaction cannot inherit it.
--   * Not client-settable: PostgREST exposes no way to set arbitrary GUCs, so
--     only database code (the RPCs) can supply it.
--   * Manager-only visibility is inherited, unchanged, from audit_log's
--     existing grants/RLS (managers SELECT; drivers have no access at all).

alter table audit_log add column context jsonb;

comment on column audit_log.context is
  'Optional, trusted-RPC-supplied operation context for this change (e.g. {"operation":"assign_driver","availability_state":"unavailable","availability_override":true,"reason":"..."}). NULL for ordinary audited writes and for every row that predates this column. Written only by audit_log_row_change() from the transaction-local setting app.audit_context -- never client-supplied. Manager-readable only, via audit_log''s existing access rules.';

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
  v_context_text text;
  v_context jsonb;
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

  -- Optional operation context. current_setting(..., true) returns NULL
  -- (not an error) when the setting was never defined in this session. The
  -- exception block (a subtransaction) is entered ONLY when there is
  -- actually something to parse, so the ordinary no-context write path pays
  -- nothing for it.
  v_context_text := nullif(btrim(coalesce(current_setting('app.audit_context', true), '')), '');
  if v_context_text is not null then
    begin
      v_context := v_context_text::jsonb;
      if jsonb_typeof(v_context) <> 'object' then
        v_context := null;
      end if;
    exception when others then
      v_context := null;
    end;
  end if;

  insert into audit_log (table_name, row_id, action, actor_user_id, actor_role, actor_source, before, after, changed_fields, context)
  values (tg_table_name, v_row_id, lower(tg_op), v_actor_user_id, v_actor_role, v_actor_source, v_before, v_after, v_changed, v_context);

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

comment on function audit_log_row_change() is
  'Generic AFTER INSERT/UPDATE/DELETE trigger body: writes one audit_log row per change. Actor comes from auth.uid()/auth.role(), never a client-supplied column. Optionally captures trusted-RPC operation context from the transaction-local setting app.audit_context into audit_log.context (NULL when unset/empty/malformed -- never fails the write).';
