# 贡献指南

感谢你愿意改进 ZQAgent。这个项目能执行真实命令、修改真实文件，所以我们对变更的要求比一般项目更严格。

## 开始之前

- 小改动（错别字、文档、明显的 bug 修复）可以直接提 PR。
- **大改动请先开 issue 讨论**，尤其是：新增工具、修改权限/审批逻辑、改动线协议（`proto/`）、改动对外 API。未经讨论的大 PR 很可能被拒绝，避免你的时间被浪费。
- 涉及安全的问题请看 [SECURITY.md](./SECURITY.md)，不要开公开 issue。

## 开发环境

要求 Node.js >= 18.17，包管理器使用 pnpm。

```bash
pnpm install
pnpm --filter @zqagent/core test        # 单元测试
pnpm --filter @zqagent/core typecheck   # 类型检查
pnpm --filter @zqagent/core dev         # 本地启动 CLI
```

提交前请确保 `test` 与 `typecheck` 都通过。

## 代码约定

- 使用 TypeScript，保持 `strict` 通过；不要用 `any` 掩盖类型问题。
- 注释用中文，只解释「为什么」，不复述代码在做什么。
- 新增工具体现在 `src/tools/`，并在工具注册处声明风险等级（`read` / `write` / `exec`）。**风险等级标错会导致审批被绕过，属于阻断性问题。**
- 任何写文件、起进程、发网络请求的逻辑都必须走 `PermissionEngine`，不要自己直接调用 `fs.writeFile` 或 `child_process`。
- 改动线协议时同步更新 `proto/` 与 `docs/wire-protocol.md`，并跑 `pnpm --filter @zqagent/core exec tsx scripts/gen_wire_vectors.ts` 重新生成向量。

## 测试

- 修 bug 请附带一个能复现该 bug 的测试。
- 新增工具需要覆盖：正常路径、审批被拒绝、参数非法。
- 不要提交依赖真实网络的测试；需要外部服务时用本地 stub。

## 提交信息

采用 Conventional Commits：

```
feat(cli): 支持 /model 切换时保留会话
fix(permissions): 修复 auto 模式下命令白名单失效
docs: 补充 MCP http 传输示例
```

## PR 检查清单

- [ ] `test` 与 `typecheck` 通过
- [ ] 新增/修改的行为有测试覆盖
- [ ] 没有提交密钥、真实账号、内部地址或 `dist/`、`node_modules/`
- [ ] 涉及权限、审批、命令执行的改动，在 PR 描述中说明了安全影响
- [ ] 面向用户的变更已同步文档（`packages/site/docs/` 或 `docs/`）

## 许可

提交 PR 即表示你同意以 [Apache-2.0](./LICENSE) 许可贡献你的代码，并确认你有权这样做。
