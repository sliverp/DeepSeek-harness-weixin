// src/bridge.ts
import { createHash as createHash3 } from "crypto";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

// src/conversations.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

// src/types.ts
var UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };
var MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5
};
var MessageType = { NONE: 0, USER: 1, BOT: 2 };
var MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
function parseCredential(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("weixin-channel: managed credential is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("weixin-channel: managed credential must be a JSON object");
  }
  const data = parsed;
  if (typeof data.token !== "string" || data.token.trim() === "") {
    throw new Error("weixin-channel: managed credential has no token");
  }
  if (typeof data.accountId !== "string" || data.accountId.trim() === "") {
    throw new Error("weixin-channel: managed credential has no accountId");
  }
  if (typeof data.baseUrl !== "string" || !isHttpsUrl(data.baseUrl)) {
    throw new Error("weixin-channel: managed credential baseUrl must be an HTTPS URL");
  }
  return {
    token: data.token.trim(),
    accountId: data.accountId.trim(),
    baseUrl: data.baseUrl.replace(/\/+$/, ""),
    ...typeof data.userId === "string" && data.userId.trim() ? { userId: data.userId.trim() } : {}
  };
}
function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// src/util.ts
import { createHash, randomBytes } from "crypto";
function sessionIdFor(accountId, message) {
  const userId = message.from_user_id?.trim();
  if (!userId) throw new Error("Weixin message has no sender identifier");
  const digest = createHash("sha256").update(`${accountId}\0${userId}`).digest("hex").slice(0, 32);
  return `weixin-v1-single-${digest}`;
}
function truncateUtf8(text, maxBytes, suffix = "\n\n[\u56DE\u590D\u5DF2\u622A\u65AD]") {
  const normalized = text.trim();
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized;
  const suffixBytes = Buffer.byteLength(suffix);
  const available = Math.max(0, maxBytes - suffixBytes);
  let result = "";
  let bytes = 0;
  for (const codePoint of normalized) {
    const size = Buffer.byteLength(codePoint);
    if (bytes + size > available) break;
    result += codePoint;
    bytes += size;
  }
  return result + (suffixBytes <= maxBytes ? suffix : "");
}
async function withTimeout(task, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
var SeenMessageIds = class {
  constructor(limit) {
    this.limit = limit;
  }
  limit;
  ids = /* @__PURE__ */ new Set();
  /** Return true for a duplicate; record a new id otherwise. */
  hasOrAdd(id) {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value;
      if (oldest === void 0) break;
      this.ids.delete(oldest);
    }
    return false;
  }
};
function messageKey(message) {
  if (message.message_id !== void 0) return String(message.message_id);
  if (message.client_id?.trim()) return message.client_id;
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}
function generateClientId() {
  return `dsh-weixin:${Date.now()}-${randomBytes(4).toString("hex")}`;
}

