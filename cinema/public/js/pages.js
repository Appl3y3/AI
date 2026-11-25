/* ================================================================
   首页 / 分类浏览 / 专题 / 放送表 / 搜索 / 详情
   ================================================================ */
import { api } from './api.js';
import {
  $, $$, esc, cardHtml, gridHtml, skeletonGrid, emptyHtml,
  sectionHead, markNav, toast, yearOptions, itemKey, imgTag,
} from './ui.js';
import { recentList, getHistoryOne, getFavorites, isFavorite, toggleFavorite } from './store.js';

export const CATS = [
  { key: 'anime', label: '动漫' },
  { key: 'jpanime', label: '日漫' },
  { key: 'animeMovie', label: '剧场版' },
  { key: 'tv', label: '剧集' },
  { key: 'movie', label: '电影' },
  { key: 'variety', label: '综艺' },
  { key: 'shortplay', label: '短剧' },
  { key: 'doc', label: '纪录片' },
];

const AREAS = ['', '日本', '国产', '欧美', '韩国', '港台', '泰国', '其他'];

/* ================================================================
   首页
   ================================================================ */
export async function renderHome(view) {
  markNav('home');
  const recent = recentList(8);

  let favs = getFavorites().slice(0, 8);

  view.innerHTML = `
    <div id="heroSlot"></div>
    ${recent.length ? `<section class="section">
      ${sectionHead('继续观看', '#/me', '观看记录')}
      ${gridHtml(recent.map((r) => ({
        src: r.src, id: r.id, name: r.name, pic: r.pic, year: r.year || '',
        area: r.epName || '', type: '', remarks: '', epCount: 0, score: 0,
      })), { showProgress: true })}
    </section>` : ''}
    <div id="hotSlot">${skeletonGrid(12)}</div>
    ${favs.length ? `<div id="favSlot"></div>` : ''}
    <div id="latestSlot"></div>`;

  // Hero 用最近在看的，没有就等 hot 数据
  try {
    const data = await api.home();

    // ---- Hero：优先「继续观看」，否则热播 top1
    const heroSlot = $('#heroSlot');
    if (heroSlot) {
      const lead = recent[0]
        ? {
            name: recent[0].name, pic: recent[0].pic,
            src: recent[0].src, id: recent[0].id,
            remarks: recent[0].epName, year: recent[0].year,
            area: recent[0].area, score: 0,
            desc: recent[0].percent
              ? `已看到 ${recent[0].epName || ''} · ${Math.round(recent[0].percent * 100)}%`
              : '', isResume: true,
          }
        : data.hot[0]
          ? { ...data.hot[0], desc: data.hot[0].remarks, isResume: false }
          : null;
      if (lead) {
        heroSlot.innerHTML = heroHtml(lead, data.hot.slice(0, 5));
        bindHero(heroSlot, [lead, ...data.hot.slice(0, 5)].slice(0, 5));
      }
    }

    // ---- 最近热播动漫
    const hotSlot = $('#hotSlot');
    if (hotSlot) {
      hotSlot.innerHTML = data.hot.length
        ? `<section class="section">
            ${sectionHead('最近热播动漫', '#/browse?cat=jpanime')}
            ${gridHtml(data.hot)}
          </section>`
        : emptyHtml('暂无热播数据', '片源接口可能正在维护，稍后再试');
    }

    // ---- 最新更新
    const latestSlot = $('#latestSlot');
    if (latestSlot && data.latest.length) {
      latestSlot.innerHTML = `<section class="section">
        ${sectionHead('最新更新', '#/browse?cat=anime')}
        ${gridHtml(data.latest)}
      </section>`;
    }

    // ---- 我的收藏
    const favSlot = $('#favSlot');
    if (favSlot && favs.length) {
      favSlot.innerHTML = `<section class="section">
        ${sectionHead('我的收藏', '#/me')}
        ${gridHtml(favs)}
      </section>`;
    }

    const fs = $('#footerStatus');
    if (fs) fs.textContent = `${data.sources} 个片源在线 · 数据来自公开采集接口`;
  } catch (e) {
    const hotSlot = $('#hotSlot');
    if (hotSlot) hotSlot.innerHTML = emptyHtml('加载失败', e.message, '⚠️');
  }
}

