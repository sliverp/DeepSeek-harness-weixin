#!/usr/bin/env node

import { requestLoginFromControlSocket, resolveControlSocketPath } from './control.js'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface CliOptions {
  command: 'login'
  socketPath: string
}

/** Run the plugin-owned Linux control CLI. */
export async function run(argv: readonly string[]): Promise<number> {
  let options: CliOptions
  try {
    const parsed = parseArgs(argv)
    if (parsed === 'help') {
      process.stdout.write(usage())
      return 0
    }
    options = parsed
  } catch (error) {
    process.stderr.write(`${renderError(error)}\n\n${usage()}`)
    return 2
  }

  let response
  try {
    response = await requestLoginFromControlSocket(options.socketPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const detail = code === 'ENOENT' || code === 'ECONNREFUSED'
      ? '微信插件控制通道尚未运行，请先启动 pnpm dsh web。'
      : `无法连接微信插件控制通道：${renderError(error)}`
    process.stderr.write(`${detail}\nSocket: ${options.socketPath}\n`)
    return 1
  }

  if (!response.ok) {
    process.stderr.write(`微信扫码启动失败：${response.error}\n`)
    return 1
  }
  if (response.kind === 'connected') {
    process.stdout.write('微信已经连接，无需扫码。\n')
    return 0
  }

  try {
    await displayQr(response.url)
  } catch (error) {
    process.stderr.write(`无法显示微信二维码：${renderError(error)}\n`)
    return 1
  }
  process.stdout.write(response.reused
    ? '已显示当前扫码流程的最新二维码。\n'
    : '已生成新的微信二维码，请扫码并在微信中确认连接。\n')
  return 0
}

function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return 'help'
  if (argv[0] !== 'login') throw new Error(`未知命令：${argv[0] ?? ''}`)

  let socketPath: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--socket') {
      const value = argv[index + 1]
      if (!value) throw new Error('--socket 需要一个路径')
      socketPath = value
      index += 1
      continue
    }
    if (argument?.startsWith('--socket=')) {
      socketPath = argument.slice('--socket='.length)
      if (!socketPath) throw new Error('--socket 需要一个路径')
      continue
    }
    throw new Error(`未知参数：${argument ?? ''}`)
  }
  return { command: 'login', socketPath: resolveControlSocketPath(socketPath) }
}

async function displayQr(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('微信二维码地址不是 HTTPS')
  const qrcode = await import('qrcode-terminal')
  qrcode.default.generate(url, { small: true })
  process.stdout.write(`二维码备用链接（请勿转发）：\n${url}\n`)
}

function usage(): string {
  return [
    '用法：dsh-weixin login [--socket <path>]',
    '',
    '通过本机 Unix Socket 请求正在运行的 DeepSeek Harness 微信插件显示二维码。',
    '',
  ].join('\n')
}

function renderError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '<无法显示的错误>'
  }
}

if (isMainModule()) {
  process.exitCode = await run(process.argv.slice(2))
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
