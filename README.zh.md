# DeepSeek Harness 微信插件

[English](README.md)

基于腾讯官方 iLink/ClawBot 协议和扫码授权，为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提供独立的微信私聊通道。

这是 DeepSeek Harness 原生插件，不依赖 OpenClaw。iLink 协议、扫码流程、AES 媒体处理和消息字段参考了腾讯以 MIT 许可证开源的 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 2.4.6 实现。

## 功能

- 微信官方二维码登录，不需要 AppID、AppSecret 或手工申请的 key。
- 登录令牌由 Harness 凭据服务保存，不进入插件配置。
- 长轮询游标原子持久化，重启后继续消费。
- 每个微信用户对应一个持久 Harness 会话。
- 完整接入 Harness Agent preset 生命周期、结构化工具执行和 Web live session 复用。
- 接收文字、语音转写、引用上下文和 AES 加密图片。
- 发送文字，并通过微信 CDN 加密上传图片。
- 出站文字支持与腾讯插件一致的部分 Markdown 渲染。
- 当前模型不支持视觉时，自动保存图片并降级为附件说明。
- 支持允许名单、禁用策略、有界并发、去重、重试和完整清理。
- 内置 `/bot-ping`、`/bot-help`、`/bot-status`、`/bot-image-test`、`/bot-cancel`。
- 按需扫码不阻塞 Harness Web；Linux 登录命令可在 Web 启动前独立完成授权。
- 工具请求审批时，可在同一微信会话用 `/approve <短码>` 或 `/reject <短码>` 决定。
- `/new`、`/reset` 创建新的持久 session；其他 Harness 斜杠命令直接进入命令运行时。

腾讯当前的 ClawBot/iLink 接入仅支持私聊。

## 前置条件：ClawBot 权限

这个通道不使用 API key。你的微信账号必须已经出现官方 ClawBot 插件入口：

```text
微信 → 我 → 设置 → 插件 → ClawBot
```

腾讯仍在逐步开放该功能。如果没有这个入口，不是缺少 key，也没有单独的 key 申请页面；需要等待账号获得资格，或先使用其他通道。

## 安装

直接从 GitHub 安装到 `web` profile（以下假设 `dsh` 已加入全局 `PATH`）：

```sh
dsh plugin --profile web add github:sliverp/DeepSeek-harness-weixin
```

安装只会更新 profile。服务尚未运行时用下面的命令启动；已经运行则重启：

```sh
dsh web
```

启动 `dsh web` 时，插件只会恢复已有凭据；没有凭据时保持离线，不会自动创建二维码，也不会阻塞或关闭 Harness Web。

需要扫码登录或更换当前微信账号时，运行：

```sh
dsh plugin --profile web exec dsh-weixin login --wait
```

`--wait` 会先显示二维码，再持续等待微信授权；成功退出码为 `0`，超时、扫码失败或凭据写入失败时退出码非 `0`。这个命令不要求 `dsh web` 已经运行：Web 未运行时，它会独立完成扫码并通过 Harness 官方凭据存储写入 `WEIXIN_ILINK_CREDENTIAL`，以后启动 Web 会自动恢复连接；Web 已运行时，它会使用仅当前用户可访问的本机 Unix Socket 请求插件登录，扫码确认前保留旧连接，确认后覆盖凭据并等待热切换完成。

这个流程即使微信已经连接也会强制重新扫码并覆盖配置，不会返回“微信已经连接，无需扫码”。命令不会启动或重启 Web，也不会把二维码链接写入 session。二维码失效或流程超时后，重新运行命令即可生成新二维码。

只需要二维码 URL（例如交给其他脚本）并等待最终结果时使用：

```sh
dsh plugin --profile web exec dsh-weixin login --url --wait
```

该模式会立即把 URL 写到标准输出，然后保持进程运行直到授权完成。标准输出严格等于 URL 本身：不渲染二维码、不输出状态文字，也不附加换行；诊断写入标准错误。扫码并完成连接切换（或在 Web 未运行时完成凭据持久化）后退出 `0`，超时或失败退出非 `0`，因此脚本可以直接检查退出码。Web 中的 `/weixin-login` 仍保留为辅助入口，但不是 Linux 命令扫码的前提。

