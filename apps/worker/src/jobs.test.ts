import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@app/core/log';
import { WorkerJobs } from './jobs';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function fakeBoss() {
  const events: string[] = [];
  return {
    events,
    send: vi.fn(async (queue: string, _data: object, options?: { singletonKey?: string }) => {
      events.push(`send ${queue} ${options?.singletonKey ?? ''}`);
      return 'id';
    }),
    complete: vi.fn(async (queue: string, id: string) => {
      events.push(`complete ${queue} ${id}`);
      return { jobs: [id], requested: 1, affected: 1 };
    }),
  };
}

describe('WorkerJobs', () => {
  it('sends right away outside a job', async () => {
    const boss = fakeBoss();
    const jobs = new WorkerJobs(boss as never, silent);
    await jobs.sender.send('prepare-target', { targetId: 't1' }, { singletonKey: 't1' });
    expect(boss.events).toEqual(['send prepare-target t1']);
  });

  it('holds a re-send of the running job until the job is completed', async () => {
    const boss = fakeBoss();
    const jobs = new WorkerJobs(boss as never, silent);
    await jobs.run({ id: 'job-1', name: 'prepare-target', singletonKey: 't1' }, async () => {
      // Same queue + key: must wait (exclusive queue would drop it while job-1 is active).
      expect(
        await jobs.sender.send(
          'prepare-target',
          { targetId: 't1' },
          { singletonKey: 't1', startAfter: 30 },
        ),
      ).toBeNull();
      // Different queue or key: goes out immediately.
      await jobs.sender.send('publish-target', { targetId: 't1' }, { singletonKey: 't1' });
      await jobs.sender.send('prepare-target', { targetId: 't2' }, { singletonKey: 't2' });
    });
    expect(boss.events).toEqual([
      'send publish-target t1',
      'send prepare-target t2',
      'complete prepare-target job-1',
      'send prepare-target t1',
    ]);
    expect(boss.send.mock.calls.at(-1)![2]).toEqual({ singletonKey: 't1', startAfter: 30 });
  });

  it('does not complete or re-send when the handler fails (pg-boss retries the job)', async () => {
    const boss = fakeBoss();
    const jobs = new WorkerJobs(boss as never, silent);
    await expect(
      jobs.run({ id: 'job-1', name: 'prepare-target', singletonKey: 't1' }, async () => {
        await jobs.sender.send('prepare-target', { targetId: 't1' }, { singletonKey: 't1' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(boss.events).toEqual([]);
  });
});
