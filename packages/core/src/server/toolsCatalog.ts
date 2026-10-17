/**
 * 工具目录（面向控制台展示，只读）
 *
 * 按会话一致的方式装配一个 ToolRegistry（不注册需要 provider 的 explore 工具），
 * 导出工具名 / 描述 / 分类 / 风险 / 是否需审批。仅用于「配置 → 工具」列表展示。
 */
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { registerFileTools } from "../tools/files.js";
import { registerShellTool } from "../tools/shell.js";
import { registerSearchTool } from "../tools/search.js";
import { registerWebTools } from "../tools/web.js";
import { registerGitTools } from "../tools/git.js";
import { registerDiffTools } from "../tools/diff.js";
import { registerAskTool } from "../tools/ask.js";
import { registerPlanTool } from "../tools/plan.js";
import { registerDirectoryTool } from "../tools/directories.js";
import { registerTodoTool, TodoList } from "../tools/todo.js";
import { registerMediaTool } from "../tools/media.js";

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  riskLevel: string;
  requiresApproval: boolean;
}

/** 组装当前项目可用工具清单（workspace 仅影响文件/命令类工具的注册路径） */
export function buildToolCatalog(workspace: string): ToolInfo[] {
  const registry = new ToolRegistry();
  try {
    registerFileTools(registry, workspace);
    registerShellTool(registry, workspace);
    registerSearchTool(registry, workspace);
    registerWebTools(registry);
    registerGitTools(registry, workspace);
    registerDiffTools(registry, workspace);
    registerAskTool(registry);
    registerPlanTool(registry);
    registerDirectoryTool(registry);
    registerMediaTool(registry, workspace);
    registerTodoTool(registry, new TodoList());
  } catch {
    // 单个注册失败不影响其余
  }
  return registry.list().map((t) => ({
    name: t.name,
    description: t.schema.function?.description ?? "",
    category: t.metadata.category,
    riskLevel: t.metadata.riskLevel,
    requiresApproval: t.metadata.requiresApproval,
  }));
}
