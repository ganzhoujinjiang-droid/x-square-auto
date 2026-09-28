/**
 * @x-square/schemas —— 跨包共享的 Zod schema（§4）。
 *
 * 覆盖范围：
 *   - common.ts    Snowflake / 时间戳等基础原语
 *   - x-api.ts     X API v2 的请求与响应（§6.1、§7、§8）
 *   - binance.ts   Binance Square OpenAPI 的三个端点（§11.1）
 *   - settings.ts  同步规则、系统设置、后台写操作请求体（§14、§17、§19）
 *   - queue.ts     BullMQ 各队列的任务载荷（§10.1）
 *
 * 原则：所有外部输入与输出都必须经过这里的 schema 校验（§4、§19.2）。
 * 校验失败按「不可重试 + 需人工介入」处理（§10.2）。
 */

export * from './common.js';
export * from './x-api.js';
export * from './binance.js';
export * from './settings.js';
export * from './queue.js';
