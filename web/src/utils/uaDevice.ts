// P8.29：访问设备识别码（浏览器特征）——解析 User-Agent → 特征描述 + 稳定识别码。
// 识别码 = FNV-1a 32 位哈希前 8 位十六进制（纯前端计算、零依赖；同设备同浏览器恒定）。

export interface UaDevice {
  label: string; // 浏览器特征描述，如「Chrome 143 · Windows 10/11 · 桌面」
  code: string;  // 设备识别码（8 位十六进制）
}

export function parseUaLabel(ua: string): string {
  if (!ua) return "";
  let browser = "";
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/EdgA\/(\d+)/))) browser = "Edge 移动 " + m[1];
  else if ((m = ua.match(/Edg\/(\d+)/))) browser = "Edge " + m[1];
  else if ((m = ua.match(/OPR\/(\d+)/))) browser = "Opera " + m[1];
  else if ((m = ua.match(/(?:Headless)?Chrome\/(\d+)/))) browser = "Chrome " + m[1];
  else if ((m = ua.match(/Chromium\/(\d+)/))) browser = "Chromium " + m[1];
  else if ((m = ua.match(/Firefox\/(\d+)/))) browser = "Firefox " + m[1];
  else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) browser = "Safari " + m[1];
  else if (/Safari/.test(ua)) browser = "Safari";
  else if (/Mozilla/.test(ua)) browser = "浏览器";
  let os = "";
  if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
  else if (/Windows NT 6\.3/.test(ua)) os = "Windows 8.1";
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if ((m = ua.match(/Android (\d+)/))) os = "Android " + m[1];
  else if (/iPhone|iPad|iPod/.test(ua)) {
    const mm = ua.match(/OS (\d+[_]\d+)/);
    os = mm ? "iOS " + mm[1].replace("_", ".") : "iOS";
  } else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  const device = /Mobile|iPhone|iPod|Android/.test(ua) ? "移动" : "桌面";
  return [browser, os, device].filter(Boolean).join(" · ");
}

export function uaCode(ua: string): string {
  if (!ua) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < ua.length; i++) {
    h ^= ua.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function describeUa(ua: string): UaDevice {
  return { label: parseUaLabel(ua), code: uaCode(ua) };
}
