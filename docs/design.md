# SummarizedWorkingMemory：首版设计

## 已确定的行为

插件提供一个新的 Agent 预设。选中该预设后，模型每轮读取当前 Summary、最近 N 次压缩交互和当前用户输入。系统提示词、工具与环境仍由 DSH 装配。轮内工具调用继续使用完整连续历史，最终响应采用一个 JSON 对象：`response`、`summary`、`recentChats`。

`response` 用于主会话显示；`summary` 与 `recentChats` 分别进入右侧两个可编辑页面。Summary 为自然长文本，不规定小标题、字段或固定模板。Recent Chats 是 `{ user: string, assistant: string }[]`，按时间升序排列，最后一条概括本轮。Summary 已经吸收这些交互，但近期细节仍在 Recent Chats 中保留。没有后台总结 Agent，也不增加一次专用摘要模型调用。

Working Memory 本身只有 Summary 和 Recent Chats。当前用户输入是下一次调用的输入，不是预先写入的已完成经历。N 作为预设配置；首版默认值尚未由用户指定，可在装配阶段取一个明确可调的初始值。

## 每轮数据流

1. 从当前 Session 读取最后一次成功提交的记忆快照，以及用户已保存的编辑。首轮为空记忆。
2. 建立本轮输入：DSH 的有效系统、工具与环境材料，加上 Summary → Recent Chats → 当前输入。附件和中途 steering 仍保留 DSH 原生消息结构。
3. 轮内按原生 Agent loop 继续调用工具，每一步保留本轮已发生的 assistant / tool 消息。
4. 无工具调用的最终回复完成后，解析整个 JSON；校验全部字段成功，才一起提交 Summary 与 Recent Chats，并显示 response。
5. 下一轮替换已被记忆覆盖的旧工作历史，不重复发送过去各轮的原始对话和工具结果。人类可查看的历史日志保留。

JSON 字段由模型输出；Host 必须负责校验与持久化。仅在浏览器里解析、保存会造成关闭页面或后台运行时丢失记忆，因此 Client 只呈现 Host 接受的状态。

## 三个小模块

| 模块 | 工作 |
| --- | --- |
| 输出协议 | 固定 JSON 提示词，整包解析，限制 recentChats 窗口；Summary 不做内容模板化 |
| Host 轮次接入 | 在边界替换模型工作历史、读取和提交 Session 记忆、接收编辑 |
| Client 展示 | 主会话显示 response；右侧 Summary 与 Recent Chats 两个编辑页 |

JSON 提示词是协议指令，不是要求服务端启用 provider 的全局 JSON response mode。工具步骤继续走原生工具协议；是否支持工具与强制 JSON 模式同时使用，不能靠模型名称推断。

## DSH 0.1.7-alpha.1 接入依据

调研快照：`deepseek-ai/deepseek-harness@c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`。该提交的 `dsh-agent-loop/package.json` 标记 `0.1.7-alpha.1`；未验证 npm 发布包。

| 已核对的接口 | 对本插件的意义 |
| --- | --- |
| `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` | 声明独立预设，在预设里挂载本插件；不沿用旧 `agent-presets` 包假设 |
| `systemPrompt.section()` | 注册固定输出协议；变化的记忆不放进系统前缀 |
| `agent/pre-step` | 可处理输入接纳与 Session surface，必须只在轮次切换时替换历史 |
| `agent/request` | 只变更 LLM 配置，明确不能修改 messages；不能拿它伪造请求投影 |
| Session `surfaceOp: { op: 'replace', startSeq, endSeq }` | 通过正式日志操作替换模型可见区间；原始日志仍保留 |
| `agent/turn-stopping` | 正常停止边界可检查最终输出；取消、错误和 max-tokens 要单独识别 |
| `sidebarRightTabs.register()` 与 `sidebar.right.pane.tab` | 注册两个原生右侧 tab，不另造侧栏容器 |
| `uiConversation` / `conversation.chat.node` | 人类会话显示和模型 surface 分离；surface 替换不会自动把旧 JSON 气泡变成 response |

源码：

- [预设声明](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/preset/agent-preset/README.md)
- [Agent 扩展点](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/core/agent/src/runtime-types.ts)
- [模型 surface 与人类 transcript](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/core/session/src/surface.ts)
- [右侧 tab 接口](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-sidebar-right/src/client/contract/slots.ts)
- [Chat renderer 接口](https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/packages/client/ui-chat/src/client/contract/slots.ts)

## 接入时必须解决的两个细节

**稳定材料的重新出现。** DSH 有一部分环境、Skill catalog 和 Agent instructions 是注入的 user-role 消息，并非都在 system 中。如果一刀切删除全部非 system 历史，这些材料可能因为上游去重缓存而不再注入。Host 接入应根据各消息的原生 source 和生命周期保留或重建有效材料，同时清掉旧工作历史。不要把它们塞入 Summary 代替原生所有权。

**主会话展示。** 默认 Chat 从 append-origin 事件和实时流呈现内容。不能只做一个 surface replacement，就声称用户会看到解析后的 response；也不能改写模型原始流伪造日志。接入阶段需使用公开的 Conversation / renderer 扩展点，只对启用插件的 Session 解析最终回复，普通 Session 保留原生显示。首版可缓冲最终 JSON，完整校验后再显示回复，以免为流式拆字段引入一个复杂解析器。这个展示接法尚未通过运行验证。

## 最小一致性处理

- 每次完整 JSON 作为一次记忆提交，避免 Summary 新、Recent Chats 旧。Host 快照有内部 revision；它不属于模型输出字段。
- 首版编辑在空闲时保存，运行期间保留可读状态并禁用保存；Host 仍验证 revision，拒绝覆盖更新后的状态。
- JSON 无效、截断、取消或失败时保留旧记忆，不把半轮内容写成“已完成”。展示错误并保留原始输出供查看，不悄悄增发一次总结请求。
- 恢复失败轮时不得删除尚未被成功记忆覆盖的工具工作。需要继续该未完成轮或显式提示恢复状态，不能假装已生成完整摘要。
- Host 对超出 N 的列表保留最新 N 条。程序不能证明摘要事实正确，也不能机械验证最后一条语义上确实覆盖了本轮；这些由提示词和实际模型验收检查。
- 普通会话不启用轮间替换。Session 恢复后仍必须读到同一份记忆，而不是依赖浏览器本地缓存。

## 缓存与规模

固定协议提示词、系统材料、工具定义应尽量保持稳定；一轮内部连续追加工具结果，保留可复用前缀。轮间变化的 Summary 与 Recent Chats 放在固定材料后。实际命中率受模型服务的缓存规则、序列化与环境材料变化影响，这里不声明测得的命中比例。

N 只限制 Recent Chats 数量，不限制 Summary 长度。本版不额外引入摘要 token 配额或二次压缩器；实际使用时需要观察 Summary 是否持续膨胀。
