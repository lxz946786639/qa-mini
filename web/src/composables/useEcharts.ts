// P8.48 仪表盘：ECharts 模块化注册 + 主题感知 init（控制台图表单一入口）。
// 主题机制 = useTheme（<html> data-theme="light" / 缺省深色；EP 变量由 style.css 按主题映射），
// 因此图表文字/轴线色从容器计算样式读取 --el-* 变量即可自动跟随主题。
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkPointComponent,
  TooltipComponent
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  MarkPointComponent,
  TooltipComponent,
  CanvasRenderer
]);

export type Chart = echarts.EChartsType;

// 仪表盘统一色板（四主体 + 辅助色；图例顺序与 series 一致）
export const DASH_COLORS = {
  admin: "#5b8ff9", // 管理（蓝）
  user: "#5ad8a6", // 用户（绿）
  code: "#f6bd16", // 访问码（黄）
  anon: "#8c95a3", // 匿名（灰）
  line: "#5b8ff9",
  error: "#e8684a",
  pie: ["#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#9270ca", "#6dc8ec"]
};

/** 从容器当前主题读取 EP 变量（文字/轴线色）。 */
export function themeOf(el: HTMLElement) {
  const cs = getComputedStyle(el);
  return {
    text: cs.getPropertyValue("--el-text-color-regular").trim() || "#c8cdd6",
    sub: cs.getPropertyValue("--el-text-color-secondary").trim() || "#8c95a3",
    axis: cs.getPropertyValue("--el-border-color-light").trim() || "#2a3140"
  };
}

export function baseAxis(t: { text: string; axis: string }) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.text },
    splitLine: { lineStyle: { color: t.axis, type: "dashed" as const, opacity: 0.55 } }
  };
}

/** init + resize 监听（window + ResizeObserver）；cleanup 挂在实例上。 */
export function initChart(el: HTMLElement): Chart {
  const c = echarts.init(el);
  const onResize = () => {
    if (!c.isDisposed()) c.resize();
  };
  window.addEventListener("resize", onResize);
  const ro = new ResizeObserver(onResize);
  ro.observe(el);
  (c as unknown as { __cleanup: () => void }).__cleanup = () => {
    window.removeEventListener("resize", onResize);
    ro.disconnect();
    if (!c.isDisposed()) c.dispose();
  };
  return c;
}

export function disposeChart(c: Chart | null | undefined) {
  if (!c) return;
  const fn = (c as unknown as { __cleanup?: () => void }).__cleanup;
  if (typeof fn === "function") fn();
  else if (!c.isDisposed()) c.dispose();
}
