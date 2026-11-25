/* ================================================================
   个人中心 / 设置
   ================================================================ */
import { $, $$, esc, gridHtml, emptyHtml, imgTag, toast, markNav, itemKey } from './ui.js';
import {
  getSettings, setSettings, getHistory, removeHistory, clearHistory,
  getFavorites, removeFavorite, relTime, fmtTime, recentList,
} from './store.js';

/* ================================================================
   个人中心
   ================================================================ */
export function renderMe(view, params) {
  markNav('me');
  const tab = params.get('tab') || 'history';
  const history = getHistory();
  const favs = getFavorites();

  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">个人中心</h1>
      <div class="page-sub">播放记录与收藏都存在本机浏览器，不上传</div>
    </div>

    <div class="filters" style="padding:8px 12px">
      <div class="filter-opts">
        <a class="chip ${tab === 'history' ? 'on' : ''}" href="#/me?tab=history" data-link>浏览记录 (${history.length})</a>
        <a class="chip ${tab === 'fav' ? 'on' : ''}" href="#/me?tab=fav" data-link>我的收藏 (${favs.length})</a>
        <a class="chip ${tab === 'stats' ? 'on' : ''}" href="#/me?tab=stats" data-link>统计</a>
      </div>
    </div>

    <div id="meBody"></div>`;

  const body = $('#meBody');

  if (tab === 'fav') {
    body.innerHTML = favs.length
      ? gridHtml(favs)
      : emptyHtml('还没有收藏', '在详情页点「☆ 收藏」把喜欢的片子存下来', '⭐');
    return;
  }

  if (tab === 'stats') {
    const totalSec = history.reduce((a, x) => a + (x.t || 0), 0);
    const finished = history.filter((x) => (x.percent || 0) > 0.95).length;
    const cats = {};
    history.forEach((x) => { if (x.area) cats[x.area] = (cats[x.area] || 0) + 1; });
    body.innerHTML = `
      <div class="panel">
        <h3 class="panel-title">观看统计</h3>
        <div class="panel-desc">仅统计本机记录</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:14px">
          <div><div style="font-size:24px;font-weight:800;color:var(--accent-2)">${history.length}</div><div class="muted small">部影片</div></div>
          <div><div style="font-size:24px;font-weight:800;color:var(--gold)">${Math.round(totalSec / 60)}</div><div class="muted small">分钟观看</div></div>
          <div><div style="font-size:24px;font-weight:800;color:#4ade80">${finished}</div><div class="muted small">部已看完</div></div>
          <div><div style="font-size:24px;font-weight:800">${favs.length}</div><div class="muted small">部收藏</div></div>
        </div>
      </div>`;
    return;
  }

  // 浏览记录
  if (!history.length) {
    body.innerHTML = emptyHtml('还没有观看记录', '播放任意影片后，这里会自动记录进度', '🕘');
    return;
  }

  body.innerHTML = `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div>
          <h3 class="panel-title">浏览记录</h3>
          <div class="panel-desc">点击任意条目可继续播放上次的进度</div>
        </div>
        <button class="btn btn-sm btn-line" id="clearBtn">清空</button>
      </div>
      ${history.map((h) => histRow(h)).join('')}
    </div>`;

  $('#clearBtn').addEventListener('click', () => {
    if (confirm('确定清空全部浏览记录？')) {
      clearHistory();
      toast('已清空');
      renderMe(view, params);
    }
  });

  $$('.hist-del', body).forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeHistory(b.dataset.key);
      toast('已删除');
      renderMe(view, params);
    });
  });
}

function histRow(h) {
  const pct = Math.min(100, Math.round((h.percent || 0) * 100));
  const resume = h.percent > 0.005 && h.percent < 0.995;
  const href = `#/play/${encodeURIComponent(h.src)}/${encodeURIComponent(h.id)}?ep=${h.epIndex || 0}&line=${h.lineIndex || 0}`;
  return `<a class="hist-row" href="${href}" data-link>
    <div class="hist-poster">${imgTag(h.pic, h.name)}</div>
    <div class="hist-info">
      <div class="hist-name">${esc(h.name)}</div>
      <div class="hist-ep">${esc(h.epName || '')} · ${fmtTime(h.t || 0)}${h.dur ? ' / ' + fmtTime(h.dur) : ''}</div>
      <div class="hist-bar"><i style="width:${pct}%"></i></div>
      <div class="hist-time">${relTime(h.updatedAt)} · 已看 ${pct}%${resume ? ' · 可续播' : (pct >= 99 ? ' · 已看完' : '')}</div>
    </div>
    <button class="hist-del" data-key="${esc(h.key)}" title="删除记录">✕</button>
  </a>`;
}

/* ================================================================
   设置
   ================================================================ */
