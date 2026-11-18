/** 同意文案的版本。文案有实质修改时加 1，已同意的用户需要重新同意。 */
export const CONSENT_VERSION = 1;

export interface ProviderInfo {
  /** 写入同意记录；服务商变化时需要重新同意 */
  id: string;
  label: string;
  /** 是否真的会把内容发送给第三方 */
  external: boolean;
}

export function providerInfo(aiProvider: string): ProviderInfo {
  if (aiProvider === "bailian") return { id: "bailian", label: "阿里云百炼（通义千问）", external: true };
  return { id: "mock", label: "演示模式的模拟模型（不会发送给任何第三方）", external: false };
}

export interface ConsentSection {
  heading: string;
  body: string;
}

/**
 * “AI 服务说明”的文案：发给谁、发送什么、用途，并如实说明留存条件尚未核实。
 * 不承诺无法验证的行为（例如服务商侧的删除）。依据：docs/business/privacy-retention.md。
 */
export function consentSections(provider: ProviderInfo): ConsentSection[] {
  return [
    { heading: "发送给谁", body: provider.external ? `你的内容会发送给第三方 AI 服务商：${provider.label}，由它完成识别或分析。` : `当前是演示模式，使用${provider.label}。正式上线后会发送给第三方 AI 服务商。` },
    {
      heading: "发送什么",
      body: "截图识别：你上传的聊天截图图片。关系分析：你已保存的聊天文字（包含对方的发言）、你补充的线下事件的事实部分（日期、类型、经过），以及你的个人偏好。你在事件里写下的个人感受不会发送。不会发送你的手机号和账号信息。",
    },
    { heading: "用途", body: "只用于为你生成识别结果和分析报告。本产品默认不使用你的真实聊天来训练或评测产品。" },
    {
      heading: "服务商留存（待核实）",
      body: "我们尚未核实该服务商对传入内容的保存期限与条件，因此不对服务商那一侧的留存或删除作任何承诺。你在本产品里删除资料，只能保证我们自己系统内的数据按规则处理。",
    },
    { heading: "聊天里的他人信息", body: "聊天内容包含对方的个人信息。请只上传你有权使用的资料，并避免上传涉及隐私的敏感内容。" },
    { heading: "你的选择", body: "不同意则无法使用截图识别和关系分析；对象档案、粘贴文本导入等其他功能不受影响。同意会按版本记录。" },
  ];
}
