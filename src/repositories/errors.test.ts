import { describe, expect, it } from 'vitest';
import { RepositoryError, unwrap } from './errors';

describe('unwrap', () => {
  it('returns data on success', async () => {
    const result = await unwrap('test.op', Promise.resolve({ data: [1, 2, 3], error: null }));
    expect(result).toEqual([1, 2, 3]);
  });

  it('throws a RepositoryError carrying the operation and code on failure, instead of a raw Supabase error', async () => {
    await expect(
      unwrap(
        'drivers.deactivate',
        Promise.resolve({ data: null, error: { message: 'permission denied for table drivers', code: '42501' } })
      )
    ).rejects.toMatchObject({
      name: 'RepositoryError',
      operation: 'drivers.deactivate',
      code: '42501',
    });
  });

  it('throws when data is unexpectedly null despite no error, rather than silently returning null as T', async () => {
    await expect(unwrap('test.op', Promise.resolve({ data: null, error: null }))).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('RepositoryError.userMessage', () => {
  it('gives a generic, safe message that never leaks the raw DB detail', () => {
    const err = new RepositoryError('drivers.deactivate failed: permission denied for table drivers', {
      operation: 'drivers.deactivate',
      code: '42501',
    });
    expect(err.userMessage).not.toContain('table drivers');
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('still retains the original cause and code for developers/logging', () => {
    const cause = { message: 'boom', code: 'XX000' };
    const err = new RepositoryError('x failed', { operation: 'x', code: 'XX000', cause });
    expect(err.cause).toBe(cause);
    expect(err.code).toBe('XX000');
    expect(err.operation).toBe('x');
  });
});