如果没有全局 `dsh`，可以把上述命令中的 `dsh` 换成 `pnpm dsh`；URL-only 模式应使用 `pnpm --silent dsh ...`，避免 pnpm 自己的 `$ node ...` 提示混入标准输出。

不要转发二维码备用链接，也不要复制或提交保存后的 JSON 凭据；两者都能授权访问已连接的 ClawBot。

## 配置

组合包默认插入：

```yaml
- id: weixin-channel
  name: deepseek-harness-weixin
  config:
    credentialRef: WEIXIN_ILINK_CREDENTIAL
    cwd: !!js process.env.DSH_WEIXIN_CWD ?? process.cwd()
    permissionPreset: workspace-write
    statePath: !!js process.env.DSH_WEIXIN_STATE_PATH ?? ''
    controlSocketPath: !!js process.env.DSH_WEIXIN_CONTROL_SOCKET ?? ''
```

如需调整，在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖这一行：

```yaml
- id: weixin-channel
  name: deepseek-harness-weixin
  config:
    credentialRef: WEIXIN_ILINK_CREDENTIAL
    cwd: /absolute/path/the-agent-may-work-in
    agentPreset: standard
    permissionPreset: workspace-write
    statePath: /absolute/path/weixin-sync.json
    controlSocketPath: /absolute/path/weixin-control.sock
    autoLogin: false
    accessPolicy: allowlist
    allowFrom: [your-ilink-user-id]
    imageInputMode: auto
    responseTimeoutMs: 300000
    approvalTimeoutMs: 240000
    maxInFlightMessages: 8
    maxReplyImages: 4
```

`statePath` 为空时，游标默认保存在 `~/.dsh/weixin/`，并以原子写入和 `0600` 文件权限保护。

`controlSocketPath` 为空时默认为 `~/.dsh/weixin/control.sock`，目录权限为 `0700`，Socket 权限为 `0600`。它只用于 Web 已运行时的登录热切换，不是 `login --wait` 的启动前提。如自定义路径，CLI 使用相同的 `DSH_WEIXIN_CONTROL_SOCKET` 环境变量，或传入 `dsh-weixin login --socket <path>`。

`autoLogin` 默认为 `false`：缺少凭据时保持离线，只有运行上面的 Linux 命令才发起扫码。设为 `true` 可恢复启动 Web 时在后台自动显示二维码的行为；无论取值如何，扫码都不会阻塞 Web。

`imageInputMode` 默认为 `auto`：支持视觉的模型会收到持久图片块；纯文本模型会收到附件元数据，避免整轮失败。只有确认模型支持图片时才使用 `always`；使用 `never` 可强制文本降级。

`agentPreset` 可省略，默认采用 Harness preset roster 当前的默认项。新 session 会把最终解析出的 preset 记录到 header；恢复持久 session 时会采用该 session 记录的 preset（包括后续的 `agent-preset/selected` 事件）。只有完全没有 preset 记录的旧 session 才会明确回退到当前配置或默认 preset。同一 session 已经被 Web 加载时，微信通道会复用该 live Agent，不会启动第二个 writer。

`permissionPreset` 可省略。配置后会先通过 `ctx.permissionPresets` 校验，并且只在创建新的通道 session 时写入；恢复持久 session 或借用 live Agent 时会保留该 session 已记录的权限。Harness Agent Loop 发出 `approval/request` 时，插件会把结构化 `tool/call` 中的工具名和命令发送到发起该回合的微信会话，例如：

```text
Bash 请求执行：ls -la
回复 /approve 123456 或 /reject 123456
该审批将在 240 秒后失效。
```

只有同一微信会话中的匹配短码有效；每个短码只能决定一次。批准会向 Harness 返回 `allowed-once`，拒绝返回 `rejected`，超时、发送失败、取消或服务退出则按不可用/已取消闭合。`approvalTimeoutMs` 必须小于 `responseTimeoutMs`，以便审批后 Agent Loop 还有时间执行工具并生成最终回复。审批命令不受普通消息的并发上限阻塞。

