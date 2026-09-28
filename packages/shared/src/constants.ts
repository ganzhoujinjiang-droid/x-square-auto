/**
 * 全局常量。
 *
 * 集中在此的原因（§26 风险 10）：X API 定价随时可能调整，成本常量必须集中配置，
 * 不得硬编码散落在业务代码中。
 */

// ---------------------------------------------------------------------------
// 端点地址
// ---------------------------------------------------------------------------

/** X API v2 根地址。本系统只调用读取类接口，永不写入（§1.1）。 */
export const X_API_BASE_URL = 'https://api.x.com';

/** X OAuth 2.0 授权页。 */
export const X_OAUTH_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

/** X OAuth 2.0 令牌端点。 */
export const X_OAUTH_TOKEN_URL = 'https://api.x.com/2/oauth2/token';

/**
 * Binance Square OpenAPI V1 —— 仅用于 POST /content/add（§11.1）。
 *
 * ⚠️ 发布必须走 V1。全部用 V2 会导致 /content/add 失败。
 */
export const BINANCE_SQUARE_V1_BASE_URL =
  'https://www.binance.com/bapi/composite/v1/public/pgc/openApi';

/**
 * Binance Square OpenAPI V2 —— 仅用于图片预签名上传与状态轮询（§11.1）。
 */
export const BINANCE_SQUARE_V2_BASE_URL =
  'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';

/** Binance 统一请求头中标识客户端类型的固定值（§11.1）。 */
export const BINANCE_CLIENT_TYPE = 'binanceSkill';

/** Binance 响应体中代表成功的 code，注意是字符串而非数字 0（§11.1）。 */
export const BINANCE_SUCCESS_CODE = '000000';

// ---------------------------------------------------------------------------
// X 轮询
// ---------------------------------------------------------------------------

/** 后台可选的轮询间隔（秒），§6.2。 */
export const POLL_INTERVAL_OPTIONS_SEC = [15, 30, 60, 120, 300] as const;

export type PollIntervalSec = (typeof POLL_INTERVAL_OPTIONS_SEC)[number];

/** 默认轮询间隔，§6.2。 */
export const DEFAULT_POLL_INTERVAL_SEC: PollIntervalSec = 30;

/** GET /2/users/{id}/tweets 的 max_results，V1 固定 100（§6.1）。 */
export const X_TIMELINE_MAX_RESULTS = 100;

/** baseline 探测时取的条数（§6.5）。 */
export const X_BASELINE_MAX_RESULTS = 5;

/**
 * x-rate-limit-remaining 低于此值时主动休眠至 reset 时间（§6.2）。
 * 禁止写死无限循环请求。
 */
export const X_RATE_LIMIT_REMAINING_THRESHOLD = 2;

/** 连续 429 达到此次数后，自动将轮询间隔翻倍（§10.3）。 */
export const X_CONSECUTIVE_RATE_LIMIT_THRESHOLD = 3;

/** 轮询间隔翻倍后的上限（§10.3）。 */
export const X_MAX_POLL_INTERVAL_SEC: PollIntervalSec = 300;

/** OAuth state 的 Redis TTL（毫秒），§7.1。 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** access_token 到期前多久主动刷新（毫秒），§7.5。 */
export const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;

/** Token 刷新失败的退避序列（毫秒），§7.5。 */
export const TOKEN_REFRESH_BACKOFF_MS = [60_000, 300_000, 900_000] as const;

// ---------------------------------------------------------------------------
// 队列（BullMQ，§10.1）
// ---------------------------------------------------------------------------

