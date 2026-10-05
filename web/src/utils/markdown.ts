// 移植自 public/app.js 的内联 Markdown 渲染器（语义一致；**先 HTML 转义后解析**防 XSS）
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderInline(s: string): string {
  // s 已转义；处理 行内代码 / 链接 / 加粗 / 斜体
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return "\u0001" + (codes.length - 1) + "\u0001";
  });
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>");
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => "<code>" + codes[Number(i)] + "</code>");
  return s;
}

export function renderMarkdown(src: string): string {
  const blocks: string[] = [];
  let text = src.replace(/`{3}(?:\w*)\n?([\s\S]*?)`{3}/g, (_m, code: string) => {
    blocks.push(code.replace(/\n$/, ""));
    return "\u0002" + (blocks.length - 1) + "\u0002";
  });
  text = escapeHtml(text);
  const lines = text.split("\n");
  const out: string[] = [];
  let inUl = false, inOl = false, inQuote = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
    if (inQuote) { out.push("</blockquote>"); inQuote = false; }
  };
  for (const line of lines) {
    const fence = line.match(/^\u0002(\d+)\u0002$/);
    if (fence) {
      closeLists();
      out.push("<pre><code>" + escapeHtml(blocks[Number(fence[1])]) + "</code></pre>");
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      out.push("<h" + h[1].length + ">" + renderInline(h[2]) + "</h" + h[1].length + ">");
      continue;
    }
    if (/^\s*([-*])\s+/.test(line) && line.trim() !== "-") {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push("<li>" + renderInline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
      continue;
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push("<li>" + renderInline(ol[2]) + "</li>");
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) { closeLists(); out.push("<hr>"); continue; }
    if (/^&gt;\s?/.test(line)) {
      if (inUl || inOl) closeLists();
      if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
      out.push("<p>" + renderInline(line.replace(/^&gt;\s?/, "")) + "</p>");
      continue;
    }
    closeLists();
    if (line.trim() === "") continue;
    out.push("<p>" + renderInline(line) + "</p>");
  }
  closeLists();
  return out.join("");
}
