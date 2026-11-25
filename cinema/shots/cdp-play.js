/* 验证播放器：打开播放页，等 hls 起播，回报 video 状态 */
const path = require('path');
const CDP = 'http://127.0.0.1:9333';

async function newTarget() {
  const r = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  return r.json();
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ready, send, events, close: () => ws.close() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (c, expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

(async () => {
  const jobs = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  for (const j of jobs) {
    const t = await newTarget();
    const c = await connect(t.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    // 自动放行 video 静音播放限制
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__autoPlay = true;
        document.addEventListener('DOMContentLoaded', () => {
          const v = document.querySelector('video');
          if (v) v.muted = false;
        });`,
    });

    await c.send('Page.navigate', { url: j.url });
    await sleep(j.wait || 12000);

    const probe = await evalJs(c, `(() => {
      const v = document.querySelector('video');
      if (!v) return 'NO VIDEO ELEMENT';
      const hls = window.__hlsInfo || null;
      return JSON.stringify({
        src: (v.currentSrc || v.src || '').slice(0, 110),
        readyState: v.readyState,
        networkState: v.networkState,
        duration: Number.isFinite(v.duration) ? Math.round(v.duration) : String(v.duration),
        currentTime: Math.round(v.currentTime * 10) / 10,
        paused: v.paused,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        buffered: v.buffered.length ? Math.round(v.buffered.end(v.buffered.length-1)) : 0,
        error: v.error ? v.error.code + ':' + v.error.message : null,
        overlayHidden: document.querySelector('#overlay')?.classList.contains('hide'),
        ovMsg: document.querySelector('#ovMsg')?.textContent || '',
        epLabel: document.querySelector('#epLabel')?.textContent || '',
        dmCount: document.querySelectorAll('.danmaku-layer .dm').length,
      });
    })()`);
    console.log('===', j.file || j.url);
    console.log(probe);

    if (j.file) {
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(path.join(__dirname, j.file), Buffer.from(r.data, 'base64'));
    }

    const errs = [];
    for (const e of c.events) {
      if (e.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (e.params.exceptionDetails.exception?.description || '').slice(0, 200));
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') errs.push('LOG ' + e.params.entry.text.slice(0, 160));
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errs.push('CE ' + e.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 200));
    }
    if (errs.length) console.log('ERRORS:\n' + [...new Set(errs)].slice(0, 6).join('\n'));

    c.close();
    await fetch(`${CDP}/json/close/${t.id}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
