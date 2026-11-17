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
