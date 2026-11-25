/* 深度功能验证：真实播放推进、弹幕收发、断点续播、收藏、跳过片头 */
const path = require('path');
const fs = require('fs');
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

(async () => {
  const t = await newTarget();
  const c = await connect(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  console.log('STEP 0 — 清空本机历史/收藏/设置，保证每次从干净状态开始');
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/home' });
  await sleep(2500);
  console.log('  已清空:', await ev(`(()=>{['sg.history.v1','sg.favorites.v1','sg.settings.v1'].forEach(k=>localStorage.removeItem(k));return 'ok';})()`));

  console.log('STEP 1 — 打开播放页');
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/play/guangsu/225090?ep=0&line=0' });
  await sleep(14000);

  console.log('  静音后强制播放…');
  console.log('  ', await ev(`(async()=>{const v=document.querySelector('video');v.muted=true;
    try{await v.play()}catch(e){return 'play fail: '+e.message}
    return 'play() ok';})()`));
  await sleep(6000);
  const t1 = await ev(`(()=>{const v=document.querySelector('video');
    return JSON.stringify({t:Math.round(v.currentTime*10)/10, paused:v.paused, rs:v.readyState,
      buf:v.buffered.length?Math.round(v.buffered.end(v.buffered.length-1)):0});})()`);
  console.log('  6s 后:', t1);

  await sleep(5000);
  const t2 = await ev(`(()=>{const v=document.querySelector('video');
    return JSON.stringify({t:Math.round(v.currentTime*10)/10, paused:v.paused});})()`);
  console.log('  再 5s:', t2);

  console.log('STEP 2 — 发送弹幕');
  console.log('  ', await ev(`(()=>{
    const i=document.querySelector('#dmText'); if(!i) return 'no input';
    i.value='测试弹幕-自动验证';
    document.querySelector('#dmSend').click(); return 'clicked';})()`));
  await sleep(2500);
  console.log('  屏幕上弹幕数:', await ev(`document.querySelectorAll('.danmaku-layer .dm').length`));
  const dmApi = await fetch('http://127.0.0.1:8787/api/danmaku?key=' + encodeURIComponent('guangsu:225090|0|0'));
  const dmJson = await dmApi.json();
  console.log('  服务端已存弹幕:', JSON.stringify(dmJson).slice(0, 220));

  console.log('STEP 3 — 进度落盘 + 收藏');
  console.log('  进度:', await ev(`(()=>{const h=JSON.parse(localStorage.getItem('sg.history.v1')||'[]');
    return JSON.stringify(h.map(x=>({n:x.name,ep:x.epName,t:Math.round(x.t),pct:+(x.percent*100).toFixed(1)})));})()`));
  console.log('  收藏:', await ev(`(()=>{document.querySelector('#favBtn2').click();
    return JSON.parse(localStorage.getItem('sg.favorites.v1')||'[]').length + ' 条';})()`));

  console.log('STEP 4 — 离开页面后重新进入，检查续播');
  const before = await ev(`(()=>{const h=JSON.parse(localStorage.getItem('sg.history.v1')||'[]');return JSON.stringify(h[0]||{}).slice(0,160);})()`);
  console.log('  记录:', before);
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/' });
  await sleep(3000);
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/play/guangsu/225090?ep=0&line=0' });
  await sleep(14000);
  console.log('  重进后 currentTime:', await ev(`Math.round(document.querySelector('video').currentTime)`),
    '| toast:', await ev(`document.querySelector('#toast')?.textContent||''`));

  console.log('STEP 5 — 个人中心浏览记录');
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/me?tab=history' });
  await sleep(4000);
  console.log('  ', await ev(`(()=>{const rows=document.querySelectorAll('.hist-row');
    return rows.length+' 行; 首行: '+(rows[0]?.innerText.replace(/\\n/g,' | ')||'');})()`));

  console.log('STEP 6 — 收藏页');
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/me?tab=fav' });
  await sleep(4000);
  console.log('  收藏卡片数:', await ev(`document.querySelectorAll('.grid .card').length`));

  const errs = [];
  for (const e of c.events) {
    if (e.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (e.params.exceptionDetails.exception?.description || '').slice(0, 200));
  }
  if (errs.length) console.log('页面异常:\n' + [...new Set(errs)].slice(0, 5).join('\n'));
  else console.log('无 JS 异常');

  c.close();
  await fetch(`${CDP}/json/close/${t.id}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
