import { DIMENSION_KEYS } from "@/domain/analysis/rules";
import { EVENT_KIND_LABEL } from "@/domain/events";
import type { AnalysisModel, ExtractInput, Fact, InterpretInput, ModelEvent, ModelMessage } from "./analysis-model";

/**
 * 规则型“模拟分析模型”：只用于本地演示与自动化测试，**不代表任何真实模型的质量**。
 * 它按关键词规则从聊天里提取事实，并刻意保守——礼貌用语、消息条数、回复快慢都不当作意愿证据。
 * 它自称的维度状态故意不做充分度核验（交给程序核验），以便测试“不采信模型自称”。
 */
export const MOCK_ANALYSIS_MODEL_ID = "mock-rule-analysis-v0";
export const MOCK_PROMPT_VERSION = "analysis-prompt-v0-mock";

const POLITE = /^(谢谢|多谢|感谢|好的|好哒|好|嗯|嗯嗯|哈哈|哈哈哈|早|早安|晚安|你好|辛苦了|不客气|哦|ok|OK|收到)[！!。.~～\s]*$/;
const QUESTION = /[?？]|吗|呢|什么|怎么|哪里|哪个|多久|几点/;
const ARRANGE = /(见面|约|一起|吃饭|吃个饭|周[一二三四五六日末]|明天|今晚|后天|下周|这周|周末)/;
const AGREE = /(好呀|好啊|可以|没问题|行|OK|ok|见|到了|我到了|已经到)/;
const CANCEL = /(取消|去不了|来不了|不能来|临时有事|有急事)/;
const RESCHEDULE = /(改期|改天|下次|另约|换个时间|改到|重新约)/;
const REFUSAL = /(别再联系|不要再联系|请不要联系|不想再联系|不要再找我|别再找我|拉黑)/;
const PACE = /(慢慢来|不着急|不急|太快了|想快点|快点确定)/;
const BOUNDARY = /(不方便|不太想聊|不想聊|不想说|不想谈)/;
const INJECTION = /(忽略(以上|之前|前面|上面)?(所有|全部)?(规则|指令|提示|设定)|ignore (all|any|the)?\s*(previous|above)|给(这个人|她|他|对方)?打满分|system prompt|你现在是)/i;

/** 事实太多时按时间均匀抽取代表（输出有条数上限；均匀抽取也保留跨日期的覆盖）。 */
function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]);
}

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

export function extractFactsByRules(messages: ModelMessage[]): Fact[] {
  const facts: Fact[] = [];
  const lookAhead = (i: number, n: number) => messages.slice(i + 1, i + 1 + n);

  messages.forEach((m, i) => {
    if (m.type === "SYSTEM") return;
    // 聊天里的指令只是待分析的资料：记录并忽略，不执行
    if (INJECTION.test(m.content)) {
      facts.push({
        dimension: "none",
        text: "这条消息里有疑似指令的文字，已按普通聊天内容处理，没有执行，也没有用它评价任何维度。",
        refs: [m.code],
        polarity: "neutral",
        signal: "injection_ignored",
      });
      return;
    }
    // 没有提供内容的语音、图片：不猜测
    if (m.type !== "TEXT") return;

    if (m.speaker === "OTHER" && REFUSAL.test(m.content)) {
      facts.push({ dimension: "communication_boundaries", text: `对方明确表示不希望继续联系：“${short(m.content)}”`, refs: [m.code], polarity: "counter", signal: "explicit_refusal" });
      return;
    }
    if (POLITE.test(m.content.trim())) return; // 礼貌用语不当作意愿证据

    if (m.speaker === "OTHER" && QUESTION.test(m.content)) {
      facts.push({ dimension: "willingness_to_know", text: `对方向你提问：“${short(m.content)}”`, refs: [m.code], polarity: "support" });
      facts.push({ dimension: "mutual_investment", text: `对方主动抛出话题或追问：“${short(m.content)}”`, refs: [m.code], polarity: "support" });
    }

    if (CANCEL.test(m.content)) {
      const follow = lookAhead(i, 3).find((x) => x.speaker === m.speaker && RESCHEDULE.test(x.content));
      if (follow) {
        facts.push({ dimension: "follow_through", text: "有人临时取消，同时主动提出改期（不记为兑现失败）。", refs: [m.code, follow.code], polarity: "neutral", signal: "cancel_with_reschedule" });
      } else {
        facts.push({ dimension: "follow_through", text: `出现了临时取消：“${short(m.content)}”。仅凭一次取消不能判断兑现能力。`, refs: [m.code], polarity: "neutral", signal: "temporary_cancel" });
      }
    } else if (ARRANGE.test(m.content)) {
      const answer = lookAhead(i, 4).find((x) => x.speaker !== m.speaker && x.speaker !== "UNKNOWN" && AGREE.test(x.content));
      if (answer && m.speaker !== "UNKNOWN") {
        facts.push({ dimension: "follow_through", text: "有人提出了具体的安排，另一方接受了。", refs: [m.code, answer.code], polarity: "support" });
      }
    } else if (/(我到了|已经到了|到楼下)/.test(m.content)) {
      facts.push({ dimension: "follow_through", text: `按约定到达：“${short(m.content)}”`, refs: [m.code], polarity: "support" });
    }

    if (PACE.test(m.content)) {
      facts.push({ dimension: "pace_alignment", text: `有人谈到了相处节奏：“${short(m.content)}”`, refs: [m.code], polarity: "neutral" });
    }
    if (BOUNDARY.test(m.content)) {
      facts.push({ dimension: "communication_boundaries", text: `有人表达了自己的边界：“${short(m.content)}”`, refs: [m.code], polarity: "neutral" });
    }
  });
  return facts;
}

