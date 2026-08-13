import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Durable iLink long-poll cursor store with owner-only atomic writes. */
export class SyncCursorStore {
  constructor(readonly path: string) {}

  /** Load the last committed cursor, or an empty cursor for a new account. */
  async load(): Promise<string> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { get_updates_buf?: unknown }
      return typeof parsed.get_updates_buf === 'string' ? parsed.get_updates_buf : ''
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return ''
      throw new Error(`weixin-channel: cannot read sync cursor ${JSON.stringify(this.path)}: ${String(error)}`)
    }
  }

  /** Atomically commit one cursor with directory mode 0700 and file mode 0600. */
  async save(cursor: string): Promise<void> {
    const parent = dirname(this.path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    let committed = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ get_updates_buf: cursor }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.path)
      committed = true
      await chmod(this.path, 0o600)
    } finally {
      if (!committed) await unlink(temporary).catch(() => undefined)
    }
  }
}
