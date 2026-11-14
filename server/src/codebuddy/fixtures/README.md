# CodeBuddy ACP fixtures

这些 JSONL 文件来自已登录 CodeBuddy CLI 的隔离探针，只保留 adapter 测试所需的 JSON-RPC 结构。

- 每行是一个 JSON-RPC 信封，`_direction` 标记 Relay 探针发送或 CodeBuddy 返回。
- 动态 ID、用户目录、项目路径、认证头、Cookie、连接令牌和 Provider 信息必须脱敏。
- fixture 只能通过 `server/scripts/probe-codebuddy-acp.ts` 在显式临时 cwd 中更新。
- 不得使用项目根目录或正式 `workspace/` 运行探针。
