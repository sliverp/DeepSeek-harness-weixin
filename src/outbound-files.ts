import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One workspace file materialized for a Weixin upload. */
export interface OutboundFile {
  data: Uint8Array
  name: string
}

/** Files and user-visible safety warnings extracted from one final answer. */
export interface OutboundFileCollection {
  files: OutboundFile[]
  warnings: string[]
}

interface FileCandidate {
  path: string
  explicit: boolean
}

const MARKDOWN_LINK = /(?<!!)\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g

/** Resolve final-answer file links into bounded bytes that can be uploaded by Weixin. */
export async function collectOutboundFiles(
  text: string,
  cwd: string,
  maxFiles: number,
  maxFileBytes: number,
): Promise<OutboundFileCollection> {
  if (maxFiles === 0 || !text.trim()) return { files: [], warnings: [] }
  const candidates = fileCandidates(text)
  if (candidates.length === 0) return { files: [], warnings: [] }

  let workspace: string
  try {
    workspace = await realpath(cwd)
  } catch {
    return { files: [], warnings: ['文件未发送：当前 Agent 工作目录不可用。'] }
  }

  const files: OutboundFile[] = []
  const warnings = new Set<string>()
  const seen = new Set<string>()
  for (const candidate of candidates.slice(0, 100)) {
    const localPath = candidatePath(candidate.path, cwd)
    if (localPath === undefined) continue

    let canonical: string
    try {
      canonical = await realpath(localPath)
    } catch {
      if (candidate.explicit) warnings.add('有文件链接指向不存在或不可读取的文件，未发送。')
      continue
    }
    if (!contains(workspace, canonical)) {
      if (candidate.explicit) warnings.add('工作目录之外的文件不会通过微信发送。')
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)

    let info
    try {
      info = await stat(canonical)
    } catch {
      if (candidate.explicit) warnings.add('有文件链接指向不存在或不可读取的文件，未发送。')
      continue
    }
    if (!info.isFile()) {
      if (candidate.explicit) warnings.add('目录或特殊文件不能通过微信发送。')
      continue
    }
    if (info.size === 0) {
      warnings.add('微信不允许发送空文件。')
      continue
    }
    if (info.size > maxFileBytes) {
      warnings.add(`文件超过微信出站上限 ${maxFileBytes} 字节，未发送。`)
      continue
    }
    if (files.length >= maxFiles) {
      warnings.add(`一次回复最多发送 ${maxFiles} 个文件，其余文件未发送。`)
      continue
    }

    try {
      files.push({ data: await readBounded(canonical, maxFileBytes), name: basename(canonical) })
    } catch {
      warnings.add('文件在读取时发生变化、超过限制或不可读取，未发送。')
    }
  }
  return { files, warnings: [...warnings] }
}

function fileCandidates(text: string): FileCandidate[] {
  const candidates: FileCandidate[] = []
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const value = match[1]
    if (value !== undefined) candidates.push({ path: value, explicit: true })
  }
  return candidates
}

function candidatePath(input: string, cwd: string): string | undefined {
  let value = input.trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1)
  value = value.replace(/[),.;!?。，；！？：]+$/u, '')
  try {
    value = decodeURIComponent(value)
  } catch {
    return undefined
  }
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value)
    } catch {
      return undefined
    }
  }
  if (value.startsWith('sandbox:')) value = value.slice('sandbox:'.length)
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !isAbsolute(value)) return undefined
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function contains(parent: string, child: string): boolean {
  const fromParent = relative(parent, child)
  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent))
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) return Buffer.concat(chunks, total)
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    throw new Error('file exceeds outbound limit')
  } finally {
    await handle.close()
  }
}
