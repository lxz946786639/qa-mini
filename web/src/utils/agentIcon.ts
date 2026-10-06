// P8.25：智能体图标统一使用 Element Plus 图标名（项目禁止使用 emoji 图标，见 AGENTS.md §2）。
// agents.icon 字段存图标名（如 "Cpu"）；空 = 默认图标（Cpu）。
// P8.11 遗留 emoji 值经 LEGACY_EMOJI_MAP 自动映射为对应 UI 图标；未知值回退默认图标。
import type { Component } from "vue";
import {
  Cpu, ChatDotRound, DataAnalysis, DataLine, TrendCharts, Document, Notebook,
  Reading, Collection, Microphone, VideoCamera, Headset, Odometer, Aim,
  Compass, School, OfficeBuilding, Briefcase, Link, MagicStick, SetUp, Tools
} from "@element-plus/icons-vue";

// 渲染映射全集（含遗留映射目标 SetUp/Tools，点选网格不含后两者）
export const AGENT_ICONS: Record<string, Component> = {
  Cpu, ChatDotRound, DataAnalysis, DataLine, TrendCharts, Document, Notebook,
  Reading, Collection, Microphone, VideoCamera, Headset, Odometer, Aim,
  Compass, School, OfficeBuilding, Briefcase, Link, MagicStick, SetUp, Tools
};
// 点选网格（20 枚预设）
export const AGENT_ICON_CHOICES: string[] = [
  "Cpu", "ChatDotRound", "DataAnalysis", "DataLine", "TrendCharts", "Document",
  "Notebook", "Reading", "Collection", "Microphone", "VideoCamera", "Headset",
  "Odometer", "Aim", "Compass", "School", "OfficeBuilding", "Briefcase", "Link", "MagicStick"
];

// P8.11 遗留 emoji → P8.25 UI 图标（仅展示兼容；保存后即以图标名落库）
const LEGACY_EMOJI_MAP: Record<string, string> = {
  "🤖": "Cpu", "🧠": "DataAnalysis", "💡": "MagicStick", "🎓": "School", "🎙️": "Microphone",
  "📚": "Collection", "📖": "Reading", "🔬": "DataLine", "🧪": "SetUp", "⚗️": "Odometer",
  "📋": "Document", "📝": "Notebook", "💬": "ChatDotRound", "📊": "TrendCharts", "⚖️": "Compass",
  "💼": "Briefcase", "🏭": "OfficeBuilding", "🌐": "Link", "🎯": "Aim", "🛠️": "Tools"
};

// 归一化：空 = ""（默认图标）；EP 图标名原样；遗留 emoji → 映射名；未知 → ""（回退默认）
export function normalizeAgentIcon(v: string | null | undefined): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (AGENT_ICONS[s]) return s;
  return LEGACY_EMOJI_MAP[s] || "";
}

// 取渲染组件（任何未知/遗留值安全回退 Cpu 默认图标）
export function agentIconComponent(v: string | null | undefined): Component {
  return AGENT_ICONS[normalizeAgentIcon(v)] || Cpu;
}
