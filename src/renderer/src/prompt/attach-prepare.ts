import { oversizeAttachment, type AttachLimit } from '../../../shared/attachment-limit'
import { attachKind, planImage, planVideo, type ImagePlan, type VideoPlan } from './attach-plan'

/**
 * THE FILES A PHONE PICKED, MADE READY TO GO UP: each one kept as it is,
 * compressed to fit the path (attach-plan.ts), or refused with a reason the
 * box can say. One at a time — a phone has one hardware encoder — with the
 * progress of each, and stopped by the signal between files or mid-encode.
 *
 * The browser's work is passed in (attach-media.ts), so the rules here are
 * tested without a codec or a canvas.
 */

type EncodePlan<P> = Extract<P, { kind: 'encode' }>

export interface Compressors {
  /** Length and shown size; null when this browser cannot read the file. */
  readonly probeVideo: (file: File) => Promise<{ seconds: number; width: number; height: number } | null>
  /** The compressed MP4. Rejects when this browser cannot make one (an AbortError when stopped). */
  readonly encodeVideo: (
    file: File,
    plan: EncodePlan<VideoPlan>,
    progress: (fraction: number) => void,
    signal: AbortSignal
  ) => Promise<Blob>
  /** Its size as shown; null when this browser cannot decode it. */
  readonly probeImage: (file: File) => Promise<{ width: number; height: number } | null>
  readonly encodeImage: (file: File, plan: EncodePlan<ImagePlan>) => Promise<Blob>
}

export interface PrepareOptions {
  readonly limit: AttachLimit
  /** Which file (1-based, of `total`) and how far its compressing is. */
  readonly onProgress?: (progress: {
    readonly name: string
    readonly fraction: number
    readonly index: number
    readonly total: number
  }) => void
  readonly signal?: AbortSignal
}

const MB = 1024 * 1024
const megabytes = (bytes: number): string => `${Number((bytes / MB).toFixed(1))} MB`
/** A second try asks for this much of the first bitrate: encoders overshoot, rarely by more. */
const RETRY_SCALE = 0.7

/**
 * THE OWNER STOPPED IT (the box's ✕): not a failure, and the box says nothing.
 * Its own name, so it is never mistaken for a request the network aborted —
 * a path that changed mid-upload is a failure the owner must hear about.
 */
export const ATTACH_STOPPED = 'AttachStopped'
export class AttachStopped extends Error {
  constructor() {
    super('stopped')
    this.name = ATTACH_STOPPED
  }
}

const stopped = (): AttachStopped => new AttachStopped()
const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError'

/** `name` with its last extension swapped: `IMG_1.MOV` → `IMG_1.mp4`. */
const renamed = (name: string, extension: string): string => `${name.replace(/\.[^./]+$/, '') || 'file'}.${extension}`

/** Where the limit comes from, for a sentence about it. */
const pathSaid = (limit: AttachLimit): string =>
  limit.via === 'relay' ? `through the relay attachments stop at ${megabytes(limit.bytes)}` : `the Mac takes attachments up to ${megabytes(limit.bytes)}`

/** As it is, when the path takes it; otherwise the reason it cannot go. */
const asItIs = (file: File, limit: AttachLimit): File => {
  const said = oversizeAttachment([file], limit)
  if (said) throw new Error(said)
  return file
}

/** The smaller of the two, when the original fits: compressing never makes a file worse. */
const smaller = (file: File, made: File, limit: AttachLimit): File => (made.size >= file.size && file.size <= limit.bytes ? file : made)

