/* ================================================================
   通用 UI 组件与工具
   ================================================================ */
import { poster } from './api.js';
import { getHistoryOne } from './store.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
export function toast(msg, ms = 2000) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function itemKey(it) {
  return `${it.src}:${it.id}`;
}

/** 海报懒加载：图片 onerror 后显示占位 */
export function imgTag(src, alt = '', cls = '') {
  const u = poster(src, alt);
  if (!u) {
    return `<div class="sk ${cls}" style="width:100%;height:100%"></div>`;
  }
  return `<img ${cls ? `class="${cls}" ` : ''}src="${esc(u)}" alt="${esc(alt)}" loading="lazy"
    onload="this.classList.add('loaded')"
    onerror="this.style.display='none';this.parentNode.classList.add('noimg')" />`;
}

/** 单张卡片 */
export function cardHtml(it, { showProgress = false } = {}) {
  const key = itemKey(it);
  const hist = showProgress ? getHistoryOne(key) : null;
  const pct = hist && hist.percent ? Math.min(100, hist.percent * 100) : 0;
  const badge = it.remarks || (it.epCount ? `全${it.epCount}集` : '');
  const metaBits = [it.year, it.area, it.type].filter(Boolean);

  return `
  <a class="card" href="#/detail/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}" data-link>
    <div class="card-poster">
      ${imgTag(it.pic, it.name)}
      ${badge ? `<span class="card-badge">${esc(badge)}</span>` : ''}
      ${it.score ? `<span class="card-score">${it.score.toFixed(1)}</span>` : ''}
      ${pct > 0 ? `<div class="card-progress"><i style="width:${pct}%"></i></div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-name">${esc(it.name)}</div>
      <div class="card-meta">${metaBits.map((m, i) => `${i ? '<span class="dot"></span>' : ''}${esc(m)}`).join('')}</div>
    </div>
  </a>`;
}

export function gridHtml(items, opts = {}) {
  if (!items || !items.length) return '';
  return `<div class="grid">${items.map((it) => cardHtml(it, opts)).join('')}</div>`;
}

/** 骨架屏卡片 */
export function skeletonGrid(n = 12) {
  return `<div class="grid">${Array.from({ length: n })
    .map(() => `<div class="sk-card"><div class="sk sk-poster"></div><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:45%"></div></div>`)
    .join('')}</div>`;
}

export function emptyHtml(title, sub = '', icon = '🎬') {
  return `<div class="empty">
    <div class="empty-icon">${icon}</div>
    <h3>${esc(title)}</h3>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
  </div>`;
}

export function sectionHead(title, moreHref, moreText = '查看全部') {
  return `<div class="section-head">
    <h2 class="section-title">${esc(title)}</h2>
    ${moreHref ? `<a class="section-more" href="${moreHref}" data-link>${esc(moreText)} ›</a>` : ''}
  </div>`;
}

/** 弹层 */
export function openModal(title, bodyHtml) {
  closeModal();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'modalMask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <span>${esc(title)}</span>
        <button class="modal-close" data-close aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) closeModal();
  });
  return mask;
}
export function closeModal() {
  const m = $('#modalMask');
  if (m) m.remove();
}

/** 年份选项 */
export function yearOptions() {
  const now = new Date().getFullYear();
  const out = [];
  for (let y = now + 1; y >= now - 20; y--) out.push(String(y));
  return out;
}

/** 顶部导航高亮 */
export function markNav(name) {
  $$('#mainNav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
}

export function setScrollProgress() {
  const bar = $('#scrollProgress');
  if (!bar) return;
  const h = document.documentElement;
  const max = h.scrollHeight - h.clientHeight;
  bar.style.width = max > 0 ? `${(h.scrollTop / max) * 100}%` : '0';
}