/** 队列名。§10.1 定义的 6 条队列，其中 reconcile-uncertain 属 V2。 */
export const QUEUE_NAMES = {
  syncPost: 'sync-post',
  processContent: 'process-content',
  downloadMedia: 'download-media',
  uploadMedia: 'upload-media',
  publishBinance: 'publish-binance',
  reconcileUncertain: 'reconcile-uncertain',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** 通用队列的重试次数，§10.1。 */
export const QUEUE_ATTEMPTS = 5;

/** 自定义退避序列（毫秒）：30s / 60s / 120s / 300s / 600s，§10.1。 */
export const QUEUE_BACKOFF_DELAYS_MS = [
  30_000, 60_000, 120_000, 300_000, 600_000,
] as const;

/** 默认任务锁时长（毫秒），§10.1。 */
export const QUEUE_LOCK_DURATION_MS = 60_000;

/** publish-binance 的任务锁时长（毫秒），§10.1。发布耗时更长。 */
export const QUEUE_PUBLISH_LOCK_DURATION_MS = 120_000;

/** stalled 检测间隔（毫秒），§10.1。 */
export const QUEUE_STALLED_INTERVAL_MS = 30_000;

/** 完成任务保留条数，§10.1。 */
export const QUEUE_REMOVE_ON_COMPLETE_COUNT = 1000;

/**
 * 失败任务必须保留供排查，因此 removeOnFail 恒为 false（§10.1）。
 * 独立成常量是为了防止后续误改为 true。
 */
export const QUEUE_REMOVE_ON_FAIL = false;

/** 单张图片下载/上传的最大重试次数，受 400/日 上传限额约束（§12）。 */
export const MEDIA_MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Binance 硬限额（§11.3）
// ---------------------------------------------------------------------------

/** 日发帖上限。 */
export const BINANCE_DAILY_POST_LIMIT = 100;

/** 日媒体上传上限。 */
export const BINANCE_DAILY_UPLOAD_LIMIT = 400;

/** 发帖预警阈值，达到后后台黄色提示（§11.3）。 */
export const BINANCE_DAILY_POST_WARN_AT = 95;

/** 上传预警阈值（§11.3）。 */
export const BINANCE_DAILY_UPLOAD_WARN_AT = 380;

/** Redis 计数键 TTL：48 小时，跨 UTC 日滚动（§11.3）。 */
export const BINANCE_COUNTER_TTL_MS = 48 * 60 * 60 * 1000;

/** 短帖（contentType=1）最多图片数，§11.2。 */
export const BINANCE_SHORT_POST_MAX_IMAGES = 4;

/** 长文章（contentType=2）恰好 1 张封面，§11.2。V1 不实现，常量先行登记。 */
export const BINANCE_ARTICLE_COVER_COUNT = 1;

/** Binance contentType 枚举，§11.2。 */
export const BINANCE_CONTENT_TYPE = {
  shortPost: 1,
  article: 2,
} as const;

/**
 * 正文长度软性预警阈值（§14.3）。
 *
 * ⚠️ 待验证（§26 风险 1）：Square 正文准确字符上限官方未公开，仅给出错误码 20013。
 * 此处 280 只是软性预警，真实超限由 20013 兜底映射为 FAILED。
 * 用户在真实环境试发长文确认后，应把实测上限写入 SOFT_WARN_CONTENT_LENGTH。
 */
export const SOFT_WARN_CONTENT_LENGTH = 280;

// ---------------------------------------------------------------------------
// 图片处理（§12）
// ---------------------------------------------------------------------------

/** 单张图片最大字节数：15MB。 */
export const MEDIA_MAX_BYTES = 15 * 1024 * 1024;

/** 图片下载超时（毫秒）。 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

/** 允许的图片 MIME 白名单，§12。视频与 GIF 在 V1 不同步。 */
export const MEDIA_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/** 扩展名 → Content-Type 映射，PUT 预签名 URL 时使用（§11.1）。 */
export const MEDIA_EXTENSION_CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'x-msvideo',
  webm: 'video/webp',
};

