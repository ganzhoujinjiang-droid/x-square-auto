/**
 * 同步任务状态机（§9）。
 *
 * 设计要点：
 *   1. 状态与 Prisma 的 JobStatus enum 一一对应（§21.1）。
 *   2. 转移表是唯一事实来源，任何非法转移在运行时抛错（§9.2 的「双保险」之运行时侧；
 *      类型侧由 canTransition / assertTransition 的签名收窄提供）。
 *   3. 终态不可被 Worker 自动改变（§9.2）。UNCERTAIN 的唯一出口是人工操作（§9.3）。
 */

/** 同步任务状态，与 prisma/schema.prisma 的 enum JobStatus 保持一致。 */
export const JOB_STATUS = {
  discovered: 'DISCOVERED',
  filtered: 'FILTERED',
  queued: 'QUEUED',
  processing: 'PROCESSING',
  mediaProcessing: 'MEDIA_PROCESSING',
  publishing: 'PUBLISHING',
  success: 'SUCCESS',
  failed: 'FAILED',
  uncertain: 'UNCERTAIN',
  cancelled: 'CANCELLED',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** 全部状态的数组形式，便于遍历与校验。 */
export const ALL_JOB_STATUSES: readonly JobStatus[] = Object.values(JOB_STATUS);

/**
 * 终态集合（§9.2）：Worker 不得自动改变这些状态。
 *
 * FILTERED 是「规则判定为不同步」的正常终态，不是错误（§9.1）。
 */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  JOB_STATUS.success,
  JOB_STATUS.failed,
  JOB_STATUS.uncertain,
  JOB_STATUS.cancelled,
  JOB_STATUS.filtered,
];

/**
 * 人工操作的唯一出口（§9.2 / §9.3）：
 *
 *   UNCERTAIN → QUEUED    用户点击「确认未发布并允许重试」
 *   UNCERTAIN → SUCCESS   用户点击「确认已发布」，post_id 允许为空
 *
 * 另外图片处理失败时的人工降级（§12）与人工取消也在此登记。
 */
export const MANUAL_JOB_TRANSITIONS: readonly JobStatus[] = [
  JOB_STATUS.queued,
  JOB_STATUS.success,
  JOB_STATUS.cancelled,
];

/**
 * 合法转移表（§9.1 的状态流向 + §9.2/§9.3/§12 的异常分支）。
 *
 * 说明：
 *   - DISCOVERED → FILTERED / QUEUED：规则评估的两个结果。
 *   - QUEUED → PROCESSING：进入内容处理（文本模板 / AI 改写）。
 *   - PROCESSING → MEDIA_PROCESSING / PUBLISHING：有图走媒体链路，纯文本直接发布。
 *   - MEDIA_PROCESSING → PUBLISHING：拿到全部 imageUrl 后发布。
 *   - PUBLISHING → SUCCESS / FAILED / UNCERTAIN：发布的三种结局，其中
 *     UNCERTAIN 由超时 / 504 / 连接中断触发（§9.3），绝不自动重试。
 *   - 任意非终态 → CANCELLED：人工取消。
 *   - UNCERTAIN → QUEUED / SUCCESS：人工确认，见 MANUAL_JOB_TRANSITIONS。
 *   - FAILED → QUEUED：人工重试（§12 的「手动重试」入口）。
 *     注意这条不属于 Worker 自动行为，只能由后台人工触发。
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  [JOB_STATUS.discovered]: [JOB_STATUS.filtered, JOB_STATUS.queued],
  [JOB_STATUS.queued]: [JOB_STATUS.processing, JOB_STATUS.cancelled],
  [JOB_STATUS.processing]: [
    JOB_STATUS.mediaProcessing,
    JOB_STATUS.publishing,
    JOB_STATUS.failed,
    JOB_STATUS.cancelled,
  ],
  [JOB_STATUS.mediaProcessing]: [
    JOB_STATUS.publishing,
    JOB_STATUS.failed,
    JOB_STATUS.cancelled,
  ],
  [JOB_STATUS.publishing]: [
    JOB_STATUS.success,
    JOB_STATUS.failed,
    JOB_STATUS.uncertain,
  ],
  // 终态：Worker 视角下无出边。UNCERTAIN 与 FAILED 的人工出口单独由
  // MANUAL_JOB_TRANSITIONS 表达，需通过 transitionJob(..., { manual: true }) 显式声明。
  [JOB_STATUS.success]: [],
  [JOB_STATUS.filtered]: [],
  [JOB_STATUS.cancelled]: [],
  [JOB_STATUS.failed]: [],
  [JOB_STATUS.uncertain]: [],
};

/** 人工转移表，只在 transitionJob 传入 manual: true 时生效。 */
export const MANUAL_TRANSITION_TABLE: Readonly<
  Record<JobStatus, readonly JobStatus[]>