export function renderSettings(view) {
  markNav('settings');
  const s = getSettings();

  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">设置</h1>
      <div class="page-sub">配置保存在浏览器本地</div>
    </div>

    <div class="panel">
      <h3 class="panel-title">播放</h3>
      <div class="panel-desc">跳过片头片尾的时长按秒计算</div>

      <div class="setting-row">
        <div>
          <div class="setting-label">自动跳过片头</div>
          <div class="setting-hint">开始播放后自动快进到指定秒数</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="skipIntro" ${s.skipIntro ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>

      <div class="setting-row" id="introRow" style="${s.skipIntro ? '' : 'opacity:.45'}">
        <div>
          <div class="setting-label">片头时长</div>
          <div class="setting-hint">自动跳过的秒数</div>
        </div>
        <input type="number" class="num-input" id="introSeconds" min="0" max="600" value="${s.introSeconds}" />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">自动跳过片尾</div>
          <div class="setting-hint">播放到剩余指定秒数时跳到下一集</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="skipOutro" ${s.skipOutro ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>

      <div class="setting-row" id="outroRow" style="${s.skipOutro ? '' : 'opacity:.45'}">
        <div>
          <div class="setting-label">片尾时长</div>
          <div class="setting-hint">提前多少秒结束</div>
        </div>
        <input type="number" class="num-input" id="outroSeconds" min="0" max="600" value="${s.outroSeconds}" />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">自动连播下一集</div>
          <div class="setting-hint">一集播完自动接着下一集</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="autoplayNext" ${s.autoplayNext ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">记住播放速度</div>
          <div class="setting-hint">下次播放沿用上次的倍速</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="rememberRate" ${s.rememberRate ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>
    </div>

    <div class="panel">
      <h3 class="panel-title">弹幕</h3>
      <div class="panel-desc">弹幕保存在本机，你和同一个浏览器的其他人都能看到</div>

      <div class="setting-row">
        <div>
          <div class="setting-label">默认开启弹幕</div>
          <div class="setting-hint">进入播放页时是否显示弹幕</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="danmakuOn" ${s.danmakuOn ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">弹幕字号</div>
          <div class="setting-hint">${s.danmakuSize}px</div>
        </div>
        <input type="range" min="12" max="30" value="${s.danmakuSize}" id="danmakuSize" style="width:150px" />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">弹幕不透明度</div>
          <div class="setting-hint">${Math.round(s.danmakuOpacity * 100)}%</div>
        </div>
        <input type="range" min="20" max="100" value="${Math.round(s.danmakuOpacity * 100)}" id="danmakuOpacity" style="width:150px" />
      </div>
    </div>

    <div class="panel">
      <h3 class="panel-title">数据</h3>
      <div class="panel-desc">所有数据只存在这台电脑的浏览器里</div>
      <div class="setting-row">
        <div>
          <div class="setting-label">记住浏览记录</div>
          <div class="setting-hint">关闭后不再记录观看进度</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="saveHistory" ${s.saveHistory ? 'checked' : ''} />
          <span class="track"></span>
        </label>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">清空所有本地数据</div>
          <div class="setting-hint">包括记录、收藏、设置</div>
        </div>
        <button class="btn btn-sm btn-line" id="resetAll">清空</button>
      </div>
    </div>`;

  // 绑定
  const bindSwitch = (id, key, cb) => {
    const el = $('#' + id);
    if (!el) return;
    el.addEventListener('change', () => {
      setSettings({ [key]: el.checked });
      if (cb) cb(el.checked);
    });
  };

  bindSwitch('skipIntro', 'skipIntro', (on) => {
    $('#introRow').style.opacity = on ? '1' : '.45';
  });
  bindSwitch('skipOutro', 'skipOutro', (on) => {
    $('#outroRow').style.opacity = on ? '1' : '.45';
  });
  bindSwitch('autoplayNext', 'autoplayNext');
  bindSwitch('rememberRate', 'rememberRate');
  bindSwitch('danmakuOn', 'danmakuOn');
  bindSwitch('saveHistory', 'saveHistory');

  $('#introSeconds').addEventListener('change', (e) => {
    setSettings({ introSeconds: Math.max(0, Math.min(600, Number(e.target.value) || 0)) });
    toast('已保存');
  });
  $('#outroSeconds').addEventListener('change', (e) => {
    setSettings({ outroSeconds: Math.max(0, Math.min(600, Number(e.target.value) || 0)) });
    toast('已保存');
  });
  $('#danmakuSize').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    setSettings({ danmakuSize: v });
    e.target.closest('.setting-row').querySelector('.setting-hint').textContent = v + 'px';
  });
  $('#danmakuOpacity').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    setSettings({ danmakuOpacity: v });
    e.target.closest('.setting-row').querySelector('.setting-hint').textContent = Math.round(v * 100) + '%';
  });

  $('#resetAll').addEventListener('click', () => {
    if (!confirm('确定清空所有本地数据？此操作不可恢复。')) return;
    try {
      localStorage.removeItem('sg.history.v1');
      localStorage.removeItem('sg.favorites.v1');
      localStorage.removeItem('sg.settings.v1');
    } catch (e) {}
    toast('已清空');
    renderSettings(view);
  });
}
