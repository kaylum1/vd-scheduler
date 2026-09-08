import { describe, expect, it } from 'vitest';
import { MockShiftConfigurationRepository } from './shiftConfiguration';
import { RepositoryError } from '../errors';

describe('MockShiftConfigurationRepository: Stage 2C manager operations', () => {
  const repo = new MockShiftConfigurationRepository();

  it('materialiseShifts throws a clear RepositoryError rather than faking DB logic', async () => {
    await expect(repo.materialiseShifts('r1')).rejects.toBeInstanceOf(RepositoryError);
    await expect(repo.materialiseShifts('r1')).rejects.toThrow(/not supported in mock mode/i);
  });

  it('previewTemplateRefresh / applyTemplateRefresh throw the same way', async () => {
    await expect(repo.previewTemplateRefresh('r1')).rejects.toThrow(/not supported in mock mode/i);
    await expect(repo.applyTemplateRefresh('r1')).rejects.toThrow(/not supported in mock mode/i);
  });

  it('previewTemplateCancellation / applyTemplateCancellation throw the same way', async () => {
    await expect(repo.previewTemplateCancellation('r1')).rejects.toThrow(/not supported in mock mode/i);
    await expect(repo.applyTemplateCancellation('r1')).rejects.toThrow(/not supported in mock mode/i);
  });
});
