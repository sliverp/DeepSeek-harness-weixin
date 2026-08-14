# DeepSeek Harness Weixin

[简体中文](README.zh.md)

An independent Weixin private-chat channel for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness), using Tencent's official iLink/ClawBot protocol and QR authorization.

This is a DeepSeek Harness plugin, not an OpenClaw adapter. The iLink protocol, QR flow, AES media handling, and message fields are derived from Tencent's MIT-licensed [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 2.4.6 implementation.

## Features

- Official Weixin QR login; no AppID, AppSecret, or manually issued key.
- Login token stored through the Harness credential provider, never in plugin config.
- Restart-safe long-poll cursor with atomic owner-only storage.
- Persistent Harness conversation per Weixin user.
- Full Harness Agent preset lifecycle, including structured tool execution and live Web-session reuse.
- Inbound text, voice transcription, quoted context, and encrypted images.
- Outbound text and AES-encrypted CDN image upload.
- Tencent-compatible partial Markdown rendering for outbound text.
- Automatic text-only fallback when the selected model cannot inspect images.
- Allowlist/disabled access policy, bounded concurrency, deduplication, retries, and clean teardown.
- `/bot-ping`, `/bot-help`, `/bot-status`, `/bot-image-test`, and `/bot-cancel` diagnostics.
- Same-chat `/approve <code>` and `/reject <code>` decisions for tool approval requests.
- Persistent `/new` and `/reset` sessions plus direct dispatch of other Harness slash commands.

The official ClawBot/iLink integration currently supports private chats only.

## Prerequisite: ClawBot access

This channel does not use an API key. Your Weixin account must have the official ClawBot plugin entry:

```text
Weixin → Me → Settings → Plugins → ClawBot
```

Tencent is rolling this feature out gradually. If the entry is absent, there is no key to apply for; wait until the account becomes eligible or use another supported channel.

## Install

Install directly from GitHub into the `web` profile:

```sh
pnpm dsh plugin --profile web add github:sliverp/DeepSeek-harness-weixin
```

Installation only updates the profile. Start the service with the command below, or restart it if it is already running:

```sh
pnpm dsh web
```

On the first launch, the plugin prints a QR code and a short-lived fallback URL. Scan it with Weixin and confirm the connection. If Weixin shows a numeric verification code, type that code into the same terminal. The issued credential is then stored under `WEIXIN_ILINK_CREDENTIAL` by `ctx.credentials`; subsequent launches require no login.

Do not share the QR fallback URL or the stored JSON credential. Both authorize access to the linked ClawBot.

## Configuration

The bundle inserts this row:

```yaml
- id: weixin-channel
  name: deepseek-harness-weixin
  config:
    credentialRef: WEIXIN_ILINK_CREDENTIAL
    cwd: !!js process.env.DSH_WEIXIN_CWD ?? process.cwd()
    statePath: !!js process.env.DSH_WEIXIN_STATE_PATH ?? ''
```

Override the row in `~/.dsh/profiles/web/cordis.patch.yml` when needed:

```yaml
- id: weixin-channel
  name: deepseek-harness-weixin
  config:
    credentialRef: WEIXIN_ILINK_CREDENTIAL
    cwd: /absolute/path/the-agent-may-work-in
    agentPreset: standard
    permissionPreset: workspace-write
    statePath: /absolute/path/weixin-sync.json
    accessPolicy: allowlist
    allowFrom: [your-ilink-user-id]
    imageInputMode: auto
    responseTimeoutMs: 300000
    approvalTimeoutMs: 240000
    maxInFlightMessages: 8
    maxReplyImages: 4
```

When `statePath` is empty, the cursor is stored under `~/.dsh/weixin/`. The plugin creates the file atomically with mode `0600`.

`imageInputMode` defaults to `auto`: image-capable models receive a durable image block, while text-only models receive attachment metadata instead of failing the turn. Use `always` only with a route known to accept images, or `never` to force the fallback.

`agentPreset` is optional and defaults to the Harness preset roster's current default. A newly created session records the resolved preset in its header. Persistent resumes restore the preset recorded by the session (including later `agent-preset/selected` events); only a legacy session with no recorded preset uses the current configured/default fallback. If Web already has the same session loaded, the channel reuses that live Agent rather than creating a second writer.

