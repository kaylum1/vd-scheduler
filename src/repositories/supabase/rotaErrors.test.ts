import { describe, expect, it } from 'vitest';
import {
  AvailabilityOverrideRequiredError,
  RepositoryError,
  RotaAssignmentError,
  isAvailabilityOverrideRequired,
  isRotaAssignmentError,
  type PostgrestLikeError,
} from '../errors';
import { mapRotaRpcError } from './rotaErrors';

const err = (code: string, details: string | null, message = 'db message'): PostgrestLikeError => ({ code, details, hint: null, message });

describe('mapRotaRpcError: VD001 (availability override required)', () => {
  it('VD001 + details=unavailable -> typed override-required, state unavailable', () => {
    const e = mapRotaRpcError('rota.assignDriver', err('VD001', 'unavailable'));
    expect(e).toBeInstanceOf(AvailabilityOverrideRequiredError);
    expect(isAvailabilityOverrideRequired(e)).toBe(true);
    expect((e as AvailabilityOverrideRequiredError).availabilityState).toBe('unavailable');
  });

  it('VD001 + details=not_submitted -> typed override-required, state not_submitted', () => {
    const e = mapRotaRpcError('rota.assignDriver', err('VD001', 'not_submitted'));
    expect(isAvailabilityOverrideRequired(e)).toBe(true);
    expect((e as AvailabilityOverrideRequiredError).availabilityState).toBe('not_submitted');
  });

  it('keeps the original PostgREST error as `cause` for logging, but exposes only a safe, first-party userMessage', () => {
    const e = mapRotaRpcError('rota.assignDriver', err('VD001', 'unavailable', 'some raw db text')) as AvailabilityOverrideRequiredError;
    expect(e.cause).toMatchObject({ code: 'VD001', details: 'unavailable' });
    expect(e.userMessage).toBe('This driver marked themselves unavailable for this shift.');
    expect(mapRotaRpcError('rota.assignDriver', err('VD001', 'not_submitted')).userMessage).toBe(
      'This driver has not submitted availability for this shift.'
    );
  });

  it.each([[null], ['weird'], ['UNAVAILABLE'], [''], ['available']])(
    'VD001 with an unrecognised DETAIL (%j) falls back to a generic error -- never silently treated as a known state',
    (details) => {
      const e = mapRotaRpcError('rota.assignDriver', err('VD001', details));
      expect(isAvailabilityOverrideRequired(e)).toBe(false);
      expect(e).not.toBeInstanceOf(RotaAssignmentError);
      expect(e).toBeInstanceOf(RepositoryError);
    }
  );

  it('is decided by the machine-readable DETAIL, never by parsing the human-readable message', () => {
    // The message says "unavailable" -- but with no DETAIL it must NOT be read as that state.
    const e = mapRotaRpcError('rota.assignDriver', err('VD001', null, 'This driver marked themselves unavailable for this shift.'));
    expect(isAvailabilityOverrideRequired(e)).toBe(false);
    // ...and a lying message cannot override a real DETAIL.
    const e2 = mapRotaRpcError('rota.assignDriver', err('VD001', 'not_submitted', 'This driver marked themselves unavailable for this shift.'));
    expect((e2 as AvailabilityOverrideRequiredError).availabilityState).toBe('not_submitted');
  });
});

describe('mapRotaRpcError: other assignment errors become stable typed errors', () => {
  const cases: Array<[string, string, string | null, 'rota.assignDriver' | 'rota.unassignDriver', string]> = [
    ['duplicate', '23505', null, 'rota.assignDriver', 'duplicate_assignment'],
    ['historical shift (assign)', '55006', 'historical_shift', 'rota.assignDriver', 'historical_shift'],
    ['historical shift (unassign)', '55006', 'historical_shift', 'rota.unassignDriver', 'historical_shift'],
    ['attendance recorded', '55006', 'attendance_recorded', 'rota.unassignDriver', 'attendance_recorded'],
    ['shift/driver not found (assign)', 'P0002', null, 'rota.assignDriver', 'not_found'],
    ['assignment not found (unassign)', 'P0002', null, 'rota.unassignDriver', 'assignment_not_found'],
    ['inactive driver / cross-resort / cancelled shift / long reason', '23514', null, 'rota.assignDriver', 'rule_violation'],
  ];

  it.each(cases)('%s -> RotaAssignmentError(kind=%s...)', (_label, code, details, operation, kind) => {
    const e = mapRotaRpcError(operation, err(code, details, 'First-party manager message.'));
    expect(isRotaAssignmentError(e)).toBe(true);
    expect(isRotaAssignmentError(e, kind as never)).toBe(true);
    expect((e as RotaAssignmentError).kind).toBe(kind);
    // The database's message is deliberately friendly first-party copy: it is what the manager sees.
    expect(e.userMessage).toBe('First-party manager message.');
    expect(e.code).toBe(code);
    expect(isAvailabilityOverrideRequired(e)).toBe(false);
  });

  it('55006 with an unrecognised or missing DETAIL is not mistaken for either known locked state', () => {
    for (const details of [null, 'something_else']) {
      const e = mapRotaRpcError('rota.unassignDriver', err('55006', details));
      expect(isRotaAssignmentError(e)).toBe(false);
      expect(e).toBeInstanceOf(RepositoryError);
    }
  });

  it('the guard can discriminate by kind', () => {
    const e = mapRotaRpcError('rota.assignDriver', err('23505', null));
    expect(isRotaAssignmentError(e, 'duplicate_assignment')).toBe(true);
    expect(isRotaAssignmentError(e, 'historical_shift')).toBe(false);
    expect(isRotaAssignmentError(new Error('plain'))).toBe(false);
    expect(isRotaAssignmentError(undefined)).toBe(false);
  });
});

describe('mapRotaRpcError: everything else stays generic and never leaks database text', () => {
  it('42501 (not a manager) -> generic RepositoryError with the standard permission message', () => {
    const e = mapRotaRpcError('rota.assignDriver', err('42501', null, 'not authorized'));
    expect(e).not.toBeInstanceOf(RotaAssignmentError);
    expect(e.code).toBe('42501');
    expect(e.userMessage).toBe('You do not have permission to do that.');
  });

  it('an unknown code -> generic RepositoryError whose userMessage is NOT the raw database message', () => {
    const e = mapRotaRpcError('rota.unassignDriver', err('XX000', null, 'internal: relation "rota_assignments" exploded'));
    expect(e).toBeInstanceOf(RepositoryError);
    expect(e.userMessage).toBe('Something went wrong. Please try again.');
    expect(e.userMessage).not.toMatch(/rota_assignments|exploded/);
  });
});
