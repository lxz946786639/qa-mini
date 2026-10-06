"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function main() {
  const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=D:/AiCode/qa-mini/.tmp-chrome-p819", "--window-size=1280,800", "--blink-settings=preferredColorScheme=2", "--remote-debugging-port=9222"], { stdio: "ignore" });
  let ver = null;
  for (let i = 0; i < 30 && !ver; i++) { await sleep(500); try { const r = await fetch("http://127.0.0.1:9222/json/version"); ver = await r.json(); } catch (e) {} }
  if (!ver) throw new Error("chrome not ready");
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  let mid = 0; const pending = new Map(); let sid = null;
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const B = (method, params) => new Promise((res, rej) => {
    const id = ++mid;
    const to = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("cdp timeout: " + method)); } }, 15000);
    pending.set(id, (d) => { clearTimeout(to); res(d); });
    ws.send(JSON.stringify(sid ? { id, sessionId: sid, method, params: params || {} } : { id, method, params: params || {} }));
  });
  const ct = await B("Target.createTarget", { url: "http://127.0.0.1:8787/" });
  const at = await B("Target.attachToTarget", { targetId: ct.result.targetId, flatten: true });
  sid = at.result.sessionId;
  await B("Page.enable");
  const C = (m, p) => B(m, p);
  const ev = (expr) => C("Runtime.evaluate", { expression: expr, returnByValue: true }).then(r => r.result.result && r.result.result.value);
  await sleep(2500);
  await ev("(() => { document.getElementById('workflow').scrollIntoView(); return true; })()");
  await sleep(900);
  console.log("FOOTER:", await ev("(() => document.querySelector('.lp-foot').innerText)()"));
  const d = await C("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("D:/AiCode/qa-mini/.tmp-shots/p819-footer.png", Buffer.from(d.result.data, "base64"));
  console.log("shot: p819-footer.png");
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
}
main().catch(e => { console.error("FATAL", e && e.message); process.exit(1); });