function heroHtml(it, others) {
  return `<div class="hero">
    <div class="hero-bg" style="background-image:url('${esc(posterOf(it.pic))}')"></div>
    <div class="hero-mask"></div>
    <div class="hero-inner">
      <div class="hero-poster">${imgTag(it.pic, it.name)}</div>
      <div class="hero-info">
        <span class="hero-tag">${it.isResume ? '继续观看' : '今日热播'}</span>
        <h1 class="hero-title">${esc(it.name)}</h1>
        ${it.desc ? `<div class="hero-desc">${esc(it.desc)}</div>` : ''}
        <div class="hero-meta">
          ${it.score ? `<span><b>${it.score.toFixed(1)}</b> 分</span>` : ''}
          ${it.year ? `<span>${esc(it.year)}</span>` : ''}
          ${it.area ? `<span>${esc(it.area)}</span>` : ''}
          ${it.type ? `<span>${esc(it.type)}</span>` : ''}
          ${it.remarks ? `<span>${esc(it.remarks)}</span>` : ''}
        </div>
        <div class="hero-actions">
          <a class="btn btn-primary" href="#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=0" data-link>
            ▶ ${it.isResume ? '继续播放' : '立即播放'}
          </a>
          <a class="btn btn-ghost" href="#/detail/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}" data-link>详情</a>
        </div>
      </div>
    </div>
    <div class="hero-dots">${others.map((_, i) => `<i class="${i === 0 ? 'on' : ''}" data-dot="${i}"></i>`).join('')}</div>
  </div>`;
}

function posterOf(pic) {
  if (!pic) return '';
  return `/api/img?u=${encodeURIComponent(pic)}`;
}
function bindHero(root, list) {
  const dots = $$('.hero-dots i', root);
  if (dots.length <= 1) return;
  let idx = 0;
  let timer = null;
  const show = (n) => {
    idx = n % list.length;
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
    const it = list[idx];
    const hero = $('.hero', root);
    if (!hero) return;
    $('.hero-bg', hero).style.backgroundImage = `url('${posterOf(it.pic)}')`;
    $('.hero-poster', hero).innerHTML = imgTag(it.pic, it.name);
    $('.hero-title', hero).textContent = it.name;
    const desc = $('.hero-desc', hero);
    if (desc) desc.textContent = it.remarks || '';
    const tag = $('.hero-tag', hero);
    if (tag) tag.textContent = idx === 0 && it.isResume ? '继续观看' : '今日热播';
    const meta = $('.hero-meta', hero);
    if (meta) {
      meta.innerHTML = [
        it.score ? `<span><b>${Number(it.score).toFixed(1)}</b> 分</span>` : '',
        it.year ? `<span>${esc(it.year)}</span>` : '',
        it.area ? `<span>${esc(it.area)}</span>` : '',
        it.type ? `<span>${esc(it.type)}</span>` : '',
        it.remarks ? `<span>${esc(it.remarks)}</span>` : '',
      ].filter(Boolean).join('');
    }
    const play = $('.hero-actions .btn-primary', hero);
    if (play && it.src) {
      play.href = `#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=0`;
    }
    const det = $('.hero-actions .btn-ghost', hero);
    if (det && it.src) det.href = `#/detail/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}`;
  };
  dots.forEach((d) => d.addEventListener('click', () => {
    show(Number(d.dataset.dot));
    restart();
  }));
  const restart = () => {
    clearInterval(timer);
    timer = setInterval(() => show(idx + 1), 6500);
  };
  restart();
}

/* ================================================================
   分类浏览
   ================================================================ */
