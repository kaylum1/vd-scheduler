-- Live Driver My Rota, checkpoint LD-A: a driver-safe publication signal.
--
-- Driver My Rota must tell "this week is not published yet" apart from
-- "this week is published and I have no shifts". driver_visible_assignments
-- alone cannot (both are zero rows), so drivers need to know whether their
-- resort's week is currently published -- and nothing more.
--
-- Until now the only way for a driver to learn that was a direct SELECT on
-- rota_publications (policy rota_publications_driver_select_own_resort),
-- which also exposes published_by (a manager's app_users id),
-- generation_source and both timestamps. This migration:
--
--   1. adds driver_visible_week_publications, a minimal view
--      (resort_id, week_start) -- one row per CURRENTLY published week of the
--      calling driver's OWN resort, nothing else; and
--   2. removes the drivers' direct read of rota_publications, so the view is
--      the single supported driver publication surface.
--
-- MECHANISM: identical to driver_visible_shifts / driver_visible_assignments
-- (migration 17): the view is NOT security_invoker, so it reads the base table
-- with its owner's privileges, and its own WHERE clause resolves the caller
-- from the session (auth.uid() -> app_users -> driver) through
-- current_app_user(). There is deliberately no parameter, no driver_id and no
-- resort_id input anywhere: a client cannot ask about another resort.
--
-- "Currently published" uses the same predicate as every other publication
-- check in the schema (week_availability_status, the availability RLS helper
-- shift_instance_week_is_published, driver_visible_assignments):
-- published_at is not null and unpublished_at is null. No second
-- publication-state model is introduced; an unpublished week's row simply
-- disappears from the view.
--
-- Nothing else depends on the dropped driver policy: the availability RPCs
-- (week_availability_status, confirm_availability_week,
-- reopen_availability_week) and shift_instance_week_is_published (which backs
-- the driver availability write policies) are all SECURITY DEFINER, and the
-- two existing driver views read rota_publications as their owner. Manager
-- access is untouched (rota_publications_manager_all). The helper
-- current_driver_resort_id() is left in place; it is simply no longer used by
-- a rota_publications policy.

create view driver_visible_week_publications
with (security_invoker = false)
as
select
  rp.resort_id,
  rp.week_start
from rota_publications rp
where rp.published_at is not null
  and rp.unpublished_at is null
  and exists (
    select 1 from current_app_user() cau
    where cau.role = 'driver' and cau.is_active and cau.resort_id = rp.resort_id
  );

comment on view driver_visible_week_publications is
  'Driver-safe publication status: one row (resort_id, week_start) per CURRENTLY published week of the calling driver''s own resort. A row means published; no row means not published. Exposes no publication id, published_by, generation_source or timestamps, and takes no driver/resort input -- the session decides.';

revoke all on driver_visible_week_publications from anon, authenticated;
grant select on driver_visible_week_publications to authenticated;

-- Drivers no longer read rota_publications directly (they keep zero access:
-- RLS is FORCEd and the only remaining policy is the manager one).
drop policy rota_publications_driver_select_own_resort on rota_publications;
