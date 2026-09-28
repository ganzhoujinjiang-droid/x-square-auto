/**
 * Snowflake ID 处理（§21.3）。
 *
 * X 的 Tweet ID 是 64 位 Snowflake，超出 JavaScript Number.MAX_SAFE_INTEGER（2^53）。
 * 本项目统一用字符串存储 + 转 BigInt 比较，并在 schema 层校验格式为纯数字。
 */

/** 纯数字字符串校验，Snowflake 不含负号与小数点。 */
const SNOWFLAKE_PATTERN = /^\d+$/;

/** 判断字符串是否为合法 Snowflake 格式。 */
export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

/**
 * 解析 Snowflake，格式非法时抛错。
 *
 * 不要使用 Number()：超过 2^53 会静默丢失精度，导致 since_id 判断错误、
 * 进而漏帖或重复入库。
 */
export function parseSnowflake(value: string): bigint {
  if (!isSnowflake(value)) {
    throw new TypeError(`非法的 Snowflake 格式：${value}`);
  }
  return BigInt(value);
}

/** 安全解析，失败返回 null（用于处理可能为空的外部输入）。 */
export function tryParseSnowflake(value: unknown): bigint | null {
  return isSnowflake(value) ? BigInt(value) : null;
}

/** 比较两个 Snowflake：a > b 返回 1，相等 0，a < b 返回 -1。 */
export function compareSnowflake(a: string, b: string): -1 | 0 | 1 {
  const left = parseSnowflake(a);
  const right = parseSnowflake(b);
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

/** a 是否严格大于 b（用于 since_id 判定）。 */
export function isSnowflakeGreaterThan(a: string, b: string): boolean {
  return compareSnowflake(a, b) === 1;
}

/**
 * 取一组 Snowflake 中的最大值。
 *
 * §6.4 的关键约束：不能按数组顺序取最后一个。X API 默认按时间倒序返回，
 * 但分页、回溯导入等场景下顺序不可依赖，必须显式比较数值。
 *
 * @returns 最大值字符串；输入为空数组时返回 null
 */
export function maxSnowflake(values: readonly string[]): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (!isSnowflake(value)) {
      throw new TypeError(`非法的 Snowflake 格式：${value}`);
    }
    if (max === null || compareSnowflake(value, max) === 1) {
      max = value;
    }
  }
  return max;
}

/** 取一组 Snowflake 中的最小值。 */
export function minSnowflake(values: readonly string[]): string | null {
  let min: string | null = null;
  for (const value of values) {
    if (!isSnowflake(value)) {
      throw new TypeError(`非法的 Snowflake 格式：${value}`);
    }
    if (min === null || compareSnowflake(value, min) === -1) {
      min = value;
    }
  }
  return min;
}

/**
 * 按 Snowflake 升序排序（旧 → 新），返回新数组，不修改入参。
 *
 * §6.4 要求按 created_at 升序处理以保证发布顺序；由于 Snowflake 时间有序递增，
 * 按 ID 升序等价于按时间升序，且不依赖响应中的 created_at 字段。
 */
export function sortSnowflakeAsc(values: readonly string[]): string[] {
  return [...values].sort(compareSnowflake);
}

/**
 * 从 Snowflake 反解时间戳（毫秒）。
 *
 * X 的 Snowflake 纪元为 1288834974657（2010-11-04T01:42:54.657Z）。
 * 仅用于日志与排错，不参与业务判定——业务时间一律取 created_at。
 */
const SNOWFLAKE_EPOCH_MS = 1288834974657n;

export function snowflakeToTimestampMs(snowflake: string): number {
  const id = parseSnowflake(snowflake);
  return Number((id >> 22n) + SNOWFLAKE_EPOCH_MS);
}
