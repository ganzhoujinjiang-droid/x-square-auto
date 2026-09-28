/**
 * @x-square/x-client —— X API v2 只读客户端 + OAuth 2.0 PKCE（§4、§6、§7）。
 *
 * 边界（§1.1）：本包只能读 X，绝不包含任何写入 X 的接口。
 * Token 只在内存中流转；加解密归 crypto 包与上层服务，本包不碰数据库。
 */

export * from './errors.js';
export * from './http.js';
export * from './oauth.js';
export * from './timeline.js';