> = {
  ...JOB_TRANSITIONS,
  // §9.2：UNCERTAIN 的两个唯一人工出口
  [JOB_STATUS.uncertain]: [JOB_STATUS.queued, JOB_STATUS.success],
  // §12：失败任务的人工重试
  [JOB_STATUS.failed]: [JOB_STATUS.queued],
};

/** 判断状态是否为终态（§9.2）。 */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/**
 * 判断 from → to 是否为合法转移。
 *
 * @param manual 是否允许人工出口（UNCERTAIN → QUEUED/SUCCESS、FAILED → QUEUED）。
 *               Worker 内部一律传 false，防止自动逻辑绕过人工确认（§9.3）。
 */
export function canTransition(
  from: JobStatus,
  to: JobStatus,
  options: { manual?: boolean } = {},
): boolean {
  const table = options.manual === true ? MANUAL_TRANSITION_TABLE : JOB_TRANSITIONS;
  return table[from].includes(to);
}

/** 非法状态转移错误。 */
export class InvalidJobTransitionError extends Error {
  override readonly name = 'InvalidJobTransitionError';

  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
    readonly manual: boolean,
  ) {
    super(
      `非法的任务状态转移：${from} → ${to}` +
        (manual ? '（人工通道）' : '（自动通道）') +
        '。状态机约束见系统设计文档 §9.2。',
    );
  }
}

/**
 * 断言 from → to 合法，否则抛 InvalidJobTransitionError（§9.2）。
 *
 * 数据库写入前必须先过这一关：状态列的每一次 UPDATE 都应经由本函数校验，
 * 避免绕过状态机直接赋值。
 */
export function assertTransition(
  from: JobStatus,
  to: JobStatus,
  options: { manual?: boolean } = {},
): void {
  const manual = options.manual === true;
  if (!canTransition(from, to, { manual })) {
    throw new InvalidJobTransitionError(from, to, manual);
  }
}

/** 校验任意字符串是否为合法 JobStatus（用于解析数据库返回值）。 */
export function isJobStatus(value: unknown): value is JobStatus {
  return (
    typeof value === 'string' &&
    (ALL_JOB_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * 解析 JobStatus，失败抛错。
 *
 * 数据库列虽然是 enum，但跨进程传递（Redis 队列 payload、API 响应）时会退化为
 * 字符串，入口处必须重新校验。
 */
export function parseJobStatus(value: unknown): JobStatus {
  if (!isJobStatus(value)) {
    throw new TypeError(`非法的 JobStatus 值：${String(value)}`);
  }
  return value;
}

/**
 * 状态是否代表「发布请求已发出、结果未知」。
 *
 * 这是 §10.4 崩溃恢复的判断依据：publish-binance 处理器第一步永远先查状态，
 * 若已是 UNCERTAIN 或 SUCCESS 必须立即终止，不得重复调用 Binance。
 */
export function isPublishSettled(status: JobStatus): boolean {
  return status === JOB_STATUS.success || status === JOB_STATUS.uncertain;
}
