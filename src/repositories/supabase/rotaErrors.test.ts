import { describe, expect, it } from 'vitest';
import {
  AutoRotaError,
  AvailabilityOverrideRequiredError,
  PublishRotaConfirmationRequiredError,
  PublishRotaError,
  RepositoryError,
  RotaAssignmentError,
  isAvailabilityOverrideRequired,
  isPublishRotaConfirmationRequired,
  isPublishRotaError,
  isRotaAssignmentError,
  type PostgrestLikeError,
} from '../errors';
import { mapAutoRotaRpcError, mapPublishRotaRpcError, mapRotaRpcError } from './rotaErrors';

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

describe('mapAutoRotaRpcError (apply_auto_rota contract)', () => {
  it.each([
    ['VD002', 'stale_plan', 'stale_plan'],
    ['55006', 'published_week', 'published_week'],
    ['55006', 'historical_week', 'historical_week'],
    ['55006', 'historical_shift', 'historical_shift'],
    ['42501', null, 'permission_denied'],
    ['P0002', null, 'resort_not_found'],
    ['22023', null, 'invalid_week'],
    ['22023', 'plan_malformed', 'invalid_plan'],
    ['22023', 'plan_shift_not_in_week', 'invalid_plan'],
    ['22023', 'plan_driver_not_in_resort', 'invalid_plan'],
    // Unrecognised combinations are never mistaken for a known state.
    ['VD002', 'other', 'unknown'],
    ['VD002', null, 'unknown'],
    ['55006', 'attendance_recorded', 'unknown'],
    ['55006', null, 'unknown'],
    ['XX000', null, 'unknown'],
  ] as const)('%s / %s -> %s', (code, detail, kind) => {
    const mapped = mapAutoRotaRpcError('rota.generateAutoRota', err(code, detail));
    expect(mapped).toBeInstanceOf(AutoRotaError);
    expect(mapped.kind).toBe(kind);
    expect(mapped.code).toBe(code);
    // The manager-facing text is first-party: no SQLSTATE, DETAIL token or database wording.
    expect(mapped.userMessage).not.toMatch(/VD002|55006|42501|P0002|22023|XX000|stale_plan|plan_malformed|db message/);
  });

  it('keeps the original error as the (log-only) cause', () => {
    const original = err('VD002', 'stale_plan');
    expect(mapAutoRotaRpcError('rota.generateAutoRota', original).cause).toBe(original);
  });
});

