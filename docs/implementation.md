# 实现约定与任务

上游意图与结构见 [design.md](design.md)。本页直接把已经确定的方案转成实现任务，不另扩写 Requirement。

## 执行约定

1. 接受的模型输出恰好有 `response: string`、`summary: string`、`recentChats: { user: string, assistant: string }[]`。整包验证失败不更新记忆。Summary 不强制章节或 YAML 模板。
2. 每个 Session 持有自己的记忆。新的正常轮次只带当前记忆和当前输入；轮内保留工具调用与结果。已覆盖的旧原文不再作为工作历史发送。
3. 正常轮次成功后从未覆盖的 Session surface 派生待审核 Working Memory 提案；完整 JSON 一旦校验成功，`response` 可立即显示。pending 或 recovery 存在期间新的 turn 必须被拒绝，并把 claimed next-step / next-turn 输入按原类别放回 inbox，避免退化到 raw-history 推理。
4. 用户审核、修改或清空并保存后，Host 以一个 replacement memory `user/message` 原子提交 reviewed Summary、最新 N 条 Recent Chats；成功 proposal 同时在该 message source 中保存对应 response。`commit/edit` 仅作为 Cordis runtime events 发出，不新增 Session event type，不参与恢复正确性。
5. JSON 失败、取消、error、max-tokens 等未形成可接受 Working Memory 的轮次进入 recovery。人工保存 recovery 时 replacement 覆盖完整未压缩 surface，然后才解除轮间屏障。
6. Host 不在 `session/event` 同步观察回调里 append；durable `turn/end` 只负责更新进程内分类/recovery 状态。
7. Client 为启用此能力的 Session 显示两个原生右侧页；运行和 settled-but-unclassified 窗口都缓冲内部 JSON，分类后投影 pending/committed response，不修改其他预设的行为。
8. 版本兼容声明区分 CI 类型/构建验证与真实 DSH 运行时联调。

## 项目形态

沿用 workspace-scope 的装配根与特性模块分离方式。预期完成结构：

```text
src/index.ts                 Host 装配根与预设隔离（已实现，待实包类型检查）
src/preset.ts                Agent-scope 最终 JSON 协议提示词
src/host/protocol.ts         JSON 校验、提示词、纯状态更新（已实现）
src/host/session.ts          轮次边界、恢复与 Session surface 记忆（已实现）
src/host/api.ts              Host 读写服务与 Session 寻址（已实现）
src/host/rpc.ts              Connection RPC read/save 端点（已实现）
src/prompts/final-response.json
src/types.ts                 Host/Client 共享的纯 wire 类型
src/client/index.tsx         Client 装配根
src/client/tabs.tsx          原生右侧 tab、入口按钮、原生回复 renderer 包装
src/client/transport.ts      Connection RPC Client
src/client/memory-panel.tsx  两个编辑页（已实现）
src/client/response.ts       pending/committed 回复提取与分类窗口缓冲
cordis.patch.yml             Host 行与最小 opt-in Agent 预设（协议能力可组合）
tsdown.config.ts             Host / preset ESM 与 DSH Client bundle
tsconfig.{host,client}.json  隔离 Host / Client 的 Cordis 声明合并
tests/
```

Client 适配只使用已核对的公开 Connection、Sidebar、Session、Chat slot 契约。回复 renderer 包装现有原生 assistant renderer，并复用原注册项的 locale 与 inject；普通回复仍由原生 renderer 处理。GitHub Actions 已用声明的 alpha.1 依赖通过测试、类型检查和构建；在用户实机完成真实 DSH 联调前继续保持 private。

## 任务状态

- [x] 核对上游 alpha.1 的预设、Agent 和 sidebar 接入点。
- [x] 内置 JSON 提示词；自由 Summary 与标准 Recent Chats 协议。
- [x] 完整输出校验、最新 N 条裁剪、手动编辑校验、revision 冲突检测。
- [x] 自动测试覆盖协议、从 surface 重建提案/recovery、原子 memory authority、`commit/edit` Cordis runtime 通知、pending/recovery 轮间屏障、steering/followup 原类别恢复与 wake marker、失败轮人工恢复、配置变更规范化、合法 replacement、跨面板审核草稿、预设隔离、稳定上下文边界、非正常 durable `turn/end` 与 Client 分类缓冲。
- [x] GitHub Actions 已安装声明的精确 DSH alpha.1 依赖，并通过 test / typecheck / build。
- [x] Host：pending/recovery 从已知 DSH Session 事件与 surface 重建；存在任一状态时阻止下一轮 raw-history 推理；人工接受/恢复后合法 surface 替换并唤醒原队列；支持重启恢复、revision 编辑冲突与失败历史覆盖。
- [x] Host：真正 idle 前不生成提案，避免 `turn-stopping` 后同轮 steering 被提前压缩。
- [x] Host 源码契约对照：自定义 user source、已知 Session event 持久化约束、replace 端点语义、durable `turn/end`、Inbox claim/restore、Connection RPC 和 Service 装配签名；不写入第三方 custom Session event。
- [x] Host 发布包类型检查与构建已由 CI 验证；真实运行核验仍待用户实机。
- [x] Client：两个可编辑审核面板、Recent Chats 严格编辑校验、pending/committed response 投影与 transport port。
- [x] Client 源码适配：两个原生 tab、RPC、人工审核/recovery 提示、运行期与 settled-but-unclassified 窗口隐藏内部 JSON envelope；普通 Session 保持原生 renderer。
- [x] Bundle：Host/preset/Client 构建入口、manifest、CI，以及不夹带 Coding Agent 配置的最小 opt-in preset。
- [x] Bundle 实包构建已由 CI 验证。
- [ ] 联调：含工具轮结束后先出现待审核提案；未审核提案不成为模型记忆；修改并接受后下一轮只带新记忆；重启恢复提案；无效 JSON/取消不覆盖旧状态；普通预设不受影响。

目前 CI 已能证明协议、轮次状态机以及 alpha.1 发布包上的类型/构建契约；仍不能替代真实 DSH 工具循环、持久化后端和 UI slot 的实机联调。
