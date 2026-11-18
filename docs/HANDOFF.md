# 交接记录（新对话从这里开始）

> 更新于 2026-11-18，M5c 完成待用户提交时。新对话先读本文件，再读 `README.md`、`GLOSSARY.md`、`docs/verification-matrix.md`。

## 1. 进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| Stage 0 | 文档、术语表、ADR、评分规则 v0（实验）、`config/scoring/v0.json` | ✅ 已提交 8c9312c |
| M0 | 脚手架、pg-boss worker、embedded-postgres、环境校验、生产保护 | ✅ 1c43e49 |
| M1 | 手机号 OTP 登录、邀请码、对象档案、偏好、额度账本、管理后台 | ✅ 57eb50c |
| M2a | 聊天文本导入、消息模型、重叠检测、确认与纠错 | ✅ 33ecf68 |
| M2b | 截图上传、私有存储、模拟识别任务、识别额度、原图清理 | ✅ 63c6042 |
| M3a | AI 服务同意关卡、分析流水线、引用校验、快照与新鲜度、报告页、安全评测 | ✅ fecb120 |
| M3b | 线下事件、好感变化、时间线与复盘 | ✅ 80fd598 |
| M4 | 纯函数评分、对比/排名/待了解/趋势、报告适配分与趋势卡片 | ✅ 9f69c03 |
| M5a | 数据导出 + 账户删除全流程（隐私功能） | ✅ e3024d7 |
| M5b | 后台任务状态、成本、用户反馈 | ✅ 5db3266 |
| M5c | Dockerfile、部署与备案文档、手机端/微信验收清单、最终 AI 评测报告、剩余限制清单（规则保持 experimental） | ✅ 本次提交 |

**MVP 的开发范围到此全部完成。** 剩下的不是写功能，而是：真实服务适配器（AI/短信/OSS）、真实模型评测、合规核实与备案、真机验收——见 [docs/limitations.md](./limitations.md) 的 A 组（上线阻断）。下一步由用户决定先做哪一块。

M5c 取舍（用户确认）：评分规则保持 `experimental`；Dockerfile 一个镜像两个启动命令；代码只加“配置漂移守卫”单测（`ENV_KEYS` 导出自 `src/lib/env.ts`），**没有**加健康检查端点测试与评测覆盖对照检查。M5c 的新发现：生产模式 + 真实提供方变量下应用能启动、`/api/health` 200，但页面 500（适配器未实现）——健康检查不代表可用；移除了 `next.config.ts` 的 `output: "standalone"`（镜像用 `next start`，该配置会让 `next start` 报警告）。交付物：`Dockerfile`、`.dockerignore`、`docs/deploy/README.md`、`docs/deploy/icp-and-compliance.md`、`docs/acceptance/mobile-wechat-checklist.md`、`docs/evals/final-ai-eval-report.md`、`docs/limitations.md`。**Dockerfile 没有在真实 Docker 构建过；备案/合规内容全部“待核实”，不是法律意见。**

M5 拆分经用户确认（2026-11-18）：三块，每块完成后停下。M5a 的取舍（用户确认）：账户删除=立即停用+立即删除在线数据；导出=JSON + 每个对象的聊天文本；测试接缝=导出服务集成、聊天文本纯函数、账户删除服务集成、Playwright 三种视口。

M5b 验证结果：typecheck、lint、`next build` 通过；vitest 386 个测试（35 个文件，新增 36：成本纯函数 12、用量 9、任务状态 6、反馈 9）通过；Playwright 84 个通过（78 + 新增 6，1 个按设计跳过）；安全评测 9/9。变异检查 14 项（模拟成本当 null、公式错、平均含未知、按 UTC 分天、不记失败调用、未调用也记、任务不限窗口、卡住阈值、泄露用户 ID、无反馈限流、mine 不限用户、不写审计、不脱敏）全部使测试变红（其中“未调用也记”最初存活，补了“原图丢失不记用量”的用例后变红）。用户确认的取舍：成本=记录用量+配置单价估算；反馈=简单表单、用户主动附片段；任务页只读无内容；测试接缝=任务状态服务、成本记录/估算/汇总、反馈服务、e2e。

