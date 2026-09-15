import type { ShiftConfigurationRepository, ShiftScheduleInput } from '../types';
import type {
  ApplyTemplateCancellationResult,
  ApplyTemplateRefreshResult,
  MaterialiseShiftsResult,
  ShiftInstanceRecord,
  ShiftRecord,
  ShiftTemplateRecord,
  TemplateCancellationPreviewRow,
  TemplateRefreshPreviewRow,
} from '../domain';
import { RepositoryError } from '../errors';
import { assembleShifts } from '../assembleShift';
import { mockShiftTemplates, mockShiftTypes, nextMockShiftTemplateId, nextMockShiftTypeId } from './fixtures';
import { generateMockShiftInstancesForWeek } from './shiftInstances';

/**
 * Materialisation/template-refresh/cancellation are manager-console-grade
 * operations (governing-template resolution across a date range, safety-
 * gated snapshot diffing, audit-linked cancellation) that only mean
 * anything against the real database functions — see Stage 2C. Faking a
 * second implementation of that logic here would be exactly the kind of
 * DB-logic duplication the Supabase repository is required to avoid, just
 * moved to the mock side instead of solving the problem. A clear "not
 * supported" error is more honest than a shallow, untested simulation —
 * consistent with how MockAuthService.signIn() throws for operations mock
 * mode has no real equivalent for.
 */
function notSupportedInMockMode(operation: string): never {
  throw new RepositoryError(`${operation} is not supported in mock mode — use VITE_DATA_PROVIDER=supabase.`, {
    operation,
    code: 'mock_unsupported',
  });
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'shift';
}

