import type { ShiftConfigurationRepository } from '../types';
import type {
  ApplyTemplateCancellationResult,
  ApplyTemplateRefreshResult,
  MaterialiseShiftsResult,
  ShiftInstanceRecord,
  ShiftTemplateRecord,
  ShiftTypeRecord,
  TemplateCancellationPreviewRow,
  TemplateRefreshPreviewRow,
} from '../domain';
import { RepositoryError } from '../errors';
import { mockShiftTemplates, mockShiftTypes, nextMockShiftTemplateId, nextMockShiftTypeId } from './fixtures';
import { generateMockShiftInstancesForWeek } from './shiftInstances';

/**
 * Materialisation/template-refresh/cancellation are manager-console-grade
 * operations (governing-template resolution across a date range, safety-
 * gated snapshot diffing, audit-linked cancellation) that only mean
 * anything against the real database functions — see Stage 2C. Faking a
 * second implementation of that logic here would be exactly the kind of
 * DB-logic duplication the Supabase repository is required to avoid, just
 * moved to the mock side instead of solving the problem. Since nothing
 * consumes these yet (not wired into Configuration UI), a clear "not
 * supported" error is more honest than a shallow, untested simulation —
 * consistent with how MockAuthService.signIn() throws for operations mock
 * mode has no real equivalent for.
 */
function notSupportedInMockMode(operation: string): never {
  throw new RepositoryError(`${operation} is not supported in mock mode — use VITE_DATA_PROVIDER=supabase.`, { operation });
}

export class MockShiftConfigurationRepository implements ShiftConfigurationRepository {
  async listShiftTypes(resortId: string): Promise<ShiftTypeRecord[]> {
    // Shallow copies, not the live fixture objects — rename/reorder/
    // deactivate mutate mockShiftTypes entries in place, and a consumer
    // relying on TanStack Query's structural sharing needs genuinely new
    // objects to detect a change between fetches (see the identical note on
    // MockDriverRepository.listDrivers).
    return mockShiftTypes.filter((t) => t.resortId === resortId).map((t) => ({ ...t }));
  }

  async listShiftTemplates(shiftTypeId: string): Promise<ShiftTemplateRecord[]> {
    return mockShiftTemplates.filter((t) => t.shiftTypeId === shiftTypeId).map((t) => ({ ...t }));
  }

  async listShiftInstances(params: { resortId: string; weekStart: string }): Promise<ShiftInstanceRecord[]> {
    return generateMockShiftInstancesForWeek(params.resortId, params.weekStart);
  }

  async createShiftType(input: { resortId: string; key: string; name: string; sortOrder: number }): Promise<ShiftTypeRecord> {
    // Mirrors shift_types_resort_key_unique (migration 05) so mock mode
    // rejects the same case the real database would, rather than silently
    // allowing two shift types with the same key at one resort.
    const duplicate = mockShiftTypes.some((t) => t.resortId === input.resortId && t.key === input.key);
    if (duplicate) {
      throw new RepositoryError(`shift type key "${input.key}" already exists at this resort`, {
        operation: 'shiftConfiguration.createShiftType',
        code: '23505',
      });
    }
    const record: ShiftTypeRecord = { id: nextMockShiftTypeId(), resortId: input.resortId, key: input.key, name: input.name, sortOrder: input.sortOrder, isActive: true };
    mockShiftTypes.push(record);
    return { ...record };
  }

  async renameShiftType(shiftTypeId: string, name: string): Promise<ShiftTypeRecord> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId);
    if (!shiftType) throw new RepositoryError(`shift type ${shiftTypeId} not found`, { operation: 'shiftConfiguration.renameShiftType' });
    shiftType.name = name;
    return { ...shiftType };
  }

  async reorderShiftType(shiftTypeId: string, sortOrder: number): Promise<ShiftTypeRecord> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId);
    if (!shiftType) throw new RepositoryError(`shift type ${shiftTypeId} not found`, { operation: 'shiftConfiguration.reorderShiftType' });
    shiftType.sortOrder = sortOrder;
    return { ...shiftType };
  }

  async deactivateShiftType(shiftTypeId: string): Promise<ShiftTypeRecord> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId);
    if (!shiftType) throw new RepositoryError(`shift type ${shiftTypeId} not found`, { operation: 'shiftConfiguration.deactivateShiftType' });
    // Mirrors shift_types_prevent_unsafe_deactivation_trg (Stage 2D
    // Checkpoint 1 guard): never orphan an active recurring template.
    const activeTemplateCount = mockShiftTemplates.filter((t) => t.shiftTypeId === shiftTypeId && t.isActive).length;
    if (activeTemplateCount > 0) {
      throw new RepositoryError(
        `shift type ${shiftTypeId} has ${activeTemplateCount} active recurring template(s); deactivate those first`,
        { operation: 'shiftConfiguration.deactivateShiftType', code: '55006' }
      );
    }
    shiftType.isActive = false;
    return { ...shiftType };
  }

  async createShiftTemplateVersion(input: {
    shiftTypeId: string;
    resortId: string;
    weekday: number;
    startTime: string;
    endTime: string;
    requiredDrivers: number;
    basePayChf: number;
    deliveryRateChf: number;
    isPremium: boolean;
    effectiveFrom: string;
  }): Promise<ShiftTemplateRecord> {
    const record: ShiftTemplateRecord = {
      id: nextMockShiftTemplateId(),
      resortId: input.resortId,
      shiftTypeId: input.shiftTypeId,
      weekday: input.weekday,
      startTime: input.startTime,
      endTime: input.endTime,
      requiredDrivers: input.requiredDrivers,
      basePayChf: input.basePayChf,
      deliveryRateChf: input.deliveryRateChf,
      isPremium: input.isPremium,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      isActive: true,
    };
    mockShiftTemplates.push(record);
    return { ...record };
  }

  async deactivateShiftTemplate(templateId: string, effectiveTo: string): Promise<ShiftTemplateRecord> {
    const template = mockShiftTemplates.find((t) => t.id === templateId);
    if (!template) throw new RepositoryError(`shift template ${templateId} not found`, { operation: 'shiftConfiguration.deactivateShiftTemplate' });
    template.effectiveTo = effectiveTo;
    template.isActive = false;
    return { ...template };
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