export async function renderBrowse(view, params) {
  const cat = params.get('cat') || 'anime';
  const year = params.get('year') || '';
  const area = params.get('area') || '';
  const src = params.get('src') || '';
  const pg = Number(params.get('pg') || 1);

  const catLabel = (CATS.find((c) => c.key === cat) || { label: '全部' }).label;
  markNav(cat === 'animeMovie' ? 'animemovie' : cat);

  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">${esc(catLabel)}</h1>
      <div class="page-sub">按类型、年份、地区筛选 · 多源聚合</div>
    </div>
    <div class="filters">
      <div class="filter-row">
        <span class="filter-label">类型</span>
        <div class="filter-opts">
          ${CATS.map((c) => `<a class="chip ${c.key === cat ? 'on' : ''}"
            href="${catHref(c.key, year, area, src)}" data-link>${c.label}</a>`).join('')}
        </div>
      </div>
      <div class="filter-row">
        <span class="filter-label">年份</span>
        <div class="filter-opts">
          <a class="chip ${!year ? 'on' : ''}" href="${catHref(cat, '', area, src)}" data-link>全部</a>
          ${yearOptions().map((y) => `<a class="chip ${y === year ? 'on' : ''}"
            href="${catHref(cat, y, area, src)}" data-link>${y}</a>`).join('')}
        </div>
      </div>
      <div class="filter-row">
        <span class="filter-label">地区</span>
        <div class="filter-opts">
          ${AREAS.map((a) => `<a class="chip ${a === area ? 'on' : ''}"
            href="${catHref(cat, year, a, src)}" data-link>${a || '全部'}</a>`).join('')}
        </div>
      </div>
    </div>
    <div id="listSlot">${skeletonGrid(12)}</div>
    <div id="moreSlot"></div>`;

  try {
    const data = await api.list({ cat, year, area, pg, src });
    const slot = $('#listSlot');
    if (!slot) return;

    if (!data.list.length) {
      slot.innerHTML = emptyHtml('没有找到内容', '换个筛选条件试试');
      return;
    }
    slot.innerHTML = gridHtml(data.list);

    const more = $('#moreSlot');
    if (more && pg < 60) {
      more.innerHTML = `<div class="load-more">
        <a class="btn btn-line" href="${catHref(cat, year, area, src, pg + 1)}" data-link>下一页 (${pg}) ›</a>
      </div>`;
    }
    const sub = $('.page-sub');
    if (sub) sub.textContent = `${data.count} 部结果 · 累计 ${data.total.toLocaleString()} 部 · 第 ${pg} 页`;
  } catch (e) {
    const slot = $('#listSlot');
    if (slot) slot.innerHTML = emptyHtml('加载失败', e.message, '⚠️');
  }
}

function catHref(cat, year, area, src, pg) {
  const q = new URLSearchParams({ cat });
  if (year) q.set('year', year);
  if (area) q.set('area', area);
  if (src) q.set('src', src);
  if (pg && pg > 1) q.set('pg', String(pg));
  return `#/browse?${q}`;
}

/* ================================================================
   专题：特摄 / 剧场版
   ================================================================ */
export async function renderTopic(view, kind) {
  const isToku = kind === 'tokusatsu';
  markNav(isToku ? 'tokusatsu' : 'animemovie');
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">${isToku ? '特摄剧' : '剧场版'}</h1>
      <div class="page-sub">${isToku
        ? '假面骑士 · 奥特曼 · 超级战队 · 铠甲勇士 · 牙狼 等关键词聚合'
        : '动漫电影 + 标题含「剧场版」的作品'}</div>
    </div>
    <div id="listSlot">${skeletonGrid(12)}</div>`;

  try {
    const data = await api.topic(kind);
    const slot = $('#listSlot');
    if (!slot) return;
    slot.innerHTML = data.list.length
      ? gridHtml(data.list)
      : emptyHtml('没有找到内容', '关键词匹配为空，稍后再试');
    const sub = $('.page-sub');
    if (sub) sub.textContent = `共 ${data.list.length} 部 · 来自 ${data.errors && data.errors.length ? '部分' : '全部'}片源`;
  } catch (e) {
    const slot = $('#listSlot');
    if (slot) slot.innerHTML = emptyHtml('加载失败', e.message, '⚠️');
  }
}

/* ================================================================
   放送表
   ================================================================ */
export async function renderSchedule(view, params) {
  markNav('schedule');
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">番剧放送表</h1>
      <div class="page-sub">数据来自 AniList · 按本地时区显示 · 缓存 3 小时</div>
    </div>
    <div id="schSlot">${skeletonGrid(6)}</div>`;

  try {
    const data = await api.schedule();
    const slot = $('#schSlot');
    if (!slot) return;

    const dayParam = params && params.get('day');
    const cur = dayParam != null && dayParam !== '' ? Number(dayParam) : data.today;
    const day = data.days[cur] || data.days[0];

    slot.innerHTML = `
      <div class="schedule-tabs">
        ${data.days.map((d) => `<button class="schedule-tab ${d.day === cur ? 'on' : ''}" data-day="${d.day}">
          ${d.label}${d.day === data.today ? '<span class="today-dot"></span>' : ''}
          <span class="muted" style="font-size:11px"> ${d.list.length}</span>
        </button>`).join('')}
      </div>
      <div class="schedule-list">
        ${day.list.length ? day.list.map(scheduleItemHtml).join('')
          : emptyHtml('这一天没有放送', '换个日期看看', '📺')}
      </div>`;

    $$('.schedule-tab', slot).forEach((b) => {
      b.addEventListener('click', () => {
        location.hash = `#/schedule?day=${b.dataset.day}`;
      });
    });
  } catch (e) {
    const slot = $('#schSlot');
    if (slot) slot.innerHTML = emptyHtml('放送表加载失败', e.message, '⚠️');
  }
}

