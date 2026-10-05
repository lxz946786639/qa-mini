// SSE 订阅（/api/events）：服务器按主体作用域投递（P3），本端只收得到自己可见会话的事件。
// EventSource 原生自动重连；连接状态暴露给 UI（顶栏徽标）。
import { onBeforeUnmount, onMounted, ref } from "vue";

export type SseHandler = (data: any) => void;

export function useSse(handlers: Record<string, SseHandler>) {
  const status = ref<"connecting" | "open" | "error">("connecting");
  let es: EventSource | null = null;
  onMounted(() => {
    es = new EventSource("/api/events");
    es.onopen = () => { status.value = "open"; };
    es.onerror = () => { status.value = "error"; };
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
