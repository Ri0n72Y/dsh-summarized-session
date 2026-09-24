# dsh-summarized-session

DSH + Cordis 的 SummarizedWorkingMemory 插件开发仓库。

每轮以 **Summary + Recent Chats + 当前输入** 开始，轮内沿用正常工具调用历史，最终由同一次模型响应同时提出回复和新的工作记忆。合法 final envelope 解析成功后，`response` 立即作为普通回复显示；`summary + recentChats` 进入待审核状态，用户可修改或清空，明确接受后才替换旧工作历史。在待审核记忆处理完之前，下一轮输入会被保留并暂不进入模型。

**当前进度：协议核心、Host 轮次状态机、Connection RPC、两个原生右侧页、最终回复 renderer、可组合 preset 插件、bundle manifest 与 CI 均已实现。** GitHub Actions 已针对 `0.1.7-alpha.1` 依赖完成安装、测试、类型检查和构建；尚未在真实 DSH UI / 工具循环中联调，因此 `package.json` 继续设为 private，不声明已经完成运行时兼容认证。

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

Summary 同时吸收最近几轮的内容；Recent Chats 保留含本轮在内的最近 N 次压缩交互，更新 Summary 不会清空它。系统提示词、工具定义和环境描述不写进 Summary。AI 只负责提出 Working Memory 更新，用户审核是 accepted Working Memory 的唯一入口。存在待审核提案时不会开启下一轮 raw-history 推理；新输入保存在 Agent inbox 中，接受提案后再恢复处理。

本阶段纯协议、Host 假 Session 状态机与 Client 数据模型测试无需安装依赖，使用 Node.js 24：

```sh
npm test
```

当前测试覆盖：严格 JSON、最近 N 条、revision 冲突、提案持久化、原子 memory authority、`commit/edit` 审计事件、待审核轮间屏障与输入恢复、合法 surface replacement、重启恢复、失败轮保留与人工恢复、配置变更后的 Surface 规范化、跨面板审核草稿、`turn-stopping` 后继续同轮 steering 时不提前压缩、普通预设隔离、稳定上下文保留，以及 pending/committed response 投影。

实际 DSH 环境中的下一步是运行真实联调矩阵：含工具调用的两轮对话、pending 时继续发送输入、人工修改/接受、重启恢复、非法 JSON/取消，以及普通 preset 隔离。

构建采用 Host / preset ESM 与 DSH Client module-loader bundle 三个入口，输出到 `lib/`。Host 与 Client 使用独立 TypeScript 工程。安装补丁加入 Host coordinator，以及一个**故意最小化**的 `summarized-working-memory` opt-in preset；它只挂载本插件协议，不复制 Coding Agent 的 persona、工具、plan mode 或 subagent。实际组合时，把 `dsh-summarized-session/preset` 加入你自己的 Agent preset，并把 Host 的 `presetId` 指向该 preset。
