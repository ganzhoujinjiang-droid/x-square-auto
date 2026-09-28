/**
 * 共享的 Zod 原语（§4：所有外部输入/输出强制 schema 校验）。
 */

import { z } from 'zod';

/**
 * Snowflake ID：纯数字字符串（§21.3）。
 *
 * 必须用字符串而非 z.number()——Tweet ID 是 64 位，超过 2^53 会静默丢精度。
 */
export const snowflakeSchema = z
  .string()
  .regex(/^\d+$/, 'Snowflake 必须是纯数字字符串');

/** 可选的 Snowflake（用于 since_id 尚未设置的场景）。 */
export const optionalSnowflakeSchema = snowflakeSchema.nullish();

/**
 * ISO 8601 时间戳字符串。
 *
 * §20.4：X API 返回 UTC；应用层一律 UTC。这里只校验格式，转换由调用方负责。
 */
export const isoDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/,
    '必须是 ISO 8601 时间戳',
  );

/** 解析为 Date 的时间戳。 */
export const dateSchema = z.coerce.date();

/** cuid 主键（Prisma @default(cuid()) 的产物）。 */
export const cuidSchema = z.string().min(1).startsWith('c');

/**
 * 限定 http/https 协议的 URL。
 *
 * ⚠️ 不要用 z.string().url() 处理「本系统会去请求的地址」：Zod 的 .url() 只校验
 * URL 语法，ftp:// file:// data:// 等协议一律放行。而这些地址会被 download-media
 * 直接抓取（§12），或被作为 imageList 发往 Binance（§11.1）——接受任意协议
 * 等于把协议选择权交给了外部响应。
 *
 * 适用场景：X 媒体直链、Binance 预签名 URL、Binance imageUrl / shareLink。
 */
export const httpUrlSchema = z
  .string()
  .url('必须是合法的 URL')
  .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
    message: 'URL 协议必须是 http 或 https',
  });

/** 非空字符串，去除首尾空白后校验。 */
export const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * 外部 API 响应统一使用 strictObject。
 *
 * 理由（§10.2）：Zod 校验失败被归类为「响应结构不符预期（可能是接口变更）」，
 * 属不可重试错误、需人工介入。因此对 X / Binance 的响应采取严格校验，
 * 出现未登记字段时立即暴露，而不是静默忽略。
 *
 * ⚠️ 维护提示：本系统对 X 的每个请求都显式枚举了 tweet.fields / media.fields（§6.1），
 * 因此正常情况下不会出现意外字段。若平台新增了字段导致校验失败，
 * 应先在 schema 中登记该字段，而不是把 strictObject 改成 object()。
 */
export const strictObject = z.strictObject;

/** 掩码形式的密钥（§11.6：abc12...xyz9）。用于校验 API 响应不含完整密钥。 */
export const maskedSecretSchema = z
  .string()
  .regex(/^[^.\s]{1,8}\.\.\.[^.\s]{1,8}$/, '必须是掩码形式的密钥');

/** 布尔型设置项的宽容解析：接受 true/false 与 "true"/"false"。 */
export const looseBooleanSchema = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
]);
