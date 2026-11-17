export interface StoredObject {
  key: string;
  modifiedAt: Date;
}

/**
 * 私有对象存储接口。生产实现为阿里云 OSS 私有桶（待接入，见验证矩阵）；本地为文件系统模拟。
 * 对象不对外公开：下载只通过带过期时间与签名的短时令牌，令牌由服务端在校验归属后签发。
 */
export interface FileStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** 不存在返回 null */
  get(key: string): Promise<Uint8Array | null>;
  /** 删除不存在的对象不报错 */
  delete(key: string): Promise<void>;
  list(): Promise<StoredObject[]>;
  /** 为 key 签发有效期 ttlSeconds 的令牌 */
  signToken(key: string, ttlSeconds: number): string;
  /** 令牌有效（未过期、签名正确）时返回 key，否则 null */
  verifyToken(token: string): string | null;
}
