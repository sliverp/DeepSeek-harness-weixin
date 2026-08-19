#!/usr/bin/env node
import {
  loginStandalone,
  requestLoginFromControlSocket,
  resolveControlSocketPath,
  waitForLoginFromControlSocket
} from "./chunk-KCZ7FGE3.js";

// src/cli.ts
import { realpathSync } from "fs";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";
var DEFAULT_CREDENTIAL_REF = "WEIXIN_ILINK_CREDENTIAL";
var DEFAULT_LOGIN_TIMEOUT_MS = 3e5;
async function run(argv) {
  let options;
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
      process.stdout.write(usage());
      return 0;
    }
    options = parsed;
  } catch (error) {
    process.stderr.write(`${renderError(error)}

${usage()}`);
    return 2;
  }
  let response;
  try {
    response = await requestLoginFromControlSocket(options.socketPath, { urlOnly: options.urlOnly });
  } catch (error) {
    if (options.wait && isControlUnavailable(error)) return runStandalone(options);
    const code = error.code;
    const detail = code === "ENOENT" || code === "ECONNREFUSED" ? "\u5FAE\u4FE1\u63D2\u4EF6\u63A7\u5236\u901A\u9053\u5C1A\u672A\u8FD0\u884C\uFF1B\u4F7F\u7528 --wait \u53EF\u5728\u4E0D\u542F\u52A8 dsh web \u7684\u60C5\u51B5\u4E0B\u72EC\u7ACB\u767B\u5F55\u3002" : `\u65E0\u6CD5\u8FDE\u63A5\u5FAE\u4FE1\u63D2\u4EF6\u63A7\u5236\u901A\u9053\uFF1A${renderError(error)}`;
    process.stderr.write(`${detail}
Socket: ${options.socketPath}
`);
    return 1;
  }
  if (!response.ok) {
    process.stderr.write(`\u5FAE\u4FE1\u626B\u7801\u542F\u52A8\u5931\u8D25\uFF1A${response.error}
`);
    return 1;
  }
  if (response.kind !== "qr") {
    process.stderr.write("\u5FAE\u4FE1\u626B\u7801\u542F\u52A8\u5931\u8D25\uFF1A\u63A7\u5236\u901A\u9053\u8FD4\u56DE\u4E86\u65E0\u6548\u7684\u4E8C\u7EF4\u7801\u72B6\u6001\u3002\n");
    return 1;
  }
  try {
    await presentQr(response.url, options.urlOnly);
  } catch (error) {
    process.stderr.write(`\u65E0\u6CD5\u663E\u793A\u5FAE\u4FE1\u4E8C\u7EF4\u7801\uFF1A${renderError(error)}
`);
    return 1;
  }
  if (options.wait) return waitForLiveLogin(options, response);
  if (options.urlOnly) return 0;
  process.stdout.write(response.reused ? "\u5DF2\u663E\u793A\u5F53\u524D\u626B\u7801\u6D41\u7A0B\u7684\u6700\u65B0\u4E8C\u7EF4\u7801\u3002\n" : "\u5DF2\u751F\u6210\u65B0\u7684\u5FAE\u4FE1\u4E8C\u7EF4\u7801\uFF0C\u8BF7\u626B\u7801\u5E76\u5728\u5FAE\u4FE1\u4E2D\u786E\u8BA4\u8FDE\u63A5\u3002\n");
  return 0;
}
function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) return "help";
  if (argv[0] !== "login") throw new Error(`\u672A\u77E5\u547D\u4EE4\uFF1A${argv[0] ?? ""}`);
  let socketPath;
  let urlOnly = false;
  let wait = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url") {
      urlOnly = true;
      continue;
    }
    if (argument === "--wait") {
      const value = argv[index + 1];
      if (value === "true" || value === "false") {
        wait = value === "true";
        index += 1;
      } else {
        wait = true;
      }
      continue;
    }
    if (argument?.startsWith("--wait=")) {
      const value = argument.slice("--wait=".length);
      if (value !== "true" && value !== "false") throw new Error("--wait \u53EA\u63A5\u53D7 true \u6216 false");
      wait = value === "true";
      continue;
    }
    if (argument === "--socket") {
      const value = argv[index + 1];
      if (!value) throw new Error("--socket \u9700\u8981\u4E00\u4E2A\u8DEF\u5F84");
      socketPath = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--socket=")) {
      socketPath = argument.slice("--socket=".length);
      if (!socketPath) throw new Error("--socket \u9700\u8981\u4E00\u4E2A\u8DEF\u5F84");
      continue;
    }
    throw new Error(`\u672A\u77E5\u53C2\u6570\uFF1A${argument ?? ""}`);
  }
  return { command: "login", socketPath: resolveControlSocketPath(socketPath), urlOnly, wait };
}
async function presentQr(url, urlOnly) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u5730\u5740\u4E0D\u662F HTTPS");
  if (urlOnly) {
    process.stdout.write(url);
    return;
  }
  const qrcode = await import("qrcode-terminal");
  qrcode.default.generate(url, { small: true });
  process.stdout.write(`\u4E8C\u7EF4\u7801\u5907\u7528\u94FE\u63A5\uFF08\u8BF7\u52FF\u8F6C\u53D1\uFF09\uFF1A
${url}
`);
}
function usage() {
  return [
    "\u7528\u6CD5\uFF1Adsh-weixin login [--url] [--wait[=true|false]] [--socket <path>]",
    "",
    "\u5F3A\u5236\u91CD\u65B0\u767B\u5F55\u5E76\u8986\u76D6\u5DF2\u4FDD\u5B58\u7684\u5FAE\u4FE1\u51ED\u636E\u3002",
    "--url \u6210\u529F\u65F6\u53EA\u5411\u6807\u51C6\u8F93\u51FA\u5199\u5165\u4E8C\u7EF4\u7801 URL\uFF0C\u4E0D\u8F93\u51FA\u4E8C\u7EF4\u7801\u6216\u5176\u4ED6\u6587\u5B57\u3002",
    "--wait \u5148\u8F93\u51FA\u4E8C\u7EF4\u7801\u6216 URL\uFF0C\u518D\u7B49\u5F85\u6388\u6743\u5B8C\u6210\uFF1B\u6210\u529F\u9000\u51FA 0\uFF0C\u5931\u8D25\u9000\u51FA\u975E 0\u3002",
    "--wait \u4E0D\u4F9D\u8D56 dsh web\uFF1BWeb \u5DF2\u8FD0\u884C\u65F6\u901A\u8FC7\u672C\u673A Socket \u5B8C\u6210\u8FDE\u63A5\u70ED\u5207\u6362\u3002",
    ""
  ].join("\n");
}
async function waitForLiveLogin(options, response) {
  if (response.loginId === void 0) {
    process.stderr.write("\u8FD0\u884C\u4E2D\u7684\u5FAE\u4FE1\u63D2\u4EF6\u7248\u672C\u4E0D\u652F\u6301 --wait\uFF0C\u8BF7\u91CD\u542F dsh web \u540E\u518D\u8BD5\u3002\n");
    return 1;
  }
  let completion;
  try {
    completion = await waitForLoginFromControlSocket(options.socketPath, response.loginId);
  } catch (error) {
    process.stderr.write(`\u7B49\u5F85\u5FAE\u4FE1\u6388\u6743\u5931\u8D25\uFF1A${renderError(error)}
`);
    return 1;
  }
  if (!completion.ok) {
    process.stderr.write(`\u5FAE\u4FE1\u6388\u6743\u5931\u8D25\uFF1A${completion.error}
`);
    return 1;
  }
  if (completion.kind !== "connected") {
    process.stderr.write("\u5FAE\u4FE1\u6388\u6743\u5931\u8D25\uFF1A\u63A7\u5236\u901A\u9053\u8FD4\u56DE\u4E86\u65E0\u6548\u7684\u5B8C\u6210\u72B6\u6001\u3002\n");
    return 1;
  }
  if (!options.urlOnly) process.stdout.write("\u5FAE\u4FE1\u6388\u6743\u6210\u529F\uFF0C\u8FDE\u63A5\u5DF2\u5207\u6362\u3002\n");
  return 0;
}
async function runStandalone(options) {
  let shown = false;
  try {
    await loginStandalone({
      credentialRef: process.env.DSH_WEIXIN_CREDENTIAL_REF?.trim() || DEFAULT_CREDENTIAL_REF,
      timeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
      showQr: async (url) => {
        if (shown && options.urlOnly) throw new Error("\u4E8C\u7EF4\u7801\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u8FD0\u884C\u767B\u5F55\u547D\u4EE4\u83B7\u53D6\u65B0 URL");
        shown = true;
        await presentQr(url, options.urlOnly);
      },
      status: options.urlOnly ? () => void 0 : (message) => process.stdout.write(`${message}
`),
      readVerifyCode: readVerifyCodeFromCli
    });
    return 0;
  } catch (error) {
    process.stderr.write(`\u5FAE\u4FE1\u6388\u6743\u5931\u8D25\uFF1A${renderError(error)}
`);
    return 1;
  }
}
async function readVerifyCodeFromCli(prompt, signal) {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await (signal === void 0 ? input.question(prompt) : input.question(prompt, { signal }))).trim();
  } finally {
    input.close();
  }
}
function isControlUnavailable(error) {
  const code = error?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}
function renderError(error) {
  try {
    return String(error);
  } catch {
    return "<\u65E0\u6CD5\u663E\u793A\u7684\u9519\u8BEF>";
  }
}
if (isMainModule()) {
  process.exitCode = await run(process.argv.slice(2));
}
function isMainModule() {
  const entry = process.argv[1];
  if (entry === void 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
export {
  run
};
//# sourceMappingURL=cli.js.map