本 checkout 使用 `workspace-write`。当前主机没有可用的本地沙箱后端时，Bash 可能请求一次性升级到 `danger-full-access`；只有明确回复对应的 `/approve` 后才会执行。批准这类升级意味着该次工具调用不受文件沙箱约束，因此必须保持 `allowFrom` 足够严格并在批准前检查命令。

## Agent Loop 修复后的旧 session 处理

session ID namespace 已升级为 `weixin-v3-single-...`。已有 `weixin-v1-single-...` 和 `weixin-v2-single-...` session 都不会被删除或改写，仍可在 Web 中查看。微信通道不再恢复 v1，因为其中可能已经把工具调用载体保存成普通 assistant 文本；也不再恢复 v2，因为文字审批接入前发起的审批可能留下未闭合 turn。升级后从微信发送第一条消息时会创建干净的 v3 session。每次 `/new` 或 `/reset` 会切换到后缀为 `-new-N` 的新 session；旧日志保持原样，服务重启后会继续编号最大的最新 session。

## 斜杠命令

`/new` 和 `/reset` 由微信通道处理：如当前 Agent 正在运行，会先取消并等待其闭合，然后创建新的持久 Harness session。旧 session 不会删除，仍可在 Web 中恢复或查看。

`/weixin-login` 是 Linux CLI 之外的辅助入口，可从 Web 强制拉起重新扫码；它不会进入模型。其他语法合法的斜杠命令会调用 `ctx.commands.execute(agent, line, signal)`，而不是作为用户文字交给模型；因此会产生 Harness 原生的 `command/run` 和 `command/done` 事件。实际命令目录取决于当前 Harness 组合，通常包括 `/plan`、`/compact`、`/permission`、`/goal`、`/feedback` 和 `/export`。未知或格式错误的斜杠命令会直接返回命令提示，同样不会进入模型。

## Markdown 兼容性

iLink 协议的出站文字只是普通 `text_item.text` 字符串，不存在独立的富文本消息类型。发送前，本插件会采用[腾讯 `openclaw-weixin` 2.4.6](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/markdown-filter.ts) 相同的部分 Markdown 过滤策略：保留代码块、行内代码、表格、列表、引用、分隔线、H1-H4 标题、粗体、删除线和非 CJK 斜体标记；微信不支持的 CJK 斜体/粗斜体标记以及 H5-H6 标记会被移除，但正文保留。Markdown 图片引用会被移除，因为 Harness 图片块会改走 AES 加密的微信 CDN 媒体链路。

这是针对微信显示能力的部分兼容，不等同于完整 CommonMark 或 HTML 渲染。

## 验证

日志出现 iLink 凭据验证成功后，从已连接的微信会话发送 `/bot-ping`，应收到：

```text
pong — DeepSeek Harness 微信机器人已连接。
```

发送 `/bot-image-test` 可以独立验证 AES 加密、微信 CDN 上传和图片投递，不依赖模型生成图片。然后再发送普通文字和一张照片，验证 Harness 模型链路。

工具审批可发送“我当前有啥文件？”验证。收到 `Bash 请求执行：...` 后，原样回复其中的 `/approve <短码>`；插件应先确认批准，随后只发送工具执行后的最终文件列表。回复 `/reject <短码>` 则拒绝该次调用。

## 重新登录

无需先删除凭据，直接运行 `dsh plugin --profile web exec dsh-weixin login --wait` 即可强制重新扫码并覆盖 `WEIXIN_ILINK_CREDENTIAL`。如果微信提示 ClawBot 已绑定其他本地实例，请先在微信中解除旧连接。

## 开发

```sh
pnpm install
pnpm run check
```

仓库提交构建后的 `dist/`，因此从 GitHub 安装时不需要授权依赖执行构建脚本。

## 许可证与上游声明

MIT。协议派生部分在 [LICENSE](LICENSE) 中保留腾讯版权和许可证声明。
