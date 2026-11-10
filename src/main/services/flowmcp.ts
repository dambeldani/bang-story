import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import type { KeyTestResult } from '@shared/types'

/**
 * Google Flow through flow-mcp (https://github.com/GTAI-1/flow-mcp), a separate program the user installs and
 * signs in with. It drives a Chrome window that is logged in to Flow and answers on a local HTTP API, guarded by a
 * token it writes to ~/.flow-mcp/token. Bang Story never sees a Google password or cookie, only that token.
 */
export class FlowError extends Error {}

const PORT = 8787
const NOT_RUNNING =
  'flow-mcp belum jalan. Buka terminal di folder flow-mcp, jalankan "npm run studio", biarkan tetap terbuka, lalu coba lagi.'

/** Dev only: STUDIO_FLOW_BASE and STUDIO_FLOW_TOKEN point at a mock so the screens can be tested without a Flow account. */
function base(): string {
  return (!app.isPackaged && process.env.STUDIO_FLOW_BASE) || `http://127.0.0.1:${PORT}`
}

/** Read on every call: flow-mcp makes a new token each time it starts. */
function token(): string {
  if (!app.isPackaged && process.env.STUDIO_FLOW_TOKEN) return process.env.STUDIO_FLOW_TOKEN
  const file = join(process.env.FLOW_MCP_HOME ?? join(homedir(), '.flow-mcp'), 'token')
  if (!existsSync(file)) throw new FlowError(NOT_RUNNING)
  return readFileSync(file, 'utf8').trim()
}

async function call<T>(method: string, args: object = {}, signal?: AbortSignal): Promise<T> {
  const key = token()
  let res: Response
  try {
    res = await fetch(`${base()}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flow-token': key },
      body: JSON.stringify(args),
      signal
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new FlowError(NOT_RUNNING)
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 401) throw new FlowError('flow-mcp menolak token. Jalankan ulang "npm run studio" lalu coba lagi.')
  if (!res.ok) throw new FlowError(`flow-mcp: ${body.error ?? res.status}`)
  return body as T
}

interface FlowJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  files?: string[]
  progress?: string
  note?: string
  error?: string
}

interface FlowState {
  signedIn?: boolean
  inProject?: boolean
  hint?: string
  plan?: string
  credits_remaining?: unknown
}

export async function test(): Promise<KeyTestResult> {
  try {
    const { flow } = await call<{ flow: FlowState }>('status', { detailed: true })
    if (!flow.signedIn) return { ok: false, message: 'Flow belum login. Jalankan "npm run login" di folder flow-mcp, masuk ke Google di jendela Chrome-nya, lalu tes lagi.' }
    if (!flow.inProject) return { ok: false, message: 'Login sudah, tapi belum ada proyek Flow yang terbuka. Buka atau buat satu proyek di jendela Chrome flow-mcp, lalu tes lagi.' }
    const parts = ['Terhubung']
    if (flow.plan) parts.push(flow.plan)
    if (flow.credits_remaining != null) parts.push(`${flow.credits_remaining} kredit tersisa`)
    return { ok: true, message: parts.join(' · ') }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

export async function cancelJob(id: string): Promise<void> {
  await call('cancel', { job_id: id }).catch(() => undefined)
}

interface RunOpts {
  signal: AbortSignal
  onJob(id: string): void
  onStatus(status: 'queued' | 'running', elapsedMs: number): void
}

/** Queues one scene in Flow and waits until flow-mcp has saved its file; returns that local path. */
async function runScene(scene: Record<string, unknown>, opts: RunOpts, timeoutMs: number, what: string): Promise<string> {
  const sent = await call<{ output_dir: string; jobs: FlowJob[] }>('generate', { project: 'BangStory', scenes: [scene] }, opts.signal)
  const first = sent.jobs[0]
  if (!first) throw new FlowError('flow-mcp tidak membuat pekerjaan. Cek jendela Chrome-nya.')
  opts.onJob(first.id)
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const w = await call<{ jobs: FlowJob[] }>('wait', { job_ids: [first.id], timeout_seconds: 30 }, opts.signal)
    const job = w.jobs[0]
    if (!job) throw new FlowError('flow-mcp kehilangan pekerjaan ini, kemungkinan karena dijalankan ulang. Coba lagi.')
    if (job.status === 'done') {
      const file = job.files?.[0]
      if (!file) throw new FlowError(job.note ?? `Flow selesai tanpa file ${what}.`)
      return isAbsolute(file) ? file : join(sent.output_dir, file)
    }
    if (job.status === 'failed' || job.status === 'cancelled') throw new FlowError(job.error ?? job.note ?? `Flow gagal membuat ${what}.`)
    opts.onStatus(job.status, Date.now() - started)
  }
  throw new FlowError(`Flow terlalu lama membuat ${what} ini.`)
}

/**
 * Makes one image in Flow. Images cost no credits, so the request is capped at 0: if Flow ever quotes a price,
 * nothing is made and nothing is spent.
 */
export function makeImage(opts: RunOpts & { prompt: string; aspect: string; refs: string[] }): Promise<string> {
  return runScene(
    { prompt: opts.prompt, type: 'image', aspect_ratio: opts.aspect, reference_images: opts.refs.slice(0, 3), max_credits: 0, retries: 1 },
    opts,
    30 * 60 * 1000,
    'gambar'
  )
}

/**
 * Makes one video in Flow, from a first-frame image or from the text (plus up to 3 reference images). Videos cost
 * credits, so `maxCredits` caps one video: if Flow quotes more, nothing is made and nothing is spent.
 */
export function makeVideo(
  opts: RunOpts & {
    prompt: string
    aspect: string
    firstFrame?: string
    refs: string[]
    model?: string
    durationSec?: number
    maxCredits: number
  }
): Promise<string> {
  const scene: Record<string, unknown> = { prompt: opts.prompt, type: 'video', aspect_ratio: opts.aspect, max_credits: opts.maxCredits, retries: 0 }
  if (opts.model) scene.model = opts.model
  if (opts.durationSec) scene.duration = opts.durationSec
  // Flow's composer takes a first frame OR reference images for a video, never both.
  if (opts.firstFrame) scene.first_frame = opts.firstFrame
  else if (opts.refs.length) scene.reference_images = opts.refs.slice(0, 3)
  return runScene(scene, opts, 45 * 60 * 1000, 'video')
}
