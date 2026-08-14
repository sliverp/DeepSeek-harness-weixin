import * as z from '@deepseek-ai/schemastery';
import z__default from '@deepseek-ai/schemastery';
import { Context } from '@deepseek-ai/cordis';
import { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { ImageMediaType } from '@deepseek-ai/dsh-attachment';
import { ContentBlock } from '@deepseek-ai/dsh-llm';

/** Access policy for direct Weixin messages. */
type AccessMode = 'open' | 'allowlist' | 'disabled';
/** How inbound Weixin images are presented to the selected Harness model. */
type ImageInputMode = 'auto' | 'always' | 'never';
/** Weixin iLink channel configuration. */
interface Config {
    credentialRef: string;
    cwd: string;
    agentPreset?: string;
    permissionPreset?: string;
    statePath: string;
    controlSocketPath: string;
    autoLogin: boolean;
    accessPolicy: AccessMode;
    allowFrom: string[];
    imageInputMode: ImageInputMode;
    responseTimeoutMs: number;
    approvalTimeoutMs: number;
    mediaDownloadTimeoutMs: number;
    apiTimeoutMs: number;
    longPollTimeoutMs: number;
    loginTimeoutMs: number;
    retryDelayMs: number;
    backoffDelayMs: number;
    staleTokenPauseMs: number;
    maxConsecutiveFailures: number;
    maxInFlightMessages: number;
    sendRetries: number;
    maxReplyBytes: number;
    maxReplyImages: number;
    maxOutboundImageBytes: number;
    maxSeenMessageIds: number;
    systemPrompt: string;
}
/** Runtime-validated plugin configuration. */
declare const Config: z__default<Config>;

/** Encrypted Weixin CDN reference. */
interface CdnMedia {
    encrypt_query_param?: string;
    aes_key?: string;
    encrypt_type?: number;
    full_url?: string;
}
/** One image item. */
interface ImageItem {
    media?: CdnMedia;
    thumb_media?: CdnMedia;
    aeskey?: string;
    url?: string;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number;
}
/** One structured message item. */
interface MessageItem {
    type?: number;
    create_time_ms?: number;
    update_time_ms?: number;
    is_completed?: boolean;
    msg_id?: string;
    ref_msg?: {
        message_item?: MessageItem;
        title?: string;
    };
    text_item?: {
        text?: string;
    };
    image_item?: ImageItem;
    voice_item?: {
        media?: CdnMedia;
        text?: string;
    };
    file_item?: {
        media?: CdnMedia;
        file_name?: string;
        md5?: string;
        len?: string;
    };
    video_item?: {
        media?: CdnMedia;
        video_size?: number;
        thumb_media?: CdnMedia;
    };
}
/** Message returned by the iLink getupdates API. */
interface WeixinMessage {
    seq?: number;
    message_id?: number;
    from_user_id?: string;
    to_user_id?: string;
    client_id?: string;
    create_time_ms?: number;
    update_time_ms?: number;
    delete_time_ms?: number;
    session_id?: string;
    group_id?: string;
    message_type?: number;
    message_state?: number;
    item_list?: MessageItem[];
    context_token?: string;
    run_id?: string;
}
/** Long-poll result. */
interface GetUpdatesResponse {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: WeixinMessage[];
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
}
/** Credential issued after a successful QR confirmation. */
interface WeixinCredential {
    token: string;
    accountId: string;
    baseUrl: string;
    userId?: string;
}
/** Parse and validate the managed JSON credential without exposing its values. */
declare function parseCredential(value: string): WeixinCredential;

/** QR-login callbacks kept injectable for deterministic protocol tests. */
interface LoginCallbacks {
    showQr(url: string): Promise<void>;
    readVerifyCode(prompt: string, signal?: AbortSignal): Promise<string>;
    status(message: string): void;
}
/** Obtain an iLink credential through the official Weixin QR flow. */
declare function loginWithQr(options: {
    timeoutMs: number;
    existingTokens?: string[];
    callbacks?: Partial<LoginCallbacks>;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}): Promise<WeixinCredential>;

type FetchPort = typeof fetch;
/** iLink operations used by monitoring, inbound media, and replies. */
interface WeixinApiPort {
    getUpdates(cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<GetUpdatesResponse>;
    notifyStart(): Promise<void>;
    notifyStop(): Promise<void>;
    sendText(to: string, text: string, contextToken?: string): Promise<void>;
    sendImage(to: string, data: Uint8Array, contextToken?: string): Promise<void>;
    downloadImage(image: ImageItem, timeoutMs: number): Promise<Buffer>;
}
/** Official iLink JSON/CDN client derived from Tencent/openclaw-weixin 2.4.6. */
declare class WeixinApiClient implements WeixinApiPort {
    private readonly baseUrl;
    private readonly token;
    private readonly config;
    private readonly fetchImpl;
    private readonly cdnBaseUrl;
    constructor(baseUrl: string, token: string, config: Pick<Config, 'apiTimeoutMs' | 'sendRetries' | 'maxOutboundImageBytes'>, fetchImpl?: FetchPort);
    getUpdates(cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<GetUpdatesResponse>;
    notifyStart(): Promise<void>;
    notifyStop(): Promise<void>;
    sendText(to: string, text: string, contextToken?: string): Promise<void>;
    sendImage(to: string, data: Uint8Array, contextToken?: string): Promise<void>;
    downloadImage(image: ImageItem, timeoutMs: number): Promise<Buffer>;
    private sendItem;
    private uploadEncrypted;
    private postJson;
}

/** Injectable production API factory. */
type WeixinApiFactory = (credential: WeixinCredential, config: Config) => WeixinApiPort;
/** Injectable QR login operation. */
type WeixinLogin = typeof loginWithQr;
/** Injectable QR renderer used by terminal login and tests. */
type WeixinQrDisplay = (url: string) => Promise<void>;
/** Outcome of an explicit login request from a Harness command surface. */
type WeixinLoginRequest = {
    kind: 'qr-shown';
    reused: boolean;
    url: string;
    /** Resolves only after authorization, credential persistence, and hot-switch finish. */
    completion: Promise<WeixinCredential>;
};
/** Live Weixin iLink long-poll ↔ DeepSeek Harness bridge. */
declare class WeixinHarnessBridge {
    private readonly ctx;
    private readonly config;
    private readonly apiFactory;
    private readonly login;
    private readonly showQr;
    private readonly log;
    private readonly seen;
    private readonly abortController;
    private readonly inFlight;
    private credential;
    private api;
    private conversations;
    private monitorTask;
    private monitorAbortController;
    private disconnectTask;
    private connectionAttempt;
    private connected;
    private stopping;
    constructor(ctx: Context, config: Config, apiFactory?: WeixinApiFactory, login?: WeixinLogin, showQr?: WeixinQrDisplay);
    /** Resolve or create a QR credential, verify it, and begin long-polling. */
    start(): Promise<void>;
    /** Begin connecting without making the containing Harness profile await QR login. */
    startInBackground(): void;
    /** Force QR login, replacing any connected credential after authorization succeeds. */
    requestLogin(signal?: AbortSignal, displayQr?: boolean): Promise<WeixinLoginRequest>;
    /** Abort long-polling and await all owned messages and agents. */
    stop(): Promise<void>;
    private launchConnection;
    private connect;
    private resolveCredential;
    private monitor;
    private failureDelay;
    private disconnectActive;
    private performDisconnectActive;
    private dispatch;
    private allowed;
    private handleMessage;
    private sendReply;
    private sendTextReply;
    private retry;
    private requireConversations;
}

/** A decision command intercepted by the Weixin channel. */
interface ApprovalCommand {
    code: string;
    outcome: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>;
}
/** Result returned after resolving one pending approval. */
interface ResolvedApproval {
    code: string;
    outcome: ApprovalCommand['outcome'];
    toolName: string;
}
/** Parse an approval command; `invalid` prevents malformed commands from reaching the model. */
declare function parseApprovalCommand(text: string): ApprovalCommand | 'invalid' | undefined;
/** Owns the short-lived mapping between Harness approval requests and Weixin reply commands. */
declare class WeixinApprovalRegistry {
    private readonly timeoutMs;
    private readonly pending;
    constructor(timeoutMs: number);
    /** Ask one Weixin user and await a one-shot Harness approval outcome. */
    request(conversationId: string, request: ApprovalRequest, sendPrompt: (text: string) => Promise<void>): Promise<ApprovalOutcome>;
    /** Resolve a pending request only when the command came from its originating conversation. */
    decide(conversationId: string, command: ApprovalCommand): ResolvedApproval | undefined;
    /** Cancel every pending request for one conversation. */
    cancelConversation(conversationId: string): boolean;
    /** Cancel every pending request during channel teardown. */
    cancelAll(): void;
    private createCode;
}
/** Render the exact structured tool call linked by the approval request when available. */
declare function formatApprovalPrompt(request: ApprovalRequest, code: string, timeoutMs: number): string;

/** Completed response from one Weixin-triggered Harness turn. */
interface ConversationReply {
    text: string;
    images: Array<{
        data: Uint8Array;
        mediaType: string;
        name?: string;
    }>;
}
/** Result of dispatching one syntactically valid Harness slash command. */
type ConversationCommandOutcome = {
    kind: 'handled';
    reply: ConversationReply;
} | {
    kind: 'unknown';
    available: string[];
};

/** Build durable DSH content blocks from one official Weixin message. */
declare function inboundContent(ctx: Context, config: Config, api: WeixinApiPort, message: WeixinMessage, includeImages?: boolean): Promise<ContentBlock[]>;
/** Detect image formats accepted by Harness attachments from magic bytes. */
declare function detectImageMediaType(data: Uint8Array): ImageMediaType;

/**
 * Adapted from Tencent/openclaw-weixin v2.4.6's StreamingMarkdownFilter
 * at commit cef0bfc390393f716903e16d50408118047f87e0.
 * The upstream implementation is MIT-licensed; see this package's LICENSE.
 */
/**
 * Streaming markdown filter — character-level state machine that strips
 * unsupported markdown syntax on-the-fly.
 *
 * Outputs as much filtered text as possible on each `feed()` call, only
 * holding back the minimum characters needed for pattern disambiguation
 * (e.g. a trailing `*` that might become `***`).
 *
 * Constructs passed through (not filtered):
 * - Code fences (```)
 * - Inline code (`)
 * - Tables (|...|)
 * - Horizontal rules (---, ***, ___)
 * - Bold (**)
 * - Italic/bold-italic wrapping non-CJK content
 *
 * Constructs filtered (markers stripped, content kept):
 * - Italic/bold-italic wrapping CJK content
 * - Headings H5/H6 (#####, ######)
 * - Images (![alt](url)) — removed entirely
 *
 * States:
 * - **sol** (start-of-line): checks for line-start patterns (```, >, #####, indent)
 * - **body**: scans for inline patterns (![, ~~, ***) and outputs safe chars
 * - **fence**: inside a fenced code block, passes through until closing ```
 * - **inline**: accumulating content inside an inline marker pair
 */
declare class StreamingMarkdownFilter {
    private buf;
    private fence;
    private sol;
    private inl;
    feed(delta: string): string;
    flush(): string;
    private pump;
    /** Inside a code fence: pass content and markers through verbatim. */
    private pumpFence;
    /** At start of line: detect and consume line-start patterns, then transition to body. */
    private pumpSOL;
    /** Scan line body for inline pattern triggers; output safe chars eagerly. */
    private pumpBody;
    /** Accumulate inline content until closing marker is found. */
    private pumpInline;
    private static containsCJK;
}
/** Filter one complete Harness reply to the Markdown subset rendered by Weixin. */
declare function filterMarkdownForWeixin(text: string): string;

type WeixinControlResponse = {
    ok: true;
    kind: 'qr';
    reused: boolean;
    url: string;
    loginId?: string;
} | {
    ok: true;
    kind: 'connected';
    accountId: string;
    userId?: string;
    baseUrl: string;
} | {
    ok: false;
    error: string;
};
interface WeixinControlRequestOptions {
    timeoutMs?: number;
    urlOnly?: boolean;
}
interface WeixinControlLogger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
}
/** Default owner-only control socket shared by the plugin runtime and its CLI. */
declare function defaultControlSocketPath(): string;
/** Resolve a configured CLI/server socket path without accepting relative ambiguity. */
declare function resolveControlSocketPath(configured?: string): string;
/** Owner-only Unix socket that lets a shell request QR login from the live plugin. */
declare class WeixinControlServer {
    readonly socketPath: string;
    private readonly requestLogin;
    private readonly log;
    private server;
    private startTask;
    private readonly clients;
    private readonly loginIds;
    private readonly loginCompletions;
    private ownsSocket;
    private stopping;
    constructor(socketPath: string, requestLogin: (signal?: AbortSignal, displayQr?: boolean) => Promise<WeixinLoginRequest>, log: WeixinControlLogger);
    /** Listen without making Harness Web await filesystem or socket setup. */
    startInBackground(): void;
    /** Close active clients and remove the socket during plugin teardown. */
    stop(): Promise<void>;
    private start;
    private accept;
    private handle;
    private trackLogin;
    private respond;
}
/** Ask the live plugin for a QR from a one-shot Linux CLI process. */
declare function requestLoginFromControlSocket(socketPath: string, options?: WeixinControlRequestOptions | number): Promise<WeixinControlResponse>;
/** Wait for one QR attempt to finish authorization and hot-switching. */
declare function waitForLoginFromControlSocket(socketPath: string, loginId: string, timeoutMs?: number): Promise<WeixinControlResponse>;

interface StandaloneLoginOptions {
    credentialRef: string;
    timeoutMs: number;
    showQr(url: string): Promise<void>;
    status(message: string): void;
    readVerifyCode?(prompt: string, signal?: AbortSignal): Promise<string>;
    signal?: AbortSignal;
}
/** Injectable QR operation for standalone CLI tests. */
type StandaloneQrLogin = typeof loginWithQr;
/**
 * Complete QR authorization without a running Harness composition and commit
 * the result through Harness's own locked, atomic local credential provider.
 */
declare function loginStandalone(options: StandaloneLoginOptions, login?: StandaloneQrLogin): Promise<WeixinCredential>;

/** Deterministic, non-identifying DSH session id for one Weixin user. */
declare function sessionIdFor(accountId: string, message: Pick<WeixinMessage, 'from_user_id'>): string;
/** Bound UTF-8 text without splitting a code point. */
declare function truncateUtf8(text: string, maxBytes: number, suffix?: string): string;
/** Bounded insertion-ordered duplicate detector. */
declare class SeenMessageIds {
    private readonly limit;
    private readonly ids;
    constructor(limit: number);
    /** Return true for a duplicate; record a new id otherwise. */
    hasOrAdd(id: string): boolean;
}

declare const name = "deepseek-harness-weixin";
declare const inject: string[];

interface WeixinBridgeLifecycle {
    startInBackground(): void;
    requestLogin(signal?: AbortSignal, displayQr?: boolean): Promise<WeixinLoginRequest>;
    stop(): Promise<void>;
}
interface WeixinControlLifecycle {
    startInBackground(): void;
    stop(): Promise<void>;
}
/** Mount a bridge without making the Harness profile wait for QR authorization. */
declare function mountBridge(ctx: Context, bridge: WeixinBridgeLifecycle, control?: WeixinControlLifecycle): void;
/** Mount the Weixin QR/login channel and tie teardown to the Cordis lifecycle. */
declare function apply(ctx: Context, config: Config): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: z.default<Config>;
    apply: typeof apply;
};

export { type ApprovalCommand, Config, Config as ConfigType, type ConversationCommandOutcome, type ConversationReply, type ResolvedApproval, SeenMessageIds, type StandaloneLoginOptions, type StandaloneQrLogin, StreamingMarkdownFilter, WeixinApiClient, WeixinApprovalRegistry, type WeixinControlRequestOptions, type WeixinControlResponse, WeixinControlServer, WeixinHarnessBridge, type WeixinLoginRequest, apply, _default as default, defaultControlSocketPath, detectImageMediaType, filterMarkdownForWeixin, formatApprovalPrompt, inboundContent, inject, loginStandalone, loginWithQr, mountBridge, name, parseApprovalCommand, parseCredential, requestLoginFromControlSocket, resolveControlSocketPath, sessionIdFor, truncateUtf8, waitForLoginFromControlSocket };
