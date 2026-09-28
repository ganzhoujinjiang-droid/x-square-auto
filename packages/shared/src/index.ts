/**
 * @x-square/shared —— 跨包共享的常量、错误码、状态机与工具。
 *
 * 本包不依赖任何业务包，也不引入运行时第三方依赖（只用 node:crypto），
 * 因此可以被 x-client / binance-client / database / queue / schemas / api / worker 全量引用。
 */

export * from './constants.js';
export * from './job-status.js';
export * from './errors.js';
export * from './snowflake.js';
export * from './post-type.js';
export * from './utils.js';