function scheduleItemHtml(s) {
  const searchHref = `#/search?kw=${encodeURIComponent(s.title)}`;
  return `<a class="schedule-item" href="${searchHref}" data-link>
    <div class="schedule-time">${esc(s.time)}</div>
    <div class="schedule-cover">${s.cover ? `<img src="${esc(s.cover)}" alt="" loading="lazy" onerror="this.style.opacity=0" />` : ''}</div>
    <div class="schedule-info">
      <div class="schedule-name">${esc(s.title)}</div>
      <div class="schedule-sub">${esc(s.romaji || '')}${s.popularity ? ` · 热度 ${s.popularity.toLocaleString()}` : ''}</div>
    </div>
    <span class="schedule-ep">第 ${s.episode} 话</span>
  </a>`;
}

/* ================================================================
   搜索
   ================================================================ */
export async function renderSearch(view, params) {
  const kw = params.get('kw') || '';
  const pg = Number(params.get('pg') || 1);
  markNav('');
  const input = $('#globalSearch');
  if (input && kw) input.value = kw;

  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">搜索「${esc(kw)}」</h1>
      <div class="page-sub">跨 5 个片源同时检索，同名结果自动合并</div>
    </div>
    <div id="matchSlot"></div>
    <div id="listSlot">${skeletonGrid(12)}</div>
    <div id="moreSlot"></div>`;

  if (!kw) {
    $('#listSlot').innerHTML = emptyHtml('输入片名开始搜索', '', '🔍');
    return;
  }

  // 日文原名要先用 B 站换中文名再搜，可能要十几秒，先给个说明
  if (/[\u3040-\u30ff]/.test(kw)) {
    const sub = $('.page-sub');
    if (sub) sub.textContent = '日文原名需要先匹配中文译名，可能要十几秒…';
  }

  try {
    const data = await api.search({ kw, pg });
    const slot = $('#listSlot');
    if (!slot) return;

    // 日文原名会自动换中文译名再搜一轮，这里告诉用户实际用的名字与翻页关键词
    const matchSlot = $('#matchSlot');
    const realKw = data.matchedAs || kw;
    if (matchSlot && data.matchedAs) {
      matchSlot.innerHTML = `<div class="match-tip">片源只收中文译名，已按「${esc(data.matchedAs)}」匹配</div>`;
    }

    if (!data.list.length) {
      slot.innerHTML = emptyHtml('没有找到相关资源', '试试更短的关键词，或换用中文译名', '🔍');
      return;
    }
    slot.innerHTML = gridHtml(data.list);
    const sub = $('.page-sub');
    if (sub) sub.textContent = `${data.count} 个结果 · 第 ${pg} 页`;

    const more = $('#moreSlot');
    if (more && data.count >= 20) {
      more.innerHTML = `<div class="load-more">
        <a class="btn btn-line" href="#/search?kw=${encodeURIComponent(realKw)}&pg=${pg + 1}" data-link>下一页 ›</a>
      </div>`;
    }
  } catch (e) {
    const slot = $('#listSlot');
    if (slot) slot.innerHTML = emptyHtml('搜索失败', e.message, '⚠️');
  }
}

/* ================================================================
   详情
   ================================================================ */
export async function renderDetail(view, src, id) {
  markNav('');
  view.innerHTML = `<div id="detailSlot">${skeletonGrid(4)}</div>`;

  try {
    const data = await api.detail(src, id);
    if (!data.ok) {
      $('#detailSlot').innerHTML = emptyHtml('加载失败', data.error || '', '⚠️');
      return;
    }
    const it = data.item;
    const key = itemKey(it);
    const fav = isFavorite(key);
    const hist = getHistoryOne(key);
    const lines = data.lines || [];
    const bestLine = lines.findIndex((l) => l.m3u8);

    view.innerHTML = `
      <div class="detail-head">
        <div class="detail-poster">${imgTag(it.pic, it.name)}</div>
        <div class="detail-main">
          <h1 class="detail-title">${esc(it.name)}</h1>
          <div class="detail-sub">
            ${[it.year, it.area, it.type, it.lang].filter(Boolean).map(esc).join(' · ')}
          </div>
          <div class="detail-tags">
            ${it.score ? `<span class="tag hot">⭐ ${it.score.toFixed(1)}</span>` : ''}
            ${it.remarks ? `<span class="tag">${esc(it.remarks)}</span>` : ''}
            ${it.epCount ? `<span class="tag">共 ${it.epCount} 集</span>` : ''}
            ${lines.filter((l) => l.m3u8).length ? `<span class="tag">${lines.filter((l) => l.m3u8).length} 条直连线路</span>` : ''}
          </div>
          ${it.content ? `<div class="detail-desc${it.content.length > 110 ? '' : ' short'}" id="descBox">${esc(it.content)}</div>
            ${it.content.length > 110 ? `<button class="btn btn-sm btn-line" id="descToggle">展开简介</button>` : ''}` : ''}
          ${it.director ? `<div class="detail-sub" style="margin-top:12px">导演：${esc(it.director)}</div>` : ''}
          ${it.actors ? `<div class="detail-sub">主演：${esc(it.actors)}</div>` : ''}
          <div class="detail-actions">
            <a class="btn btn-primary" href="#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=${hist ? hist.epIndex : 0}&line=${hist ? hist.lineIndex : Math.max(0, bestLine)}" data-link>
              ▶ ${hist ? `继续看 ${esc(hist.epName || '')}` : '立即播放'}
            </a>
            <button class="btn btn-ghost" id="favBtn">${fav ? '★ 已收藏' : '☆ 收藏'}</button>
            ${data.others && data.others.length ? `<button class="btn btn-line" id="switchBtn">⇄ 换源 (${data.others.length})</button>` : ''}
          </div>
        </div>
      </div>

      ${lines.length ? `<div class="episode-panel">
        <div class="line-tabs" id="lineTabs">
          ${lines.map((l, i) => `<button class="line-tab ${i === Math.max(0, bestLine) ? 'on' : ''}" data-line="${i}">
            ${esc(l.name)}${l.m3u8 ? '<span class="dot-ok">●</span>' : ''}
            <span class="muted" style="font-size:11px"> ${l.episodes.length}</span>
          </button>`).join('')}
        </div>
        <div class="episodes" id="epBox"></div>
      </div>` : emptyHtml('暂无可用播放线路', '该片可能只有网盘或已下线', '📼')}
    `;

    // 展开简介
    const dt = $('#descToggle');
    if (dt) {
      dt.addEventListener('click', () => {
        const box = $('#descBox');
        box.classList.toggle('open');
        dt.textContent = box.classList.contains('open') ? '收起简介' : '展开简介';
      });
    }

    // 收藏
    const fb = $('#favBtn');
    if (fb) {
      fb.addEventListener('click', () => {
        const on = toggleFavorite({
          key, src: it.src, id: it.id, name: it.name, pic: it.pic,
          year: it.year, area: it.area, type: it.type, remarks: it.remarks,
        });
        fb.textContent = on ? '★ 已收藏' : '☆ 收藏';
        toast(on ? '已加入收藏' : '已取消收藏');
      });
    }

    // 换源
    const sb = $('#switchBtn');
    if (sb) {
      sb.addEventListener('click', () => showSwitchModal(data.others, it.name));
    }

    // 线路 / 剧集
    if (lines.length) {
      let curLine = Math.max(0, bestLine);
      const epBox = $('#epBox');

      const drawEps = () => {
        const l = lines[curLine];
        const h = hist && hist.lineIndex === curLine ? hist : null;
        epBox.innerHTML = l.episodes.map((ep, i) => `
          <a class="ep-btn ${h && h.epIndex === i ? 'on' : ''}"
             href="#/play/${encodeURIComponent(it.src)}/${encodeURIComponent(it.id)}?ep=${i}&line=${curLine}"
             data-link title="${esc(ep.name)}">
            ${esc(ep.name)}${h && h.epIndex === i ? '<span class="pdot"></span>' : ''}
          </a>`).join('');
      };
      drawEps();

      $$('#lineTabs .line-tab').forEach((b) => {
        b.addEventListener('click', () => {
          curLine = Number(b.dataset.line);
          $$('#lineTabs .line-tab').forEach((x) => x.classList.toggle('on', x === b));
          drawEps();
        });
      });
    }
  } catch (e) {
    $('#detailSlot').innerHTML = emptyHtml('加载失败', e.message, '⚠️');
  }
}

function showSwitchModal(others, name) {
  import('./ui.js').then(({ openModal }) => {
    const body = others.map((o, i) => `
      <div class="src-row" data-i="${i}">
        <div class="src-row-poster">${imgTag(o.pic, o.name)}</div>
        <div class="src-row-info">
          <div class="src-row-name">${esc(o.name)}</div>
          <div class="src-row-meta">${esc(o.type || '')} ${o.year ? '· ' + esc(o.year) : ''} · ${o.epCount} 集 · ${o.lineCount} 线路</div>
        </div>
        <span class="btn btn-sm btn-line">选</span>
      </div>`).join('');
    const mask = openModal(`换源播放 · ${name}`, body);
    mask.querySelectorAll('.src-row').forEach((row) => {
      row.addEventListener('click', () => {
        const o = others[Number(row.dataset.i)];
        location.hash = `#/detail/${encodeURIComponent(o.src)}/${encodeURIComponent(o.id)}`;
        mask.remove();
      });
    });
  });
}
