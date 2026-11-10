import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { KeyTestResult, ModelOption } from '@shared/types'
import { extractJson } from './json'

/**
 * LLM through a locally installed CLI (Claude Code or OpenAI Codex), using the login the user already has there.
 * No API key is stored; the prompt goes in over stdin so length and quoting never hit the command line.
 */
export type CliKind = 'claude' | 'codex'

const TIMEOUT_MS = 6 * 60 * 1000
const IS_WIN = process.platform === 'win32'

export class CliError extends Error {}

const LABEL: Record<CliKind, string> = { claude: 'Claude Code', codex: 'Codex' }

/** A GUI-launched Electron app gets a minimal PATH, so the usual install folders are searched explicitly. */
function candidateDirs(): string[] {
  const home = homedir()
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'claude'), join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'))
  }
  const nvm = join(home, '.nvm', 'versions', 'node')
  if (existsSync(nvm)) {
    const versions = readdirSync(nvm).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    for (const v of versions) dirs.push(join(nvm, v, 'bin'))
  }
  return dirs
}

/** The editor extensions ship the CLI binary even when it is not on PATH. */
function extensionBinaries(kind: CliKind): string[] {
  const root = join(homedir(), '.vscode', 'extensions')
  if (!existsSync(root)) return []
  const prefix = kind === 'claude' ? 'anthropic.claude-code-' : 'openai.chatgpt-'
  const found: string[] = []
  const names = readdirSync(root)
    .filter((n) => n.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  for (const n of names) {
    const base = join(root, n)
    if (kind === 'claude') found.push(join(base, 'resources', 'native-binary', IS_WIN ? 'claude.exe' : 'claude'))
    else {
      const bin = join(base, 'bin')
      if (existsSync(bin)) for (const sub of readdirSync(bin)) found.push(join(bin, sub, IS_WIN ? 'codex.exe' : 'codex'))
    }
  }
  return found
}

/** Where the CLI lives, or null when it is not installed. Cached, since this runs on every status check. */
const found = new Map<CliKind, string | null>()

export function findCli(kind: CliKind, refresh = false): string | null {
  if (!refresh && found.has(kind) && (found.get(kind) === null || existsSync(found.get(kind)!))) return found.get(kind) ?? null
  const names = IS_WIN ? [`${kind}.exe`, `${kind}.cmd`] : [kind]
  let hit: string | null = null
  outer: for (const dir of candidateDirs())
    for (const n of names) {
      const p = join(dir, n)
      if (existsSync(p)) {
        hit = p
        break outer
      }
    }
  hit ??= extensionBinaries(kind).find((p) => existsSync(p)) ?? null
  found.set(kind, hit)
  return hit
}

export function cliInstalled(kind: CliKind): boolean {
  return findCli(kind) !== null
}

function notInstalled(kind: CliKind): CliError {
  return new CliError(
    kind === 'claude'
      ? 'Claude Code belum terpasang di komputer ini. Pasang lewat https://claude.com/claude-code lalu masuk (login) sekali di terminal.'
      : 'Codex CLI belum terpasang di komputer ini. Pasang lewat https://github.com/openai/codex lalu masuk (login) sekali di terminal.'
  )
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(bin: string, args: string[], stdin: string | null, cwd: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Dibatalkan'), { name: 'AbortError' }))
    // .cmd shims on Windows can only start through a shell; arguments here never contain user text except the system prompt.
    const child = spawn(bin, args, { cwd, windowsHide: true, shell: IS_WIN && /\.cmd$/i.test(bin), env: { ...process.env, NO_COLOR: '1' } })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      child.kill()
      finish(() => reject(Object.assign(new Error('Dibatalkan'), { name: 'AbortError' })))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new CliError('CLI terlalu lama merespons. Coba lagi atau pilih model yang lebih cepat.')))
    }, TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort)
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (e) => finish(() => reject(new CliError(`Tidak bisa menjalankan CLI: ${e.message}`))))
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })))
    child.stdin.on('error', () => {})
    if (stdin !== null) child.stdin.write(stdin)
    child.stdin.end()
  })
}

/** CLI failures are mostly "not logged in" or "model not allowed"; say that in plain words. */
function explain(kind: CliKind, text: string): string {
  const name = LABEL[kind]
  // Codex prints a banner before the real error; the ERROR line is the useful part.
  const t = (/^ERROR:.*$/m.exec(text)?.[0].replace(/^ERROR:\s*/, '') ?? text).trim()
  if (/not logged in|please run .*login|\/login|unauthenticated|authentication|401|invalid api key/i.test(t))
    return `${name} belum login. Buka terminal, jalankan ${kind === 'claude' ? '"claude" lalu /login' : '"codex login"'}, kemudian coba lagi.`
  if (/rate limit|usage limit|429|quota/i.test(t)) return `${name} sedang kena batas pemakaian. Tunggu sebentar atau pilih model lain.`
  if (/model.*(not supported|not found|does not exist)|model_not_found/i.test(t)) return `Model ini tidak tersedia di akun ${name}-mu. Pilih model lain di Pengaturan. (${t.slice(0, 200)})`
  return `${name} gagal: ${t.slice(0, 400) || 'tanpa pesan error'}`
}

