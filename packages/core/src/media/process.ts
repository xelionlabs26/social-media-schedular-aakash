/**
 * Runs ffmpeg / ffprobe as child processes.
 *
 * Always `spawn` with an argument array (never a shell), so file names can't inject commands.
 * Every run has a timeout, a cap on captured stdout, and keeps only the tail of stderr (ffmpeg
 * is chatty; the last lines hold the actual error).
 */
import { spawn } from 'node:child_process';

const STDERR_TAIL_BYTES = 4096;
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

export interface RunOptions {
  timeoutMs: number;
  /** Stdout beyond this is an error (protects memory against a runaway ffprobe). */
  maxStdoutBytes?: number;
}

export interface RunResult {
  stdout: string;
  stderrTail: string;
}

/** Base class for everything that goes wrong while running a media tool. */
export class MediaToolError extends Error {
  constructor(
    message: string,
    public readonly tool: string,
    public readonly stderrTail = '',
  ) {
    super(message);
    this.name = 'MediaToolError';
  }
}

/** The tool exited with a non-zero code: usually the input file is broken or unsupported. */
export class MediaToolExitError extends MediaToolError {
  constructor(
    tool: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    stderrTail: string,
  ) {
    super(
      `${tool} exited with ${exitCode !== null ? `code ${exitCode}` : `signal ${signal}`}` +
        (stderrTail ? `: ${lastLines(stderrTail, 3)}` : ''),
      tool,
      stderrTail,
    );
    this.name = 'MediaToolExitError';
  }
}

/** The tool ran longer than allowed and was killed. */
export class MediaToolTimeoutError extends MediaToolError {
  constructor(
    tool: string,
    public readonly timeoutMs: number,
    stderrTail: string,
  ) {
    super(`${tool} timed out after ${Math.round(timeoutMs / 1000)} s`, tool, stderrTail);
    this.name = 'MediaToolTimeoutError';
  }
}

/**
 * The tool could not be started (not installed, wrong FFMPEG_PATH, ...). This is a worker setup
 * problem, not a problem with the video, so callers treat it as retryable.
 */
export class MediaToolSpawnError extends MediaToolError {
  constructor(
    tool: string,
    public readonly code: string | undefined,
  ) {
    super(
      code === 'ENOENT'
        ? `${tool} was not found. Install ffmpeg or set FFMPEG_PATH / FFPROBE_PATH.`
        : `${tool} could not be started (${code ?? 'unknown error'})`,
      tool,
    );
    this.name = 'MediaToolSpawnError';
  }
}

function lastLines(text: string, n: number): string {
  return text.trim().split(/\r?\n/).slice(-n).join(' | ');
}

/** Runs `command args...` and resolves with stdout when it exits with code 0. */
export function runTool(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const tool = command.split(/[\\/]/).pop() || command;

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(new MediaToolSpawnError(tool, (err as NodeJS.ErrnoException).code));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = '';
    let settled = false;
    let timedOut = false;
    let overflow = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        if (!overflow) {
          overflow = true;
          child.kill('SIGKILL');
        }
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => reject(new MediaToolSpawnError(tool, err.code)));
    });

    child.on('close', (code, signal) => {
      finish(() => {
        if (timedOut) return reject(new MediaToolTimeoutError(tool, opts.timeoutMs, stderrTail));
        if (overflow) {
          return reject(
            new MediaToolError(`${tool} printed more than ${maxStdout} bytes`, tool, stderrTail),
          );
        }
        if (code !== 0) return reject(new MediaToolExitError(tool, code, signal, stderrTail));
        resolve({ stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderrTail });
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// ffmpeg filter detection
// ---------------------------------------------------------------------------------------------

const filterCache = new Map<string, Promise<Set<string>>>();

/**
 * Names of the filters this ffmpeg build has (`ffmpeg -filters`). Cached per binary path.
 * Used to pick the HDR tone-mapping chain: `zscale` needs ffmpeg built with libzimg, which not
 * every distro build has.
 */
export function listFilters(ffmpegPath: string): Promise<Set<string>> {
  let cached = filterCache.get(ffmpegPath);
  if (!cached) {
    cached = runTool(ffmpegPath, ['-hide_banner', '-filters'], { timeoutMs: 15_000 }).then((res) =>
      parseFilterList(res.stdout),
    );
    // Don't cache failures (e.g. ffmpeg missing right now but installed later).
    cached.catch(() => filterCache.delete(ffmpegPath));
    filterCache.set(ffmpegPath, cached);
  }
  return cached;
}

/** Parses `ffmpeg -filters` output lines like ` TSC zscale  V->V  Apply resizing...`. */
export function parseFilterList(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*[T.][S.][C.]\s+(\S+)\s+\S+->\S+/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}
