# 实现约定与任务

上游意图与结构见 [design.md](design.md)。本页直接把已经确定的方案转成实现任务，不另扩写 Requirement。

## 执行约定

1. 接受的模型输出恰好有 `response: string`、`summary: string`、`recentChats: { user: string, assistant: string }[]`。整包验证失败不更新记忆。Summary 不强制章节或 YAML 模板。
2. 每个 Session 持有自己的记忆。新的正常轮次只带当前记忆和当前输入；轮内保留工具调用与结果。已覆盖的旧原文不再作为工作历史发送。
3. 正常轮次成功后 Summary 吸收本轮，Recent Chats 保留最新 N 条。用户编辑保存后应成为下一轮的实际输入。
4. Host 一次提交两个字段；禁止在 `session/event` 的同步观察回调里重入 append，上游明确拒绝重入。
5. Client 为启用此能力的 Session 显示两个原生右侧页，只显示解析后的 response 作为最终回复，不修改其他预设的行为。
6. 版本兼容声明仅在精确依赖安装、类型检查和实测后给出。

## 项目形态

沿用 workspace-scope 的装配根与特性模块分离方式。预期完成结构：

```text
src/index.ts                 Host 装配根（已实现，待 alpha.1 类型检查）
src/host/protocol.ts         JSON 校验、提示词、纯状态更新（已实现）
src/host/session.ts          轮次边界、恢复与 Session surface 记忆（已实现）
src/host/api.ts              Host 读写服务（已实现）
src/prompts/final-response.json
src/client/index.tsx         Client 导出根；DSH slot/RPC 薄适配待实包声明
src/client/memory-panel.tsx  两个编辑页（已实现）
src/client/response.ts       commit 回复提取（已实现；renderer 注册待接）
cordis.patch.yml             新预设与 bundle 装配（待实现）
tsdown.config.ts             lib/index.js + lib/client.js（已实现，待实包构建）
tests/
```

当前不伪造 Client slot/RPC 类型，也不宣称存在可安装 manifest。`prepare` 与双入口已经加入；在实包声明下完成薄适配后，再加入 `dsh.bundle.patch`、`dsh.client.inject` 与 `cordis.patch.yml`。不从 workspace-scope 搬来动态热测生成器等无关功能。

## 任务状态

- [x] 核对上游 alpha.1 的预设、Agent 和 sidebar 接入点。
- [x] 内置 JSON 提示词；自由 Summary 与标准 Recent Chats 协议。
- [x] 完整输出校验、最新 N 条裁剪、手动编辑校验、revision 冲突检测。
- [x] 13 项纯测试通过（Node.js 24.19.0），包含协议、Host 状态机与 Client 数据模型。
- [ ] 安装精确 DSH 依赖，核对发布声明与源码契约。按用户要求，本轮不在线安装或联调。
- [x] Host：记忆消息持久化、轮间 surface 替换、重启恢复、revision 编辑冲突、失败保留。
- [x] Host：真正 idle 前不提交，避免 `turn-stopping` 后同轮 steering 被提前压缩。
- [ ] Host 实包核验：自定义 user source、custom Session events、replace 端点语义和 Service 装配签名。
- [x] Client：两个可编辑面板、Recent Chats 严格编辑校验、commit 回复提取与 transport port。
- [ ] Client 实包适配：两个原生 tab、RPC、最终回复 renderer；普通 Session 保持原生展示。
- [ ] Bundle：独立预设、双入口构建、安装说明与 CI。
- [ ] 联调：两轮含工具请求，第二轮不含旧工具原文；重启恢复；编辑后下一轮实际采用新值；无效 JSON/取消不覆盖旧状态；普通预设不受影响。

目前测试能证明协议与轮次状态机自身的行为，但不能替代 DSH alpha.1 发布包的类型检查，也不能证明真实工具循环、持久化后端或 UI slot 已联调可用。
