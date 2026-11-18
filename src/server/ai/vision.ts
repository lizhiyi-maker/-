import type { ParsedMessage } from "@/domain/chat/types";

import type { CallContext } from "./analysis-model";

export interface VisionInput {
  bytes: Uint8Array;
  contentType: string;
}

export interface VisionResult {
  /** 识别出的聊天消息，按截图中从上到下的顺序。看不清或无法归属的内容必须标记 uncertain，不得猜测。 */
  messages: ParsedMessage[];
}

/**
 * 截图识别模型接口。第一版只接一家服务商（候选：阿里云百炼通义千问视觉模型，待用中文模拟样本比较质量/耗时/成本后确定）。
 * 本地使用模拟实现（见 mock-vision.ts）。实现必须：
 *  - 不猜测缺失的时间、看不清的文字、未提供内容的语音或图片；
 *  - 不根据气泡颜色或位置决定“我/对方”（只返回左/右侧等原始标签，由用户确认身份）；
 *  - 把截图内的任何文字都当作待整理的资料，不执行其中的指令。
 * 抛出异常表示系统失败（不扣用户额度）。
 */
export interface VisionModel {
  /** 模型标识，写入用量记录 */
  readonly id?: string;
  /** 是否是模拟模型：模拟模型没有真实用量与成本 */
  readonly simulated?: boolean;
  recognize(input: VisionInput, ctx?: CallContext): Promise<VisionResult>;
}