/** Mirrors create_shift's own server-side key generation (auto-suffix on collision) closely enough for mock/demo use — never asks the manager for a key, never rejects a duplicate name. */
function generateMockShiftKey(resortId: string, name: string): string {
  const base = slugify(name);
  const existing = new Set(mockShiftTypes.filter((t) => t.resortId === resortId).map((t) => t.key));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One shared, always-increasing "updatedAt" per repository call -- every
 * row a single create/revise/deactivate/reactivate call touches (retires
 * or inserts) gets the SAME value, and each call's value is strictly
 * greater than every previous call's, mirroring the real RPCs each being
 * one transaction. This is what lets assembleShift's "last known
 * schedule" reconstruction for an inactive shift tell apart two different
 * retirement events even when they share a calendar-date effectiveTo (see
 * assembleShift.ts's doc comment).
 *
 * A monotonic counter rather than `new Date().toISOString()`: two mock
 * calls made back-to-back in the same synchronous test can land in the
 * same millisecond, which would silently reintroduce the exact ambiguity
 * this field exists to resolve. Real Postgres transactions never have
 * that problem (each is a separate network round trip), so this is a
 * mock-only concern -- the value's shape (an ISO string) is preserved
 * purely so ShiftTemplateRecord.updatedAt has one honest type across both
 * providers; nothing ever parses it as a real instant.
 */
let mockUpdatedAtSeq = 0;
function nowIso(): string {
  mockUpdatedAtSeq += 1;
  return new Date(mockUpdatedAtSeq).toISOString();
}

function validateScheduleInput(input: ShiftScheduleInput, operation: string): void {
  if (!input.name.trim()) {
    throw new RepositoryError('A shift needs a name.', { operation, code: '23514' });
  }
  if (!input.weekdays || input.weekdays.length === 0) {
    throw new RepositoryError('Select at least one day of the week.', { operation, code: '23514' });
  }
  if (input.endTime <= input.startTime) {
    throw new RepositoryError('End time must be after start time.', { operation, code: '23514' });
  }
  if (!input.requiredDrivers || input.requiredDrivers < 1) {
    throw new RepositoryError('At least 1 driver is required.', { operation, code: '23514' });
  }
}

export class MockShiftConfigurationRepository implements ShiftConfigurationRepository {
  async listShifts(resortId: string): Promise<ShiftRecord[]> {
    const shiftTypes = mockShiftTypes.filter((t) => t.resortId === resortId).map((t) => ({ ...t }));
    const templatesByType = new Map<string, ShiftTemplateRecord[]>(
      shiftTypes.map((t) => [t.id, mockShiftTemplates.filter((tpl) => tpl.shiftTypeId === t.id).map((tpl) => ({ ...tpl }))])
    );
    return assembleShifts(shiftTypes, templatesByType);
  }

  async listShiftInstances(params: { resortId: string; weekStart: string }): Promise<ShiftInstanceRecord[]> {
    return generateMockShiftInstancesForWeek(params.resortId, params.weekStart);
  }

  async createShift(resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }> {
    validateScheduleInput(input, 'shiftConfiguration.createShift');

    const key = generateMockShiftKey(resortId, input.name);
    const nextSortOrder = mockShiftTypes.filter((t) => t.resortId === resortId).reduce((max, t) => Math.max(max, t.sortOrder), 0) + 1;
    const shiftTypeId = nextMockShiftTypeId();
    mockShiftTypes.push({ id: shiftTypeId, resortId, key, name: input.name.trim(), sortOrder: nextSortOrder, isActive: true });

    const effectiveFrom = input.effectiveFrom ?? todayIso();
    const updatedAt = nowIso();
    for (const weekday of input.weekdays) {
      mockShiftTemplates.push({
        id: nextMockShiftTemplateId(),
        resortId,
        shiftTypeId,
        weekday,
        startTime: input.startTime,
        endTime: input.endTime,
        requiredDrivers: input.requiredDrivers,
        basePayChf: null,
        deliveryRateChf: null,
        isPremium: null,
        effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        isActive: true,
        updatedAt,
      });
    }
    return { shiftTypeId };
  }

  async reviseShift(shiftTypeId: string, resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId);
    if (!shiftType) throw new RepositoryError('Shift not found.', { operation: 'shiftConfiguration.reviseShift', code: 'P0002' });
    if (!shiftType.isActive) {
      throw new RepositoryError('An inactive shift must be reactivated before it can be revised.', {
        operation: 'shiftConfiguration.reviseShift',
        code: '55006',
      });
    }
    validateScheduleInput(input, 'shiftConfiguration.reviseShift');

    shiftType.name = input.name.trim();
    const effectiveFrom = input.effectiveFrom ?? todayIso();
    const updatedAt = nowIso();

    // Simplified relative to the real revise_shift RPC: every weekday's
    // currently-active row (if any) is retired and replaced, rather than
    // updated in place when it hadn't started yet. That historical nuance
    // only matters for real production data integrity, not for exercising
    // the UI against mock data.
    for (const template of mockShiftTemplates) {
      if (template.shiftTypeId === shiftTypeId && template.isActive && !input.weekdays.includes(template.weekday)) {
        template.isActive = false;
        template.effectiveTo = effectiveFrom;
        template.updatedAt = updatedAt;
      }
    }
    for (const weekday of input.weekdays) {
      const current = mockShiftTemplates.find((t) => t.shiftTypeId === shiftTypeId && t.weekday === weekday && t.isActive);
      if (current) {
        current.isActive = false;
        current.effectiveTo = effectiveFrom;
        current.updatedAt = updatedAt;
      }
      mockShiftTemplates.push({
        id: nextMockShiftTemplateId(),
        resortId,
        shiftTypeId,
        weekday,
        startTime: input.startTime,
        endTime: input.endTime,
        requiredDrivers: input.requiredDrivers,
        basePayChf: null,
        deliveryRateChf: null,
        isPremium: null,
        effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        isActive: true,
        updatedAt,
      });
    }
    return { shiftTypeId };
  }

  async deactivateShift(shiftTypeId: string, _resortId: string, effectiveTo?: string): Promise<{ shiftTypeId: string }> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId && t.isActive);
    if (!shiftType) {
      throw new RepositoryError('Shift not found or already inactive.', { operation: 'shiftConfiguration.deactivateShift', code: 'P0002' });
    }
    const resolvedEffectiveTo = effectiveTo ?? todayIso();
    const updatedAt = nowIso();
    for (const template of mockShiftTemplates) {
      if (template.shiftTypeId === shiftTypeId && template.isActive) {
        template.isActive = false;
        template.effectiveTo = template.effectiveFrom > resolvedEffectiveTo ? template.effectiveFrom : resolvedEffectiveTo;
        template.updatedAt = updatedAt;
      }
    }
    shiftType.isActive = false;
    return { shiftTypeId };
  }

  async reactivateShift(shiftTypeId: string, resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId);
    if (!shiftType) throw new RepositoryError('Shift not found.', { operation: 'shiftConfiguration.reactivateShift', code: 'P0002' });
    if (shiftType.isActive) {
      throw new RepositoryError('This shift is already active.', { operation: 'shiftConfiguration.reactivateShift', code: '23514' });
    }
    if (input.endTime <= input.startTime) {
      throw new RepositoryError('End time must be after start time.', { operation: 'shiftConfiguration.reactivateShift', code: '23514' });
    }
    if (!input.weekdays || input.weekdays.length === 0) {
      throw new RepositoryError('Select at least one day of the week.', { operation: 'shiftConfiguration.reactivateShift', code: '23514' });
    }
    if (!input.requiredDrivers || input.requiredDrivers < 1) {
      throw new RepositoryError('At least 1 driver is required.', { operation: 'shiftConfiguration.reactivateShift', code: '23514' });
    }

    shiftType.isActive = true;
    const effectiveFrom = input.effectiveFrom ?? todayIso();
    const updatedAt = nowIso();
    // Every prior row is already inactive at this point -- always fresh
    // inserts, never flipping an old historical row back to active.
    for (const weekday of input.weekdays) {
      mockShiftTemplates.push({
        id: nextMockShiftTemplateId(),
        resortId,
        shiftTypeId,
        weekday,
        startTime: input.startTime,
        endTime: input.endTime,
        requiredDrivers: input.requiredDrivers,
        basePayChf: null,
        deliveryRateChf: null,
        isPremium: null,
        effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        isActive: true,
        updatedAt,
      });
    }
    return { shiftTypeId };
  }

  async materialiseShifts(_resortId: string, _fromDate?: string, _toDate?: string): Promise<MaterialiseShiftsResult> {
    notSupportedInMockMode('shiftConfiguration.materialiseShifts');
  }

  async previewTemplateRefresh(_resortId: string, _fromDate?: string): Promise<TemplateRefreshPreviewRow[]> {
    notSupportedInMockMode('shiftConfiguration.previewTemplateRefresh');
  }

  async applyTemplateRefresh(_resortId: string, _fromDate?: string): Promise<ApplyTemplateRefreshResult> {
    notSupportedInMockMode('shiftConfiguration.applyTemplateRefresh');
  }

  async previewTemplateCancellation(_resortId: string, _shiftTypeId?: string): Promise<TemplateCancellationPreviewRow[]> {
    notSupportedInMockMode('shiftConfiguration.previewTemplateCancellation');
  }

  async applyTemplateCancellation(
    _resortId: string,
    _shiftTypeId?: string,
    _reason?: string
  ): Promise<ApplyTemplateCancellationResult> {
    notSupportedInMockMode('shiftConfiguration.applyTemplateCancellation');
  }
}
