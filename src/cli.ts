#!/usr/bin/env node

import {
  requestLoginFromControlSocket,
  resolveControlSocketPath,
  waitForLoginFromControlSocket,
  type WeixinControlResponse,
} from './control.js'
import { loginStandalone } from './standalone-login.js'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

interface CliOptions {
  command: 'login'
  socketPath: string
  urlOnly: boolean
  wait: boolean
}

const DEFAULT_CREDENTIAL_REF = 'WEIXIN_ILINK_CREDENTIAL'
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000

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
    response = await requestLoginFromControlSocket(options.socketPath, { urlOnly: options.urlOnly })
  } catch (error) {
    if (options.wait && isControlUnavailable(error)) return runStandalone(options)
    const code = (error as NodeJS.ErrnoException).code
    const detail = code === 'ENOENT' || code === 'ECONNREFUSED'
      ? '微信插件控制通道尚未运行；使用 --wait 可在不启动 dsh web 的情况下独立登录。'
      : `无法连接微信插件控制通道：${renderError(error)}`
    process.stderr.write(`${detail}\nSocket: ${options.socketPath}\n`)
    return 1
  }

  if (!response.ok) {
    process.stderr.write(`微信扫码启动失败：${response.error}\n`)
    return 1
  }
  if (response.kind !== 'qr') {
    process.stderr.write('微信扫码启动失败：控制通道返回了无效的二维码状态。\n')
    return 1
  }
  try {
    await presentQr(response.url, options.urlOnly)
  } catch (error) {
    process.stderr.write(`无法显示微信二维码：${renderError(error)}\n`)
    return 1
  }
  if (options.wait) return waitForLiveLogin(options, response)
  if (options.urlOnly) return 0
  process.stdout.write(response.reused
    ? '已显示当前扫码流程的最新二维码。\n'
    : '已生成新的微信二维码，请扫码并在微信中确认连接。\n')
  return 0
}

function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return 'help'
  if (argv[0] !== 'login') throw new Error(`未知命令：${argv[0] ?? ''}`)

  let socketPath: string | undefined
  let urlOnly = false
  let wait = false
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--url') {
      urlOnly = true
      continue
    }
    if (argument === '--wait') {
      const value = argv[index + 1]
      if (value === 'true' || value === 'false') {
        wait = value === 'true'
        index += 1
      } else {
        wait = true
      }
      continue
    }
    if (argument?.startsWith('--wait=')) {
      const value = argument.slice('--wait='.length)
      if (value !== 'true' && value !== 'false') throw new Error('--wait 只接受 true 或 false')
      wait = value === 'true'
      continue
    }
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
  return { command: 'login', socketPath: resolveControlSocketPath(socketPath), urlOnly, wait }
}

async function presentQr(url: string, urlOnly: boolean): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('微信二维码地址不是 HTTPS')
  if (urlOnly) {
    process.stdout.write(url)
    return
  }
  const qrcode = await import('qrcode-terminal')
  qrcode.default.generate(url, { small: true })
  process.stdout.write(`二维码备用链接（请勿转发）：\n${url}\n`)
}

function usage(): string {
  return [
    '用法：dsh-weixin login [--url] [--wait[=true|false]] [--socket <path>]',
    '',
    '强制重新登录并覆盖已保存的微信凭据。',
    '--url 成功时只向标准输出写入二维码 URL，不输出二维码或其他文字。',
    '--wait 先输出二维码或 URL，再等待授权完成；成功退出 0，失败退出非 0。',
    '--wait 不依赖 dsh web；Web 已运行时通过本机 Socket 完成连接热切换。',
    '',
  ].join('\n')
}

async function waitForLiveLogin(options: CliOptions, response: Extract<WeixinControlResponse, { kind: 'qr' }>): Promise<number> {
  if (response.loginId === undefined) {
    process.stderr.write('运行中的微信插件版本不支持 --wait，请重启 dsh web 后再试。\n')
    return 1
  }
  let completion: WeixinControlResponse
  try {
    completion = await waitForLoginFromControlSocket(options.socketPath, response.loginId)
  } catch (error) {
    process.stderr.write(`等待微信授权失败：${renderError(error)}\n`)
    return 1
  }
  if (!completion.ok) {
    process.stderr.write(`微信授权失败：${completion.error}\n`)
    return 1
  }
  if (completion.kind !== 'connected') {
    process.stderr.write('微信授权失败：控制通道返回了无效的完成状态。\n')
    return 1
  }
  if (!options.urlOnly) process.stdout.write('微信授权成功，连接已切换。\n')
  return 0
}

async function runStandalone(options: CliOptions): Promise<number> {
  let shown = false
  try {
    await loginStandalone({
      credentialRef: process.env.DSH_WEIXIN_CREDENTIAL_REF?.trim() || DEFAULT_CREDENTIAL_REF,
      timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
      showQr: async url => {
        if (shown && options.urlOnly) throw new Error('二维码已失效，请重新运行登录命令获取新 URL')
        shown = true
        await presentQr(url, options.urlOnly)
      },
      status: options.urlOnly ? () => undefined : message => process.stdout.write(`${message}\n`),
      readVerifyCode: readVerifyCodeFromCli,
    })
    return 0
  } catch (error) {
    process.stderr.write(`微信授权失败：${renderError(error)}\n`)
    return 1
  }
}

async function readVerifyCodeFromCli(prompt: string, signal?: AbortSignal): Promise<string> {
  // stderr preserves the exact stdout contract of --url while remaining
  // interactive for accounts on which Weixin requests numeric verification.
  const input = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await (signal === undefined
      ? input.question(prompt)
      : input.question(prompt, { signal }))).trim()
  } finally {
    input.close()
  }
}

function isControlUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED'
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
