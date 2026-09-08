-- 17_driver_safe_views
--
-- Driver-facing views over shift_instances / rota_assignments. Drivers
-- have no SELECT grant on either base table (migration 16) -- these views
-- are the only way a driver session can see shift/rota data at all, and
-- they never expose is_premium, base_pay_chf, delivery_rate_chf,
-- required_drivers, template_id, origin, cancellation detail, or (for the
-- rota view) co-assigned colleagues.
--
-- MECHANISM: these views are created without `security_invoker`, which is
-- the Postgres default. That means access to the underlying base tables
-- is checked against the VIEW OWNER's privileges (postgres, which owns
-- shift_instances/rota_assignments and bypasses their RLS), not the
-- querying role's. The view's own WHERE clause still evaluates using the
-- actual caller's session (auth.uid() via current_app_user()), so it's
-- exactly as restrictive as intended -- this is the standard, deliberate
-- pattern for exposing a narrow, safe slice of a locked-down table.
-- Setting security_invoker=true here would defeat the purpose (drivers
-- would hit the same "no SELECT grant" wall the view exists to route
-- around), so it must stay off.

create view driver_visible_shifts
with (security_invoker = false)
as
select
  si.id,
  si.resort_id,
  si.date,
  si.week_start,
  si.shift_type_id,
  si.shift_key,
  si.name,
  si.sort_order,
  si.start_time,
  si.end_time,
  si.status
from shift_instances si
where si.status = 'active'
  and exists (
    select 1 from current_app_user() cau
    where cau.role = 'driver' and cau.is_active and cau.resort_id = si.resort_id
  );

comment on view driver_visible_shifts is
  'Driver-safe projection of shift_instances: active shifts in the calling driver''s own resort only. Never exposes is_premium/base_pay_chf/delivery_rate_chf/required_drivers/template_id/origin/cancellation fields.';

create view driver_visible_assignments
with (security_invoker = false)
as
select
  ra.id as assignment_id,
  si.id as shift_instance_id,
  si.resort_id,
  si.date,
  si.week_start,
  si.shift_key,
  si.name,
  si.start_time,
  si.end_time
from rota_assignments ra
join shift_instances si on si.id = ra.shift_instance_id
join rota_publications rp
  on rp.resort_id = si.resort_id
 and rp.week_start = si.week_start
 and rp.published_at is not null
 and rp.unpublished_at is null
where si.status = 'active'
  and exists (
    select 1 from current_app_user() cau
    where cau.role = 'driver' and cau.is_active and cau.driver_id = ra.driver_id
  );

comment on view driver_visible_assignments is
  'Driver-safe "My Rota": only the calling driver''s own assignments, only for published resort/weeks, only active shifts. No co-assigned driver identities, pay, premium, or headcount are exposed. A draft/unpublished assignment never appears here.';

revoke all on driver_visible_shifts from anon, authenticated;
revoke all on driver_visible_assignments from anon, authenticated;
grant select on driver_visible_shifts to authenticated;
grant select on driver_visible_assignments to authenticated;
