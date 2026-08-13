# DeepSeek Harness 微信插件

[English](README.md)

基于腾讯官方 iLink/ClawBot 协议和扫码授权，为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提供独立的微信私聊通道。

这是 DeepSeek Harness 原生插件，不依赖 OpenClaw。iLink 协议、扫码流程、AES 媒体处理和消息字段参考了腾讯以 MIT 许可证开源的 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 2.4.6 实现。

## 功能

- 微信官方二维码登录，不需要 AppID、AppSecret 或手工申请的 key。
- 登录令牌由 Harness 凭据服务保存，不进入插件配置。
- 长轮询游标原子持久化，重启后继续消费。
- 每个微信用户对应一个持久 Harness 会话。
- 接收文字、语音转写、引用上下文和 AES 加密图片。
- 发送文字，并通过微信 CDN 加密上传图片。
- 当前模型不支持视觉时，自动保存图片并降级为附件说明。
- 支持允许名单、禁用策略、有界并发、去重、重试和完整清理。
- 内置 `/bot-ping`、`/bot-help`、`/bot-status`、`/bot-image-test`、`/bot-cancel`。

腾讯当前的 ClawBot/iLink 接入仅支持私聊。

## 前置条件：ClawBot 权限

这个通道不使用 API key。你的微信账号必须已经出现官方 ClawBot 插件入口：

```text
微信 → 我 → 设置 → 插件 → ClawBot
```

腾讯仍在逐步开放该功能。如果没有这个入口，不是缺少 key，也没有单独的 key 申请页面；需要等待账号获得资格，或先使用其他通道。

## 安装

把 Release 安装到 Harness 配置中：

```sh
pnpm dsh plugin --profile web add \
  https://github.com/sliverp/DeepSeek-harness-weixin/releases/download/v0.1.0/deepseek-harness-weixin-0.1.0.tgz
pnpm dsh --profile web
```

首次启动时，插件会在终端显示二维码和一个短期有效的备用链接。用手机微信扫码并确认连接。如果微信显示数字验证码，在同一个终端输入该数字。服务器签发的凭据会通过 `ctx.credentials` 保存到 `WEIXIN_ILINK_CREDENTIAL`；后续启动不需要再次扫码。

不要转发二维码备用链接，也不要复制或提交保存后的 JSON 凭据；两者都能授权访问已连接的 ClawBot。

## 配置

组合包默认插入：

```yaml
- id: weixin-channel
  name: deepseek-harness-weixin
  config:
    credentialRef: WEIXIN_ILINK_CREDENTIAL
    cwd: !!js process.env.DSH_WEIXIN_CWD ?? process.cwd()
    statePath: !!js process.env.DSH_WEIXIN_STATE_PATH ?? ''
```

如需调整，在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖这一行：

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

`statePath` 为空时，游标默认保存在 `~/.dsh/weixin/`，并以原子写入和 `0600` 文件权限保护。

`imageInputMode` 默认为 `auto`：支持视觉的模型会收到持久图片块；纯文本模型会收到附件元数据，避免整轮失败。只有确认模型支持图片时才使用 `always`；使用 `never` 可强制文本降级。

## 验证

日志出现 iLink 凭据验证成功后，从已连接的微信会话发送 `/bot-ping`，应收到：

```text
pong — DeepSeek Harness 微信机器人已连接。
```

发送 `/bot-image-test` 可以独立验证 AES 加密、微信 CDN 上传和图片投递，不依赖模型生成图片。然后再发送普通文字和一张照片，验证 Harness 模型链路。

## 重新登录

通过 Harness 凭据设置界面删除 `WEIXIN_ILINK_CREDENTIAL`，再重启配置，插件就会生成新二维码。如果微信提示 ClawBot 已绑定其他本地实例，请先在微信中解除旧连接。

## 开发

```sh
pnpm install
pnpm run check
```

仓库提交构建后的 `dist/`，因此从 GitHub 安装时不需要授权依赖执行构建脚本。

## 许可证与上游声明

MIT。协议派生部分在 [LICENSE](LICENSE) 中保留腾讯版权和许可证声明。