export async function generateJson(kind: CliKind, model: string, system: string, prompt: string, schema: object, signal?: AbortSignal): Promise<unknown> {
  const bin = findCli(kind)
  if (!bin) throw notInstalled(kind)
  // An empty working folder keeps the agent away from the user's files, and nothing here needs tools.
  const dir = mkdtempSync(join(tmpdir(), 'bang-story-llm-'))
  try {
    if (kind === 'claude') {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--disable-slash-commands', '--setting-sources', '', '--json-schema', JSON.stringify(schema)]
      if (model) args.push('--model', model)
      // Long system prompts would risk the Windows command-line limit; those go into the message instead.
      let input = prompt
      if (system.length < 8000) args.push('--system-prompt', system)
      else input = `${system}\n\n${prompt}`
      const r = await run(bin, args, input, dir, signal)
      let j: { is_error?: boolean; result?: string; structured_output?: unknown } | null = null
      try {
        j = JSON.parse(r.stdout)
      } catch {
        // Not JSON: the CLI failed before it could answer.
      }
      if (!j) throw new CliError(explain(kind, r.stderr || r.stdout))
      if (j.is_error) throw new CliError(explain(kind, j.result ?? r.stderr))
      if (j.structured_output && typeof j.structured_output === 'object') return j.structured_output
      try {
        return extractJson(j.result ?? '')
      } catch {
        throw new CliError(`Model "${model || 'bawaan'}" tidak menghasilkan JSON yang valid. Coba pilih model lain di Pengaturan.`)
      }
    }
    const schemaFile = join(dir, 'schema.json')
    const outFile = join(dir, 'answer.txt')
    writeFileSync(schemaFile, JSON.stringify(schema))
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', dir, '--output-schema', schemaFile, '-o', outFile]
    if (model) args.push('-m', model)
    args.push('-')
    // Codex has no separate system prompt flag, so the instructions lead the message.
    const r = await run(bin, args, `${system}\n\n${prompt}`, dir, signal)
    const answer = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
    if (!answer.trim()) throw new CliError(explain(kind, r.stderr || r.stdout))
    try {
      return extractJson(answer)
    } catch {
      throw new CliError(`Model "${model || 'bawaan'}" tidak menghasilkan JSON yang valid. Coba pilih model lain di Pengaturan.`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function listModels(kind: CliKind): Promise<ModelOption[]> {
  if (kind === 'claude') {
    // Aliases always point at the newest model of that tier, so the list never goes stale.
    return [
      { id: 'sonnet', name: 'Sonnet (terbaru)', description: 'Seimbang antara kecepatan dan kualitas tulisan. Pilihan paling pas untuk naskah.', tags: [] },
      { id: 'opus', name: 'Opus (terbaru)', description: 'Paling pintar dan paling lambat. Cocok kalau naskah butuh kedalaman.', tags: [] },
      { id: 'haiku', name: 'Haiku (terbaru)', description: 'Paling cepat dan hemat batas pemakaian.', tags: [] }
    ]
  }
  const bin = findCli('codex')
  if (!bin) throw notInstalled('codex')
  const dir = mkdtempSync(join(tmpdir(), 'bang-story-llm-'))
  try {
    const r = await run(bin, ['debug', 'models'], null, dir)
    const j = JSON.parse(r.stdout) as { models?: { slug: string; display_name?: string; description?: string; visibility?: string; context_window?: number }[] }
    const list = (j.models ?? []).filter((m) => m.visibility !== 'hide')
    if (!list.length) throw new Error('kosong')
    return list.map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, description: m.description, contextLength: m.context_window ?? null, tags: [] }))
  } catch {
    throw new CliError('Daftar model Codex tidak bisa dibaca. Pastikan Codex sudah login, atau ketik ID model secara manual.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function test(kind: CliKind): Promise<KeyTestResult> {
  const bin = findCli(kind, true)
  if (!bin) return { ok: false, message: notInstalled(kind).message }
  const dir = mkdtempSync(join(tmpdir(), 'bang-story-llm-'))
  try {
    const r = await run(bin, ['--version'], null, dir)
    const v = r.stdout.trim().split('\n')[0]
    if (r.code !== 0) return { ok: false, message: explain(kind, r.stderr || r.stdout) }
    // A real (tiny) call proves the login works too, not just that the program exists.
    // Codex's own default model may be one the account cannot use, so it is always tested with a listed model.
    const model = kind === 'claude' ? 'haiku' : ((await listModels('codex'))[0]?.id ?? '')
    await generateJson(kind, model, 'Reply with the JSON object only.', 'Return {"ok": true}.', {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false
    })
    return { ok: true, message: `Terhubung · ${v}` }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
