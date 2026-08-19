import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectOutboundFiles } from '../src/outbound-files.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-weixin-outbound-'))
  temporaryDirectories.push(path)
  return path
}

describe('collectOutboundFiles', () => {
  it('collects explicit workspace file links once and ignores plain path mentions', async () => {
    const cwd = await workspace()
    const report = join(cwd, 'report.csv')
    const spacedDirectory = join(cwd, 'generated files')
    const spaced = join(spacedDirectory, 'summary.txt')
    await mkdir(spacedDirectory)
    await writeFile(report, 'id,value\n1,ok\n')
    await writeFile(spaced, 'summary')

    const result = await collectOutboundFiles(
      `已生成 [CSV](report.csv)、[摘要](<generated%20files/summary.txt>)。仅提到路径不会触发发送：${report}`,
      cwd,
      5,
      1024,
    )

    expect(result.warnings).toEqual([])
    expect(result.files.map(file => file.name)).toEqual(['report.csv', 'summary.txt'])
    expect(Buffer.from(result.files[0]!.data).toString()).toBe('id,value\n1,ok\n')
  })

  it('rejects links outside the workspace including symlink escapes', async () => {
    const cwd = await workspace()
    const outside = await workspace()
    const secret = join(outside, 'secret.txt')
    const escaped = join(cwd, 'escaped.txt')
    await writeFile(secret, 'not for upload')
    await symlink(secret, escaped)

    const result = await collectOutboundFiles(`[outside](${secret}) [escaped](${escaped})`, cwd, 5, 1024)

    expect(result.files).toEqual([])
    expect(result.warnings).toContain('工作目录之外的文件不会通过微信发送。')
  })

  it('enforces empty, size, and count limits', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'empty.txt'), '')
    await writeFile(join(cwd, 'large.txt'), '12345')
    await writeFile(join(cwd, 'one.txt'), '1')
    await writeFile(join(cwd, 'two.txt'), '2')

    const limited = await collectOutboundFiles(
      '[empty](empty.txt) [large](large.txt) [one](one.txt) [two](two.txt)',
      cwd,
      1,
      4,
    )

    expect(limited.files.map(file => file.name)).toEqual(['one.txt'])
    expect(limited.warnings).toContain('微信不允许发送空文件。')
    expect(limited.warnings).toContain('文件超过微信出站上限 4 字节，未发送。')
    expect(limited.warnings).toContain('一次回复最多发送 1 个文件，其余文件未发送。')
  })
})