/** 未知扩展名的兜底 Content-Type（§11.1）。 */
export const MEDIA_FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * 图片处理状态轮询间隔（毫秒）。
 *
 * ⚠️ 文档内部分歧（需人工裁定）：
 *   §11.1 记「官方轮询参数：间隔 3000 ms，最多 10 次」，并称「本系统沿用该参数」；
 *   §12 的流程图记「间隔 2s，最多 30 次 = 60s」。
 * 二者不一致。此处默认取 §11.1 的官方参数，因为它有官方 skill 源码作为依据；
 * §12 的 60s 上限通过 MEDIA_STATUS_POLL_MAX_ATTEMPTS 放宽后亦可覆盖。
 * 落地前请与维护者确认以哪一节为准。
 */
export const MEDIA_STATUS_POLL_INTERVAL_MS = 3000;

/** 图片处理状态最大轮询次数。 */
export const MEDIA_STATUS_POLL_MAX_ATTEMPTS = 10;

/** Binance imageStatus 返回的 status 取值（§11.1）。 */
export const BINANCE_IMAGE_STATUS = {
  /** 处理中，继续轮询。 */
  processing: 0,
  /** 处理完成，imageUrl 可用。 */
  ready: 1,
  /** 处理失败，携带 failedReason。 */
  failed: 2,
} as const;

/** 媒体临时目录（容器内），任务结束后立即删除，进程启动时清空残留（§12）。 */
export const MEDIA_TMP_DIR = '/tmp/x-square-media';

// ---------------------------------------------------------------------------
// X API 成本（§18.1）
//
// ⚠️ 官方声明 "Prices are subject to change"，调整时只需改这里（§26 风险 10）。
// ---------------------------------------------------------------------------

/** Posts: Read 标准单价（美元/资源）。 */
export const X_COST_POSTS_READ_STANDARD_USD = 0.005;

/**
 * Posts: Read 的 Owned Reads 优惠单价（美元/资源）。
 *
 * 生效前提（§7.3）：认证用户 = Developer App Owner = 被监控的 X 账号。
 * 不满足时按标准价计费，即 5 倍成本。
 */
export const X_COST_POSTS_READ_OWNED_USD = 0.001;

/** User: Read 单价（美元/资源）。 */
export const X_COST_USER_READ_USD = 0.01;

/** List: Read 单价（美元/资源）。 */
export const X_COST_LIST_READ_USD = 0.005;

/**
 * Post: Create (with URL) 单价（美元/请求）。
 *
 * 本项目不写 X，登记此常量仅为防止将来误用：它是 $0.015 的 13 倍（§14.4）。
 */
export const X_COST_POST_CREATE_WITH_URL_USD = 0.2;

/** pay-per-usage 计划每账期的 Post reads 上限（§18.1）。 */
export const X_BILLING_PERIOD_MAX_POST_READS = 3_000_000;

/** 建议首期在 Developer Console 设置的 Spending Limit（美元，§18.4）。 */
export const X_RECOMMENDED_SPENDING_LIMIT_USD = 5;

/**
 * 本地估算与 Usage endpoint 对账的偏差告警阈值（§18.5）。
 * 偏差超过 20% 时告警。
 */
export const X_COST_RECONCILE_DEVIATION_RATIO = 0.2;

/** 信用余额低于此值（美元）时后台红色横幅告警（§18.5）。 */
export const X_CREDIT_BALANCE_ALERT_USD = 1;

// ---------------------------------------------------------------------------
// 安全（§19）
// ---------------------------------------------------------------------------

/** Argon2id 参数下限（§19.1）。 */
export const ARGON2_MEMORY_KIB = 64 * 1024;
export const ARGON2_TIME_COST = 3;
export const ARGON2_PARALLELISM = 1;

/** 登录接口限流：5 次/分钟/IP（§19.2）。 */
export const LOGIN_RATE_LIMIT_PER_MIN = 5;

/** API 全局限流：100 次/分钟/会话（§19.2）。 */
export const API_RATE_LIMIT_PER_MIN = 100;