describe('mapPublishRotaRpcError (publish_rota, PB-A contract)', () => {
  const map = (code: string, details: string | null, message = 'db message') => mapPublishRotaRpcError('rota.publishRota', err(code, details, message));

  describe('VD003 (confirmation required)', () => {
    it.each([['1', 1], ['2', 2], ['17', 17], ['1000', 1000]])('VD003 + %j -> typed confirmation-required carrying %i uncovered slots', (details, count) => {
      const e = map('VD003', details);
      expect(e).toBeInstanceOf(PublishRotaConfirmationRequiredError);
      expect(isPublishRotaConfirmationRequired(e)).toBe(true);
      expect(isPublishRotaError(e)).toBe(false);
      expect((e as PublishRotaConfirmationRequiredError).uncoveredSlots).toBe(count);
      expect(e.code).toBe('VD003');
    });

    it('reads the count from DETAIL only -- a number in the message is never used', () => {
      const e = map('VD003', '2', '9 position(s) in this week are still uncovered.') as PublishRotaConfirmationRequiredError;
      expect(e.uncoveredSlots).toBe(2);
      const noDetail = map('VD003', null, '9 position(s) in this week are still uncovered.');
      expect(isPublishRotaConfirmationRequired(noDetail)).toBe(false);
      expect(isPublishRotaError(noDetail, 'unknown')).toBe(true);
    });

    it.each([[''], ['0'], ['-1'], ['2.5'], ['abc'], ['01'], [' 3'], ['3 '], ['1e3'], ['+2'], ['99999999999999999999'], [null]])(
      'VD003 + invalid DETAIL (%j) is NEVER a fake count: it becomes the generic unknown error',
      (details) => {
        const e = map('VD003', details);
        expect(isPublishRotaConfirmationRequired(e)).toBe(false);
        expect(isPublishRotaError(e, 'unknown')).toBe(true);
      }
    );

    it('exposes first-party copy, with correct singular / plural', () => {
      expect((map('VD003', '1') as PublishRotaConfirmationRequiredError).userMessage).toBe('1 position is still uncovered.');
      expect((map('VD003', '3') as PublishRotaConfirmationRequiredError).userMessage).toBe('3 positions are still uncovered.');
    });
  });

  describe('every other contract outcome', () => {
    it.each([
      ['55006', 'historical_week', 'historical_week'],
      ['23514', 'no_shifts', 'no_shifts'],
      ['23514', 'resort_inactive', 'resort_inactive'],
      ['P0002', null, 'resort_not_found'],
      ['22023', null, 'invalid_week'],
      ['42501', null, 'permission_denied'],
    ])('%s + DETAIL %j -> kind %s', (code, details, kind) => {
      const e = map(code, details);
      expect(e).toBeInstanceOf(PublishRotaError);
      expect(isPublishRotaError(e, kind as never)).toBe(true);
      expect(isPublishRotaConfirmationRequired(e)).toBe(false);
      expect(e.code).toBe(code);
    });

    it.each([
      ['23514', null], ['23514', 'something_else'], ['23514', 'NO_SHIFTS'], ['23514', ''],
      ['55006', null], ['55006', 'published_week'], ['55006', 'historical_shift'], ['55006', 'attendance_recorded'],
      ['22023', 'plan_malformed'], ['22023', 'anything'],
      ['VD001', 'unavailable'], ['VD002', 'stale_plan'], ['23505', null], ['XX000', null], ['PGRST301', null], ['', null],
    ])('%s + DETAIL %j is unexpected -> unknown (never mistaken for a known outcome)', (code, details) => {
      const e = map(code, details);
      expect(isPublishRotaError(e, 'unknown')).toBe(true);
    });

    it('a missing code is unknown too', () => {
      expect(isPublishRotaError(mapPublishRotaRpcError('rota.publishRota', { message: 'network down' }), 'unknown')).toBe(true);
    });

    it('does not guess from the friendly message text', () => {
      expect(isPublishRotaError(map('23514', null, 'This resort is inactive, so its rota can’t be published.'), 'unknown')).toBe(true);
      expect(isPublishRotaError(map('55006', null, 'This week is in the past, so it can’t be published.'), 'unknown')).toBe(true);
      expect(isPublishRotaError(map('23514', 'no_shifts', 'whatever'), 'no_shifts')).toBe(true);
    });
  });

  describe('what callers see', () => {
    it('keeps the original PostgREST error as cause and exposes only first-party copy, never DB text', () => {
      const e = map('55006', 'historical_week', 'raw db text rota_publications_resort_week_unique');
      expect(e.cause).toMatchObject({ code: '55006', details: 'historical_week' });
      expect(e.userMessage).toBe('This rota can’t be published because the week is in the past.');
      expect(e.userMessage).not.toMatch(/55006|rota_publications|historical_week|VD003/);
    });

    it.each([
      ['55006', 'historical_week', 'This rota can’t be published because the week is in the past.'],
      ['23514', 'no_shifts', 'This rota can’t be published because there are no shifts this week.'],
      ['23514', 'resort_inactive', 'This rota can’t be published because this resort is inactive.'],
      ['42501', null, 'You don’t have permission to publish this rota.'],
      ['22023', null, 'This rota week is invalid.'],
      ['XX000', null, 'Couldn’t publish the rota. Please try again.'],
    ])('%s / %j -> "%s"', (code, details, message) => {
      expect(map(code, details).userMessage).toBe(message);
    });

    it('the operation is carried through for logging', () => {
      expect(map('VD003', '2').operation).toBe('rota.publishRota');
      expect(map('42501', null).operation).toBe('rota.publishRota');
    });
  });
});