/**
 * 线下事件：只读事实。见面算作“行动兑现”的一次支持（约定的见面确实发生了），取消只记为一次临时取消（不判断兑现能力）；
 * 通话与补充事实只作为背景记录，不归入任何维度——模拟模型读不懂它们的含义，宁可不下判断。
 * 事件是用户自己的记录，这里不会从中认定“对方明确拒绝”。
 */
export function extractEventFactsByRules(events: ModelEvent[]): Fact[] {
  const facts: Fact[] = [];
  for (const ev of events) {
    const day = ev.occurredOn.toISOString().slice(0, 10);
    if (INJECTION.test(ev.content)) {
      facts.push({ dimension: "none", text: "这条事件记录里有疑似指令的文字，已按普通记录处理，没有执行，也没有用它评价任何维度。", refs: [ev.code], polarity: "neutral", signal: "injection_ignored" });
    } else if (ev.kind === "MEET") {
      facts.push({ dimension: "follow_through", text: `${day} 有一次见面（你的记录）：“${short(ev.content)}”`, refs: [ev.code], polarity: "support" });
    } else if (ev.kind === "CANCELLED") {
      facts.push({ dimension: "follow_through", text: `${day} 有一次安排被取消（你的记录）：“${short(ev.content)}”。仅凭一次取消不能判断兑现能力。`, refs: [ev.code], polarity: "neutral", signal: "temporary_cancel" });
    } else {
      facts.push({ dimension: "none", text: `${day} 的${EVENT_KIND_LABEL[ev.kind]}记录（你的记录）：“${short(ev.content)}”。只作为背景，不据此评价任何维度。`, refs: [ev.code], polarity: "neutral" });
    }
  }
  return facts;
}

const MISSING: Record<string, string> = {
  mutual_investment: "只看到零散的互动，无法判断双方主动与回应是否对等",
  willingness_to_know: "资料里对方了解你的表现很少",
  follow_through: "资料里没有讨论过具体的见面或安排，无法评价兑现情况",
  communication_boundaries: "没有出现需要表达边界或处理分歧的场景，不能据此判断沟通方式",
  pace_alignment: "资料里没有谈到各自期待的节奏",
};

const INTERPRETATION: Record<string, string> = {
  mutual_investment: "这些互动可能说明双方都在投入，但也可能只是日常交流；证据有限时不宜下结论。",
  willingness_to_know: "对方的提问可能是想了解你，也可能是礼貌性的寒暄。",
  follow_through: "已有的安排与到达情况可能反映执行意愿，但样本很少。",
  communication_boundaries: "边界表达需要结合上下文理解，这里只记录对方说了什么。",
  pace_alignment: "关于节奏的只言片语还不足以判断双方是否同步。",
};

function levelFor(supports: number, counters: number): string {
  if (supports + counters === 0) return "fair";
  const ratio = supports / (supports + counters);
  if (counters === 0) return supports >= 5 ? "very_good" : "good";
  if (ratio >= 0.8) return "good";
  if (ratio >= 0.5) return "fair";
  if (ratio >= 0.3) return "weak";
  return "very_weak";
}

