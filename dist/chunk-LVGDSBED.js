// src/control.ts
import { chmod, lstat, mkdir, unlink } from "fs/promises";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { createConnection, createServer } from "net";
var MAX_CONTROL_MESSAGE_BYTES = 4096;
var DEFAULT_CLIENT_TIMEOUT_MS = 3e4;
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
    if (!isLoginRequest(request)) return { ok: false, error: "unknown control command" };
    const result = await this.requestLogin(signal, false);
    return { ok: true, kind: "qr", reused: result.reused, url: result.url };
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
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    let input = "";
    let settled = false;
    const timeoutMs = resolvedOptions.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
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
    socket.once("connect", () => socket.write(`${JSON.stringify({
      command: "login",
      ...resolvedOptions.urlOnly === true ? { urlOnly: true } : {}
    })}
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
function parseControlResponse(value) {
  if (typeof value !== "object" || value === null) throw new Error("invalid control response");
  const response = value;
  if (response.ok === false && typeof response.error === "string") {
    return { ok: false, error: response.error };
  }
  if (response.ok === true && response.kind === "qr" && typeof response.url === "string" && typeof response.reused === "boolean") {
    return { ok: true, kind: "qr", reused: response.reused, url: response.url };
  }
  throw new Error("invalid control response");
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

export {
  defaultControlSocketPath,
  resolveControlSocketPath,
  WeixinControlServer,
  requestLoginFromControlSocket
};
//# sourceMappingURL=chunk-LVGDSBED.js.map