import { afterEach } from 'vitest';

// Only relevant for jsdom-environment test files (React component tests) —
// guarded so plain node-environment test files aren't affected.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}