M5b 实现要点：迁移 `20261123000000_m5b_usage_feedback`（`ModelUsage`、`Feedback`）；模型接口新增可选 `simulated` 与调用上下文 `ctx.reportUsage`（真实适配器上报 token；流水线/识别服务计时并记录）；`src/domain/cost.ts` + `config/cost.json`（单价为空、`pricesVerified: false`）；`src/server/usage`、`src/server/feedback`；管理服务新增 `taskStatus`/`costSummary`/`listFeedback`/`handleFeedback`；后台新增 `/admin/tasks`、`/admin/costs`、`/admin/feedback`；用户端 `/me/feedback`；导出新增 `feedback`。已知限制：成本页逐行读取窗口内全部用量记录在内存汇总（内测规模可接受）；真实适配器接入时必须调用 `ctx.reportUsage`，否则成本显示“无法估算”；没有告警/通知（只有页面）。

M5a 验证结果：typecheck、lint、`next build` 通过；vitest 350 个测试（31 个文件，新增 27：导出服务 7、聊天文本 6、账户删除 14）通过；Playwright 78 个通过（72 + 新增 6，1 个按设计跳过）。变异检查 11 项（导出不限用户、泄露手机号哈希、导出暂存消息、只导最新修订、丢事件感受、删除不清会话、无末位管理员保护、不删文件、未开始就能完成、管理员可恢复删除中账户、删除中可登录）全部使测试变红。逐个对象走删除围栏的循环与账户行级联删除等价，无法被单独测试区分（纵深防御）。

M5a 实现要点：`UserStatus` 新增 `DELETING`（迁移 `20261122000000_m5a_account_deleting`）；`src/server/account/service.ts`（begin/complete/deleteAccount/sweepDeleting，worker 每 5 分钟清扫）；`src/server/export/service.ts` + `src/domain/export.ts`（聊天文本格式化纯函数）；路由 `/api/export`、`/api/export/people/[id]/chat`；“我的”页新增“我的数据”与“删除账户”卡片（需输入“删除我的账户”）；管理员页显示“删除中”且不能改状态。已知限制：导出整份在内存生成；删除账户没有再次验证（OTP 重新验证）——只需输入确认文字，如需更强的再确认要另行确认；e2e 没覆盖“同一手机号再次注册”（60 秒重发限制），由服务测试覆盖。

M3a 验证结果：typecheck、lint、`next build` 通过；vitest 230 个测试（22 个文件）通过；Playwright 66 个通过（1 个按设计跳过）；安全评测 9/9。变异检查（同意校验、写回前过期校验、失效退款、报告归属、精选封顶、拒绝须来自对方）都能让测试变红。

M3b 验证结果：typecheck、lint、`next build` 通过；vitest 270 个测试（24 个文件，新增 40 个：事件服务 17、时间线纯函数 7、分析接入 16）通过；Playwright 72 个通过（66 + 新增 6，1 个按设计跳过）；安全评测仍 9/9。变异检查：感受产生修订、忽略事件的过期判断、忽略事件的新资料判断、快照丢事件、放开未来日期、时间线忽略偏好版本，均使测试变红；“去掉事件更新的 userId 条件”不会变红（`lockLivePerson` 的归属校验是第二道防线，两层都在）。经用户确认的取舍：事件事实可编辑并留修订；个人感受不发送给 AI；测试接缝只做事件服务集成、分析服务集成、时间线纯函数 + e2e（**没有**为证据/流水线单独补单元测试，事件的证据行为经分析服务集成测试覆盖）。

## 2. 工作约定（用户要求，务必遵守）

1. **每个功能模块完成后停下**：汇报验证结果并更新 `docs/verification-matrix.md`，由用户查阅修订；用户说"你提交"时才由我提交 git。
2. **开工前用 AskUserQuestion 和用户确认 tdd 测试接缝**（每个接缝一句话说明能抓什么、抓不到什么），未确认的接缝不写测试。M1、M2a/b、M3a 都是这样做的。
3. 验证状态必须诚实区分：✅ 已验证 / 🧪 模拟验证 / ⏳ 需真实服务。真实 AI、短信、OSS 都**没有接入**，全部是模拟实现。
4. 硬约束：生产环境不得启用演示/绕过；日志不含完整聊天、验证码、密钥；真实密钥只走环境变量；不承诺无法验证的删除/留存行为；默认不用真实聊天训练；不展示成功概率或百分比置信度；聊天里的指令是资料不是规则；明确拒绝后停止追求类建议；不做心理诊断；"未知"是状态不是分数。
5. 写 Next.js 代码前先读 `node_modules/next/dist/docs/`（AGENTS.md 要求，本版本有破坏性变更）。

