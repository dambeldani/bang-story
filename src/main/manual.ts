import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { NO_MUSIC } from '@shared/higgsfield'
import type { Asset, BatchImportResult, ManualPrompt, ManualTarget } from '@shared/types'
import { clipPrompt, defaultVideoPrompt, linkAsset, sheetPrompt } from './generation'
import { assetAbsPath } from './paths'
import { charactersOf, clipsOf, getAsset, getCharacter, getClip, getProject, insertAsset } from './repo'
import { probeDurationMs, probeSize } from './services/audio'

/**
 * Pictures and videos the user makes in another app (Gemini, ChatGPT, Google Flow, ...) and loads by hand.
 * Prompts come from the same builders Higgsfield uses, so what the user pastes matches what the app would send.
 */

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp']
const VIDEO_EXT = ['.mp4', '.mov', '.webm']
const MAX_BYTES = 1024 * 1024 * 1024

const isVideoTarget = (t: ManualTarget): boolean => t.kind === 'clip-video'

// ---------- prompts ----------

export function manualPrompt(target: ManualTarget): ManualPrompt {
  if (target.kind === 'sheet') {
    const c = getCharacter(target.id)
    return { prompt: sheetPrompt(getProject(c.projectId), c), attach: [], hint: 'Minta satu gambar lebar 16:9. Gambar ini nanti jadi acuan wajah dan kostum karakter.' }
  }
  const clip = getClip(target.id)
  const project = getProject(clip.projectId)
  if (target.kind === 'clip-video') {
    const seconds = Math.max(1, Math.round(clip.durationMs / 1000))
    return {
      prompt: `${defaultVideoPrompt(clip)} ${NO_MUSIC}`,
      attach: [],
      hint: `Pilih image-to-video dan unggah gambar klip ini sebagai frame awal. Panjang yang pas sekitar ${seconds} detik, rasio ${project.aspectRatio}.`
    }
  }
  const chars = charactersOf(project.id).filter((c) => clip.characterIds.includes(c.id))
  const withSheet = chars.filter((c) => c.sheetAssetId)
  const missing = chars.filter((c) => !c.sheetAssetId).map((c) => c.name)
  // No length limit here: the user pastes into a chat box, not into a model with a short prompt field.
  const prompt = clipPrompt(project, clip, chars, withSheet.map((c) => c.name), Infinity)
  const hint = [
    withSheet.length ? `Lampirkan lembar karakter sesuai urutan: ${withSheet.map((c) => c.name).join(', ')}.` : '',
    missing.length ? `${missing.join(', ')} belum punya lembar karakter, jadi tampilannya bisa berbeda antar klip.` : '',
    `Rasio gambar ${project.aspectRatio}.`
  ]
    .filter(Boolean)
    .join(' ')
  return { prompt, attach: withSheet.map((c) => c.name), hint }
}

// ---------- loading files ----------

/** The project a target belongs to, plus the clip or character ids to store on the asset. */
function owner(target: ManualTarget): { projectId: string; clipId: string | null; characterId: string | null } {
  if (target.kind === 'sheet') {
    const c = getCharacter(target.id)
    return { projectId: c.projectId, clipId: null, characterId: c.id }
  }
  const clip = getClip(target.id)
  return { projectId: clip.projectId, clipId: clip.id, characterId: null }
}

function checkExt(target: ManualTarget, ext: string): string {
  const e = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
  const ok = isVideoTarget(target) ? VIDEO_EXT : IMAGE_EXT
  if (!ok.includes(e))
    throw new Error(isVideoTarget(target) ? 'Pakai file video MP4, MOV, atau WebM.' : 'Pakai file gambar PNG, JPG, atau WebP.')
  return e
}

/** Stores a file already written into the project folder as an asset and links it to its owner. A rejected file is removed again. */
async function register(target: ManualTarget, rel: string, label: string): Promise<Asset> {
  try {
    return await registerFile(target, rel, label)
  } catch (e) {
    rmSync(assetAbsPath(owner(target).projectId, rel), { force: true })
    throw e
  }
}

