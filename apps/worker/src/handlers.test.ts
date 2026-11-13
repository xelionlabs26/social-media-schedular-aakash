import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceDeps } from '@app/core/deps';
import type { Logger } from '@app/core/log';
import type { Engine } from '@app/core/scheduling';
import { AiError, generateForAsset } from '@app/core/ai';
import { SttError, transcribeAsset } from '@app/core/stt';
import { notify } from '@app/core/notify';
import { createHandlers } from './handlers';
import { addAssetWarning, markAssetFailed, markTextFailed } from './failures';

vi.mock('@app/core/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@app/core/ai')>()),
  generateForAsset: vi.fn(),
}));
vi.mock('@app/core/stt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@app/core/stt')>()),
  transcribeAsset: vi.fn(),
}));
vi.mock('@app/core/media', () => ({
  processAsset: vi.fn(),
  extractAudio: vi.fn(async () => null),
}));
vi.mock('@app/core/notify', () => ({ notify: vi.fn() }));
vi.mock('./failures', () => ({
  addAssetWarning: vi.fn(),
  markAssetFailed: vi.fn(),
  markTextFailed: vi.fn(),
  noTranscriptWarning: (detail: string) => ({
    code: 'no_transcript',
    severity: 'info',
    message: detail,
  }),
}));

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

describe('worker handlers', () => {
  const send = vi.fn(async () => 'id');
  const deps = {
    log: silent,
    jobs: { send },
    env: { APP_URL: 'https://app.test' },
  } as unknown as ServiceDeps;
  const handlers = createHandlers(deps, {} as Engine);

  beforeEach(() => vi.clearAllMocks());

  it('retries AI errors only when they are retryable', async () => {
    vi.mocked(generateForAsset).mockRejectedValueOnce(new AiError('retryable', 'overloaded', 30));
    await expect(handlers['generate-text']!({ assetId: 'a1' })).rejects.toThrow('overloaded');

    vi.mocked(generateForAsset).mockRejectedValueOnce(new AiError('refusal', 'refused'));
    await handlers['generate-text']!({ assetId: 'a1' });
    expect(markTextFailed).toHaveBeenCalledWith(deps, 'a1', 'write_manually', 'refused');

    vi.mocked(generateForAsset).mockRejectedValueOnce(
      new AiError('spend', 'credit balance is too low'),
    );
    await handlers['generate-text']!({ assetId: 'a1' });
    expect(markTextFailed).toHaveBeenLastCalledWith(
      deps,
      'a1',
      'spend_limit',
      'credit balance is too low',
    );

    // Unknown errors (bugs, network) go back to pg-boss.
    vi.mocked(generateForAsset).mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handlers['generate-text']!({ assetId: 'a1' })).rejects.toThrow('socket hang up');
  });

  it('retries speech-to-text only when retryable, otherwise continues without a transcript', async () => {
    vi.mocked(transcribeAsset).mockRejectedValueOnce(new SttError('retryable', '503', 503));
    await expect(handlers['transcribe-asset']!({ assetId: 'a1' })).rejects.toThrow('503');
    expect(send).not.toHaveBeenCalled();

    vi.mocked(transcribeAsset).mockRejectedValueOnce(
      new SttError('config', 'OPENAI_API_KEY is not set'),
    );
    await handlers['transcribe-asset']!({ assetId: 'a1' });
    expect(addAssetWarning).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('generate-text', { assetId: 'a1' }, { singletonKey: 'a1' });
  });

  it('lets pg-boss retry alerts that failed for a passing reason', async () => {
    vi.mocked(notify).mockResolvedValueOnce({
      sent: false,
      reason: 'Telegram error 429',
      retryable: true,
    });
    await expect(handlers.notify!({ kind: 'test', message: 'x' })).rejects.toThrow('429');
    vi.mocked(notify).mockResolvedValueOnce({ sent: false, reason: 'not configured' });
    await handlers.notify!({ kind: 'test', message: 'x' });
  });

  it('finishes the pipeline when pg-boss gives up on a job', async () => {
    const dead = handlers['failed-jobs']!;
    await dead({ assetId: 'a1' }, { id: 'j', retryCount: 2, sourceName: 'process-asset' });
    expect(markAssetFailed).toHaveBeenCalledWith(deps, 'a1', expect.any(String));
    await dead({ assetId: 'a2' }, { id: 'j', retryCount: 4, sourceName: 'transcribe-asset' });
    expect(send).toHaveBeenCalledWith('generate-text', { assetId: 'a2' }, { singletonKey: 'a2' });
    await dead({ assetId: 'a3' }, { id: 'j', retryCount: 4, sourceName: 'generate-text' });
    expect(markTextFailed).toHaveBeenCalledWith(deps, 'a3', 'ai_failed', expect.any(String));
  });
});
