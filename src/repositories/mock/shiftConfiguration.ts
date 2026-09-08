import type { ShiftConfigurationRepository } from '../types';
import type { ShiftInstanceRecord, ShiftTemplateRecord, ShiftTypeRecord } from '../domain';
import { RepositoryError } from '../errors';
import { mockShiftTemplates, mockShiftTypes, nextMockShiftTemplateId, nextMockShiftTypeId } from './fixtures';
import { generateMockShiftInstancesForWeek } from './shiftInstances';

export class MockShiftConfigurationRepository implements ShiftConfigurationRepository {
  async listShiftTypes(resortId: string): Promise<ShiftTypeRecord[]> {
    return mockShiftTypes.filter((t) => t.resortId === resortId);
  }

  async listShiftTemplates(shiftTypeId: string): Promise<ShiftTemplateRecord[]> {
    return mockShiftTemplates.filter((t) => t.shiftTypeId === shiftTypeId);
  }

  async listShiftInstances(params: { resortId: string; weekStart: string }): Promise<ShiftInstanceRecord[]> {
    return generateMockShiftInstancesForWeek(params.resortId, params.weekStart);
  }

  async createShiftType(input: { resortId: string; key: string; name: string; sortOrder: number }): Promise<ShiftTypeRecord> {
    const record: ShiftTypeRecord = { id: nextMockShiftTypeId(), resortId: input.resortId, key: input.key, name: input.name, sortOrder: input.sortOrder, isActive: true };
    mockShiftTypes.push(record);
    return record;
  }

  async renameShiftType(shiftTypeId: string, name: string): Promise<ShiftTypeRecord> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId);
    if (!shiftType) throw new RepositoryError(`shift type ${shiftTypeId} not found`, { operation: 'shiftConfiguration.renameShiftType' });
    shiftType.name = name;
    return shiftType;
  }

  async deactivateShiftType(shiftTypeId: string): Promise<ShiftTypeRecord> {
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId);
    if (!shiftType) throw new RepositoryError(`shift type ${shiftTypeId} not found`, { operation: 'shiftConfiguration.deactivateShiftType' });
    shiftType.isActive = false;
    return shiftType;
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
    return record;
  }

  async deactivateShiftTemplate(templateId: string, effectiveTo: string): Promise<ShiftTemplateRecord> {
    const template = mockShiftTemplates.find((t) => t.id === templateId);
    if (!template) throw new RepositoryError(`shift template ${templateId} not found`, { operation: 'shiftConfiguration.deactivateShiftTemplate' });
    template.effectiveTo = effectiveTo;
    template.isActive = false;
    return template;
  }
}
