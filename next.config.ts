import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 不用 output: "standalone"：镜像里 web 用 `next start`，worker/迁移需要完整依赖（见 Dockerfile）
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["pg-boss", "pg", "ali-oss", "@alicloud/dysmsapi20170525"],
};

export default nextConfig;
