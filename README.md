# dsh-summarized-session

DSH + Cordis 的 SummarizedWorkingMemory 插件开发仓库。

每轮以 **Summary + Recent Chats + 当前输入** 开始，轮内沿用正常工具调用历史，最终由同一次模型响应同时提出回复和新的工作记忆。模型输出先进入待审核状态；用户可修改或清空，明确接受后才替换旧工作历史。

**当前进度：协议核心、Host 轮次状态机、Connection RPC、两个原生右侧页、最终回复 renderer、独立 Agent 预设、bundle manifest 与 CI 均已实现。** 代码契约已对照 DSH `0.1.7-alpha.1` 对应源码，但尚未在发布包环境中安装、类型检查和联调，因此 `package.json` 继续设为 private，不声明已经兼容可用。

目标基线为 DSH `0.1.7-alpha.1`。接口调研基于上游提交 [`c36a83f`](https://github.com/deepseek-ai/deepseek-harness/tree/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61)，不是对该版本全部发布产物的兼容认证。

- [设计与接入点](docs/design.md)
- [实现约定与剩余任务](docs/implementation.md)
- [内置 JSON 提示词](src/prompts/final-response.json)
- [协议校验与状态更新核心](src/host/protocol.ts)
- [Session 轮次与 surface 状态机](src/host/session.ts)
- [Summary / Recent Chats 编辑面板](src/client/memory-panel.tsx)

```json
{
  "response": "给用户的正常回复，可以包含 Markdown。",
  "summary": "自由长文本：我们已经做了什么，现在总体是什么状态。",
  "recentChats": [
    {
      "user": "本轮用户提出了什么。",
      "assistant": "我做了什么、使用了哪些工具并得到什么结果、到达什么状态，以及向用户报告了什么。"
    }
  ]
}
```

Summary 同时吸收最近几轮的内容；Recent Chats 保留含本轮在内的最近 N 次压缩交互，更新 Summary 不会清空它。系统提示词、工具定义和环境描述不写进 Summary。AI 只负责提出更新，用户审核是 accepted Working Memory 的唯一入口；未审核时旧记忆与原始工作历史继续保留，后续提案可以覆盖较早提案。

本阶段纯协议、Host 假 Session 状态机与 Client 数据模型测试无需安装依赖，使用 Node.js 24：

```sh
npm test
```

当前 17 项测试覆盖：严格 JSON、最近 N 条、revision 冲突、提案持久化、人工接受、合法 surface replacement、重启恢复、失败轮保留、未审核提案不成为 accepted memory、跨面板审核草稿、`turn-stopping` 后继续同轮 steering 时不提前压缩、普通预设隔离、稳定上下文保留和 Host accepted 回复投影。

实际 DSH 环境中的下一步调试顺序：

1. 安装 `package.json` 中的精确 alpha.1 依赖，先运行 `npm run typecheck` 与 `npm run build`，按发布声明修正 Host 的窄接口差异。
2. 若发布声明与源码快照存在窄差异，只修正 Host/Client 薄适配，不改协议核心。
3. 安装本地目录后选择 `Summarized Working Memory` 预设，运行两轮含工具调用的联调矩阵。

构建采用 Host / preset ESM 与 DSH Client module-loader bundle 三个入口，输出到 `lib/`。Host 与 Client 使用独立 TypeScript 工程，避免两侧同名 Cordis 服务声明互相污染。安装补丁同时加入 Host coordinator 和 `summarized-working-memory` Agent 预设；Client 通过官方 Connection RPC、Sidebar slot 和原生 assistant renderer 注册点接入。
