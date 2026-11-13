/**
 * Minimal structured logger. Redacts anything that looks like a token or secret.
 */
const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key|code_verifier|sig$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.replace(
      /(access_token|refresh_token|client_secret|key)=([^&\s]+)/gi,
      '$1=[redacted]',
    );
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'app'): Logger {
  const write = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (level === 'debug' && !process.env.DEBUG) return;
    const line = {
      t: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(data ? (redact(data) as object) : {}),
    };
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(
      JSON.stringify(line),
    );
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}

export { redact };
