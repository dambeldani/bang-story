import { useCallback, useEffect, useState } from 'react'
import { ClipboardPaste, Copy, Upload } from 'lucide-react'
import type { Asset, ManualPrompt, ManualTarget } from '@shared/types'
import { Button } from '../../components/ui'
import { errorText } from '../../lib/format'
import { useApp } from '../../store/app'

const IMAGE_TYPES = /\.(png|jpe?g|webp)$/i
const VIDEO_TYPES = /\.(mp4|mov|webm)$/i

/** The file extension to store a File under: from its name, else from its type (clipboard images have no name). */
function extOf(file: File): string {
  const m = /\.([a-z0-9]+)$/i.exec(file.name)
  if (m) return m[1].toLowerCase()
  const t = /^(?:image|video)\/([a-z0-9]+)/i.exec(file.type)?.[1].toLowerCase() ?? ''
  return t === 'quicktime' ? 'mov' : t
}

/** What a dropped or pasted file can become. Null for anything else, so other drops are left alone. */
export function kindOfFile(file: File): 'image' | 'video' | null {
  const name = file.name || `x.${extOf(file)}`
  if (IMAGE_TYPES.test(name) || file.type.startsWith('image/')) return 'image'
  if (VIDEO_TYPES.test(name) || file.type.startsWith('video/')) return 'video'
  return null
}

/** Copying prompts and loading finished files for one clip picture, clip video or character sheet. */
export function useManualMedia(target: ManualTarget) {
  const { toast } = useApp()
  const [info, setInfo] = useState<ManualPrompt | null>(null)
  const [busy, setBusy] = useState<'copy' | 'load' | null>(null)

  const guard = useCallback(
    async (kind: 'copy' | 'load', fn: () => Promise<void>): Promise<void> => {
      setBusy(kind)
      try {
        await fn()
      } catch (e) {
        toast('error', errorText(e))
      } finally {
        setBusy(null)
      }
    },
    [toast]
  )

  const done = useCallback(
    (a: Asset | null): void => {
      if (a) toast('success', target.kind === 'clip-video' ? 'Video dimuat ke klip.' : target.kind === 'sheet' ? 'Lembar karakter dimuat.' : 'Gambar dimuat ke klip.')
    },
    [toast, target.kind]
  )

  const copy = useCallback(
    () =>
      guard('copy', async () => {
        const p = await window.api.manual.prompt(target)
        await window.api.app.copyText(p.prompt)
        setInfo(p)
        toast('success', 'Prompt disalin. Tempel di aplikasi pembuat gambar atau video.')
      }),
    [guard, target.kind, target.id]
  )

  const pick = useCallback(() => guard('load', async () => done(await window.api.manual.importDialog(target))), [guard, done, target.kind, target.id])

  /** A dropped or pasted file. Files with a path on disk are copied directly; others travel as bytes. */
  const loadFile = useCallback(
    (file: File) =>
      guard('load', async () => {
        const path = window.api.manual.pathFor(file)
        done(path ? await window.api.manual.importPath(target, path) : await window.api.manual.importBytes(target, new Uint8Array(await file.arrayBuffer()), extOf(file)))
      }),
    [guard, done, target.kind, target.id]
  )

  /** The "paste image" button: reads an image straight from the clipboard. */
  const pasteImage = useCallback(
    () =>
      guard('load', async () => {
        const items = await navigator.clipboard.read().catch(() => [])
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'))
          if (!type) continue
          const blob = await item.getType(type)
          return done(await window.api.manual.importBytes(target, new Uint8Array(await blob.arrayBuffer()), extOf(new File([blob], '', { type }))))
        }
        throw new Error('Tidak ada gambar di clipboard. Salin gambarnya dulu (klik kanan › Salin gambar).')
      }),
    [guard, done, target.kind, target.id]
  )

  return { info, busy, copy, pick, loadFile, pasteImage }
}

/** Ctrl+V anywhere on the screen loads a copied image into the target; plain text pastes are left alone. */
export function usePasteImage(onFile: (file: File) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onPaste = (e: ClipboardEvent): void => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => kindOfFile(f) === 'image')
      if (!file) return
      e.preventDefault()
      onFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [onFile, enabled])
}

/** Drag-and-drop props for an area that accepts files. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setOver(false)
        onFiles([...e.dataTransfer.files])
      }
    }
  }
}

/** Buttons to copy a prompt, load the finished file, and a note on what to attach. */
export function ManualBar({
  target,
  media,
  extra
}: {
  target: ManualTarget
  media: ReturnType<typeof useManualMedia>
  /** More buttons, shown after the standard ones. */
  extra?: React.ReactNode
}) {
  const video = target.kind === 'clip-video'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Copy className="size-4" />} loading={media.busy === 'copy'} onClick={() => void media.copy()}>
          {video ? 'Salin prompt video' : 'Salin prompt'}
        </Button>
        <Button size="sm" icon={<Upload className="size-4" />} loading={media.busy === 'load'} onClick={() => void media.pick()}>
          {video ? 'Muat video' : 'Muat gambar'}
        </Button>
        {!video && (
          <Button size="sm" icon={<ClipboardPaste className="size-4" />} disabled={media.busy === 'load'} onClick={() => void media.pasteImage()}>
            Tempel gambar
          </Button>
        )}
        {extra}
      </div>
      {media.info && <p className="rounded-lg bg-sand px-2.5 py-1.5 text-xs leading-relaxed text-ink-2">{media.info.hint}</p>}
    </div>
  )
}

