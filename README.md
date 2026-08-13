# DeepSeek Harness Weixin

[简体中文](README.zh.md)

An independent Weixin private-chat channel for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness), using Tencent's official iLink/ClawBot protocol and QR authorization.

This is a DeepSeek Harness plugin, not an OpenClaw adapter. The iLink protocol, QR flow, AES media handling, and message fields are derived from Tencent's MIT-licensed [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 2.4.6 implementation.

## Features

- Official Weixin QR login; no AppID, AppSecret, or manually issued key.
- Login token stored through the Harness credential provider, never in plugin config.
- Restart-safe long-poll cursor with atomic owner-only storage.
- Persistent Harness conversation per Weixin user.
- Inbound text, voice transcription, quoted context, and encrypted images.
- Outbound text and AES-encrypted CDN image upload.
- Automatic text-only fallback when the selected model cannot inspect images.
- Allowlist/disabled access policy, bounded concurrency, deduplication, retries, and clean teardown.
- `/bot-ping`, `/bot-help`, `/bot-status`, `/bot-image-test`, and `/bot-cancel` diagnostics.

The official ClawBot/iLink integration currently supports private chats only.

## Prerequisite: ClawBot access

This channel does not use an API key. Your Weixin account must have the official ClawBot plugin entry:

```text
Weixin → Me → Settings → Plugins → ClawBot
```

Tencent is rolling this feature out gradually. If the entry is absent, there is no key to apply for; wait until the account becomes eligible or use another supported channel.

## Install

Install the release archive into a Harness profile:

```sh
pnpm dsh plugin --profile web add \
  https://github.com/sliverp/DeepSeek-harness-weixin/releases/download/v0.1.0/deepseek-harness-weixin-0.1.0.tgz
pnpm dsh --profile web
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
    statePath: /absolute/path/weixin-sync.json
    accessPolicy: allowlist
    allowFrom: [your-ilink-user-id]
    imageInputMode: auto
    maxInFlightMessages: 8
    maxReplyImages: 4
```

When `statePath` is empty, the cursor is stored under `~/.dsh/weixin/`. The plugin creates the file atomically with mode `0600`.

`imageInputMode` defaults to `auto`: image-capable models receive a durable image block, while text-only models receive attachment metadata instead of failing the turn. Use `always` only with a route known to accept images, or `never` to force the fallback.

## Verify

After the log reports that the iLink credential is verified, send `/bot-ping` from the linked Weixin chat. It should reply:

```text
pong — DeepSeek Harness 微信机器人已连接。
```

Send `/bot-image-test` to verify encrypted CDN upload and image delivery without depending on model-generated media. Then send ordinary text and a photo to verify the Harness model route.

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
