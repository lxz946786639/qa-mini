// SSE 订阅（/api/events）：服务器按主体作用域投递（P3），本端只收得到自己可见会话的事件。
// EventSource 原生自动重连；连接状态暴露给 UI（顶栏徽标）。
// P8.33：URL 带 ?dev= 设备指纹（UA 的 FNV-1a 码，供在线统计 / 踢出判定）；收到 evicted
// 控制事件或断开后探针确认处于踢出冷却 → 提示并自动返回首页。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { uaCode } from "../utils/uaDevice";

export type SseHandler = (data: any) => void;

const DEV = typeof navigator !== "undefined" ? uaCode(navigator.userAgent) : "";
const EVENTS_URL = "/api/events" + (DEV ? "?dev=" + DEV : "");
const CHECK_URL = "/api/events/check" + (DEV ? "?dev=" + DEV : "");

export function useSse(handlers: Record<string, SseHandler>) {
  const status = ref<"connecting" | "open" | "error">("connecting");
  let es: EventSource | null = null;
  let wasOpen = false;
  let probing = false;
  let evictedHandled = false;
  const router = useRouter();

  function handleEvicted() {
    if (evictedHandled) return;
    evictedHandled = true;
    if (es) { es.close(); es = null; }
    try { ElMessageBox.close(); } catch { /* 无打开的对话框 */ } // 踢出时工作区可能开着确认/输入框（如「新建会话」），随跳转一并清掉
    ElMessage.warning("您已被管理员下线");
    router.replace("/");
  }
  // P8.33：连接断开后探针（EventSource 拿不到 HTTP 状态码；探针回答「是否处于踢出冷却」）
  function probeEvicted() {
    if (probing) return;
    probing = true;
    fetch(CHECK_URL)
      .then((r) => r.json().catch(() => ({})).then((d) => ({ s: r.status, d })))
      .then(({ s, d }: { s: number; d: any }) => { if (s === 403 && d && d.evicted) handleEvicted(); })
      .catch(() => { /* 网络异常：维持 error 状态由 EventSource 原生重连 */ })
      .finally(() => { probing = false; });
  }

  onMounted(() => {
    es = new EventSource(EVENTS_URL);
    es.onopen = () => { status.value = "open"; wasOpen = true; };
    es.onerror = () => { status.value = "error"; if (wasOpen) probeEvicted(); };
    // P8.33：evicted 连接级控制事件（服务端踢出时定向推送，非广播）
    es.addEventListener("evicted", () => handleEvicted());
    for (const name of Object.keys(handlers)) {
      es.addEventListener(name, (e: MessageEvent) => {
        try {
          handlers[name](JSON.parse(e.data));
        } catch {
          /* 忽略非 JSON 帧 */
        }
      });
    }
  });
  onBeforeUnmount(() => {
    if (es) es.close();
    es = null;
  });
  return { status };
}
