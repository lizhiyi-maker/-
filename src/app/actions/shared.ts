import "server-only";
import { AuthError } from "@/server/auth/service";
import { ForbiddenError } from "@/server/admin/service";
import { NotFoundError, ValidationError } from "@/server/errors";
import { QuotaError } from "@/server/quota/ledger";

export interface FormState {
  error?: string;
  ok?: boolean;
}

/** 把领域错误转成可展示的中文消息；未知错误只返回通用提示，不泄露细节。 */
export function toMessage(e: unknown): string {
  if (
    e instanceof AuthError ||
    e instanceof ValidationError ||
    e instanceof NotFoundError ||
    e instanceof ForbiddenError ||
    e instanceof QuotaError
  ) {
    return e.message;
  }
  console.error("[action]", e instanceof Error ? e.name : "unknown");
  return "操作失败，请稍后重试";
}

export const str = (fd: FormData, key: string): string => String(fd.get(key) ?? "");

export const triBool = (fd: FormData, key: string): boolean | null => {
  const v = str(fd, key);
  return v === "yes" ? true : v === "no" ? false : null;
};

export const orNull = (fd: FormData, key: string): string | null => str(fd, key).trim() || null;
