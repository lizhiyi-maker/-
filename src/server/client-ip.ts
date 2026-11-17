/**
 * 从 X-Forwarded-For 取客户端 IP。头里靠左的项由客户端自填、可以伪造，
 * 只有可信反向代理追加在**右侧**的项可信，所以按"可信代理跳数"从右往左取。
 * 跳数为 0 表示没有可信代理，完全不使用该头（返回 null）。
 */
export function pickClientIp(xForwardedFor: string | null, trustedHops: number): string | null {
  if (trustedHops <= 0 || !xForwardedFor) return null;
  const entries = xForwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries[entries.length - trustedHops] ?? null;
}