// src/inbound.ts
async function inboundContent(ctx, config, api, message, includeImages = true) {
  const sender = message.from_user_id?.trim() ?? "unknown";
  const textParts = [`[Private Weixin message from user ${shortId(sender)}]`];
  const images = [];
  collectItems(message.item_list ?? [], textParts, images, 0);
  const selectedImages = images.slice(0, ctx.attachments.imageLimits.maxImagesPerMessage);
  const imageBlocks = [];
  let totalImageBytes = 0;
  for (const image of selectedImages) {
    const remaining = ctx.attachments.imageLimits.maxMessageImageBytes - totalImageBytes;
    const maxBytes = Math.min(ctx.attachments.imageLimits.maxImageBytes, remaining);
    if (maxBytes <= 0) break;
    const data = await withTimeout(
      api.downloadImage(image, config.mediaDownloadTimeoutMs),
      config.mediaDownloadTimeoutMs,
      "Weixin encrypted image download"
    );
    if (data.byteLength > maxBytes) throw new Error(`Weixin image exceeds the ${maxBytes}-byte attachment limit`);
    const mediaType = detectImageMediaType(data);
    const ref = await ctx.attachments.saveImage({ data, mediaType });
    totalImageBytes += ref.bytes;
    if (includeImages) {
      imageBlocks.push({ type: "image", attachment: ref });
    } else {
      textParts.push([
        `[Weixin image received: ${ref.mediaType}.`,
        `Stored as Harness attachment ${String(ref.attachmentId)}.`,
        "The selected model is text-only and cannot inspect its pixels.]"
      ].join(" "));
    }
  }
  if (textParts.length === 1 && imageBlocks.length === 0) {
    textParts.push("[Unsupported or empty Weixin message.]");
  }
  return [{ type: "text", text: textParts.join("\n") }, ...imageBlocks];
}
function collectItems(items, text, images, depth) {
  for (const item of items) {
    if (item.type === MessageItemType.TEXT) pushText(text, item.text_item?.text);
    if (item.type === MessageItemType.IMAGE && item.image_item !== void 0) images.push(item.image_item);
    if (item.type === MessageItemType.VOICE) pushText(text, item.voice_item?.text, "[Voice transcription]\n");
    if (item.type === MessageItemType.FILE) text.push("[Weixin file received; this version handles text and images.]");
    if (item.type === MessageItemType.VIDEO) text.push("[Weixin video received; this version handles text and images.]");
    const reference = item.ref_msg;
    if (reference?.title?.trim()) text.push(`[Quoted message]
${reference.title.trim()}`);
    if (reference?.message_item !== void 0 && depth < 4) {
      const quotedText = [];
      const quotedImages = [];
      collectItems([reference.message_item], quotedText, quotedImages, depth + 1);
      for (const value of quotedText) text.push(`[Quoted message]
${value}`);
      images.push(...quotedImages);
    }
  }
}
function pushText(target, value, prefix = "") {
  const normalized = value?.trim();
  if (normalized) target.push(prefix + normalized);
}
function shortId(value) {
  return value.length <= 8 ? value : value.slice(0, 8);
}
function detectImageMediaType(data) {
  if (startsWith(data, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (startsWith(data, [255, 216, 255])) return "image/jpeg";
  if (startsWith(data, [71, 73, 70, 56])) return "image/gif";
  if (startsWith(data, [82, 73, 70, 70]) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "image/webp";
  throw new Error("Weixin image has an unsupported or unrecognized format");
}
function startsWith(data, prefix) {
  return prefix.every((byte, index) => data[index] === byte);
}

// src/conversations.ts
var ConversationManager = class {
  constructor(ctx, config, accountId) {
    this.ctx = ctx;
    this.config = config;
    this.accountId = accountId;
  }
  ctx;
  config;
  accountId;
  handles = /* @__PURE__ */ new Map();
  creations = /* @__PURE__ */ new Map();
  queues = /* @__PURE__ */ new Map();
  persistedIds = /* @__PURE__ */ new Set();
  /** Snapshot persisted identities once before accepting traffic. */
  async initialize() {
    const headers = await this.ctx.sessionPersistence.list();
    this.persistedIds = new Set(headers.map((header) => String(header.id)));
  }
  /** Process one inbound message after earlier work for the same Weixin user. */
  process(message, api) {
    const id = sessionIdFor(this.accountId, message);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(() => this.processNow(id, message, api));
    const tracked = current.finally(() => {
      if (this.queues.get(id) === tracked) this.queues.delete(id);
    });
    this.queues.set(id, tracked);
    return current;
  }
  /** Cancel active work for one Weixin user. */
  cancel(message) {
    const id = sessionIdFor(this.accountId, message);
    const agent = this.handles.get(id)?.agent ?? this.ctx.agents.get(SessionId(id));
    if (agent === void 0 || agent.status === "idle") return false;
    agent.cancel({ kind: "user" });
    return true;
  }
  /** Dispose every bridge-owned Agent after queued work settles. */
  async dispose() {
    await Promise.allSettled(this.queues.values());
    await Promise.allSettled([...this.handles.values()].map((handle) => handle.dispose()));
    this.handles.clear();
  }
  async processNow(id, message, api) {
    const handle = await this.getOrCreate(id);
    const agent = handle.agent;
    const start = agent.session.events.length;
    const content = await inboundContent(this.ctx, this.config, api, message, await this.includeImages(agent));
    agent.followup(createUserMessage({ content, source: { kind: "user" } }));
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness response");
    return this.collectReply(agent, agent.session.events.slice(start));
  }
  async includeImages(agent) {
    if (this.config.imageInputMode === "always") return true;
    if (this.config.imageInputMode === "never") return false;
    const { provider, model } = agent.options;
    if (provider === void 0 || model === void 0) return false;
    const info = await this.ctx.llm.resolveModelInfo(provider, model);
    return info.inputModalities?.includes("image") ?? false;
  }
  async getOrCreate(id) {
    const existing = this.handles.get(id);
    if (existing !== void 0) return existing;
    const pending = this.creations.get(id);
    if (pending !== void 0) return pending;
    const creation = this.createOrResume(id).finally(() => this.creations.delete(id));
    this.creations.set(id, creation);
    const handle = await creation;
    this.handles.set(id, handle);
    return handle;
  }
  async createOrResume(id) {
    const sessionId = SessionId(id);
    const current = this.ctx.agentDefaultModel.currentSelection();
    const agentOptions = { provider: current.provider, model: current.model };
    if (this.persistedIds.has(id)) {
      return this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions });
    }
    const handle = await this.ctx.agents.create({ sessionId, meta: { cwd: this.config.cwd }, agentOptions });
    this.persistedIds.add(id);
    handle.agent.inject(createUserMessage({
      content: [{ type: "text", text: this.config.systemPrompt }],
      source: { kind: "plugin", plugin: "deepseek-harness-weixin", form: "instructions" }
    }));
    return handle;
  }
  async collectReply(agent, events) {
    const texts = [];
    const images = [];
    for (const event of events) {
      if (event.type !== "assistant/message") continue;
      for (const block of event.data.message.content) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
        if (block.type === "image") {
          const stored = await this.ctx.attachments.readImage(block.attachment);
          images.push({
            data: stored.data,
            mediaType: stored.ref.mediaType,
            ...stored.ref.name === void 0 ? {} : { name: stored.ref.name }
          });
        }
      }
    }
    const finalTurn = [...events].reverse().find((event) => event.type === "turn/end");
    if (texts.length === 0 && finalTurn?.type === "turn/end" && finalTurn.data.reason.kind === "error") {
      return { text: `\u5904\u7406\u5931\u8D25\uFF08${finalTurn.data.reason.error.code}\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002`, images };
    }
    if (texts.length === 0 && images.length === 0) {
      return { text: "\u5904\u7406\u5B8C\u6210\uFF0C\u4F46\u6CA1\u6709\u751F\u6210\u53EF\u53D1\u9001\u7684\u5185\u5BB9\u3002", images };
    }
    return { text: texts.join("\n\n"), images };
  }
};

