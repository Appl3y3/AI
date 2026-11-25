/* ================================================================
   路由与启动
   ================================================================ */
import { renderHome, renderBrowse, renderTopic, renderSchedule, renderSearch, renderDetail } from './pages.js';
import { renderPlayer, destroyPlayer } from './player.js';
import { renderMe, renderSettings } from './me.js';
import { $, setScrollProgress, toast, closeModal } from './ui.js';

const view = $('#view');

/** 解析 "#/path?query" */
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
  const qs = qi >= 0 ? raw.slice(qi + 1) : '';
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { parts, params: new URLSearchParams(qs) };
}

let busy = false;

async function route() {
  const { parts, params } = parseHash();
  const name = parts[0] || 'home';

  // 离开播放页要销毁播放器，防止音频继续播
  if (name !== 'play') destroyPlayer();
  closeModal();

  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  try {
    if (name === 'home' || !parts.length) {
      await renderHome(view);
    } else if (name === 'browse') {
      // 兼容 #/browse/movie 与 #/browse?cat=movie 两种写法
      if (parts[1] && !params.get('cat')) params.set('cat', parts[1]);
      await renderBrowse(view, params);
    } else if (name === 'topic') {
      await renderTopic(view, parts[1] || 'tokusatsu');
    } else if (name === 'schedule') {
      await renderSchedule(view, params);
    } else if (name === 'search') {
      await renderSearch(view, params);
    } else if (name === 'detail') {
      await renderDetail(view, parts[1] || '', parts[2] || '');
    } else if (name === 'play') {
      await renderPlayer(view, parts[1] || '', parts[2] || '', params);
    } else if (name === 'me') {
      renderMe(view, params);
    } else if (name === 'settings') {
      renderSettings(view);
    } else {
      view.innerHTML = `<div class="empty"><div class="empty-icon">🧭</div><h3>页面不存在</h3>
        <p><a href="#/" data-link style="color:var(--accent-2)">回到首页</a></p></div>`;
    }
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>页面出错</h3><p>${String(e.message || e)}</p></div>`;
  }

  // 高亮搜索框
  const kw = params.get('kw');
  if (name === 'search' && kw) $('#globalSearch').value = kw;
}

window.addEventListener('hashchange', () => {
  if (busy) return;
  route();
});

window.addEventListener('scroll', setScrollProgress, { passive: true });

document.addEventListener('DOMContentLoaded', () => {
  // 全局搜索
  const input = $('#globalSearch');
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    const kw = input.value.trim();
    if (!kw) return;
    t = setTimeout(() => {
      if (location.hash.startsWith('#/search')) {
        // 已在搜索页，直接原地刷新
        location.hash = `#/search?kw=${encodeURIComponent(kw)}`;
      }
    }, 500);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const kw = input.value.trim();
      if (kw) location.hash = `#/search?kw=${encodeURIComponent(kw)}`;
      input.blur();
    }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });

  // "/" 聚焦搜索
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });

  // 健康检查
  fetch('/api/health').then((r) => r.json()).then((h) => {
    const fs = $('#footerStatus');
    if (fs && h.ok) fs.textContent = `${h.sources} 个片源 · 服务运行 ${Math.round(h.uptime)}s`;
  }).catch(() => {});

  route();
});
