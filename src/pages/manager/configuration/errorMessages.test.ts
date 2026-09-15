import { describe, expect, it } from 'vitest';
import { RepositoryError } from '../../../repositories/errors';
import { describeConfigurationError } from './errorMessages';

function repoError(code: string, message = 'boom') {
  return new RepositoryError(message, { operation: 'test', code });
}

describe('describeConfigurationError', () => {
  it('a non-RepositoryError gets a generic, safe message', () => {
    expect(describeConfigurationError(new Error('some raw thing'), 'shiftTemplate')).toBe('Something went wrong. Please try again.');
  });

  it('11: an overlap (exclusion_violation, 23P01) becomes a friendly, specific sentence naming the shift and day — never the raw constraint name', () => {
    const message = describeConfigurationError(repoError('23P01'), 'shiftTemplate', {
      shiftTypeName: 'Dinner',
      weekdayLabel: 'Saturday',
    });
    expect(message).toBe('There is already a Dinner schedule covering Saturday for these dates.');
    expect(message).not.toMatch(/exclusion|constraint|23P01/i);
  });

  it('an overlap error without detail still reads as a sentence, not a raw code', () => {
    const message = describeConfigurationError(repoError('23P01'), 'shiftTemplate');
    expect(message).toBe('There is already a shift schedule covering this day for these dates.');
  });

  it('a mock-mode-unsupported RPC (materialise/refresh/cancellation) gets a clear, actionable message', () => {
    const message = describeConfigurationError(repoError('mock_unsupported'), 'shiftTemplate');
    expect(message).toMatch(/supabase mode/i);
    expect(message).not.toMatch(/not supported in mock mode —/); // not the raw repository message verbatim
  });

  it('a shift-template effective-date ordering violation (23514, shiftTemplate context) is distinguished from the shift-type key/resort message sharing the same SQLSTATE', () => {
    const message = describeConfigurationError(repoError('23514'), 'shiftTemplate');
    expect(message).toMatch(/effective date must be after/i);
    expect(message).not.toMatch(/key and resort/i);
  });

  it('a shift-type deactivation blocked by an active template names the real reason', () => {
    expect(describeConfigurationError(repoError('55006'), 'shiftType')).toMatch(/active recurring template/i);
  });

  it('a duplicate shift-type key names the real reason', () => {
    expect(describeConfigurationError(repoError('23505'), 'shiftType')).toMatch(/key is already used/i);
  });
});

describe('describeConfigurationError: resort context (Stage 2D Checkpoint 4.1)', () => {
  it('a blank resort name is a clear, friendly sentence', () => {
    expect(describeConfigurationError(repoError('23514'), 'resort')).toBe('Give this resort a name.');
  });

  it('a not-found resort is a clear, friendly sentence', () => {
    expect(describeConfigurationError(repoError('P0002'), 'resort')).toMatch(/could not be found/i);
  });

  it('a deactivation blocked by active dependents passes through the RPC/mock message verbatim (it already names what is blocking)', () => {
    const message = describeConfigurationError(
      repoError('55006', 'resorts.deactivate failed: This resort still has 2 active drivers, 1 active shift. Retire these first, then try again.'),
      'resort'
    );
    expect(message).toBe('This resort still has 2 active drivers, 1 active shift. Retire these first, then try again.');
    expect(message).not.toMatch(/^resorts\.deactivate failed/);
  });

  it('the same 55006 message from mock mode (no "failed:" prefix to strip) passes through unchanged', () => {
    const message = describeConfigurationError(
      repoError('55006', 'This resort still has 1 active driver. Retire these first, then try again.'),
      'resort'
    );
    expect(message).toBe('This resort still has 1 active driver. Retire these first, then try again.');
  });

  it('a driver/anonymous rejection uses the generic permission message', () => {
    expect(describeConfigurationError(repoError('42501'), 'resort')).toMatch(/do not have permission/i);
  });
});
