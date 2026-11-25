/* 验证：跳过片头/片尾设置、选集切换、弹幕开关 */
const CDP = 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTarget() {
  const r = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  return r.json();
}
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

  console.log('== 1. 设置页');
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/settings' });
  await sleep(3000);
  console.log(await ev(`document.querySelector('#view').innerText.replace(/\\n+/g,' | ').slice(0,700)`));

  console.log('\n== 2. 打开跳过片头+片尾开关');
  console.log(await ev(`(()=>{
    const rows=[...document.querySelectorAll('.setting-row')];
    const res=[];
    for(const r of rows){
      const label=(r.querySelector('.setting-label')||{}).textContent||'';
      const sw=r.querySelector('.switch');
      if(!sw) continue;
      if(/跳过片头|跳过片尾/.test(label)){ sw.click(); res.push(label.trim()+' -> clicked'); }
    }
    return res.join(' ; ')||'没找到开关';
  })()`));
  await sleep(800);
  console.log('settings:', await ev(`localStorage.getItem('sg.settings.v1')`));

  console.log('\n== 3. 进播放页，检查是否自动跳片头');
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8787/#/play/guangsu/225090?ep=0&line=0' });
  await sleep(15000);
  console.log(await ev(`(()=>{const v=document.querySelector('video');
    return JSON.stringify({t:+v.currentTime.toFixed(1),dur:+v.duration.toFixed(1),rs:v.readyState});})()`));

  console.log('\n== 4. 切到第 2 集');
  console.log(await ev(`(()=>{
    const btns=[...document.querySelectorAll('.ep-btn')];
    if(btns.length<2) return 'episodes: '+btns.length;
    btns[1].click(); return '点击 '+btns[1].textContent.trim();})()`));
  await sleep(12000);
  console.log('epLabel:', await ev(`document.querySelector('.ep-label')?.textContent || document.querySelector('#epLabel')?.textContent || '?'`));
  console.log('video:', await ev(`(()=>{const v=document.querySelector('video');
    return JSON.stringify({t:+v.currentTime.toFixed(1),dur:+v.duration.toFixed(1),rs:v.readyState});})()`));

  console.log('\n== 5. 弹幕开关');
  console.log(await ev(`(()=>{const b=document.querySelector('#btnDm');
    if(!b) return 'no btnDm'; const before=b.className; b.click(); return before+' -> '+b.className;})()`));

  const errs = c.events.filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => (e.params.exceptionDetails.exception?.description || '').slice(0, 160));
  console.log('\nJS 异常:', errs.length ? [...new Set(errs)].slice(0,4).join(' | ') : '无');

  c.close();
  await fetch(`${CDP}/json/close/${t.id}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
