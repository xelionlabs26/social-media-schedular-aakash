import { describe, expect, it } from 'vitest';
import {
  mapGraphError,
  networkError,
  parseContainerStatusCode,
  regainAccessSeconds,
  scrubSecrets,
} from './errors';
import { GraphClient } from './graph';
import { FakeGraph, graphError, json } from './test-utils';

describe('Graph error mapping', () => {
  const cases: Array<[string, number, number | undefined, string, string | undefined]> = [
    // [label, code, subcode, expected category, type]
    ['expired token', 190, undefined, 'auth', 'OAuthException'],
    ['app not installed', 102, 458, 'auth', 'OAuthException'],
    ['password changed', 190, 460, 'auth', 'OAuthException'],
    ['session expired subcode on other code', 2500, 463, 'auth', 'OAuthException'],
    ['permission denied', 10, undefined, 'auth', 'OAuthException'],
    ['permission 200', 200, undefined, 'auth', 'OAuthException'],
    ['permission 299', 299, undefined, 'auth', 'OAuthException'],
    ['app throttled', 4, undefined, 'retryable', 'OAuthException'],
    ['user throttled', 17, undefined, 'retryable', 'OAuthException'],
    ['pages user token throttled', 32, undefined, 'retryable', 'OAuthException'],
    ['custom rate limit', 613, undefined, 'retryable', 'OAuthException'],
    ['BUC pages', 80001, undefined, 'retryable', 'OAuthException'],
    ['BUC instagram', 80002, undefined, 'retryable', 'OAuthException'],
    ['unknown', 1, undefined, 'retryable', 'OAuthException'],
    ['service', 2, undefined, 'retryable', 'OAuthException'],
    ['media not ready', 9007, 2207027, 'retryable', 'OAuthException'],
    ['invalid parameter', 100, undefined, 'invalid', 'OAuthException'],
    ['reel aspect', 100, 1363040, 'invalid', 'OAuthException'],
    ['reel resolution', 1363127, undefined, 'invalid', 'OAuthException'],
    ['reel duration', 100, 1363128, 'invalid', 'OAuthException'],
    ['reel fps', 100, 1363129, 'invalid', 'OAuthException'],
    ['ig unsupported format', 352, 2207026, 'invalid', 'OAuthException'],
    ['ig caption too long', 36004, 2207010, 'invalid', 'OAuthException'],
    ['ig thumb offset', 1, 2207057, 'invalid', 'OAuthException'],
    ['ig server error', -1, 2207001, 'retryable', 'OAuthException'],
    ['ig daily limit', 9, 2207042, 'quota', 'OAuthException'],
    ['ig restricted account', 25, 2207050, 'fatal', 'OAuthException'],
    ['policy block', 368, undefined, 'fatal', 'OAuthException'],
  ];

  it.each(cases)('%s → %s', (_label, code, subcode, expected, type) => {
    const err = mapGraphError(400, {
      code,
      error_subcode: subcode,
      type,
      message: 'x',
      fbtrace_id: 'T1',
    });
    expect(err.category).toBe(expected);
    expect((err.details as { fbtraceId?: string }).fbtraceId).toBe('T1');
  });

  it('gives plain-English messages for Reels spec errors', () => {
    expect(mapGraphError(400, { code: 100, error_subcode: 1363040 }).message).toMatch(
      /aspect ratio/,
    );
    expect(mapGraphError(400, { code: 100, error_subcode: 1363129 }).message).toMatch(/24–60 fps/);
  });

  it('falls back on HTTP status', () => {
    expect(mapGraphError(502, undefined).category).toBe('retryable');
    expect(mapGraphError(503, {}).category).toBe('retryable');
    expect(mapGraphError(404, undefined).category).toBe('fatal');
    expect(networkError(new Error('ECONNRESET')).category).toBe('retryable');
  });

  it('uses estimated_time_to_regain_access (minutes) for throttling', () => {
    const headers = new Headers({
      'x-business-use-case-usage': JSON.stringify({
        '111': [{ type: 'pages', call_count: 100, estimated_time_to_regain_access: 7 }],
      }),
    });
    expect(regainAccessSeconds(headers)).toBe(420);
    expect(mapGraphError(400, { code: 80001 }, headers).retryAfterSec).toBe(420);
    expect(mapGraphError(400, { code: 4 }).retryAfterSec).toBeGreaterThan(0);
    expect(
      regainAccessSeconds(new Headers({ 'x-business-use-case-usage': 'garbage' })),
    ).toBeUndefined();
  });

  it('never keeps tokens in messages', () => {
    const msg = scrubSecrets('bad access_token=EAABBBCCCDDDEEEFFF123 and OAuth EAAXYZXYZXYZXYZ999');
    expect(msg).not.toContain('EAABBBCCCDDDEEEFFF123');
    expect(msg).not.toContain('EAAXYZXYZXYZXYZ999');
    expect(scrubSecrets('app token 1234567890|abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    const err = mapGraphError(400, { code: 190, message: 'Invalid token EAATOKENTOKENTOKEN12345' });
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(
      'EAATOKENTOKENTOKEN12345',
    );
  });

  it('parses the code from an IG container status string', () => {
    expect(parseContainerStatusCode('Error: Media upload has failed with error code 2207026')).toBe(
      2207026,
    );
    expect(parseContainerStatusCode('Error (2207053)')).toBe(2207053);
    expect(parseContainerStatusCode(undefined)).toBeUndefined();
  });
});

describe('GraphClient', () => {
  it('maps HTTP errors, rupload debug_info errors and network failures', async () => {
    const graph = new FakeGraph()
      .once('GET', /\/a\?/, () => graphError(190, { message: 'expired', status: 401 }))
      .once('POST', /rupload/, () =>
        json(
          { debug_info: { retriable: false, type: 'OffsetInvalidError', message: 'bad offset' } },
          400,
        ),
      )
      .once('GET', /\/b\?/, () => new Response('<html>oops</html>', { status: 500 }))
      .once('GET', /\/c\?/, () => {
        throw new TypeError('fetch failed');
      });
    const client = new GraphClient({ version: 'v27.0', fetch: graph.fetch, appSecret: 's' });
    await expect(client.get('a', {}, 'EAATOKEN')).rejects.toMatchObject({ category: 'auth' });
    const { Readable } = await import('node:stream');
    await expect(
      client.rupload('video-upload', 'v1', 'EAATOKEN', {
        offset: 0,
        fileSize: 1,
        body: Readable.from([Buffer.from('x')]),
      }),
    ).rejects.toMatchObject({ category: 'retryable', code: 'OffsetInvalidError' });
    await expect(client.get('b', {}, 'EAATOKEN')).rejects.toMatchObject({ category: 'retryable' });
    await expect(client.get('c', {}, 'EAATOKEN')).rejects.toMatchObject({
      category: 'retryable',
      code: 'network',
    });
    expect(graph.calls[0]!.url.href.startsWith('https://graph.facebook.com/v27.0/a?')).toBe(true);
  });
});
