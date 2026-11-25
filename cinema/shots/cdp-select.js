/* 验证播放器选集弹窗、线路切换、连续播放 */
const CDP = 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTarget() { const r = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' }); return r.json(); }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const events = [];
  const ready = new Promise((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ready, send, events, close: () => ws.close() };
}

(async () => {
  const t = await newTarget();
  const c = await connect(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // 先关掉跳片头，避免干扰选集测试
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/play/guangsu/225090?ep=0&line=0' });
  await sleep(3000);
  await ev(`localStorage.setItem('sg.settings.v1', JSON.stringify({...JSON.parse(localStorage.getItem('sg.settings.v1')||'{}'), skipIntro:false, skipOutro:false}))`);

  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/play/guangsu/225090?ep=0&line=0' });
  await sleep(15000);
  console.log('起播:', await ev(`(()=>{const v=document.querySelector('video');
    return JSON.stringify({t:+v.currentTime.toFixed(1),dur:+v.duration.toFixed(1),rs:v.readyState});})()`));

  console.log('\n== 选集弹窗');
  console.log(await ev(`(()=>{document.querySelector('#epListBtn').click(); return 'opened';})()`));
  await sleep(1200);
  console.log('弹窗标题:', await ev(`document.querySelector('.modal-head')?.textContent || document.querySelector('.modal-title')?.textContent || '?'`));
  console.log('集数:', await ev(`document.querySelectorAll('.ep-btn').length`));
  console.log('点第5集:', await ev(`(()=>{const b=[...document.querySelectorAll('.ep-btn')][4];
    if(!b) return 'no ep5'; const t=b.textContent.trim(); b.click(); return t;})()`));
  await sleep(14000);
  console.log('epLabel:', await ev(`document.querySelector('#epLabel').textContent`));
  console.log('video:', await ev(`(()=>{const v=document.querySelector('video');
    return JSON.stringify({t:+v.currentTime.toFixed(1),dur:+v.duration.toFixed(1),rs:v.readyState});})()`));
  console.log('hash:', await ev('location.hash'));
  console.log('历史:', await ev(`(()=>{const h=JSON.parse(localStorage.getItem('sg.history.v1')||'[]');
    return JSON.stringify(h.map(x=>({ep:x.epName,i:x.epIndex,t:Math.round(x.t)})));})()`));

  console.log('\n== 线路切换');
  console.log(await ev(`(()=>{document.querySelector('#lineBtn').click(); return 'opened';})()`));
  await sleep(1200);
  console.log('线路数:', await ev(`document.querySelectorAll('.src-row').length`));
  console.log('线路列表:', await ev(`[...document.querySelectorAll('.src-row-name')].map(x=>x.innerText.replace(/\\n/g,' ')).join(' || ')`));

  const errs = c.events.filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => (e.params.exceptionDetails.exception?.description || '').slice(0, 160));
  console.log('\nJS 异常:', errs.length ? [...new Set(errs)].slice(0,4).join(' | ') : '无');

  c.close();
  await fetch(`${CDP}/json/close/${t.id}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