async function registerFile(target: ManualTarget, rel: string, label: string): Promise<Asset> {
  const o = owner(target)
  const abs = assetAbsPath(o.projectId, rel)
  const size = await probeSize(abs).catch(() => null)
  if (!size) throw new Error(isVideoTarget(target) ? 'Video tidak bisa dibaca. Coba ekspor ulang atau pakai MP4.' : 'Gambar tidak bisa dibaca. Pakai file PNG, JPG, atau WebP.')
  const durationMs = isVideoTarget(target) ? await probeDurationMs(abs).catch(() => null) : null
  if (isVideoTarget(target) && !durationMs) throw new Error('Video tidak bisa dibaca. Coba ekspor ulang atau pakai MP4.')
  const asset = insertAsset({
    projectId: o.projectId,
    clipId: o.clipId,
    characterId: o.characterId,
    kind: isVideoTarget(target) ? 'video' : 'image',
    provider: 'manual',
    prompt: label,
    localPath: rel,
    durationMs,
    width: size.width,
    height: size.height
  })
  linkAsset(target.kind, asset)
  return getAsset(asset.id) ?? asset
}

function newRel(target: ManualTarget, ext: string): { rel: string; abs: string } {
  const o = owner(target)
  const rel = `${isVideoTarget(target) ? 'videos' : 'images'}/${randomUUID()}${ext}`
  const abs = assetAbsPath(o.projectId, rel)
  mkdirSync(dirname(abs), { recursive: true })
  return { rel, abs }
}

export async function importPath(target: ManualTarget, src: string): Promise<Asset> {
  const ext = checkExt(target, extname(src))
  const { rel, abs } = newRel(target, ext)
  copyFileSync(src, abs)
  return register(target, rel, basename(src))
}

/** For images pasted or dragged from a browser, where there is no file on disk to copy. */
export async function importBytes(target: ManualTarget, data: Uint8Array, ext: string): Promise<Asset> {
  const e = checkExt(target, ext)
  if (!data.byteLength) throw new Error('Isi file kosong.')
  if (data.byteLength > MAX_BYTES) throw new Error('File terlalu besar.')
  const { rel, abs } = newRel(target, e)
  writeFileSync(abs, Buffer.from(data))
  return register(target, rel, 'dari clipboard')
}

export async function importDialog(target: ManualTarget): Promise<Asset | null> {
  const video = isVideoTarget(target)
  const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, {
    title: video ? 'Pilih video hasil' : 'Pilih gambar hasil',
    filters: [video ? { name: 'Video', extensions: ['mp4', 'mov', 'webm'] } : { name: 'Gambar', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile']
  })
  if (res.canceled || !res.filePaths[0]) return null
  return importPath(target, res.filePaths[0])
}

/**
 * Loads every file of a folder into the clip whose number is in the file name (scene-03.png goes to clip 3).
 * When no file has a number, the files are taken in name order, one per clip.
 */
export async function importFolder(projectId: string, kind: 'image' | 'video'): Promise<BatchImportResult | null> {
  const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, {
    title: kind === 'video' ? 'Pilih folder berisi video' : 'Pilih folder berisi gambar',
    properties: ['openDirectory']
  })
  if (res.canceled || !res.filePaths[0]) return null
  const dir = res.filePaths[0]
  const exts = kind === 'video' ? VIDEO_EXT : IMAGE_EXT
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && exts.includes(extname(f.name).toLowerCase()))
    .map((f) => f.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const clips = clipsOf(getProject(projectId).id)
  const numbered = files.map((name) => ({ name, n: /(\d+)/.exec(basename(name, extname(name)))?.[1] }))
  const byNumber = numbered.some((f) => f.n)
  const out: BatchImportResult = { imported: 0, skipped: [] }
  for (const [i, f] of numbered.entries()) {
    const clip = byNumber ? clips[Number(f.n) - 1] : clips[i]
    if (!clip) {
      out.skipped.push(f.name)
      continue
    }
    try {
      await importPath({ kind: kind === 'video' ? 'clip-video' : 'clip-image', id: clip.id }, join(dir, f.name))
      out.imported++
    } catch {
      out.skipped.push(f.name)
    }
  }
  return out
}