M4 验证结果：typecheck、lint、`next build` 通过；vitest 323 个测试（28 个文件，新增 53 个：评分 8、排名 17、趋势 10、对比服务集成 18）通过；Playwright 72 个通过（无新增正式用例，1 个按设计跳过）；安全评测 9/9。变异检查 14 项（缺失当 0 分、向下取整、偏好权重丢失、不查重要维度、不查已知下限、旧偏好报告入池、拒绝不排除、并列不共享名次、跨阶段混池、趋势阈值边界、趋势忽略偏好版本、趋势不限窗口、对比不限用户、报告适配分用默认权重）全部使测试变红。用户确认的取舍：沿用实验规则数值；未五维全已知时不展示任何聚合数；排名池“先剔除个体不合格者再求共同已知”；测试接缝只做评分/排名/趋势纯函数 + 对比服务集成。**未经确认没有写 e2e**：界面用一份未提交的临时 Playwright 脚本（直接写入已保存分析）在桌面 Chrome 与 iPhone WebKit 冒烟通过后已删除；如需正式 e2e，要先确认接缝（难点：mock 分析模型很难产出五维全已知，需直接写库造数据）。

## 3. M4 实现要点（已完成）

- `src/domain/scoring/`：`score.ts`（适配分，仅五维全“已知”才有）、`ranking.ts`（按阶段分池、准入、待了解、并列）、`trend.ts`（同口径窗口、口径变化）、`labels.ts`（文案）。数值全部读自 `config/scoring/v0.json`（`rules.ts` 的 schema 已扩展 total/ranking/trend；配置里的阶段键改为枚举值 `JUST_MET`/`GETTING_TO_KNOW`，数值与版本号不变）。
- `src/server/compare/service.ts`：`overview`（汇聚各对象最新成功分析、当前偏好、阶段、新鲜度、好感）与 `trend`；`analysis.getReport` 新增 `fit`/`importance`，`listSnapshots` 新增 `fit`。
- 界面：`/compare`（各阶段排名、待了解、暂未参与排名及原因、并列查看最多 3 个，手机一次两个）；报告页新增“适配分”卡片与“趋势”卡片；都标“实验规则”。
- 规则仍是 `experimental`；转 `active` 要等 M5 的最终评测和用户确认。口径细节见 `rules-v0-experimental.md` §6“实现口径”。
- 已新增项目技能 `.claude/skills/scoring-rules`。

### M4 遗留
1. 趋势取“窗口里最新与最早之差”（文档没说清是相邻还是首尾），选了首尾；如想改成相邻两份要改 `trend.ts` 与测试。
2. 配置里的 `stop_contact_requested` 没有独立数据来源，目前由 `explicit_refusal` 一个标记覆盖。
3. 对比页对每个对象逐个调用 `getReport`（N+1 查询），内测规模可接受，对象很多时需要合并查询。
4. 报告里的适配分按当前配置的规则计算；将来出现第二个规则版本时，旧快照需要按各自版本的规则计分（现在只有一个版本）。

## 3a. M3b 实现要点（已完成，已提交）

- **线下事件**（`OfflineEvent` + `OfflineEventRevision`，迁移 `20261121000000_m3b_offline_events`）：类型（见面/通话/取消安排/补充事实）、日期（不晚于北京时间今天）、事实（≤500 字，进修订）、个人感受（≤1000 字，只在事件行上，可随时改、不产生修订）。服务 `src/server/events/service.ts`，页面在对象详情“关系记录”页签，入口页 `/records` 列出对象。
- **接入分析**：证据引用是 `MessageRef | EventRef`（M3a 旧报告只有消息引用，保持兼容）；模型代号 `E1…`；事件单独成段；事件只发事实；快照新增 `Analysis.eventRefs/eventCount`；新鲜度把事件算进“有新资料”和“资料纠正已过期”（只改感受不算）；分析期间事件被改/删 → 作废退款。详见 `analysis-spec.md` §2a。
- **时间线**（`src/domain/timeline.ts` 纯函数）：事件 + 好感变化（“从→到”）+ 分析快照，最新在前；快照相对上一份规则/偏好版本不同标“口径变化”。
- 同意文案补了一句“个人感受不会发送”，**没有**升 `CONSENT_VERSION`（只收窄不扩大）。
- 已同步：GLOSSARY（线下事件、个人感受、时间线）、analysis-spec、state-machines、rules-v0-experimental、quota、verification-matrix、README、`relationship-analysis` 技能。

