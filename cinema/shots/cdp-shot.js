/* 用 CDP 驱动 headless Chrome：打开页面、等渲染、截图、抓控制台错误 */
const fs = require('fs');
const path = require('path');

const CDP = 'http://127.0.0.1:9333';
const OUT = __dirname;

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
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(pageUrl, file, { w = 1440, h = 1000, wait = 6000, fullPage = false, scroll = 0, eval: expr = '' } = {}) {
  const t = await newTarget();
  const c = await connect(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: false,
  });
  await c.send('Page.navigate', { url: pageUrl });
  await sleep(wait);

  if (scroll) {
    await c.send('Runtime.evaluate', { expression: `window.scrollTo(0, ${scroll})` });
    await sleep(1200);
  }

  let clip;
  if (fullPage) {
    const m = await c.send('Page.getLayoutMetrics');
    const cs = m.cssContentSize;
    clip = { x: 0, y: 0, width: w, height: Math.min(cs.height, 6000), scale: 1 };
  }

  const r = await c.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: !!fullPage, ...(clip ? { clip } : {}),
  });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));

  // 收集 console 错误与页面异常
  const errs = [];
  for (const e of c.events) {
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      errs.push('console.error: ' + e.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (e.method === 'Runtime.exceptionThrown') {
      errs.push('exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));
    }
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      errs.push('log: ' + e.params.entry.text + ' ' + (e.params.entry.url || ''));
    }
  }

  // 抓 body 文本片段，确认数据真的渲染了
  const bodyTxt = await c.send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0,600)',
    returnByValue: true,
  });

  let evalRes = null;
  if (expr) {
    const r2 = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    evalRes = r2.exceptionDetails
      ? 'EXC: ' + (r2.exceptionDetails.exception?.description || r2.exceptionDetails.text)
      : r2.result.value;
  }

  c.close();
  await fetch(`${CDP}/json/close/${t.id}`);
  return { file, errs, text: bodyTxt.result.value, evalRes };
}

(async () => {
  const arg = process.argv[2] || '[]';
  let raw;
  const maybeFile = arg.replace(/^@/, '');
  if (arg.startsWith('@') || (fs.existsSync(maybeFile) && !arg.trimStart().startsWith('[') && !arg.trimStart().startsWith('{'))) {
    raw = JSON.parse(fs.readFileSync(maybeFile, 'utf8'));
  } else {
    raw = JSON.parse(arg);
  }
  // 支持纯数组，或 { viewport:{width,height}, jobs:[...] }
  const jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
  const vp = (!Array.isArray(raw) && raw.viewport) || {};
  for (const j of jobs) {
    const opts = { ...j, ...(vp.width ? { w: vp.width, h: vp.height } : {}) };
    const file = path.join(OUT, j.file || (j.name + '.png'));
    const r = await shot(j.url, file, opts);
    console.log('---', path.basename(file));
    if (r.errs.length) console.log('ERRORS:\n' + r.errs.slice(0, 8).join('\n'));
    else console.log('no console errors');
    console.log('TEXT:', JSON.stringify(r.text.slice(0, 260)));
    if (r.evalRes !== null) console.log('EVAL:', JSON.stringify(r.evalRes));
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
