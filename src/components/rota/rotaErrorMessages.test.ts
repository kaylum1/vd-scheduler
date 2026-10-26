import { describe, expect, it } from 'vitest';
import { describeRotaError } from './rotaErrorMessages';
import { RotaAssignmentError } from '../../repositories/errors';

const err = (kind: ConstructorParameters<typeof RotaAssignmentError>[0], message = 'db text') => new RotaAssignmentError(kind, message, { operation: 'rota.unassignDriver', code: '55006' });

describe('describeRotaError: attendance vs check-in on removal', () => {
  it('a recorded check-in has its own manager copy and refreshes the week so the new evidence shows', () => {
    expect(describeRotaError(err('check_in_recorded'))).toEqual({
      message: 'This driver has already checked in, so this assignment can’t be removed.',
      shouldRefresh: true,
    });
  });

  it('the existing attendance copy and behaviour are unchanged, and the two are never merged', () => {
    const attendance = describeRotaError(err('attendance_recorded'));
    expect(attendance).toEqual({ message: 'This assignment can’t be removed because attendance has already been recorded.', shouldRefresh: false });
    expect(attendance.message).not.toBe(describeRotaError(err('check_in_recorded')).message);
  });
});
