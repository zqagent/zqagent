// 通知装配入口：实现已迁移至 @zqagent/shared/notify；本文件聚合 core 专属的
// tenantNotifications（依赖租户配置），并再导出共享部分。
export * from "@zqagent/shared/notify";
export * from "./tenantNotifications.js";