export function interpretByRules(input: InterpretInput): unknown {
  const byDim = new Map<string, Fact[]>();
  for (const f of input.facts) if (f.dimension !== "none") byDim.set(f.dimension, [...(byDim.get(f.dimension) ?? []), f]);
  const refusal = input.facts.find((f) => f.signal === "explicit_refusal");
  const refusalRefs = [...new Set(input.facts.filter((f) => f.signal === "explicit_refusal").flatMap((f) => f.refs))];

  const dimensions = Object.fromEntries(
    DIMENSION_KEYS.map((key) => {
      const facts = byDim.get(key) ?? [];
      const supports = facts.filter((f) => f.polarity === "support");
      const counters = facts.filter((f) => f.polarity === "counter");
      // 刻意自称：3 条事实就说“已知”。程序会按证据单元与情境重新核验。
      const claimed = facts.length >= 3 ? "known" : facts.length >= 1 ? "clue" : "insufficient";
      return [
        key,
        {
          status: claimed,
          level: claimed === "known" ? levelFor(supports.length, counters.length) : undefined,
          observedFacts: sample(facts, 8).map((f) => ({ text: f.text, refs: f.refs })),
          interpretations: facts.length > 0 ? [{ text: INTERPRETATION[key] }] : [],
          supporting: sample(supports, 8).map((f) => ({ text: f.text, refs: f.refs })),
          counter: sample(counters, 8).map((f) => ({ text: f.text, refs: f.refs })),
          missing: claimed === "known" ? [] : [MISSING[key]],
          userExperience: key === "willingness_to_know" && input.userContext.feelingsNote ? [`你的记录：${short(input.userContext.feelingsNote)}`] : [],
        },
      ];
    }),
  );

  const kinds = input.scope.batchKinds;
  const scope = `基于 ${input.scope.messageCount} 条消息（连续聊天 ${kinds.CONTINUOUS} 批，精选片段 ${kinds.CURATED} 批，不确定 ${kinds.UNCERTAIN} 批）${input.scope.eventCount > 0 ? `和 ${input.scope.eventCount} 个线下事件` : ""}。`;
  const summary = refusal
    ? `${scope}对方明确表示不希望继续联系，请尊重对方的意愿。`
    : `${scope}这是对已有资料的整理，不是对对方的评价；证据不足的维度只作为线索或标为资料不足。`;

  const anyRef = (key: string) => (byDim.get(key) ?? []).flatMap((f) => f.refs).slice(0, 2);
  const suggestions: unknown[] = [];
  if (refusal) {
    suggestions.push({
      kind: "RESPECT_BOUNDARY",
      text: "尊重对方的意愿，不再主动联系；如果心里不好受，可以和信任的朋友聊聊。",
      basis: "对方明确表示不希望继续联系",
      purpose: "尊重边界，避免造成困扰",
      unknowns: [],
      refs: refusalRefs.slice(0, 3),
    });
  } else {
    const ft = byDim.get("follow_through") ?? [];
    if (ft.some((f) => f.polarity === "support")) {
      suggestions.push({ kind: "MAINTAIN", text: "按已经约好的节奏继续相处，守住约定。", basis: "资料里有被接受并履行的安排", purpose: "让关系在双方都舒服的节奏下延续", unknowns: ["对方是否期待更频繁的联系"], refs: anyRef("follow_through") });
    }
    if ((byDim.get("willingness_to_know") ?? []).length > 0) {
      suggestions.push({ kind: "CLARIFY", text: "挑一个轻松的话题，多了解对方的兴趣和近况。", basis: "对方有过提问，但样本较少", purpose: "补充了解，减少猜测", unknowns: ["对方是否愿意进一步见面"], refs: anyRef("willingness_to_know") });
    }
    if (ft.length === 0) {
      suggestions.push({ kind: "CLARIFY", text: "如果你愿意，可以试着提一个低压力的见面或活动想法，看看对方的反应。", basis: "资料里还没有讨论过具体安排", purpose: "了解行动意愿这一未知项", unknowns: ["对方的时间和意愿"], refs: [] });
    }
  }

  return {
    conclusion: { summary },
    dimensions,
    explicitRefusal: { detected: Boolean(refusal), refs: refusalRefs.slice(0, 5) },
    suggestions: suggestions.slice(0, 3),
  };
}

export function createMockAnalysisModel(): AnalysisModel {
  return {
    id: MOCK_ANALYSIS_MODEL_ID,
    promptVersion: MOCK_PROMPT_VERSION,
    async extractFacts(input: ExtractInput) {
      return { facts: [...extractFactsByRules(input.messages), ...extractEventFactsByRules(input.events)] };
    },
    async interpret(input: InterpretInput) {
      return interpretByRules(input);
    },
  };
}