// src/login.ts
import { createInterface } from "readline/promises";

// src/protocol.ts
import { createCipheriv, createDecipheriv, createHash as createHash2, randomBytes as randomBytes2 } from "crypto";
var CHANNEL_VERSION = "0.1.0";
var BOT_AGENT = "DeepSeek-Harness/0.1.0";
var ILINK_APP_ID = "bot";
var ILINK_APP_CLIENT_VERSION = 2 << 16 | 4 << 8 | 6;
var DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
var WeixinApiClient = class {
  constructor(baseUrl, token, config, fetchImpl = fetch) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.config = config;
    this.fetchImpl = fetchImpl;
  }
  baseUrl;
  token;
  config;
  fetchImpl;
  cdnBaseUrl = DEFAULT_CDN_BASE_URL;
  async getUpdates(cursor, timeoutMs, signal) {
    try {
      return await this.postJson("ilink/bot/getupdates", {
        get_updates_buf: cursor,
        base_info: baseInfo()
      }, timeoutMs, "getUpdates", signal);
    } catch (error) {
      if (isAbort(error)) return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw error;
    }
  }
  async notifyStart() {
    const response = await this.postJson(
      "ilink/bot/msg/notifystart",
      { base_info: baseInfo() },
      this.config.apiTimeoutMs,
      "notifyStart"
    );
    assertSuccess(response, "notifyStart");
  }
  async notifyStop() {
    const response = await this.postJson(
      "ilink/bot/msg/notifystop",
      { base_info: baseInfo() },
      this.config.apiTimeoutMs,
      "notifyStop"
    );
    assertSuccess(response, "notifyStop");
  }
  async sendText(to, text, contextToken) {
    const item = { type: MessageItemType.TEXT, text_item: { text } };
    await this.sendItem(to, item, contextToken);
  }
  async sendImage(to, data, contextToken) {
    const plaintext = Buffer.from(data);
    if (plaintext.byteLength > this.config.maxOutboundImageBytes) {
      throw new Error(`Weixin outbound image exceeds the ${this.config.maxOutboundImageBytes}-byte limit`);
    }
    const key = randomBytes2(16);
    const filekey = randomBytes2(16).toString("hex");
    const encrypted = encryptAesEcb(plaintext, key);
    const upload = await this.postJson("ilink/bot/getuploadurl", {
      filekey,
      media_type: UploadMediaType.IMAGE,
      to_user_id: to,
      rawsize: plaintext.byteLength,
      rawfilemd5: createHash2("md5").update(plaintext).digest("hex"),
      filesize: encrypted.byteLength,
      no_need_thumb: true,
      aeskey: key.toString("hex"),
      base_info: baseInfo()
    }, this.config.apiTimeoutMs, "getUploadUrl");
    const uploadUrl = upload.upload_full_url?.trim() || (upload.upload_param ? `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}` : "");
    if (!uploadUrl) throw new Error("getUploadUrl returned no CDN upload URL");
    const downloadParam = await this.uploadEncrypted(uploadUrl, encrypted);
    await this.sendItem(to, {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: downloadParam,
          aes_key: Buffer.from(key.toString("hex")).toString("base64"),
          encrypt_type: 1
        },
        mid_size: encrypted.byteLength
      }
    }, contextToken);
  }
  async downloadImage(image, timeoutMs) {
    const media = image.media;
    if (media === void 0) throw new Error("Weixin image has no CDN media reference");
    const encryptedQuery = media.encrypt_query_param ?? "";
    const url = media.full_url?.trim() || (encryptedQuery ? `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQuery)}` : "");
    if (!url) throw new Error("Weixin image has no CDN download URL");
    const response = await fetchWithTimeout(this.fetchImpl, url, { method: "GET" }, timeoutMs);
    if (!response.ok) throw new Error(`Weixin CDN download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const key = image.aeskey?.trim() ? parseHexKey(image.aeskey) : media.aes_key?.trim() ? parseBase64Key(media.aes_key) : void 0;
    return key === void 0 ? bytes : decryptAesEcb(bytes, key);
  }
  async sendItem(to, item, contextToken) {
    const response = await this.postJson("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        ...contextToken === void 0 ? {} : { context_token: contextToken }
      },
      base_info: baseInfo()
    }, this.config.apiTimeoutMs, "sendMessage");
    assertSuccess(response, "sendMessage");
  }
  async uploadEncrypted(url, encrypted) {
    let lastError;
    for (let attempt = 0; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        const response = await fetchWithTimeout(this.fetchImpl, url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(encrypted)
        }, this.config.apiTimeoutMs);
        if (!response.ok) throw new Error(`Weixin CDN upload failed with HTTP ${response.status}`);
        const param = response.headers.get("x-encrypted-param");
        if (!param) throw new Error("Weixin CDN upload response has no x-encrypted-param");
        return param;
      } catch (error) {
        lastError = error;
        if (attempt < this.config.sendRetries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }
  postJson(endpoint, body, timeoutMs, label, signal) {
    return requestJson(this.fetchImpl, {
      url: new URL(endpoint, ensureTrailingSlash(this.baseUrl)).toString(),
      method: "POST",
      headers: authenticatedHeaders(this.token),
      body,
      timeoutMs,
      label,
      ...signal === void 0 ? {} : { signal }
    });
  }
};
function requestQrJson(method, url, timeoutMs, body, fetchImpl = fetch) {
  return requestJson(fetchImpl, {
    url,
    method,
    headers: commonHeaders(),
    ...body === void 0 ? {} : { body },
    timeoutMs,
    label: "Weixin QR login"
  });
}
function requestJson(fetchImpl, options) {
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(options.url, {
        method: options.method,
        headers: options.headers,
        ...options.body === void 0 ? {} : { body: JSON.stringify(options.body) },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${options.label} failed with HTTP ${response.status}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${options.label} returned invalid JSON`);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  })();
}
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}
function commonHeaders() {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION)
  };
}
function authenticatedHeaders(token) {
  const uin = randomBytes2(4).readUInt32BE(0);
  return {
    ...commonHeaders(),
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": Buffer.from(String(uin)).toString("base64")
  };
}
function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
function assertSuccess(response, label) {
  const code = response.errcode ?? response.ret ?? 0;
  if (code !== 0) throw new Error(`${label} failed with iLink code ${code}: ${response.errmsg ?? "(no message)"}`);
}
function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function parseHexKey(value) {
  if (!/^[0-9a-fA-F]{32}$/.test(value)) throw new Error("Weixin image AES hex key is invalid");
  return Buffer.from(value, "hex");
}
function parseBase64Key(value) {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  throw new Error("Weixin image AES key has an invalid length");
}
function isAbort(error) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// src/login.ts
var FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
var BOT_TYPE = "3";
var QR_POLL_TIMEOUT_MS = 35e3;
var MAX_QR_REFRESHES = 3;
async function loginWithQr(options) {
  const callbacks = {
    showQr: options.callbacks?.showQr ?? displayQr,
    readVerifyCode: options.callbacks?.readVerifyCode ?? readVerifyCode,
    status: options.callbacks?.status ?? ((message) => process.stdout.write(`${message}
`))
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + options.timeoutMs;
  let currentBaseUrl = FIXED_BASE_URL;
  let refreshes = 0;
  let pendingVerifyCode;
  let scanned = false;
  let qr = await fetchQr(options.existingTokens ?? [], fetchImpl);
  await callbacks.showQr(qr.url);
  callbacks.status("\u8BF7\u7528\u624B\u673A\u5FAE\u4FE1\u626B\u63CF\u4E8C\u7EF4\u7801\uFF0C\u5E76\u5728\u5FAE\u4FE1\u4E2D\u786E\u8BA4\u8FDE\u63A5\u3002");
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let response;
    try {
      response = await pollStatus(
        currentBaseUrl,
        qr.id,
        pendingVerifyCode,
        Math.min(QR_POLL_TIMEOUT_MS, remaining),
        fetchImpl
      );
    } catch (error) {
      if (isAbort2(error)) {
        await delay(250);
        continue;
      }
      callbacks.status(`\u4E8C\u7EF4\u7801\u72B6\u6001\u67E5\u8BE2\u6682\u65F6\u5931\u8D25\uFF0C\u6B63\u5728\u91CD\u8BD5\uFF1A${String(error)}`);
      await delay(1e3);
      continue;
    }
    switch (response.status) {
      case "wait":
        break;
      case "scaned":
        pendingVerifyCode = void 0;
        if (!scanned) {
          callbacks.status("\u4E8C\u7EF4\u7801\u5DF2\u626B\u63CF\uFF0C\u6B63\u5728\u7B49\u5F85\u5FAE\u4FE1\u786E\u8BA4\u3002");
          scanned = true;
        }
        break;
      case "need_verifycode":
        pendingVerifyCode = await callbacks.readVerifyCode(
          pendingVerifyCode === void 0 ? "\u8BF7\u8F93\u5165\u624B\u673A\u5FAE\u4FE1\u663E\u793A\u7684\u6570\u5B57\uFF1A" : "\u6570\u5B57\u4E0D\u5339\u914D\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165\uFF1A"
        );
        continue;
      case "scaned_but_redirect":
        currentBaseUrl = redirectBaseUrl(response.redirect_host);
        callbacks.status("\u5DF2\u5207\u6362\u5230\u5FAE\u4FE1\u5206\u914D\u7684\u8FDE\u63A5\u8282\u70B9\u3002");
        break;
      case "expired":
      case "verify_code_blocked":
        refreshes += 1;
        if (refreshes >= MAX_QR_REFRESHES) {
          throw new Error("\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u591A\u6B21\u5931\u6548\u6216\u9A8C\u8BC1\u7801\u591A\u6B21\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        }
        pendingVerifyCode = void 0;
        scanned = false;
        qr = await fetchQr(options.existingTokens ?? [], fetchImpl);
        callbacks.status("\u4E8C\u7EF4\u7801\u5DF2\u5237\u65B0\uFF0C\u8BF7\u91CD\u65B0\u626B\u63CF\u3002");
        await callbacks.showQr(qr.url);
        break;
      case "binded_redirect":
        throw new Error("\u8FD9\u4E2A\u5FAE\u4FE1 ClawBot \u5DF2\u7ED1\u5B9A\u5176\u4ED6\u672C\u5730\u5B9E\u4F8B\uFF1B\u8BF7\u5728\u5FAE\u4FE1\u4E2D\u89E3\u9664\u65E7\u8FDE\u63A5\u540E\u91CD\u65B0\u626B\u7801");
      case "confirmed": {
        const token = response.bot_token?.trim();
        const accountId = response.ilink_bot_id?.trim();
        if (!token || !accountId) throw new Error("\u5FAE\u4FE1\u786E\u8BA4\u6210\u529F\uFF0C\u4F46\u670D\u52A1\u5668\u6CA1\u6709\u8FD4\u56DE\u5B8C\u6574\u767B\u5F55\u51ED\u636E");
        const baseUrl = normalizeBaseUrl(response.baseurl?.trim() || currentBaseUrl);
        callbacks.status("\u5FAE\u4FE1\u8FDE\u63A5\u6388\u6743\u6210\u529F\u3002");
        return {
          token,
          accountId,
          baseUrl,
          ...response.ilink_user_id?.trim() ? { userId: response.ilink_user_id.trim() } : {}
        };
      }
      default:
        throw new Error(`\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u670D\u52A1\u5668\u8FD4\u56DE\u672A\u77E5\u72B6\u6001\uFF1A${String(response.status)}`);
    }
    await delay(1e3);
  }
  throw new Error("\u5FAE\u4FE1\u626B\u7801\u767B\u5F55\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u542F\u52A8\u540E\u518D\u8BD5");
}
async function fetchQr(existingTokens, fetchImpl) {
  const response = await requestQrJson(
    "POST",
    `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    15e3,
    { local_token_list: existingTokens.slice(-10).reverse() },
    fetchImpl
  );
  const id = response.qrcode?.trim();
  const url = response.qrcode_img_content?.trim();
  if (!id || !url) throw new Error("\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u670D\u52A1\u5668\u6CA1\u6709\u8FD4\u56DE\u6709\u6548\u4E8C\u7EF4\u7801");
  return { id, url };
}
function pollStatus(baseUrl, qrcode, verifyCode, timeoutMs, fetchImpl) {
  const query = new URLSearchParams({ qrcode });
  if (verifyCode) query.set("verify_code", verifyCode);
  return requestQrJson(
    "GET",
    `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
    timeoutMs,
    void 0,
    fetchImpl
  );
}
async function displayQr(url) {
  try {
    const qrcode = await import("qrcode-terminal");
    qrcode.default.generate(url, { small: true });
  } catch {
  }
  process.stdout.write(`\u4E8C\u7EF4\u7801\u5907\u7528\u94FE\u63A5\uFF08\u8BF7\u52FF\u8F6C\u53D1\uFF09\uFF1A
${url}
`);
}
async function readVerifyCode(prompt) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(prompt)).trim();
  } finally {
    input.close();
  }
}
function redirectBaseUrl(host) {
  if (!host?.trim()) throw new Error("\u5FAE\u4FE1\u8981\u6C42\u5207\u6362\u8282\u70B9\uFF0C\u4F46\u6CA1\u6709\u8FD4\u56DE redirect_host");
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) throw new Error("\u5FAE\u4FE1\u8FD4\u56DE\u7684 redirect_host \u683C\u5F0F\u65E0\u6548");
  return normalizeBaseUrl(`https://${host}`);
}
function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("\u5FAE\u4FE1 iLink baseUrl \u5FC5\u987B\u4F7F\u7528 HTTPS");
  return url.toString().replace(/\/+$/, "");
}
function isAbort2(error) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// src/state.ts
import { chmod, mkdir, open, readFile, rename, unlink } from "fs/promises";
import { dirname } from "path";
import { randomBytes as randomBytes3 } from "crypto";
var SyncCursorStore = class {
  constructor(path) {
    this.path = path;
  }
  path;
  /** Load the last committed cursor, or an empty cursor for a new account. */
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      return typeof parsed.get_updates_buf === "string" ? parsed.get_updates_buf : "";
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT") return "";
      throw new Error(`weixin-channel: cannot read sync cursor ${JSON.stringify(this.path)}: ${String(error)}`);
    }
  }
  /** Atomically commit one cursor with directory mode 0700 and file mode 0600. */
  async save(cursor) {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 448 });
    const temporary = `${this.path}.${process.pid}.${randomBytes3(6).toString("hex")}.tmp`;
    let committed = false;
    try {
      const handle = await open(temporary, "wx", 384);
      try {
        await handle.writeFile(JSON.stringify({ get_updates_buf: cursor }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      committed = true;
      await chmod(this.path, 384);
    } finally {
      if (!committed) await unlink(temporary).catch(() => void 0);
    }
  }
};

// src/bridge.ts
var STALE_TOKEN_CODE = -14;
var OUTBOUND_TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACn0lEQVR4nO3XsZFCQRDEUDIhxA28g1gS4JwrCmQ8QwmoR/vh8Ty74MAN7K2DBzHicAP704FABCKQIxBH4CG4/3HgC+JwPB5HII7AQ3B9QRyBh+B81oGfWKIS1RGII/AQXF8QR+AhOH5iOQIPwf2WA/9BHJsH5wjEEXgIri+II/AQHD+xHIGH4PoP4gg8BOf3DvxJD4yAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwAroOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgByzoQSGAELOtAIIERsKwDgQRGwLIOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgBCzr4AVwXepBk5abggAAAAABJRU5ErkJggg==",
  "base64"
);
var WeixinHarnessBridge = class {
  constructor(ctx, config, apiFactory = (credential, resolvedConfig) => new WeixinApiClient(credential.baseUrl, credential.token, resolvedConfig), login = loginWithQr) {
    this.ctx = ctx;
    this.config = config;
    this.apiFactory = apiFactory;
    this.login = login;
    if (!isAbsolute(config.cwd)) throw new Error(`weixin-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`);
    if (config.statePath && !isAbsolute(config.statePath)) {
      throw new Error(`weixin-channel: statePath must be absolute, got ${JSON.stringify(config.statePath)}`);
    }
    this.log = ctx.logger("deepseek-harness-weixin");
    this.seen = new SeenMessageIds(config.maxSeenMessageIds);
  }
  ctx;
  config;
  apiFactory;
  login;
  log;
  seen;
  abortController = new AbortController();
  inFlight = /* @__PURE__ */ new Set();
  credential;
  api;
  conversations;
  monitorTask;
  stopping = false;
  /** Resolve or create a QR credential, verify it, and begin long-polling. */
  async start() {
    const credential = await this.resolveCredential();
    this.credential = credential;
    const api = this.apiFactory(credential, this.config);
    this.api = api;
    const conversations = new ConversationManager(this.ctx, this.config, credential.accountId);
    this.conversations = conversations;
    await conversations.initialize();
    await api.notifyStart();
    this.log.info("Weixin iLink credential verified for account %s", shortId2(credential.accountId));
    this.monitorTask = this.monitor(api, credential).catch((error) => {
      if (!this.stopping) this.log.error("Weixin monitor stopped unexpectedly: %s", String(error));
    });
  }
  /** Abort long-polling and await all owned messages and agents. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.abortController.abort();
    if (this.monitorTask !== void 0) await this.monitorTask;
    await Promise.allSettled(this.inFlight);
    if (this.conversations !== void 0) await this.conversations.dispose();
    if (this.api !== void 0) {
      try {
        await this.api.notifyStop();
      } catch (error) {
        this.log.warn("Weixin notifyStop failed during teardown: %s", String(error));
      }
    }
  }
  async resolveCredential() {
    const ref = credentialRef(this.config.credentialRef);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (resolved !== void 0) return parseCredential(resolved.value);
    if (!this.config.autoLogin) {
      throw new Error(`weixin-channel: credential ${JSON.stringify(this.config.credentialRef)} is not configured`);
    }
    this.log.info("No Weixin credential found; starting official QR login");
    const credential = await this.login({
      timeoutMs: this.config.loginTimeoutMs,
      callbacks: { status: (message) => this.log.info("%s", message) }
    });
    await this.ctx.credentials.set(ref, JSON.stringify(credential));
    this.log.info("Weixin credential stored by the Harness credential provider");
    return credential;
  }
  async monitor(api, credential) {
    const cursorStore = new SyncCursorStore(resolveStatePath(this.config.statePath, credential.accountId));
    let cursor = await cursorStore.load();
    let timeoutMs = this.config.longPollTimeoutMs;
    let failures = 0;
    while (!this.abortController.signal.aborted) {
      try {
        const response = await api.getUpdates(cursor, timeoutMs, this.abortController.signal);
        if (this.abortController.signal.aborted) return;
        const code = response.errcode ?? response.ret ?? 0;
        if (code !== 0) {
          if (code === STALE_TOKEN_CODE) {
            this.log.error("Weixin credential is temporarily stale; pausing requests for %dms", this.config.staleTokenPauseMs);
            failures = 0;
            await delay(this.config.staleTokenPauseMs, this.abortController.signal);
            continue;
          }
          failures += 1;
          this.log.error(
            "Weixin getUpdates failed with code %d (%d/%d): %s",
            code,
            failures,
            this.config.maxConsecutiveFailures,
            response.errmsg ?? "(no message)"
          );
          await this.failureDelay(failures);
          if (failures >= this.config.maxConsecutiveFailures) failures = 0;
          continue;
        }
        failures = 0;
        if (response.longpolling_timeout_ms !== void 0 && response.longpolling_timeout_ms > 0) {
          timeoutMs = Math.max(1e3, Math.min(response.longpolling_timeout_ms, 12e4));
        }
        if (response.get_updates_buf !== void 0 && response.get_updates_buf !== "" && response.get_updates_buf !== cursor) {
          await cursorStore.save(response.get_updates_buf);
          cursor = response.get_updates_buf;
        }
        for (const message of response.msgs ?? []) await this.dispatch(message, api);
      } catch (error) {
        if (this.abortController.signal.aborted) return;
        failures += 1;
        this.log.error(
          "Weixin getUpdates transport failure (%d/%d): %s",
          failures,
          this.config.maxConsecutiveFailures,
          String(error)
        );
        await this.failureDelay(failures);
        if (failures >= this.config.maxConsecutiveFailures) failures = 0;
      }
    }
  }
  async failureDelay(failures) {
    const ms = failures >= this.config.maxConsecutiveFailures ? this.config.backoffDelayMs : this.config.retryDelayMs;
    await delay(ms, this.abortController.signal);
  }
  async dispatch(message, api) {
    if (message.message_type !== void 0 && message.message_type !== MessageType.USER) return;
    if (!message.from_user_id?.trim() || !this.allowed(message.from_user_id)) return;
    if (this.seen.hasOrAdd(messageKey(message))) return;
    while (this.inFlight.size >= this.config.maxInFlightMessages && !this.stopping) {
      await Promise.race(this.inFlight);
    }
    if (this.stopping) return;
    const task = this.handleMessage(message, api).catch((error) => {
      this.log.error("Weixin message %s failed: %s", messageKey(message), String(error));
    });
    const tracked = task.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }
  allowed(sender) {
    if (this.config.accessPolicy === "disabled") return false;
    return this.config.accessPolicy === "open" || this.config.allowFrom.includes(sender);
  }
  async handleMessage(message, api) {
    const command = commandText(message);
    if (command === "/bot-ping") {
      await this.sendReply(message, api, { text: "pong \u2014 DeepSeek Harness \u5FAE\u4FE1\u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5\u3002", images: [] });
      return;
    }
    if (command === "/bot-help") {
      await this.sendReply(message, api, {
        text: [
          "DeepSeek Harness \u5FAE\u4FE1\u673A\u5668\u4EBA",
          "/bot-ping \u2014 \u68C0\u67E5\u8FDE\u901A\u6027",
          "/bot-image-test \u2014 \u53D1\u9001\u84DD\u8272\u56FE\u7247\uFF0C\u68C0\u67E5\u56FE\u7247\u94FE\u8DEF",
          "/bot-status \u2014 \u67E5\u770B\u5F53\u524D\u8FDE\u63A5\u72B6\u6001",
          "/bot-cancel \u2014 \u53D6\u6D88\u5F53\u524D\u751F\u6210",
          "\u5176\u4ED6\u6D88\u606F\u4F1A\u4EA4\u7ED9\u5F53\u524D Harness \u9ED8\u8BA4\u6A21\u578B\u5904\u7406\u3002"
        ].join("\n"),
        images: []
      });
      return;
    }
    if (command === "/bot-image-test") {
      await this.sendReply(message, api, {
        text: "\u84DD\u8272\u6D4B\u8BD5\u56FE\u7247\u53D1\u9001\u6210\u529F\u3002",
        images: [{ data: OUTBOUND_TEST_PNG, mediaType: "image/png", name: "weixin-image-test.png" }]
      });
      return;
    }
    if (command === "/bot-status") {
      await this.sendReply(message, api, {
        text: "\u5FAE\u4FE1 iLink \u957F\u8F6E\u8BE2\u6B63\u5E38\uFF0CDeepSeek Harness \u4F1A\u8BDD\u6309\u5FAE\u4FE1\u7528\u6237\u72EC\u7ACB\u6301\u4E45\u5316\u3002",
        images: []
      });
      return;
    }
    if (command === "/bot-cancel") {
      const cancelled = this.requireConversations().cancel(message);
      await this.sendReply(message, api, {
        text: cancelled ? "\u5DF2\u8BF7\u6C42\u53D6\u6D88\u5F53\u524D\u751F\u6210\u3002" : "\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u751F\u6210\u7684\u56DE\u590D\u3002",
        images: []
      });
      return;
    }
    try {
      const reply = await this.requireConversations().process(message, api);
      await this.sendReply(message, api, reply);
    } catch (error) {
      this.log.error("Weixin message processing failed: %s", String(error));
      try {
        await this.sendReply(message, api, { text: "\u5904\u7406\u6D88\u606F\u65F6\u53D1\u751F\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", images: [] });
      } catch (sendError) {
        this.log.error("Weixin error reply failed: %s", String(sendError));
      }
    }
  }
  async sendReply(message, api, reply) {
    const to = message.from_user_id?.trim();
    if (!to) throw new Error("Weixin reply has no target user");
    const images = reply.images.slice(0, this.config.maxReplyImages);
    const text = truncateUtf8(reply.text || (images.length === 0 ? "\u5904\u7406\u5B8C\u6210\u3002" : ""), this.config.maxReplyBytes);
    if (text) {
      await this.retry(() => api.sendText(to, text, message.context_token));
    }
    for (const image of images) {
      await this.retry(() => api.sendImage(to, image.data, message.context_token));
    }
  }
  async retry(operation) {
    let lastError;
    for (let attempt = 0; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < this.config.sendRetries) await delay(250 * (attempt + 1), this.abortController.signal);
      }
    }
    throw lastError;
  }
  requireConversations() {
    if (this.conversations === void 0) throw new Error("weixin-channel: conversations are not initialized");
    return this.conversations;
  }
};
function commandText(message) {
  return (message.item_list ?? []).filter((item) => item.type === MessageItemType.TEXT).map((item) => item.text_item?.text ?? "").join("\n").trim().toLowerCase();
}
function resolveStatePath(configured, accountId) {
  if (configured) return configured;
  const digest = createHash3("sha256").update(accountId).digest("hex").slice(0, 16);
  return join(homedir(), ".dsh", "weixin", `${digest}.sync.json`);
}
function shortId2(value) {
  return value.length <= 12 ? value : value.slice(0, 12);
}

// src/config.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  credentialRef: z.string().default("WEIXIN_ILINK_CREDENTIAL"),
  cwd: z.string().required(),
  statePath: z.string().default(""),
  autoLogin: z.boolean().default(true),
  accessPolicy: z.union(["open", "allowlist", "disabled"]).default("open"),
  allowFrom: z.array(z.string()).default([]),
  imageInputMode: z.union(["auto", "always", "never"]).default("auto"),
  responseTimeoutMs: z.number().step(1).min(1).default(3e5),
  mediaDownloadTimeoutMs: z.number().step(1).min(1).default(3e4),
  apiTimeoutMs: z.number().step(1).min(1).default(15e3),
  longPollTimeoutMs: z.number().step(1).min(1e3).default(35e3),
  loginTimeoutMs: z.number().step(1).min(1e3).default(48e4),
  retryDelayMs: z.number().step(1).min(100).default(2e3),
  backoffDelayMs: z.number().step(1).min(100).default(3e4),
  staleTokenPauseMs: z.number().step(1).min(1e3).default(36e5),
  maxConsecutiveFailures: z.number().step(1).min(1).max(20).default(3),
  maxInFlightMessages: z.number().step(1).min(1).max(100).default(8),
  sendRetries: z.number().step(1).min(0).max(5).default(2),
  maxReplyBytes: z.number().step(1).min(100).max(1e5).default(2e4),
  maxReplyImages: z.number().step(1).min(0).max(9).default(4),
  maxOutboundImageBytes: z.number().step(1).min(1024).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  maxSeenMessageIds: z.number().step(1).min(100).max(1e5).default(5e3),
  systemPrompt: z.string().default(
    "You are replying through Weixin. Keep replies clear and suitable for private chat. Do not reveal credentials, context tokens, or internal system data. When a request needs an interactive approval that Weixin cannot provide, explain what approval is needed instead of waiting indefinitely."
  )
});

// src/index.ts
var name = "deepseek-harness-weixin";
var inject = ["agentDefaultModel", "agents", "attachments", "credentials", "llm", "sessionPersistence"];
async function apply(ctx, config) {
  const bridge = new WeixinHarnessBridge(ctx, config);
  await ctx.effect(async function* () {
    yield async () => bridge.stop();
    await bridge.start();
  }, "deepseek-harness-weixin.long-poll");
}
var index_default = { name, inject, Config, apply };
export {
  Config,
  SeenMessageIds,
  WeixinApiClient,
  WeixinHarnessBridge,
  apply,
  index_default as default,
  detectImageMediaType,
  inboundContent,
  inject,
  loginWithQr,
  name,
  parseCredential,
  sessionIdFor,
  truncateUtf8
};
//# sourceMappingURL=index.js.map