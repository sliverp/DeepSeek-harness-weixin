import * as z from '@deepseek-ai/schemastery';
import z__default from '@deepseek-ai/schemastery';
import { Context } from '@deepseek-ai/cordis';
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
    statePath: string;
    autoLogin: boolean;
    accessPolicy: AccessMode;
    allowFrom: string[];
    imageInputMode: ImageInputMode;
    responseTimeoutMs: number;
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
    readVerifyCode(prompt: string): Promise<string>;
    status(message: string): void;
}
/** Obtain an iLink credential through the official Weixin QR flow. */
declare function loginWithQr(options: {
    timeoutMs: number;
    existingTokens?: string[];
    callbacks?: Partial<LoginCallbacks>;
    fetchImpl?: typeof fetch;
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
/** Live Weixin iLink long-poll ↔ DeepSeek Harness bridge. */
declare class WeixinHarnessBridge {
    private readonly ctx;
    private readonly config;
    private readonly apiFactory;
    private readonly login;
    private readonly log;
    private readonly seen;
    private readonly abortController;
    private readonly inFlight;
    private credential;
    private api;
    private conversations;
    private monitorTask;
    private stopping;
    constructor(ctx: Context, config: Config, apiFactory?: WeixinApiFactory, login?: WeixinLogin);
    /** Resolve or create a QR credential, verify it, and begin long-polling. */
    start(): Promise<void>;
    /** Abort long-polling and await all owned messages and agents. */
    stop(): Promise<void>;
    private resolveCredential;
    private monitor;
    private failureDelay;
    private dispatch;
    private allowed;
    private handleMessage;
    private sendReply;
    private retry;
    private requireConversations;
}

/** Build durable DSH content blocks from one official Weixin message. */
declare function inboundContent(ctx: Context, config: Config, api: WeixinApiPort, message: WeixinMessage, includeImages?: boolean): Promise<ContentBlock[]>;
/** Detect image formats accepted by Harness attachments from magic bytes. */
declare function detectImageMediaType(data: Uint8Array): ImageMediaType;

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

/** Mount the Weixin QR/login channel and tie teardown to the Cordis lifecycle. */
declare function apply(ctx: Context, config: Config): Promise<void>;
declare const _default: {
    name: string;
    inject: string[];
    Config: z.default<Config>;
    apply: typeof apply;
};

export { Config, Config as ConfigType, SeenMessageIds, WeixinApiClient, WeixinHarnessBridge, apply, _default as default, detectImageMediaType, inboundContent, inject, loginWithQr, name, parseCredential, sessionIdFor, truncateUtf8 };
