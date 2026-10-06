// P8.28：项目时间展示统一格式 yyyy-MM-dd HH:mm:ss（本地时区）——表格/表单等全量时间字段
// 一律经此格式化（此前管理端表格直接渲染 ISO 原文，如 2026-10-05T12:36:58.018Z）。
// 紧凑场景（工作区会话列表 MM-DD HH:mm、卡片 HH:MM:SS）为 P8.14 对齐旧版的设计，保留各自的本地格式化。
export function fmtDateTime(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
  );
}
