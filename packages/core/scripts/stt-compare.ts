/**
 * Speech-to-text bake-off (PLAN.md §4.8, milestone M1).
 *
 * Runs the same videos through several speech-to-text providers and writes a side-by-side
 * report, so the owner can pick the one that handles their Hindi + English mix best.
 *
 *   pnpm stt:compare <video files or folders...> [--providers=sarvam,deepgram] [--out=folder]
 *
 * Keys come from .env (SARVAM_API_KEY, DEEPGRAM_API_KEY, OPENAI_API_KEY, ASSEMBLYAI_API_KEY).
 * Providers without a key are skipped. Nothing is written to the database.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SttProvider } from '@app/db';
import { getEnv } from '../src/env';
import { getTranscriber, isSttConfigured } from '../src/stt';

const run = promisify(execFile);
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|wav|aac)$/i;
const ALL: SttProvider[] = ['sarvam', 'deepgram', 'openai', 'assemblyai'];

interface Cell {
  provider: SttProvider;
  ok: boolean;
  text: string;
  language?: string;
  seconds: number;
}

function parseArgs(argv: string[]) {
  const inputs: string[] = [];
  let providers: SttProvider[] | undefined;
  let out = path.resolve('.data/stt-compare');
  for (const a of argv) {
    if (a.startsWith('--providers=')) {
      providers = a
        .slice('--providers='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as SttProvider[];
    } else if (a.startsWith('--out=')) out = path.resolve(a.slice('--out='.length));
    else inputs.push(a);
  }
  return { inputs, providers, out };
}

async function expandInputs(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const st = await fs.stat(input);
    if (st.isDirectory()) {
      for (const name of (await fs.readdir(input)).sort()) {
        if (VIDEO_EXT.test(name)) files.push(path.join(input, name));
      }
    } else files.push(input);
  }
  return files;
}

async function durationMs(file: string): Promise<number> {
  const { stdout } = await run(getEnv().FFPROBE_PATH, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return Math.round(Number(stdout.trim()) * 1000);
}

/** Same audio the app sends: mono 16 kHz AAC in .m4a. */
async function extractAudio(file: string, dir: string): Promise<string> {
  const out = path.join(dir, `${path.basename(file).replace(/\.[^.]+$/, '')}.m4a`);
  await run(getEnv().FFMPEG_PATH, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    file,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'aac',
    '-b:a',
    '48k',
    out,
  ]);
  return out;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function htmlReport(
  rows: Array<{ file: string; seconds: number; cells: Cell[] }>,
  providers: SttProvider[],
) {
  const head = providers.map((p) => `<th>${esc(p)}</th>`).join('');
  const body = rows
    .map(
      (r) =>
        `<tr><td class="f">${esc(path.basename(r.file))}<br><small>${r.seconds.toFixed(0)} s</small></td>${providers
          .map((p) => {
            const c = r.cells.find((x) => x.provider === p);
            if (!c) return '<td class="na">not run</td>';
            return `<td class="${c.ok ? '' : 'err'}">${esc(c.text) || '<em>(empty)</em>'}<br><small>${
              c.language ? `lang ${esc(c.language)} · ` : ''
            }${c.seconds.toFixed(1)} s</small></td>`;
          })
          .join('')}</tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Speech-to-text comparison</title>
<style>body{font:15px/1.55 system-ui,'Noto Sans Devanagari',sans-serif;margin:16px;color:#17181b;background:#f7f7f8}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #e3e5e8;padding:10px;vertical-align:top;text-align:left}
th{background:#f1f2f4}td.f{white-space:nowrap;font-weight:600}td.err{color:#b91c1c}td.na{color:#646a73}small{color:#646a73;font-weight:400}
@media (prefers-color-scheme:dark){body{background:#0f1013;color:#eceef1}table{background:#17181c}th{background:#1f2126}th,td{border-color:#2b2e35}}</style></head>
<body><h1>Speech-to-text comparison</h1><p>Same audio for every provider. Pick the column that gets your Hindi + English right most often.</p>
<div style="overflow-x:auto"><table><thead><tr><th>Video</th>${head}</tr></thead><tbody>
${body}
</tbody></table></div></body></html>`;
}

async function main() {
  const { inputs, providers: requested, out } = parseArgs(process.argv.slice(2));
  if (inputs.length === 0) {
    console.error(
      'Usage: pnpm stt:compare <videos or folders...> [--providers=sarvam,deepgram] [--out=folder]',
    );
    process.exit(1);
  }
  const env = getEnv();
  const candidates = requested ?? ALL;
  const providers = candidates.filter((p) => isSttConfigured(p, env));
  const skipped = candidates.filter((p) => !providers.includes(p));
  if (skipped.length) console.log(`Skipping (no API key in .env): ${skipped.join(', ')}`);
  if (providers.length === 0) {
    console.error(
      'No provider has an API key. Add e.g. SARVAM_API_KEY and DEEPGRAM_API_KEY to .env.',
    );
    process.exit(1);
  }

  const files = await expandInputs(inputs);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-compare-'));
  await fs.mkdir(out, { recursive: true });
  const rows: Array<{ file: string; seconds: number; cells: Cell[] }> = [];

  try {
    for (const file of files) {
      const ms = await durationMs(file);
      let audio: string;
      try {
        audio = await extractAudio(file, work);
      } catch {
        console.log(`\n▶ ${path.basename(file)}: no audio track, skipped`);
        rows.push({
          file,
          seconds: ms / 1000,
          cells: providers.map((provider) => ({
            provider,
            ok: false,
            text: 'No audio in this video',
            seconds: 0,
          })),
        });
        continue;
      }
      console.log(`\n▶ ${path.basename(file)} (${(ms / 1000).toFixed(0)} s)`);
      const cells: Cell[] = [];
      for (const provider of providers) {
        const started = Date.now();
        try {
          const res = await getTranscriber(provider, env).transcribe({
            filePath: audio,
            mimeType: 'audio/mp4',
            durationMs: ms,
            languageHints: ['hi', 'en'],
            keywords: [],
          });
          cells.push({
            provider,
            ok: true,
            text: res.text,
            language: res.language,
            seconds: (Date.now() - started) / 1000,
          });
          console.log(
            `  ${provider}: ${res.text.slice(0, 120)}${res.text.length > 120 ? '…' : ''}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          cells.push({
            provider,
            ok: false,
            text: `Error: ${message}`,
            seconds: (Date.now() - started) / 1000,
          });
          console.log(`  ${provider}: ERROR ${message}`);
        }
      }
      rows.push({ file, seconds: ms / 1000, cells });
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  const htmlPath = path.join(out, 'report.html');
  const jsonPath = path.join(out, 'report.json');
  await fs.writeFile(htmlPath, htmlReport(rows, providers));
  await fs.writeFile(jsonPath, JSON.stringify(rows, null, 2));
  console.log(`\nReport: ${htmlPath}\nData:   ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