const prepareVideo = async (
  file: File,
  options: PrepareOptions,
  compressors: Compressors,
  signal: AbortSignal,
  place: { readonly index: number; readonly total: number }
): Promise<File> => {
  const { limit } = options
  const facts = await compressors.probeVideo(file).catch(() => null)
  if (!facts) return asItIs(file, limit)
  const plan = planVideo({ name: file.name, size: file.size, ...facts }, limit)
  if (plan.kind === 'keep') return file
  if (plan.kind === 'refuse') throw new Error(plan.reason)
  const progress = (fraction: number): void => options.onProgress?.({ name: file.name, fraction, ...place })
  const encode = async (encodePlan: EncodePlan<VideoPlan>): Promise<Blob> => {
    try {
      return await compressors.encodeVideo(file, encodePlan, progress, signal)
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw stopped()
      if (file.size <= limit.bytes) return file
      throw new Error(`${file.name} is ${megabytes(file.size)} and this browser could not make it smaller; ${pathSaid(limit)}`)
    }
  }
  progress(0)
  const first = await encode(plan)
  if (first === file) return file
  const made =
    first.size <= limit.bytes
      ? first
      : await encode({ ...plan, videoBps: Math.floor(plan.videoBps * RETRY_SCALE), audioBps: Math.min(plan.audioBps, 48_000) })
  if (made === file) return file
  const ready = new File([made], renamed(file.name, 'mp4'), { type: 'video/mp4' })
  const kept = smaller(file, ready, limit)
  if (kept.size > limit.bytes) throw new Error(`${file.name} is still ${megabytes(kept.size)} compressed; ${pathSaid(limit)}`)
  return kept
}

const prepareImage = async (file: File, options: PrepareOptions, compressors: Compressors): Promise<File> => {
  const { limit } = options
  const facts = await compressors.probeImage(file).catch(() => null)
  if (!facts) return asItIs(file, limit)
  const plan = planImage({ name: file.name, type: file.type, size: file.size, ...facts }, limit)
  if (plan.kind === 'keep') return asItIs(file, limit)
  const made = await compressors.encodeImage(file, plan).catch(() => null)
  if (!made) return asItIs(file, limit)
  const ready = smaller(file, new File([made], renamed(file.name, 'jpg'), { type: plan.type }), limit)
  return asItIs(ready, limit)
}

export async function prepareAttachments(files: readonly File[], options: PrepareOptions, compressors: Compressors): Promise<File[]> {
  const signal = options.signal ?? new AbortController().signal
  const ready: File[] = []
  for (const [at, file] of files.entries()) {
    if (signal.aborted) throw stopped()
    const kind = attachKind(file)
    const done =
      kind === 'video'
        ? await prepareVideo(file, options, compressors, signal, { index: at + 1, total: files.length })
        : kind === 'image'
          ? await prepareImage(file, options, compressors)
          : asItIs(file, options.limit)
    ready.push(done)
  }
  if (signal.aborted) throw stopped()
  return ready
}

export interface SendOptions extends Omit<PrepareOptions, 'onProgress'> {
  /** What the box says now; `compressing` while the ✕ can still stop something. */
  readonly onNote: (said: string | null, compressing: boolean) => void
}

/** Short enough for a phone's note beside the box: which file of how many, and how far. */
export const compressingSaid = ({ fraction, index, total }: { fraction: number; index: number; total: number }): string =>
  `compressing${total > 1 ? ` ${index}/${total}` : ''} · ${Math.round(fraction * 100)}%`

/**
 * EACH FILE MADE READY, THEN SENT, BEFORE THE NEXT IS TOUCHED: the phone holds
 * one compressed file at a time, and the Mac takes one upload from this box.
 * The paths come back in the files' order.
 */
export async function sendOneByOne(
  files: readonly File[],
  save: (ready: File[]) => Promise<string[]>,
  options: SendOptions,
  compressors: Compressors
): Promise<string[]> {
  const { onNote, signal } = options
  let paths: readonly string[] = []
  for (const [at, file] of files.entries()) {
    const place = { index: at + 1, total: files.length }
    onNote(null, true)
    const [ready] = await prepareAttachments(
      [file],
      {
        limit: options.limit,
        ...(signal ? { signal } : {}),
        onProgress: ({ fraction }) => {
          if (!signal?.aborted) onNote(compressingSaid({ fraction, ...place }), true)
        }
      },
      compressors
    )
    onNote(files.length > 1 ? `uploading ${place.index}/${place.total}…` : 'uploading…', false)
    paths = [...paths, ...(await save([ready]))]
  }
  return [...paths]
}
