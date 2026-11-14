/**
 * cdp.js — 最小 Chrome DevTools Protocol 客户端。
 *
 * 零依赖：只用 Node 内置的 `WebSocket`（Node 22+ 自带）与 `fetch`。
 * 不引入 puppeteer / playwright —— 宿主插件里多一个依赖就多一处安装失败点。
 *
 * 默认连本机 9333 端口的 Edge/Chrome（由 `browser.js` 负责拉起来）。
 * 用环境变量 `WX135_CDP_HOST` 覆盖，格式 `http://127.0.0.1:<port>`。
 */

export const DEFAULT_HOST = process.env.WX135_CDP_HOST || 'http://127.0.0.1:9333';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带超时的 fetch（浏览器可能没起 / 端口被占，不能无限等）。 */
async function fetchJson(url, timeoutMs = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** 一个标签页的 CDP 连接。支持 `send` 与事件订阅。 */
export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => this.#onClose());
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const slot = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.error) {
        slot.reject(new Error(`CDP ${slot.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        slot.resolve(msg.result);
      }
      return;
    }
    if (msg.method && this.listeners.has(msg.method)) {
      for (const fn of this.listeners.get(msg.method)) {
        try {
          fn(msg.params, msg.sessionId);
        } catch {
          /* 订阅者的异常不能影响连接 */
        }
      }
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error('CDP 连接已关闭'));
    }
    this.pending.clear();
  }

  static async connect(wsUrl, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 CDP 超时: ${wsUrl}`)), timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`连接 CDP 失败: ${wsUrl}`));
        },
        { once: true },
      );
    });
    return new CdpConnection(ws);
  }

  /** 发一条 CDP 命令；超时默认 30s（截图/长求值要留余量）。 */
  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  /** 订阅一个 CDP 事件，返回取消函数。 */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.#onClose();
  }
}

/** 列出所有可调试标签页（只保留 page 类型）。 */
export async function listTargets(host = DEFAULT_HOST) {
  const all = await fetchJson(`${host}/json/list`);
  return all.filter((t) => t?.type === 'page');
}

/** 浏览器版本信息；能拿到就说明调试端口活着。 */
export async function browserVersion(host = DEFAULT_HOST) {
  return fetchJson(`${host}/json/version`);
}

/** 按 URL 子串 / 标题子串选一个标签页。 */
export function pickTarget(targets, { url, title, index } = {}) {
  let list = targets.filter((t) => t.type === 'page');
  if (url) list = list.filter((t) => (t.url || '').includes(url));
  if (title) list = list.filter((t) => (t.title || '').includes(title));
  const page = Number.isInteger(index) ? list[index] : list[0];
  return page || null;
}

/** 连接到一个标签页并启用常用域。 */
export async function connectTarget(target) {
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl);
  await conn.send('Page.enable');
  await conn.send('Runtime.enable');
  return conn;
}

/** 远程求值，返回 JS 值；有异常就把异常描述抛出来。 */
export async function evaluate(conn, expression, { awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = {}) {
  const r = await conn.send(
    'Runtime.evaluate',
    { expression, returnByValue, awaitPromise, includeCommandLineAPI: false, userGesture: false },
    { timeoutMs },
  );
  if (r?.exceptionDetails) {
    const desc =
      r.exceptionDetails.exception?.description
      || r.exceptionDetails.text
      || JSON.stringify(r.exceptionDetails);
    throw new Error(`页面 JS 异常: ${desc}`);
  }
  return r?.result?.value;
}

/** 求值并把 JSON 字符串结果解析成对象（页面里用 JSON.stringify 返回时最方便）。 */
export async function evaluateJson(conn, expression, opts = {}) {
  const value = await evaluate(conn, expression, opts);
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** 截图，返回 PNG/JPEG Buffer。 */
export async function captureScreenshot(conn, { format = 'png', quality, clip, captureBeyondViewport = false, timeoutMs = 45000 } = {}) {
  const params = { format, captureBeyondViewport };
  if (format === 'jpeg' && quality) params.quality = quality;
  if (clip) params.clip = clip;
  const r = await conn.send('Page.captureScreenshot', params, { timeoutMs });
  return Buffer.from(r.data, 'base64');
}

/** 物理鼠标点击（DOM `.click()` 对 135 的不少控件无效）。 */
export async function mouseClick(conn, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

/** 视口尺寸覆盖（移动端模拟，用于按手机宽度截图）。 */
export async function setViewport(conn, { width, height, mobile = true, deviceScaleFactor = 1 }) {
  await conn.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(width),
    height: Math.round(height),
    deviceScaleFactor,
    mobile,
  });
  await sleep(300);
}

/** 取消视口覆盖。 */
export async function clearViewport(conn) {
  try {
    await conn.send('Emulation.clearDeviceMetricsOverride');
  } catch {
    /* ignore */
  }
}

/** 滚动窗口到 y。 */
export async function scrollWindow(conn, y) {
  await evaluate(conn, `(() => { window.scrollTo(0, ${Math.round(y)}); return 'ok'; })()`);
}

/** 新开标签页。 */
export async function newTab(host, url = 'about:blank') {
  const res = await fetch(`${host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`新建标签页失败: HTTP ${res.status}`);
  return res.json();
}

/** 关闭一个标签页（写权限在 /json/close/<id>）。 */
export async function closeTab(host, targetId) {
  const res = await fetch(`${host}/json/close/${targetId}`, { signal: AbortSignal.timeout(8000) });
  return res.ok;
}
