import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { SyncCursorStore } from '../src/state.js'

describe('SyncCursorStore', () => {
  it('atomically persists an owner-only long-poll cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-state-'))
    try {
      const path = join(directory, 'nested', 'cursor.json')
      const store = new SyncCursorStore(path)
      expect(await store.load()).toBe('')
      await store.save('cursor-1')
      expect(await store.load()).toBe('cursor-1')
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ get_updates_buf: 'cursor-1' })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
