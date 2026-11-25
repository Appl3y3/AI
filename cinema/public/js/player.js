/* ================================================================
   播放页：hls.js 播放、弹幕、跳过片头片尾、断点续播
   ================================================================ */
import { api, poster, streamUrl } from './api.js';
import { $, $$, esc, toast, imgTag, emptyHtml, itemKey } from './ui.js';
import {
  getSettings, setSettings, getHistoryOne, saveHistory, toggleFavorite, isFavorite, fmtTime,
} from './store.js';

let H = null;          // hls 实例
let currentCleanup = null;

export function destroyPlayer() {
  if (currentCleanup) { try { currentCleanup(); } catch (e) {} currentCleanup = null; }
  if (H) { try { H.destroy(); } catch (e) {} H = null; }
}

/* ================================================================ */
export async function renderPlayer(view, src, id, params) {
  destroyPlayer();
  const s = getSettings();
  view.innerHTML = `<div id="playerSlot" style="padding-top:6px">
    <div class="player-wrap"><div class="player-stage" style="display:grid;place-items:center">
      <div class="player-msg"><div class="spinner"></div><div>正在获取播放地址…</div></div>
    </div></div>
  </div>`;

  let data;
  try {
    data = await api.detail(src, id);
  } catch (e) {
    $('#playerSlot').innerHTML = emptyHtml('获取播放地址失败', e.message, '⚠️');
    return;
  }
  if (!data.ok || !data.lines || !data.lines.length) {
    $('#playerSlot').innerHTML = emptyHtml('该资源暂无可用线路',
      '可能只有网盘链接，或片源已下线。可以试试「换源」。', '📼');
    return;
  }

  const it = data.item;
  const key = itemKey(it);

  // 选线路：优先 URL 指定 > 历史 > 第一条直连
  const directIdx = data.lines.findIndex((l) => l.m3u8);
  let lineIndex = Number(params.get('line'));
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= data.lines.length) {
    const h = getHistoryOne(key);
    lineIndex = h && data.lines[h.lineIndex] ? h.lineIndex : Math.max(0, directIdx);
  }
  let line = data.lines[lineIndex];

  let epIndex = Number(params.get('ep'));
  if (!Number.isInteger(epIndex) || epIndex < 0 || epIndex >= line.episodes.length) {
    const h = getHistoryOne(key);
    epIndex = h && h.lineIndex === lineIndex && h.epIndex < line.episodes.length ? h.epIndex : 0;
  }

  const hist = getHistoryOne(key);
  const startAt = hist && hist.lineIndex === lineIndex && hist.epIndex === epIndex ? hist.t || 0 : 0;

  // ---------------- 绘制骨架 ----------------
  view.innerHTML = `
    <div class="player-page">
      <div class="player-wrap">
        <div class="player-stage" id="stage">
          <video id="video" playsinline webkit-playsinline preload="metadata"
            poster="${esc(poster(it.pic, it.name))}"></video>
          <div class="danmaku-layer" id="dmLayer"></div>
          <div class="player-overlay" id="overlay">
            <div class="player-msg"><div class="spinner"></div><div id="ovMsg">正在载入视频…</div></div>
          </div>
        </div>
        <div class="pctrl">
          <div class="pctrl-row" style="margin-bottom:8px">
            <input type="range" class="pseek" id="seek" min="0" max="1000" value="0" step="1" />
          </div>
          <div class="pctrl-row">
            <button class="pbtn" id="btnPlay" title="播放/暂停">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="pbtn" id="btnPrev" title="上一集">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
            </button>
            <button class="pbtn" id="btnNext" title="下一集">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>
            </button>
            <span class="ptime" id="tCur">00:00</span>
            <span class="muted" style="font-size:12px">/</span>
            <span class="ptime" id="tDur">00:00</span>
            <div style="flex:1"></div>
            <button class="pbtn ${s.danmakuOn ? 'on' : ''}" id="btnDm" title="弹幕开关">
              <svg viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M3 4h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-7l-4 3v-3H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/></svg>
            </button>
            <select class="pspeed" id="speed" title="倍速">
              ${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => `<option value="${r}" ${Math.abs(r - (s.rememberRate ? s.lastRate : 1)) < 0.01 ? 'selected' : ''}>${r}x</option>`).join('')}
            </select>
            <select class="pvol" id="vol" title="音量">
              ${[1, 0.8, 0.6, 0.4, 0.2, 0].map((v) => `<option value="${v}" ${Math.abs(v - s.defaultVolume) < 0.01 ? 'selected' : ''}>${v === 0 ? '静音' : Math.round(v * 100) + '%'}</option>`).join('')}
            </select>
            <button class="pbtn" id="btnFull" title="全屏">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9V4h5v2H6v3H4Zm16 0h-2V6h-3V4h5v5ZM4 15h2v3h3v2H4v-5Zm14 3v-3h2v5h-5v-2h3Z"/></svg>
            </button>
            <a class="pbtn" href="#/detail/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}" data-link title="返回详情">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>
            </a>
          </div>
        </div>
      </div>

      <div class="player-meta">
        <div>
          <h1 class="player-title">${esc(it.name)}</h1>
          <div class="player-ep" id="epLabel">${esc(line.name)} · ${esc(line.episodes[epIndex].name)}</div>
        </div>
        <div class="player-tools">
          <button class="btn btn-sm btn-line" id="favBtn2">${isFavorite(key) ? '★ 已收藏' : '☆ 收藏'}</button>
          <button class="btn btn-sm btn-line" id="lineBtn">线路 ${lineIndex + 1}/${data.lines.length}</button>
          <button class="btn btn-sm btn-line" id="epListBtn">选集 ${epIndex + 1}/${line.episodes.length}</button>
          ${data.others && data.others.length ? `<button class="btn btn-sm btn-line" id="switchBtn2">换源 (${data.others.length})</button>` : ''}
        </div>
      </div>

      <div class="dm-send">
        <input type="text" id="dmText" placeholder="发条弹幕，和大家一起看…" maxlength="60" />
        <input type="color" class="dm-color" id="dmColor" value="#ffffff" title="弹幕颜色" />
        <select class="dm-mode" id="dmMode">
          <option value="rtl">滚动</option>
          <option value="top">顶部</option>
          <option value="bottom">底部</option>
        </select>
        <button class="btn btn-sm btn-primary" id="dmSend">发送</button>
      </div>

      <div id="switchSlot"></div>
    </div>`;

  const video = $('#video');
  const overlay = $('#overlay');
  const ovMsg = $('#ovMsg');

  // ---------------- 弹幕 ----------------
  const dmLayer = $('#dmLayer');
  let dmOn = s.danmakuOn;
  let dmList = [];
  let dmIndex = 0;
  let dmTimer = null;
  let laneBusy = {};   // 轨道占用时间

  function dmKey() {
    return `${key}|${lineIndex}|${epIndex}`;
  }

  async function loadDanmaku() {
    try {
      const r = await api.danmakuGet(dmKey());
      dmList = (r.list || []).sort((a, b) => a.t - b.t);
      dmIndex = 0;
    } catch (e) { dmList = []; }
  }

  function spawnDm(d) {
    if (!dmLayer || dmLayer.children.length > 90) return;
    const el = document.createElement('div');
    el.className = 'dm';
    el.textContent = d.text;
    el.style.color = d.color || '#fff';
    el.style.fontSize = `${s.danmakuSize}px`;
    el.style.opacity = String(s.danmakuOpacity);

    const stageW = dmLayer.clientWidth || 800;
    const stageH = dmLayer.clientHeight || 450;

    if (d.mode === 'top' || d.mode === 'bottom') {
      const lanes = Math.max(1, Math.floor(stageH / 44));
      const lane = Math.floor(Math.random() * Math.min(lanes, 6));
      el.style.top = d.mode === 'top'
        ? `${8 + lane * 30}px`
        : `${stageH - 40 - lane * 30}px`;
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
      el.style.animation = 'none';
      dmLayer.appendChild(el);
      setTimeout(() => el.remove(), 4200);
      return;
    }

    const lanes = Math.max(1, Math.floor(stageH / 40));
    let lane = 0;
    for (let i = 0; i < Math.min(lanes, 10); i++) {
      if (!laneBusy[i] || laneBusy[i] < Date.now()) { lane = i; break; }
      lane = i;
    }
    laneBusy[lane] = Date.now() + 2400;
    el.style.top = `${6 + lane * 30}px`;

    dmLayer.appendChild(el);
    const dist = stageW + el.offsetWidth + 40;
    el.style.setProperty('--dist', `-${dist}px`);
    el.style.animation = `dm-rtl ${6 + Math.random() * 2}s linear forwards`;
    setTimeout(() => el.remove(), 9000);
  }

  function tickDm() {
    if (!video || video.paused) return;
    const t = video.currentTime;
    while (dmIndex < dmList.length && dmList[dmIndex].t <= t) {
      const d = dmList[dmIndex];
      dmIndex++;
      if (dmOn && t - d.t < 1.2) spawnDm(d);
    }
  }
  dmTimer = setInterval(tickDm, 220);

  // 跳转后重置弹幕指针
  function resetDmIndex() {
    dmIndex = 0;
    while (dmIndex < dmList.length && dmList[dmIndex].t < video.currentTime) dmIndex++;
  }

  // ---------------- 播放核心 ----------------
  let epDur = 0;
  let lastSave = 0;
  let lastHistSave = 0;

  function loadStream(rawUrl, { autoplay = true, seekTo = 0 } = {}) {
    overlay.classList.remove('hide');
    ovMsg.textContent = '正在载入视频…';

    // 统一走本地代理：源站普遍没有 CORS 头
    const url = streamUrl(rawUrl);

    // 非 m3u8 / mp4 的是「网页分享页」，浏览器不能直接播
    if (!/\.m3u8(\?|$)/i.test(rawUrl) && !/\.mp4(\?|$)/i.test(rawUrl)) {
      overlay.classList.remove('hide');
      const sp = $('#overlay .spinner');
      if (sp) sp.remove();
      ovMsg.textContent = '这条线路是网页分享页，无法直接播放，请在「线路」里换一条带 ● 直连 标记的';
      return;
    }

    // mp4 直接 src
    if (/\.mp4(\?|$)/i.test(rawUrl)) {
      video.src = url;
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      if (autoplay) video.play().catch(() => {});
      return;
    }

    if (H) { H.destroy(); H = null; }

    if (window.Hls && window.Hls.isSupported()) {
      H = new window.Hls({
        maxBufferLength: 40,
        maxMaxBufferLength: 90,
        enableWorker: true,
        lowLatencyMode: false,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 30000,
      });
      H.loadSource(url);
      H.attachMedia(video);
      H.on(window.Hls.Events.MANIFEST_PARSED, () => {
        overlay.classList.add('hide');
        if (autoplay) video.play().catch(() => {});
        if (seekTo > 1) video.currentTime = seekTo;
      });
      H.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          ovMsg.textContent = '网络中断，正在重试…';
          setTimeout(() => { try { H.startLoad(); } catch (e) {} }, 1200);
        } else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { H.recoverMediaError(); } catch (e) {}
        } else {
          overlay.classList.remove('hide');
          ovMsg.textContent = '该线路播放失败，请换一条线路或换源';
          $('#overlay .spinner')?.remove();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      if (autoplay) video.play().catch(() => {});
    } else {
      ovMsg.textContent = '当前浏览器不支持 HLS 播放';
    }
  }

  function onMeta() {
    overlay.classList.add('hide');
    epDur = video.duration || 0;
    $('#tDur').textContent = fmtTime(epDur);
    if (startAt > 1 && startAt < epDur - 10) {
      video.currentTime = startAt;
      toast(`已续播至 ${fmtTime(startAt)}`);
    }
    if (s.skipIntro && s.introSeconds > 0 && video.currentTime < 5) {
      video.currentTime = Math.min(s.introSeconds, Math.max(0, epDur - 5));
      toast(`已跳过片头 ${s.introSeconds}s`);
    }
    video.volume = Number(s.defaultVolume);
    if (s.rememberRate) video.playbackRate = Number(s.lastRate) || 1;
  }

  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('error', () => {
    overlay.classList.remove('hide');
    ovMsg.textContent = '视频加载失败，请尝试换线路或换源';
  });
  video.addEventListener('waiting', () => {
    if (!overlay.classList.contains('hide')) return;
  });
  video.addEventListener('playing', () => {
    overlay.classList.add('hide');
  });

  // 进度 / 片尾跳过 / 自动连播
  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const p = video.currentTime / video.duration;
    const seek = $('#seek');
    if (seek && document.activeElement !== seek) seek.value = String(Math.round(p * 1000));
    $('#tCur').textContent = fmtTime(video.currentTime);

    // 片尾跳过
    if (s.skipOutro && s.outroSeconds > 0 && video.duration > s.outroSeconds + 10) {
      if (video.currentTime >= video.duration - s.outroSeconds) {
        if (s.autoplayNext) goNext(true);
        else video.pause();
        return;
      }
    }

    // 进度回写（每 4 秒）
    const now = Date.now();
    if (now - lastHistSave > 4000) {
      lastHistSave = now;
      saveHistory({
        key, src: it.src, id: it.id, name: it.name, pic: it.pic,
        year: it.year, area: it.area,
        epName: line.episodes[epIndex].name,
        epIndex, lineIndex, epCount: line.episodes.length,
        t: video.currentTime, dur: video.duration || 0, percent: p,
      });
    }
  });

  video.addEventListener('ended', () => {
    saveHistory({
      key, src: it.src, id: it.id, name: it.name, pic: it.pic,
      year: it.year, area: it.area,
      epName: line.episodes[epIndex].name,
      epIndex, lineIndex, epCount: line.episodes.length,
      t: video.duration, dur: video.duration, percent: 1,
    });
    if (s.autoplayNext) goNext(true);
  });

  video.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });

  // ---------------- 控制条 ----------------
  const btnPlay = $('#btnPlay');
  const PLAY_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

  btnPlay.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener('play', () => { btnPlay.innerHTML = PAUSE_SVG; });
  video.addEventListener('pause', () => { btnPlay.innerHTML = PLAY_SVG; });

  $('#seek').addEventListener('input', (e) => {
    if (!video.duration) return;
    video.currentTime = (Number(e.target.value) / 1000) * video.duration;
  });
  $('#seek').addEventListener('change', resetDmIndex);

  $('#speed').addEventListener('change', (e) => {
    const r = Number(e.target.value);
    video.playbackRate = r;
    setSettings({ lastRate: r });
  });
  $('#vol').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    video.volume = v;
    video.muted = v === 0;
    setSettings({ defaultVolume: v });
  });

  $('#btnFull').addEventListener('click', () => {
    const stage = $('#stage');
    if (!document.fullscreenElement) {
      (stage.requestFullscreen ? stage.requestFullscreen() : stage.webkitRequestFullscreen?.());
    } else {
      document.exitFullscreen?.();
    }
  });

  $('#btnDm').addEventListener('click', (e) => {
    dmOn = !dmOn;
    e.currentTarget.classList.toggle('on', dmOn);
    setSettings({ danmakuOn: dmOn });
    if (!dmOn) dmLayer.innerHTML = '';
  });

  // 选集 / 线路 / 换源 / 收藏
  function goNext(auto) {
    if (epIndex + 1 < line.episodes.length) {
      location.hash = `#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=${epIndex + 1}&line=${lineIndex}`;
      if (auto) toast('自动播放下一集');
    } else if (auto) {
      toast('已经是最后一集了');
    }
  }
  function goPrev() {
    if (epIndex > 0) {
      location.hash = `#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=${epIndex - 1}&line=${lineIndex}`;
    } else toast('已经是第一集了');
  }
  $('#btnNext').addEventListener('click', () => goNext(false));
  $('#btnPrev').addEventListener('click', goPrev);

  $('#favBtn2').addEventListener('click', (e) => {
    const on = toggleFavorite({
      key, src: it.src, id: it.id, name: it.name, pic: it.pic,
      year: it.year, area: it.area, type: it.type, remarks: it.remarks,
    });
    e.currentTarget.textContent = on ? '★ 已收藏' : '☆ 收藏';
    toast(on ? '已加入收藏' : '已取消收藏');
  });

  $('#epListBtn').addEventListener('click', async () => {
    const { openModal } = await import('./ui.js');
    const h = getHistoryOne(key);
    const body = `<div class="episodes" style="max-height:none">
      ${line.episodes.map((ep, i) => `<a class="ep-btn ${i === epIndex ? 'on' : ''}"
        href="#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=${i}&line=${lineIndex}" data-link>
        ${esc(ep.name)}${h && h.lineIndex === lineIndex && h.epIndex === i ? '<span class="pdot"></span>' : ''}
      </a>`).join('')}
    </div>`;
    const mask = openModal(`选集 · ${it.name}`, body);
    mask.addEventListener('click', (e) => {
      if (e.target.closest('a.ep-btn')) mask.remove();
    });
  });

  $('#lineBtn').addEventListener('click', async () => {
    const { openModal } = await import('./ui.js');
    const body = data.lines.map((l, i) => `
      <div class="src-row" data-i="${i}">
        <div class="src-row-info">
          <div class="src-row-name">${esc(l.name)} ${l.m3u8 ? '<span style="color:#4ade80">● 直连</span>' : '<span class="muted">○ 需解析</span>'}</div>
          <div class="src-row-meta">${l.episodes.length} 集</div>
        </div>
        <span class="btn btn-sm ${i === lineIndex ? 'btn-primary' : 'btn-line'}">${i === lineIndex ? '当前' : '切换'}</span>
      </div>`).join('');
    const mask = openModal('选择播放线路', body);
    mask.querySelectorAll('.src-row').forEach((row) => {
      row.addEventListener('click', () => {
        const i = Number(row.dataset.i);
        location.hash = `#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=0&line=${i}`;
        mask.remove();
      });
    });
  });

  const sb2 = $('#switchBtn2');
  if (sb2) {
    sb2.addEventListener('click', async () => {
      const { openModal } = await import('./ui.js');
      const body = data.others.map((o, i) => `
        <div class="src-row" data-i="${i}">
          <div class="src-row-poster">${imgTag(o.pic, o.name)}</div>
          <div class="src-row-info">
            <div class="src-row-name">${esc(o.name)}</div>
            <div class="src-row-meta">${esc(o.type || '')} ${o.year ? '· ' + esc(o.year) : ''} · ${o.epCount} 集</div>
          </div>
          <span class="btn btn-sm btn-line">选</span>
        </div>`).join('');
      const mask = openModal('换源播放', body);
      mask.querySelectorAll('.src-row').forEach((row) => {
        row.addEventListener('click', () => {
          const o = data.others[Number(row.dataset.i)];
          location.hash = `#/detail/${encodeURIComponent(o.src)}/${encodeURIComponent(o.id)}`;
          mask.remove();
        });
      });
    });
  }

  // 发送弹幕
  const dmText = $('#dmText');
  async function sendDm() {
    const text = dmText.value.trim();
    if (!text) return;
    const payload = {
      text,
      t: video.currentTime || 0,
      color: $('#dmColor').value,
      mode: $('#dmMode').value,
    };
    dmText.value = '';
    try {
      await api.danmakuPost(dmKey(), payload);
      dmList.push({ ...payload, t: payload.t });
      dmList.sort((a, b) => a.t - b.t);
      // 立刻在屏幕上显示一次
      if (dmOn) spawnDm({ ...payload, color: payload.color });
      toast('弹幕已发送');
    } catch (e) {
      toast('发送失败：' + e.message);
    }
  }
  $('#dmSend').addEventListener('click', sendDm);
  dmText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendDm(); }
  });

  // 快捷键
  const keyHandler = (e) => {
    if (/input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); if (video.paused) video.play(); else video.pause(); }
    else if (e.key === 'ArrowRight') { video.currentTime += 5; resetDmIndex(); }
    else if (e.key === 'ArrowLeft') { video.currentTime -= 5; resetDmIndex(); }
    else if (e.key === 'ArrowUp') { video.volume = Math.min(1, video.volume + 0.1); }
    else if (e.key === 'ArrowDown') { video.volume = Math.max(0, video.volume - 0.1); }
    else if (e.key === 'f' || e.key === 'F') { $('#btnFull').click(); }
  };
  document.addEventListener('keydown', keyHandler);

  // 进入时先存一条记录（保证「浏览记录」立刻有）
  saveHistory({
    key, src: it.src, id: it.id, name: it.name, pic: it.pic,
    year: it.year, area: it.area,
    epName: line.episodes[epIndex].name,
    epIndex, lineIndex, epCount: line.episodes.length,
    t: startAt, dur: 0, percent: startAt > 0 ? 0.001 : 0,
  });

  await loadDanmaku();
  loadStream(line.episodes[epIndex].url, { autoplay: true, seekTo: startAt });

  currentCleanup = () => {
    clearInterval(dmTimer);
    document.removeEventListener('keydown', keyHandler);
    if (video && video.duration) {
      saveHistory({
        key, src: it.src, id: it.id, name: it.name, pic: it.pic,
        year: it.year, area: it.area,
        epName: line.episodes[epIndex].name,
        epIndex, lineIndex, epCount: line.episodes.length,
        t: video.currentTime, dur: video.duration,
        percent: video.currentTime / video.duration,
      });
    }
    try { video.pause(); } catch (e) {}
  };
}
