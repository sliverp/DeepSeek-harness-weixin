#!/usr/bin/env node
import {
  requestLoginFromControlSocket,
  resolveControlSocketPath
} from "./chunk-2OXSSMUP.js";

// src/cli.ts
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
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
    response = await requestLoginFromControlSocket(options.socketPath);
  } catch (error) {
    const code = error.code;
    const detail = code === "ENOENT" || code === "ECONNREFUSED" ? "\u5FAE\u4FE1\u63D2\u4EF6\u63A7\u5236\u901A\u9053\u5C1A\u672A\u8FD0\u884C\uFF0C\u8BF7\u5148\u542F\u52A8 pnpm dsh web\u3002" : `\u65E0\u6CD5\u8FDE\u63A5\u5FAE\u4FE1\u63D2\u4EF6\u63A7\u5236\u901A\u9053\uFF1A${renderError(error)}`;
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
  if (response.kind === "connected") {
    process.stdout.write("\u5FAE\u4FE1\u5DF2\u7ECF\u8FDE\u63A5\uFF0C\u65E0\u9700\u626B\u7801\u3002\n");
    return 0;
  }
  try {
    await displayQr(response.url);
  } catch (error) {
    process.stderr.write(`\u65E0\u6CD5\u663E\u793A\u5FAE\u4FE1\u4E8C\u7EF4\u7801\uFF1A${renderError(error)}
`);
    return 1;
  }
  process.stdout.write(response.reused ? "\u5DF2\u663E\u793A\u5F53\u524D\u626B\u7801\u6D41\u7A0B\u7684\u6700\u65B0\u4E8C\u7EF4\u7801\u3002\n" : "\u5DF2\u751F\u6210\u65B0\u7684\u5FAE\u4FE1\u4E8C\u7EF4\u7801\uFF0C\u8BF7\u626B\u7801\u5E76\u5728\u5FAE\u4FE1\u4E2D\u786E\u8BA4\u8FDE\u63A5\u3002\n");
  return 0;
}
function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) return "help";
  if (argv[0] !== "login") throw new Error(`\u672A\u77E5\u547D\u4EE4\uFF1A${argv[0] ?? ""}`);
  let socketPath;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
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
  return { command: "login", socketPath: resolveControlSocketPath(socketPath) };
}
async function displayQr(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("\u5FAE\u4FE1\u4E8C\u7EF4\u7801\u5730\u5740\u4E0D\u662F HTTPS");
  const qrcode = await import("qrcode-terminal");
  qrcode.default.generate(url, { small: true });
  process.stdout.write(`\u4E8C\u7EF4\u7801\u5907\u7528\u94FE\u63A5\uFF08\u8BF7\u52FF\u8F6C\u53D1\uFF09\uFF1A
${url}
`);
}
function usage() {
  return [
    "\u7528\u6CD5\uFF1Adsh-weixin login [--socket <path>]",
    "",
    "\u901A\u8FC7\u672C\u673A Unix Socket \u8BF7\u6C42\u6B63\u5728\u8FD0\u884C\u7684 DeepSeek Harness \u5FAE\u4FE1\u63D2\u4EF6\u663E\u793A\u4E8C\u7EF4\u7801\u3002",
    ""
  ].join("\n");
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