### M3b 用户决定与遗留
1. **用户记录的“当面被拒绝”**（用户 2026-11-18 决定：**暂不设专门入口**，保持现状，作为已知限制）：目前“明确拒绝”只认对方的聊天消息（M3a 的既有不变量，防止用户自述被当作对方的拒绝）。如果用户只把拒绝记成线下事件而聊天里没有，报告不会停止推进类建议。若以后要增加入口（例如事件类型“对方明确拒绝”，由用户确认），属安全取舍，须先和用户确认。
2. 只有事件、没有聊天资料时不能开始分析（事件是补充资料）。如需放开要重新评估证据封顶。
3. 旧分析快照目前只在时间线显示结论摘要，不能展开成完整报告；是否需要“查看当时的报告”留给用户定。

## 4. 之后

（M4 已完成，下面的 M4 条目留作规则出处。）

- **M4**：纯函数评分（等级→分值、按偏好权重、仅五维全"已知"才显示适配分）、排名准入（阶段、共同已知维度 ≥4 且含所有重要程度 5 的维度）、同分并列、待了解、趋势（同规则+同偏好版本、≥2 份、差 ≥8 分）、口径变化标注。规则见 `docs/scoring/rules-v0-experimental.md`，数值只以 `config/scoring/v0.json` 为准。规则启用前须经用户确认 D1–D4。
- **M5**：手机端/微信验收清单（真机留给用户）、导出、账户删除全流程、后台成本/反馈/审计、Dockerfile 与部署/备案文档、最终 AI 评测报告、剩余限制清单。
- 还没写的项目专用 Skill：AI 接入与评测、部署与数据管理（`chat-import`、`relationship-analysis`、`scoring-rules` 已有，在 `.claude/skills/`）。

## 5. 已知风险与遗留（M3a、M3b 汇报过）

- 真实 AI 服务商未接入：`AI_PROVIDER=bailian` 会抛"尚未实现"；分析与识别都是规则型模拟，评测只验证框架、校验器、程序核验，不代表真实模型质量。
- 同意文案写明服务商留存条件"尚未核实"，核实前不得改写成承诺。
- worker 在写回结果与额度结算之间崩溃时，依赖 15 分钟清理任务退还额度。
- 写回时的资源代际校验是纵深防御，目前无法被测试单独触发。
- 回复间隔函数存在但分析暂未使用；具体分数在 M4 才显示。
- M1 评审留下的 13 条"判断类"代码气味有意保持不变。
- e2e 偶发 warmup 登录页反复重载：M3b 实测改了 Prisma 模式后出现，**删除 `.next/dev` 后恢复**（缓存不一致的假设得到支持，但根因仍未查明）；warmup 已设重试 1 次，不足以自愈时手动删缓存。
- 修改事件表单时页面上同时有“新增”和“修改”两个表单：输入 id 必须唯一（已用 `useId`），e2e 里按表单容器取输入。

## 6. 环境提示

- 本机无 Docker/PostgreSQL/pnpm，用 `embedded-postgres`（开发库端口 54329，e2e 库端口 54331，e2e 的 next dev 在 :3100）+ npm。
- **命令必须在大写盘符路径运行**（`C:/Ai_coding/relationship`）；中文 Windows 的 initdb 需 `--locale=C`（已处理）。
- Prisma 7：迁移用 `prisma migrate diff --from-schema <旧> --to-schema <新> --script` 生成；客户端生成到 `src/generated/prisma`。
- 坑：服务端代码不要写带字面量路径的 `resolve(".x")`（会让 Turbopack 监视整个项目并无限重载）；边缘层用 `isDomainError` 而不是 `instanceof`；e2e 的 DB/上传/产物放临时目录。
- 常用命令见 `README.md`（`npm test`、`npm run typecheck`、`npm run lint`、`npm run eval:analysis`、Playwright e2e）。
