import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NotImplementedError } from '@app/core/deps';
import { AiError } from '@app/core/ai';
import { ConfigError } from '@app/core/env';
import { toActionError, UserError } from './errors';

describe('toActionError', () => {
  it('maps stub modules to a friendly "not available yet"', () => {
    expect(toActionError(new NotImplementedError('scheduling.schedulePosts'))).toEqual({
      ok: false,
      code: 'not_implemented',
      error: "Scheduling isn't available yet in this version of the app.",
    });
    expect(toActionError(new NotImplementedError('ai.refineField')).error).toMatch(/^AI writing/);
  });

  it('passes owner-facing messages through and keeps their codes', () => {
    expect(toActionError(new UserError('Upload incomplete', 'size_mismatch'))).toEqual({
      ok: false,
      code: 'size_mismatch',
      error: 'Upload incomplete',
    });
    const withMessage = Object.assign(new Error('internal'), { userMessage: 'Post is publishing' });
    expect(toActionError(withMessage).error).toBe('Post is publishing');
  });

  it('maps auth, validation, AI, config and version conflicts', () => {
    const unauthorized = Object.assign(new Error('Not signed in'), { name: 'UnauthorizedError' });
    expect(toActionError(unauthorized).code).toBe('unauthorized');
    const zerr = z.object({ id: z.uuid() }).safeParse({ id: 'x' }).error!;
    expect(toActionError(zerr)).toMatchObject({ code: 'validation' });
    expect(toActionError(new AiError('spend', 'limit')).error).toMatch(/spend limit/);
    expect(toActionError(new ConfigError('ANTHROPIC_API_KEY')).code).toBe('unavailable');
    const conflict = Object.assign(new Error('stale'), { name: 'VersionConflictError' });
    expect(toActionError(conflict).code).toBe('conflict');
    expect(toActionError(new Error('version mismatch for target')).code).toBe('conflict');
  });

  it('hides unknown errors and logs them', () => {
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const res = toActionError(new Error('relation "x" does not exist; token=abc'), log, 'test');
    expect(res).toEqual({
      ok: false,
      code: 'error',
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalledOnce();
  });
});
