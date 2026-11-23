export const PROXY_PREFIX = '/api/proxy'
export const PROXY_NEEDS_SCREEN = 'cookrew-proxy-needs-screen'
export const PROXY_READ = 'cookrew-proxy-read'
export const PROXY_NAVIGATE = 'cookrew-proxy-navigate'

export const PROXY_INIT = 'cookrew-proxy-init'

export const PROXY_SHIM = `(() => {
  const PREFIX = ${JSON.stringify(PROXY_PREFIX)};
  const CARD = document.documentElement.dataset.cookrewProxyCard || '';
  const BASE = document.documentElement.dataset.cookrewProxyUrl || document.baseURI;
  const frameRead = window.cookrewProxyRead;
  const realResponse = window.Response;
  const AT = (raw) => {
    try {
      if (raw.startsWith(PREFIX + '/' + CARD + '/')) return raw;
      const u = new URL(raw, BASE);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return PREFIX + '/' + CARD + '/' + btoa(unescape(encodeURIComponent(u.href))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    } catch (e) { return null }
  };
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : (input && input.url);
    const at = typeof raw === 'string' ? AT(raw) : null;
    if (!frameRead) return realFetch.call(this, at || input, init);
    if (!at) return realFetch.call(this, input, init);
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return unsupported();
    return frameRead(at, method).then(({ bytes, status, type }) => new realResponse(bytes, {
      status, headers: { 'content-type': type }
    }));
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const pending = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, async = true) {
    const at = typeof url === 'string' ? AT(url) : null;
    pending.delete(this);
    if (!at) return open.apply(this, arguments);
    if (!frameRead) return open.apply(this, [method, at, ...Array.prototype.slice.call(arguments, 2)]);
    const upper = String(method).toUpperCase();
    if (!async || upper !== 'GET') { say(); throw new Error('This request needs Screen.'); }
    pending.set(this, at);
    return open.call(this, 'GET', 'data:application/octet-stream,');
  };
  XMLHttpRequest.prototype.send = function () {
    const at = pending.get(this);
    if (!at) return send.apply(this, arguments);
    frameRead(at, 'GET').then(({ bytes, status, type }) => {
      if (pending.get(this) !== at || this.readyState !== 1) return;
      if (status < 200 || status >= 300) throw new Error('The page request failed.');
      const responseType = this.responseType;
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      this.addEventListener('loadend', () => URL.revokeObjectURL(url), { once: true });
      open.call(this, 'GET', url);
      this.responseType = responseType;
      send.call(this);
    }).catch(() => this.dispatchEvent(new ProgressEvent('error')));
  };
  const unsupported = () => {
    say();
    return Promise.reject(new TypeError('This request needs Screen.'));
  };
  const say = () => {
    window.cookrewProxyNotice?.();
    if (document.querySelector('[data-cookrew-needs-screen]')) return;
    const el = document.createElement('div');
    el.setAttribute('data-cookrew-needs-screen', '');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:10px 12px;font:13px system-ui;background:#fff3cd;color:#5a4300;z-index:2147483647';
    el.textContent = 'This page uses a live connection. Switch to Screen to use it.';
    document.documentElement.appendChild(el);
  };
  const RealWS = window.WebSocket;
  if (RealWS) {
    window.WebSocket = function (url, protocols) {
      say();
      return new RealWS(url, protocols);
    };
    window.WebSocket.prototype = RealWS.prototype;
  }
  const RealES = window.EventSource;
  if (RealES) {
    window.EventSource = function (url, init) {
      say();
      return new RealES(url, init);
    };
    window.EventSource.prototype = RealES.prototype;
  }
})();`

/** Fixed inline code for a blob frame, admitted by its hash on the console. */
export const PROXY_FRAME_SCRIPT = `(() => {
  const { port1, port2 } = new MessageChannel();
  const nonce = document.documentElement.dataset.cookrewProxyNonce;
  document.documentElement.removeAttribute('data-cookrew-proxy-nonce');
  parent.postMessage({ type: ${JSON.stringify(PROXY_INIT)}, nonce }, '*', [port2]);
  let nextRead = 0;
  const pending = new Map();
  port1.onmessage = ({ data }) => pending.get(data.id)?.(data.result);
  window.cookrewProxyRead = (path, method) => new Promise((resolve, reject) => {
    const id = ++nextRead;
    const finish = (result) => {
      clearTimeout(timer);
      pending.delete(id);
      if (result) resolve(result); else reject(new TypeError('The page request failed.'));
    };
    const timer = setTimeout(() => finish(null), 20000);
    pending.set(id, finish);
    port1.postMessage({ type: ${JSON.stringify(PROXY_READ)}, id, path, method });
  });
  window.cookrewProxyNotice = () => port1.postMessage({ type: ${JSON.stringify(PROXY_NEEDS_SCREEN)} });
  window.addEventListener('click', (event) => {
    if (!event.isTrusted || event.defaultPrevented) return;
    const link = event.target.closest?.('[data-cookrew-proxy-link]');
    if (!link) return;
    event.preventDefault();
    port1.postMessage({ type: ${JSON.stringify(PROXY_NAVIGATE)}, path: link.dataset.cookrewProxyLink });
  });
  window.addEventListener('submit', (event) => {
    event.preventDefault();
    window.cookrewProxyNotice();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const marker = document.querySelector('[data-cookrew-needs-screen]');
    if (marker) window.cookrewProxyNotice();
  }, { once: true });
})();\n${PROXY_SHIM}`

export const PROXY_FRAME_SCRIPT_HASH = "'sha256-sZdJbUH3axsGk/nfNp4iOeEg5QRjisHS8/fziGNefxk='"
