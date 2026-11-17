/** 服务层共用的、可直接展示给用户的领域错误。 */
export class NotFoundError extends Error {
  constructor(what = "资源") {
    super(`${what}不存在`);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * 按名称判断领域错误。Next 会把页面、路由处理器、Server Action 分别打包，每份可能带有自己的本模块副本，
 * 而服务容器是进程内单例——此时 `instanceof` 会失败。因此边缘层（app/ 下）一律用本函数，不用 instanceof。
 */
export function isDomainError(e: unknown, ...names: string[]): e is Error {
  return e instanceof Error && names.includes(e.name);
}

export const isNotFound = (e: unknown) => isDomainError(e, "NotFoundError");
