/**
 * @x-square/binance-client —— Binance Square OpenAPI 客户端（§4、§11）。
 *
 * 只封装三个官方端点；密钥只在内存流转，加解密与掩码展示归上层服务（§11.6）。
 */

export * from './errors.js';
export * from './http.js';
export * from './api.js';
