# dsh-summarized-session

DSH + Cordis 的 SummarizedWorkingMemory 插件开发仓库。

每轮以 **Summary + Recent Chats + 当前输入** 开始，轮内沿用正常工具调用历史，最终由同一次模型响应同时输出回复和新的工作记忆。

**当前进度：设计与协议核心已完成第一稿，Host / Client 接入未完成，尚不可作为 DSH 插件安装。** `package.json` 暂设为 private，不声明虚假的插件入口或兼容性实测状态。

目标基线为 DSH `0.1.7-alpha.1`。接口调研基于上游提交 [`c36a83f`](https://github.com/deepseek-ai/deepseek-harness/tree/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61)，不是对该版本全部发布产物的兼容认证。

- [设计与接入点](docs/design.md)
- [实现约定与剩余任务](docs/implementation.md)
- [内置 JSON 提示词](src/prompts/final-response.json)
- [协议校验与状态更新核心](src/host/protocol.ts)

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

Summary 同时吸收最近几轮的内容；Recent Chats 保留含本轮在内的最近 N 次压缩交互，更新 Summary 不会清空它。系统提示词、工具定义和环境描述不写进 Summary。

本阶段协议测试无需安装依赖，使用 Node.js 24：

```sh
npm test
```

后续采用 [dsh-workspace-scope](https://github.com/Ri0n72Y/dsh-workspace-scope) 的静态 bundle 结构：Host / Client 两个装配入口、`lib/` 构建输出、`prepare` 和 `cordis.patch.yml`。只参考项目形态，不复制其 `0.1.6-alpha.2` 接口与特有功能。
