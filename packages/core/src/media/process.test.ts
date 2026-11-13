import { describe, expect, it } from 'vitest';
import {
  MediaToolExitError,
  MediaToolSpawnError,
  MediaToolTimeoutError,
  parseFilterList,
  runTool,
} from './process';

const node = process.execPath;

describe('runTool', () => {
  it('returns stdout on success', async () => {
    const res = await runTool(node, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 10_000 });
    expect(res.stdout).toBe('hi');
  });

  it('passes arguments without a shell', async () => {
    const res = await runTool(
      node,
      ['-e', 'process.stdout.write(process.argv[1])', '$(echo x); rm -rf /'],
      {
        timeoutMs: 10_000,
      },
    );
    expect(res.stdout).toBe('$(echo x); rm -rf /');
  });

  it('reports a non-zero exit with the stderr tail', async () => {
    const err = await runTool(
      node,
      ['-e', 'process.stderr.write("x".repeat(10000) + "\\nreal problem\\n"); process.exit(3)'],
      { timeoutMs: 10_000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaToolExitError);
    expect((err as MediaToolExitError).exitCode).toBe(3);
    expect((err as MediaToolExitError).stderrTail.length).toBeLessThanOrEqual(4096);
    expect((err as MediaToolExitError).message).toContain('real problem');
  });

  it('kills the process on timeout', async () => {
    await expect(
      runTool(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(MediaToolTimeoutError);
  });

  it('reports a missing binary as a spawn error', async () => {
    await expect(runTool('/nonexistent/ffmpeg', [], { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      MediaToolSpawnError,
    );
  });

  it('caps stdout', async () => {
    await expect(
      runTool(node, ['-e', 'process.stdout.write("x".repeat(100000))'], {
        timeoutMs: 10_000,
        maxStdoutBytes: 1000,
      }),
    ).rejects.toThrow('more than 1000 bytes');
  });
});

describe('parseFilterList', () => {
  it('reads filter names from ffmpeg -filters output', () => {
    const names = parseFilterList(
      [
        'Filters:',
        '  T.. = Timeline support',
        ' ... abench            A->A       Benchmark part of a filtergraph.',
        ' TS. colorspace        V->V       Convert between colorspaces.',
        ' .SC zscale            V->V       Apply resizing, colorspace and bit depth conversion.',
        ' ... buffer            |->V       Buffer video frames.',
      ].join('\n'),
    );
    expect([...names].sort()).toEqual(['abench', 'buffer', 'colorspace', 'zscale']);
  });
});
