/* ================================================================
   后端接口封装
   ================================================================ */

const BASE = '';

async function getJson(url, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.ok === false) throw new Error(j.error || '接口返回失败');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  sources: () => getJson(`${BASE}/api/cms?action=sources`),
  home: () => getJson(`${BASE}/api/cms?action=home`, 40000),
  list: ({ cat = 'anime', year = '', area = '', pg = 1, src = '' }) => {
    const q = new URLSearchParams({ action: 'list', cat, pg: String(pg) });
    if (year) q.set('year', year);
    if (area) q.set('area', area);
    if (src) q.set('src', src);
    return getJson(`${BASE}/api/cms?${q}`, 40000);
  },
  search: ({ kw, pg = 1, src = '' }) => {
    const q = new URLSearchParams({ action: 'search', kw, pg: String(pg) });
    if (src) q.set('src', src);
    return getJson(`${BASE}/api/cms?${q}`, 40000);
  },
  topic: (topic) =>
    getJson(`${BASE}/api/cms?action=topic&topic=${encodeURIComponent(topic)}`, 60000),
  detail: (src, id) =>
    getJson(`${BASE}/api/cms?action=detail&src=${encodeURIComponent(src)}&id=${encodeURIComponent(id)}`, 40000),
  schedule: () => getJson(`${BASE}/api/schedule`, 40000),

  danmakuGet: (key) => getJson(`${BASE}/api/danmaku?key=${encodeURIComponent(key)}`, 15000),
  danmakuPost: (key, payload) =>
    fetch(`${BASE}/api/danmaku?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json()),

  health: () => getJson(`${BASE}/api/health`, 8000),
};

/** 视频流代理：源站没有 CORS 头，必须走本地转发 */
export function streamUrl(url) {
  if (!url) return '';
  return `${BASE}/api/proxy?u=${encodeURIComponent(url)}`;
}

/** 海报代理：绕开图床防盗链；name 用于失败时生成占位图 */
export function poster(url, name = '') {
  if (!url) return name ? `${BASE}/api/img?n=${encodeURIComponent(name)}` : '';
  // AniList 的图可以直接用
  if (/anilist|graphql/i.test(url)) return url;
  const q = new URLSearchParams({ u: url });
  if (name) q.set('n', name);
  return `${BASE}/api/img?${q}`;
}