/** 登录失败锁定：同 IP + 同用户名 5 次失败锁定 15 分钟（§19.1）。 */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

/** AES-256-GCM 密文结构尺寸（字节），§7.4。 */
export const AES_IV_BYTES = 12;
export const AES_AUTH_TAG_BYTES = 16;
export const AES_KEY_BYTES = 32;

/** 密钥掩码保留的前缀与后缀长度（§11.6：前 5 位 + ... + 后 4 位）。 */
export const SECRET_MASK_PREFIX_LEN = 5;
export const SECRET_MASK_SUFFIX_LEN = 4;

// ---------------------------------------------------------------------------
// 文本模板（§14.3）
// ---------------------------------------------------------------------------

/** 模板中支持的变量名。 */
export const TEMPLATE_VARIABLES = [
  'text',
  'url',
  'username',
  'date',
  'hashtags',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** 默认模板（§14.3）。 */
export const DEFAULT_TEMPLATE = '{text}\n\n—\n来源：@{username}\n{url}';

// ---------------------------------------------------------------------------
// 可观测性（§20）
// ---------------------------------------------------------------------------

/** 生产日志级别（§20.2）。 */
export const PRODUCTION_LOG_LEVEL = 'info';

/** 日志保留天数，按日轮转（§20.2）。 */
export const LOG_RETENTION_DAYS = 14;

/** /health 返回的 status 取值（§20.1）。 */
export const HEALTH_STATUS = {
  ok: 'ok',
  degraded: 'degraded',
  error: 'error',
} as const;

export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS];

/** UI 默认展示时区（§20.4）。数据库与应用层一律 UTC。 */
export const DEFAULT_DISPLAY_TIMEZONE = 'Asia/Tokyo';

/** X 侧轮询状态取值（§6.3）。 */
export const POLL_STATUS = {
  ok: 'OK',
  rateLimited: 'RATE_LIMITED',
  authFailed: 'AUTH_FAILED',
  networkError: 'NETWORK_ERROR',
  serverError: 'SERVER_ERROR',
} as const;

export type PollStatus = (typeof POLL_STATUS)[keyof typeof POLL_STATUS];

/** X 账号状态取值（§21.1 XAccount.status 注释）。 */
export const X_ACCOUNT_STATUS = {
  pending: 'PENDING',
  active: 'ACTIVE',
  tokenExpired: 'TOKEN_EXPIRED',
  paused: 'PAUSED',
  error: 'ERROR',
} as const;

export type XAccountStatus =
  (typeof X_ACCOUNT_STATUS)[keyof typeof X_ACCOUNT_STATUS];

/** UNCERTAIN 的产生原因（§21.1 SyncJob.uncertainReason）。 */
export const UNCERTAIN_REASON = {
  timeout: 'TIMEOUT',
  http504: 'HTTP_504',
  connectionReset: 'CONNECTION_RESET',
} as const;

export type UncertainReason =
  (typeof UNCERTAIN_REASON)[keyof typeof UNCERTAIN_REASON];

/** 系统内自定义错误码（区别于 Binance 平台错误码）。 */
export const SYSTEM_ERROR_CODE = {
  /** 日发帖限额前置校验未通过（§11.3）。不发出请求，直接 FAILED。 */
  dailyPostLimit: 'DAILY_POST_LIMIT',
  /** 日上传限额前置校验未通过（§11.3）。 */
  dailyUploadLimit: 'DAILY_UPLOAD_LIMIT',
  /** 图片处理失败，等待人工选择降级方式（§12）。 */
  mediaProcessingFailed: 'MEDIA_PROCESSING_FAILED',
  /** X 原帖在同步后被编辑，Binance 侧无法跟随修改（§13.1）。 */
  xEditedAfterSync: 'X_EDITED_AFTER_SYNC',
} as const;

export type SystemErrorCode =
  (typeof SYSTEM_ERROR_CODE)[keyof typeof SYSTEM_ERROR_CODE];
