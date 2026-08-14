// src/control.ts
import { randomUUID } from "crypto";
import { chmod, lstat, mkdir, unlink } from "fs/promises";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { createConnection, createServer } from "net";
var MAX_CONTROL_MESSAGE_BYTES = 4096;
var DEFAULT_CLIENT_TIMEOUT_MS = 3e4;
var DEFAULT_WAIT_TIMEOUT_MS = 10 * 6e4;
var MAX_TRACKED_LOGINS = 32;
function defaultControlSocketPath() {
  return join(homedir(), ".dsh", "weixin", "control.sock");
}
function resolveControlSocketPath(configured) {
  const value = configured?.trim() || process.env.DSH_WEIXIN_CONTROL_SOCKET?.trim();
  if (!value) return defaultControlSocketPath();
  return isAbsolute(value) ? value : resolve(value);
}
var WeixinControlServer = class {
  constructor(socketPath, requestLogin, log) {
    this.socketPath = socketPath;
    this.requestLogin = requestLogin;
    this.log = log;
    if (!isAbsolute(socketPath)) throw new Error(`weixin control socket path must be absolute, got ${JSON.stringify(socketPath)}`);
  }
  socketPath;
  requestLogin;
  log;
  server;
  startTask;
  clients = /* @__PURE__ */ new Set();
  loginIds = /* @__PURE__ */ new WeakMap();
  loginCompletions = /* @__PURE__ */ new Map();
  ownsSocket = false;
  stopping = false;
  /** Listen without making Harness Web await filesystem or socket setup. */
  startInBackground() {
    if (this.startTask !== void 0 || this.stopping) return;
    const task = this.start();
    this.startTask = task;
    void task.catch((error) => {
      if (!this.stopping) this.log.warn("Weixin CLI control socket is unavailable: %s", renderError(error));
    });
  }
  /** Close active clients and remove the socket during plugin teardown. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.startTask !== void 0) await Promise.allSettled([this.startTask]);
    for (const client of this.clients) client.destroy();
    const server = this.server;
    if (server !== void 0) {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      this.server = void 0;
    }
    if (this.ownsSocket) {
      await unlinkIfPresent(this.socketPath);
      this.ownsSocket = false;
    }
    this.loginCompletions.clear();
  }
  async start() {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 448 });
    await removeStaleSocket(this.socketPath);
    if (this.stopping) return;
    const server = createServer((socket) => this.accept(socket));
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => rejectListen(error);
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
    this.ownsSocket = true;
    if (this.stopping) {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await unlinkIfPresent(this.socketPath);
      this.ownsSocket = false;
      return;
    }
    server.on("error", (error) => this.log.warn("Weixin CLI control socket failed: %s", renderError(error)));
    this.server = server;
    await chmod(this.socketPath, 384);
    this.log.info("Weixin CLI control socket listening at %s", this.socketPath);
  }
  accept(socket) {
    this.clients.add(socket);
    socket.setEncoding("utf8");
    const controller = new AbortController();
    let input = "";
    let handled = false;
    const finish = () => {
      this.clients.delete(socket);
      if (!controller.signal.aborted) controller.abort(new Error("Weixin CLI client disconnected"));
    };
    socket.once("close", finish);
    socket.on("data", (chunk) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_MESSAGE_BYTES) {
        handled = true;
        this.respond(socket, { ok: false, error: "control request is too large" });
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = input.slice(0, newline);
      void this.handle(line, controller.signal).then(
        (response) => this.respond(socket, response),
        (error) => this.respond(socket, { ok: false, error: renderError(error) })
      );
    });
  }
  async handle(line, signal) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return { ok: false, error: "invalid control request" };
    }
    if (isLoginRequest(request)) {
      const result = await this.requestLogin(signal, false);
      return {
        ok: true,
        kind: "qr",
        reused: result.reused,
        url: result.url,
        loginId: this.trackLogin(result.completion)
      };
    }
    if (isWaitLoginRequest(request)) {
      const completion = this.loginCompletions.get(request.loginId);
      if (completion === void 0) return { ok: false, error: "unknown or expired login attempt" };
      return waitFor(completion, signal);
    }
    return { ok: false, error: "unknown control command" };
  }
  trackLogin(completion) {
    const existing = this.loginIds.get(completion);
    if (existing !== void 0) return existing;
    const loginId = randomUUID();
    this.loginIds.set(completion, loginId);
    this.loginCompletions.set(loginId, completion.then(
      (credential) => ({
        ok: true,
        kind: "connected",
        accountId: credential.accountId,
        ...credential.userId === void 0 ? {} : { userId: credential.userId },
        baseUrl: credential.baseUrl
      }),
      (error) => ({ ok: false, error: renderError(error) })
    ));
    while (this.loginCompletions.size > MAX_TRACKED_LOGINS) {
      const oldest = this.loginCompletions.keys().next().value;
      if (oldest === void 0) break;
      this.loginCompletions.delete(oldest);
    }
    return loginId;
  }
  respond(socket, response) {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}
`);
  }
};
function requestLoginFromControlSocket(socketPath, options = {}) {
  if (!isAbsolute(socketPath)) return Promise.reject(new Error("control socket path must be absolute"));
  const resolvedOptions = typeof options === "number" ? { timeoutMs: options } : options;
  return requestControl(
    socketPath,
    {
      command: "login",
      ...resolvedOptions.urlOnly === true ? { urlOnly: true } : {}
    },
    resolvedOptions.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS
  );
}
function waitForLoginFromControlSocket(socketPath, loginId, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  if (!loginId.trim()) return Promise.reject(new Error("login id must not be empty"));
  return requestControl(socketPath, { command: "wait-login", loginId }, timeoutMs);
}
function requestControl(socketPath, request, timeoutMs) {
  if (!isAbsolute(socketPath)) return Promise.reject(new Error("control socket path must be absolute"));
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    let input = "";
    let settled = false;
    const timer = setTimeout(() => settleError(new Error(`control request timed out after ${timeoutMs}ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
    };
    const settleError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResponse(error);
    };
    const settleValue = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResponse(value);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}
`));
    socket.once("error", settleError);
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_MESSAGE_BYTES) {
        settleError(new Error("control response is too large"));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        settleValue(parseControlResponse(JSON.parse(input.slice(0, newline))));
      } catch (error) {
        settleError(error instanceof Error ? error : new Error(renderError(error)));
      }
    });
    socket.once("end", () => {
      if (!settled) settleError(new Error("control socket closed without a response"));
    });
  });
}
function isLoginRequest(value) {
  return typeof value === "object" && value !== null && value.command === "login" && (value.urlOnly === void 0 || typeof value.urlOnly === "boolean");
}
function isWaitLoginRequest(value) {
  return typeof value === "object" && value !== null && value.command === "wait-login" && typeof value.loginId === "string" && value.loginId.length > 0;
}
function parseControlResponse(value) {
  if (typeof value !== "object" || value === null) throw new Error("invalid control response");
  const response = value;
  if (response.ok === false && typeof response.error === "string") {
    return { ok: false, error: response.error };
  }
  if (response.ok === true && response.kind === "qr" && typeof response.url === "string" && typeof response.reused === "boolean" && (response.loginId === void 0 || typeof response.loginId === "string")) {
    return {
      ok: true,
      kind: "qr",
      reused: response.reused,
      url: response.url,
      ...response.loginId === void 0 ? {} : { loginId: response.loginId }
    };
  }
  if (response.ok === true && response.kind === "connected" && typeof response.accountId === "string" && (response.userId === void 0 || typeof response.userId === "string") && typeof response.baseUrl === "string") {
    return {
      ok: true,
      kind: "connected",
      accountId: response.accountId,
      ...response.userId === void 0 ? {} : { userId: response.userId },
      baseUrl: response.baseUrl
    };
  }
  throw new Error("invalid control response");
}
function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolveWait, rejectWait) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      rejectWait(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolveWait(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        rejectWait(error);
      }
    );
  });
}
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("control client disconnected");
}
async function removeStaleSocket(socketPath) {
  let stat;
  try {
    stat = await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path ${socketPath}`);
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error(`another Weixin plugin is already listening at ${socketPath}`);
  }
  await unlinkIfPresent(socketPath);
}
function socketAcceptsConnections(socketPath) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish(new Error(`timed out probing ${socketPath}`)), 500);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
    };
    const finish = (error, live) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== void 0) rejectProbe(error);
      else resolveProbe(live ?? false);
    };
    socket.once("connect", () => finish(void 0, true));
    socket.once("error", (error) => {
      const code = error.code;
      if (code === "ECONNREFUSED" || code === "ENOENT") finish(void 0, false);
      else finish(error);
    });
  });
}
async function unlinkIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function renderError(error) {
  try {
    return String(error);
  } catch {
    return "<unrenderable error>";
  }
}

// src/util.ts
import { createHash, randomBytes } from "crypto";
var SESSION_NAMESPACE = "weixin-v3-single";
function sessionIdFor(accountId, message) {
  const userId = message.from_user_id?.trim();
  if (!userId) throw new Error("Weixin message has no sender identifier");
  const digest = createHash("sha256").update(`${accountId}\0${userId}`).digest("hex").slice(0, 32);
  return `${SESSION_NAMESPACE}-${digest}`;
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
  return new Promise((resolve2) => {
    if (signal?.aborted) {
      resolve2();
      return;
    }
    const timer = setTimeout(resolve2, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve2();
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

// src/protocol.ts
import { createCipheriv, createDecipheriv, createHash as createHash2, randomBytes as randomBytes2 } from "crypto";
var CHANNEL_VERSION = "0.2.4";
var BOT_AGENT = "DeepSeek-Harness/0.2.4";
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
        if (attempt < this.config.sendRetries) await new Promise((resolve2) => setTimeout(resolve2, 250 * (attempt + 1)));
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
function requestQrJson(method, url, timeoutMs, body, fetchImpl = fetch, signal) {
  return requestJson(fetchImpl, {
    url,
    method,
    headers: commonHeaders(),
    ...body === void 0 ? {} : { body },
    timeoutMs,
    label: "Weixin QR login",
    ...signal === void 0 ? {} : { signal }
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
import { createInterface } from "readline/promises";
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
  throwIfAborted(options.signal);
  let qr = await fetchQr(options.existingTokens ?? [], fetchImpl, options.signal);
  await callbacks.showQr(qr.url);
  callbacks.status("\u8BF7\u7528\u624B\u673A\u5FAE\u4FE1\u626B\u63CF\u4E8C\u7EF4\u7801\uFF0C\u5E76\u5728\u5FAE\u4FE1\u4E2D\u786E\u8BA4\u8FDE\u63A5\u3002");
  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    const remaining = deadline - Date.now();
    let response;
    try {
      response = await pollStatus(
        currentBaseUrl,
        qr.id,
        pendingVerifyCode,
        Math.min(QR_POLL_TIMEOUT_MS, remaining),
        fetchImpl,
        options.signal
      );
    } catch (error) {
      throwIfAborted(options.signal);
      if (isAbort2(error)) {
        await delay(250, options.signal);
        continue;
      }
      callbacks.status(`\u4E8C\u7EF4\u7801\u72B6\u6001\u67E5\u8BE2\u6682\u65F6\u5931\u8D25\uFF0C\u6B63\u5728\u91CD\u8BD5\uFF1A${String(error)}`);
      await delay(1e3, options.signal);
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
          pendingVerifyCode === void 0 ? "\u8BF7\u8F93\u5165\u624B\u673A\u5FAE\u4FE1\u663E\u793A\u7684\u6570\u5B57\uFF1A" : "\u6570\u5B57\u4E0D\u5339\u914D\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165\uFF1A",
          options.signal
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
        qr = await fetchQr(options.existingTokens ?? [], fetchImpl, options.signal);
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
    await delay(1e3, options.signal);
  }
  throwIfAborted(options.signal);
  throw new Error("\u5FAE\u4FE1\u626B\u7801\u767B\u5F55\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u542F\u52A8\u540E\u518D\u8BD5");
}
async function fetchQr(existingTokens, fetchImpl, signal) {
  const response = await requestQrJson(
    "POST",
    `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    15e3,
    { local_token_list: existingTokens.slice(-10).reverse() },
    fetchImpl,
    signal
  );
  const id = response.qrcode?.trim();
  const url = response.qrcode_img_content?.trim();
  if (!id || !url) throw new Error("\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u670D\u52A1\u5668\u6CA1\u6709\u8FD4\u56DE\u6709\u6548\u4E8C\u7EF4\u7801");
  return { id, url };
}
function pollStatus(baseUrl, qrcode, verifyCode, timeoutMs, fetchImpl, signal) {
  const query = new URLSearchParams({ qrcode });
  if (verifyCode) query.set("verify_code", verifyCode);
  return requestQrJson(
    "GET",
    `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
    timeoutMs,
    void 0,
    fetchImpl,
    signal
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
async function readVerifyCode(prompt, signal) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await (signal === void 0 ? input.question(prompt) : input.question(prompt, { signal }))).trim();
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
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "\u5FAE\u4FE1\u626B\u7801\u767B\u5F55\u5DF2\u53D6\u6D88");
}

// src/standalone-login.ts
import { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
async function loginStandalone(options, login = loginWithQr) {
  const ctx = new Context();
  const fiber = ctx.plugin(LocalCredentialProvider, { watch: false });
  await fiber;
  try {
    const ref = credentialRef(options.credentialRef);
    const info = await ctx.credentials.describe(ref);
    if (!info.writable) {
      throw new Error(`\u51ED\u636E ${options.credentialRef} \u7531\u542F\u52A8\u73AF\u5883\u63D0\u4F9B\uFF0C\u65E0\u6CD5\u88AB\u767B\u5F55\u547D\u4EE4\u8986\u76D6`);
    }
    const existing = await ctx.credentials.resolve(ref);
    const existingTokens = existing === void 0 ? [] : credentialTokens(existing.value);
    const callbacks = {
      showQr: options.showQr,
      status: options.status,
      ...options.readVerifyCode === void 0 ? {} : { readVerifyCode: options.readVerifyCode }
    };
    const credential = await login({
      timeoutMs: options.timeoutMs,
      existingTokens,
      callbacks,
      ...options.signal === void 0 ? {} : { signal: options.signal }
    });
    await ctx.credentials.set(ref, JSON.stringify(credential));
    return credential;
  } finally {
    await fiber.dispose();
  }
}
function credentialTokens(value) {
  try {
    return [parseCredential(value).token];
  } catch {
    return [];
  }
}

export {
  defaultControlSocketPath,
  resolveControlSocketPath,
  WeixinControlServer,
  requestLoginFromControlSocket,
  waitForLoginFromControlSocket,
  sessionIdFor,
  truncateUtf8,
  withTimeout,
  delay,
  SeenMessageIds,
  messageKey,
  MessageItemType,
  MessageType,
  parseCredential,
  WeixinApiClient,
  loginWithQr,
  displayQr,
  loginStandalone
};
//# sourceMappingURL=chunk-CFBWVOH7.js.map