`permissionPreset` is optional. When configured, it is validated against `ctx.permissionPresets` and pinned only while creating a new channel session; persisted resumes and borrowed live Agents keep the permission recorded in that session. When the Harness Agent Loop emits `approval/request`, the plugin sends the tool name and command from the structured `tool/call` to the Weixin chat that started the turn:

```text
Bash 请求执行：ls -la
回复 /approve 123456 或 /reject 123456
该审批将在 240 秒后失效。
```

Only a matching code from the same Weixin conversation is accepted, and each code is one-shot. Approval returns `allowed-once` to Harness; rejection returns `rejected`; timeout, transport failure, cancellation, and shutdown fail closed. `approvalTimeoutMs` must be less than `responseTimeoutMs`, leaving time for the Agent Loop to execute the tool and produce its final response. Approval commands bypass the ordinary message concurrency limit.

This checkout uses `workspace-write`. If the host has no usable local sandbox backend, Bash may request a one-shot escalation to `danger-full-access`; it runs only after the matching `/approve` reply. Such an approval removes filesystem confinement for that tool call, so keep `allowFrom` narrow and inspect the command before approving it.

## Session compatibility after the Agent-loop fix

Session IDs now use the `weixin-v3-single-...` namespace. Existing `weixin-v1-single-...` and `weixin-v2-single-...` sessions are left untouched and remain available in Web. The channel does not resume v1 because it may contain tool-call transport text as ordinary assistant messages; it does not resume v2 because an approval requested before text approval support may have left an open turn. The first post-upgrade Weixin message creates a clean v3 session; no existing session data is deleted or rewritten. Each `/new` or `/reset` selects a fresh `-new-N` suffix; older logs remain untouched, and a restart resumes the highest/latest generation.

## Slash commands

`/new` and `/reset` are channel-owned. If the current Agent is running, the channel cancels it and waits for the turn to close before creating a fresh persistent Harness session. The old session is retained for Web inspection or resume.

Every other syntactically valid slash command is sent to `ctx.commands.execute(agent, line, signal)`, never to the model, and therefore records native `command/run` and `command/done` events. The effective catalog depends on the Harness composition and commonly includes `/plan`, `/compact`, `/permission`, `/goal`, `/feedback`, and `/export`. Unknown or malformed slash commands return command guidance without entering the model.

## Markdown compatibility

The iLink protocol carries outbound text as a plain `text_item.text` string rather than a rich-text message type. Before sending, this plugin applies the same partial-Markdown filter as [Tencent's `openclaw-weixin` 2.4.6](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/markdown-filter.ts): code fences, inline code, tables, lists, blockquotes, horizontal rules, H1-H4 headings, bold, strikethrough, and non-CJK emphasis markers are preserved. Unsupported CJK italic/bold-italic markers and H5-H6 markers are removed while their text remains readable. Markdown image references are removed because Harness image blocks use the encrypted CDN media path instead.

This is intentionally partial compatibility, not HTML or arbitrary CommonMark rendering.

## Verify

After the log reports that the iLink credential is verified, send `/bot-ping` from the linked Weixin chat. It should reply:

```text
pong — DeepSeek Harness 微信机器人已连接。
```

Send `/bot-image-test` to verify encrypted CDN upload and image delivery without depending on model-generated media. Then send ordinary text and a photo to verify the Harness model route.

To verify tool approval, send “我当前有啥文件？”. After receiving `Bash 请求执行：...`, reply with the exact `/approve <code>` shown. The plugin should acknowledge the decision and then send only the final file listing after tool execution. `/reject <code>` denies that one call.

## Relogin

Remove the `WEIXIN_ILINK_CREDENTIAL` entry through the Harness credential settings surface and restart the profile. A new QR code will be generated. If Weixin reports that ClawBot is already bound to another local instance, remove the old connection in Weixin first.

## Development

```sh
pnpm install
pnpm run check
```

Built `dist/` artifacts are committed so GitHub installs do not require executing a dependency build script.

## License and upstream attribution

MIT. Protocol-derived portions retain Tencent's copyright and license notice in [LICENSE](LICENSE).
