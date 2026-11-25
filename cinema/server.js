'use strict';
/**
 * 拾光影院 —— 本地影视聚合服务
 *
 * 职责：
 *   1. 静态站点托管（public/）
 *   2. /api/cms      —— 聚合多个 CMS10 采集站，统一成前端好用的结构（解决 CORS）
 *   3. /api/schedule —— 番剧放送时间表（AniList 代理）
 *   4. /api/danmaku  —— 弹幕收发，落盘 data/danmaku.json
 *   5. /api/img      —— 海报图代理（绕开图床防盗链）
 *
 * 只依赖 Node 内置模块 + 本地 vendor 的 hls.js，无 npm 依赖。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * 日文原名 → 中文译名映射
 * 采集站只收中文译名，放送表给的是日文原名，直接搜会 0 条。
 * 用 B 站番剧搜索（中文站，接受日文关键词）拿中文标题。
 * ------------------------------------------------------------------ */
const BILI_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Cookie: 'buvid3=ABCDEF12-3456-7890-ABCD-EF123456789012345infoc; b_nut=1700000000',
};
const JP_RE = /[\u3040-\u30ff]/; // 假名

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

async function biliTitleMap(kw) {
  const key = 'btitle:' + kw;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const url =
      'https://api.bilibili.com/x/web-interface/search/type?search_type=media_bangumi&page=1&keyword=' +
      encodeURIComponent(kw);
    const j = await getJson(url, { headers: BILI_HEADERS, timeout: 12000 });
    const list = (j && j.data && j.data.result) || [];
    const names = [];
    for (const x of list) {
      const cn = stripTags(x.title);
      if (cn && !names.includes(cn)) names.push(cn);
      if (names.length >= 4) break;
    }
    cacheSet(key, names, 6 * 3600e3);
    return names;
  } catch (e) {
    cacheSet(key, [], 10 * 60e3);
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 片源定义
 * type id 各自一套，cat 是统一分类键。
 * 注意：所有源的一级分类（t=1/2/3/4）都是空壳，真实数据全在二级分类里，
 * 所以每个 cat 存的是「二级分类 id 数组」，请求时逐个并发取再合并。
 * ------------------------------------------------------------------ */
const SOURCES = {
  wujin: {
    label: '无尽资源',
    api: 'https://api.wujinapi.com/api.php/provide/vod/',
    note: '量大，更新快',
    cats: {
      movie: ['6', '7', '8', '9', '10', '11', '12'],
      tv: ['13', '14', '15', '16', '22', '23', '24', '37'],
      variety: ['25', '26', '27', '28'],
      anime: ['29', '30', '31', '33', '42', '43'],
      jpanime: ['30'],
      animeMovie: ['33'],
      shortplay: ['41'],
      doc: ['21'],
    },
    jpArea: '日本',
    enabled: true,
  },
  ffzy: {
    label: '非凡资源',
    api: 'https://api.ffzyapi.com/api.php/provide/vod/',
    note: '画质高，日漫全',
    cats: {
      movie: ['6', '7', '8', '9', '10', '11', '12'],
      tv: ['13', '14', '15', '16', '21', '22', '23', '24'],
      variety: ['25', '26', '27', '28'],
      anime: ['29', '30', '31', '32', '33'],
      jpanime: ['30'],
      animeMovie: ['4'],
      shortplay: ['36'],
      doc: ['20'],
    },
    jpArea: '日本',
    enabled: true,
  },
  guangsu: {
    label: '光速资源',
    api: 'https://api.guangsuapi.com/api.php/provide/vod/',
    note: '备份线路多',
    cats: {
      movie: ['6', '7', '8', '9', '10', '11', '12'],
      tv: ['13', '14', '15', '16', '21', '22', '23'],
      variety: ['37', '38', '39', '40'],
      anime: ['41', '42', '43'],
      jpanime: ['42'],
      animeMovie: ['20'],
      shortplay: ['44', '45', '46', '47', '48', '49', '50', '51', '52'],
      doc: ['24'],
    },
    jpArea: null, // 42 已是「日本动漫」，无需再过滤地区
    enabled: true,
  },
  uku: {
    label: 'U酷资源',
    api: 'https://api.ukuapi88.com/api.php/provide/vod/',
    note: '短剧/综艺强',
    cats: {
      movie: ['6', '7', '8', '9', '10', '11', '12', '33', '34'],
      tv: ['13', '14', '15', '16', '21', '22', '23'],
      variety: ['3'],
      anime: ['4'],
      jpanime: ['4'],
      animeMovie: ['20'],
      shortplay: ['32'],
      doc: ['24'],
    },
    jpArea: '日本',
    enabled: true,
  },
  bdzy: {
    label: '百度资源',
    api: 'https://api.apibdzy.com/api.php/provide/vod/',
    note: '特摄/老片多',
    cats: {
      movie: ['6', '7', '8', '9', '10', '11', '12'],
      tv: ['13', '14', '15', '16', '17', '18', '19', '23'],
      variety: ['25', '26', '27', '28'],
      anime: ['29', '30', '31'],
      jpanime: ['30'],
      animeMovie: ['39'],
      shortplay: ['54'],
      doc: [],
    },
    jpArea: '日本',
    enabled: true,
  },
};

/* 特摄关键词 —— 采集站没有「特摄」分类，只能靠关键词聚合 */
const TOKUSATSU_KEYWORDS = [
  '假面骑士', '奥特曼', '超级战队', '铠甲勇士', '牙狼',
  '哥斯拉', '特搜战队', '宇宙战队', '兽电战队', '光之美少女',
];

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */
const cache = new Map(); // key -> { exp, val }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { cache.delete(key); return null; }
  return hit.val;
}
function cacheSet(key, val, ttlMs) {
  if (cache.size > 800) {
    // 粗暴淘汰：清掉最早的一半
    const keys = [...cache.keys()].slice(0, 400);
    keys.forEach((k) => cache.delete(k));
  }
  cache.set(key, { exp: Date.now() + ttlMs, val });
}

function httpGet(url, { timeout = 12000, headers = {}, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };

    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
        timeout,
      },
      (res) => {
        // 跳转
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return httpGet(next, { timeout, headers, redirects: redirects - 1 })
            .then((r) => finish(resolve, r))
            .catch((e) => finish(reject, e));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          finish(resolve, { status: res.statusCode, headers: res.headers, body: buf });
        });
        res.on('error', (e) => finish(reject, e));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => finish(reject, e));
  });
}

async function getJson(url, opts) {
  const r = await httpGet(url, opts);
  let text = r.body.toString('utf8');
  // 有些接口会带 BOM
  text = text.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (e) {
    const head = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`非 JSON 响应(${r.status}): ${head}`);
  }
}

/* ------------------------------------------------------------------ *
 * 播放地址解析
 * vod_play_from = "feifan$$$ffm3u8"
 * vod_play_url  = "第01集$url#第02集$url$$$第01集$url#..."
 * 我们优先拿直连 m3u8 的线路，share 页作为兜底
 * ------------------------------------------------------------------ */
function parseLines(vod) {
  const froms = String(vod.vod_play_from || '').split('$$$');
  const urls = String(vod.vod_play_url || '').split('$$$');
  const lines = [];
  for (let i = 0; i < Math.max(froms.length, urls.length); i++) {
    const fname = (froms[i] || `线路${i + 1}`).trim();
    const raw = urls[i] || '';
    if (!raw.trim()) continue;

    const episodes = [];
    for (const seg of raw.split('#')) {
      if (!seg.trim()) continue;
      // 一集 = "名字$http..."，但偶尔有多个 $，取最后一个像 URL 的片段
      const parts = seg.split('$');
      let name = parts[0].trim();
      let url = '';
      for (let k = parts.length - 1; k >= 0; k--) {
        if (/^https?:\/\//i.test(parts[k].trim())) { url = parts[k].trim(); break; }
      }
      if (!url) continue;
      if (!name || /^https?:\/\//i.test(name)) {
        name = `第${String(episodes.length + 1).padStart(2, '0')}集`;
      }
      episodes.push({ name, url });
    }

    if (!episodes.length) continue;

    const direct = episodes.filter((e) => /\.m3u8(\?|$)/i.test(e.url)).length;
    lines.push({
      name: fname,
      direct,
      // 直连越多越靠前
      m3u8: direct > 0,
      episodes,
    });
  }
  // 排序：直连 m3u8 的线路优先
  lines.sort((a, b) => b.direct - a.direct);
  return lines;
}

/* 地区名归一化：上游数据脏（大陆/内地/题本/零宽字符/多地区拼接） */
const AREA_FIX = {
  大陆: '中国大陆',
  内地: '中国大陆',
  题本: '日本',
  其它: '其他',
  美国: '美国',
};
const AREA_JUNK = /^(暂无简介|暂无介绍|暂无|未知|无|空|不详|其他站|其它站|0|null|undefined)$/;
function normArea(raw) {
  let a = String(raw || '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .trim();
  if (!a) return '';
  // "美国 / 法国 / 日本" 这类只取第一个
  const first = a.split(/[,，/／、|]/)[0].trim();
  a = first || a;
  if (AREA_JUNK.test(a)) return '';
  return AREA_FIX[a] || a;
}

/* 简介清洗：去 HTML、去 &nbsp;、把「暂无简介」之类占位当成空 */
function cleanContent(html) {
  let s = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (/^(暂无简介|暂无介绍|暂无剧情|无简介|暂无|无)$/.test(s)) return '';
  return s;
}

/* 年份归一化：只保留 1900-2099 的四位数字 */
function normYear(raw) {
  const m = String(raw || '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

function normalizeItem(vod, srcKey) {
  const lines = parseLines(vod);
  const area = normArea(vod.vod_area);
  return {
    src: srcKey,
    id: String(vod.vod_id),
    name: String(vod.vod_name || '').trim(),
    pic: String(vod.vod_pic || '').trim(),
    remarks: String(vod.vod_remarks || '').trim(),
    year: normYear(vod.vod_year),
    area,
    type: fixType(vod.type_name, area),
    lang: String(vod.vod_lang || '').trim(),
    score: parseFloat(vod.vod_score) || 0,
    updatedAt: String(vod.vod_time || '').trim(),
    actors: String(vod.vod_actor || '').trim(),
    director: String(vod.vod_director || '').trim(),
    lineCount: lines.length,
    epCount: lines.reduce((m, l) => Math.max(m, l.episodes.length), 0),
    playable: lines.some((l) => l.m3u8),
  };
}

/* 上游 type_name 常与 vod_area 打架（uku 把日漫标成「国产剧」）。
 * 地区性分类名与地区冲突时直接丢掉，避免卡片出现「日本 · 国产剧」。 */
const REGION_TYPE_RE = /(国产|大陆|港台|台湾|香港|日韩|日本|韩国|欧美|美国|泰国|海外)/;
function fixType(typeName, area) {
  const t = String(typeName || '').trim();
  if (!t) return '';
  if (!REGION_TYPE_RE.test(t)) return t;
  if (!area) return t;
  const tJp = /日本|日韩/.test(t);
  const tCn = /国产|大陆/.test(t);
  const tKr = /韩国/.test(t);
  const tUs = /欧美|美国/.test(t);
  const areaIsJp = area === '日本';
  const areaIsCn = area === '中国大陆' || area === '国产';
  const areaIsKr = area === '韩国';
  const areaIsUs = area === '美国' || area === '欧美';
  const conflict =
    (tJp && !areaIsJp) || (tCn && !areaIsCn) || (tKr && !areaIsKr) || (tUs && !areaIsUs);
  return conflict ? '' : t;
}

/* 片名归一化，用于跨源合并去重 */
function nameKey(name) {
  return String(name)
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/第[一二三四五六七八九十\d]+季/g, '')
    .replace(/[：:·・,，.。!！?？"'“”‘’\-—_]/g, '')
    .toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 上游请求（带缓存 + 一次重试）
 * ------------------------------------------------------------------ */
async function fetchCms(srcKey, params) {
  const src = SOURCES[srcKey];
  if (!src) throw new Error('未知片源: ' + srcKey);

  const qs = new URLSearchParams(params);
  const url = src.api + '?' + qs.toString();
  const key = 'cms:' + url;
  const hit = cacheGet(key);
  if (hit) return hit;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const j = await getJson(url, { timeout: 14000 });
      if (!j || typeof j !== 'object' || !Array.isArray(j.list)) {
        throw new Error('返回结构异常');
      }
      cacheSet(key, j, 90 * 1000);
      return j;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('请求失败');
}

/* 多源并发，失败的不影响整体 */
async function fetchMulti(srcKeys, params, { settleTimeout = 16000 } = {}) {
  const tasks = srcKeys.map(async (k) => {
    try {
      const j = await fetchCms(k, typeof params === 'function' ? params(k) : params);
      return { src: k, ok: true, json: j };
    } catch (e) {
      return { src: k, ok: false, error: e.message };
    }
  });
  const guard = new Promise((res) => setTimeout(() => res(null), settleTimeout));
  const settled = await Promise.race([Promise.all(tasks), guard.then(() => null)]);
  if (settled) return settled;
  // 超时兜底：拿已完成的
  return await Promise.all(
    tasks.map((t) => Promise.race([t, { src: '?', ok: false, error: 'timeout' }]))
  );
}

/* ================================================================== *
 * 路由
 * ================================================================== */
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': body.length,
  });
  res.end(body);
}

/* 取某源某分类下的所有 type_id（一级分类是空壳，必须展开二级） */
function catIds(srcKey, cat) {
  const s = SOURCES[srcKey];
  if (!s) return [];
  const v = s.cats[cat];
  if (Array.isArray(v) && v.length) return v;
  const an = s.cats.anime;
  return Array.isArray(an) ? an : [];
}

/* 按分类拉取：把该分类下所有 type_id 并发请求，合并成一个结果。
 * pages>1 时每个 type_id 取多页，用来支撑「本地地区过滤」的候选池
 * —— 因为除 ffzy 外，其它源的 area 参数都被忽略。 */
async function fetchByCat(srcKeys, cat, extra = {}, { settleTimeout = 20000, pages = 1, startPg = 1 } = {}) {
  const jobs = [];
  for (const k of srcKeys) {
    const ids = catIds(k, cat);
    if (!ids.length) continue;
    const ex = typeof extra === 'function' ? extra(k) : extra;
    for (const id of ids) {
      for (let i = 0; i < pages; i++) {
        const pg = startPg + i;
        jobs.push((async () => {
          try {
            const j = await fetchCms(k, { ac: 'detail', t: id, ...ex, pg: String(pg) });
            return { src: k, ok: true, json: j };
          } catch (e) {
            return { src: k, ok: false, error: e.message };
          }
        })());
      }
    }
  }
  const guard = new Promise((res) => setTimeout(() => res(null), settleTimeout));
  const settled = await Promise.race([Promise.all(jobs), guard.then(() => null)]);
  const results = settled || (await Promise.all(
    jobs.map((t) => Promise.race([t, { src: '?', ok: false, error: 'timeout' }]))
  ));

  // 同源多 type_id 的 list 合并
  const bySrc = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    const cur = bySrc.get(r.src) || { list: [], total: 0 };
    cur.list = cur.list.concat(r.json.list || []);
    cur.total += Number(r.json.total) || 0;
    bySrc.set(r.src, cur);
  }
  return [...bySrc.entries()].map(([src, v]) => ({ src, ok: true, json: v }));
}

/* 地区筛选：上游 area 参数基本不可用（多数源忽略或直接返回 0），
 * 所以统一改成「先全量取回、再本地按归一化地区过滤」。 */
const AREA_GROUPS = {
  日本: ['日本'],
  国产: ['中国大陆', '大陆', '内地'],
  中国大陆: ['中国大陆', '大陆', '内地'],
  欧美: ['美国', '英国', '法国', '德国', '意大利', '西班牙', '加拿大', '澳大利亚',
    '新西兰', '俄罗斯', '瑞典', '丹麦', '挪威', '芬兰', '荷兰', '比利时', '波兰',
    '爱尔兰', '奥地利', '瑞士', '葡萄牙', '希腊', '捷克', '匈牙利', '墨西哥', '巴西',
    '阿根廷', '印度', '土耳其', '以色列', '乌克兰', '卢森堡', '冰岛'],
  韩国: ['韩国'],
  港台: ['香港', '中国香港', '台湾', '中国台湾', '港台'],
  泰国: ['泰国'],
  印度: ['印度'],
  其他: [],
};
function areaMatcher(area) {
  if (!area) return null;
  const allow = AREA_GROUPS[area];
  if (!allow) return (it) => it.area === area;
  if (area === '其他') {
    const known = new Set(Object.entries(AREA_GROUPS)
      .filter(([k]) => k !== '其他')
      .flatMap(([, v]) => v));
    return (it) => !it.area || !known.has(it.area);
  }
  const set = new Set(allow);
  return (it) => set.has(it.area);
}

/* --- /api/cms ------------------------------------------------------ */
async function handleCms(u, res) {
  const action = u.searchParams.get('action') || 'list';

  /* 1. 片源列表 */
  if (action === 'sources') {
    return sendJson(res, 200, {
      ok: true,
      sources: Object.entries(SOURCES).map(([k, s]) => ({
        key: k, label: s.label, note: s.note, enabled: s.enabled,
      })),
    });
  }

  /* 2. 首页聚合：最近热播动漫 + 最新更新 */
  if (action === 'home') {
    const srcKeys = Object.keys(SOURCES).filter((k) => SOURCES[k].enabled);

    // 热播动漫：各源「日韩动漫」按更新时间排，取前 24
    const hotParams = (k) => {
      const ids = catIds(k, 'jpanime');
      const p = { ac: 'detail', t: ids[0] || '30', pg: 1, order: 'time' };
      return p;
    };
    const hotResults = await fetchMulti(srcKeys.slice(0, 4), hotParams);

    const hot = [];
    const seen = new Set();
    for (const r of hotResults) {
      if (!r.ok) continue;
      for (const v of r.json.list || []) {
        const it = normalizeItem(v, r.src);
        const k = nameKey(it.name);
        if (!it.name || seen.has(k)) continue;
        seen.add(k);
        hot.push(it);
      }
    }
    hot.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    // 最新更新：全分类混排
    const latestParams = (k) => ({ ac: 'detail', pg: 1, order: 'time' });
    const latestResults = await fetchMulti(srcKeys.slice(0, 3), latestParams);
    const latest = [];
    const seen2 = new Set();
    for (const r of latestResults) {
      if (!r.ok) continue;
      for (const v of r.json.list || []) {
        const it = normalizeItem(v, r.src);
        const k = nameKey(it.name);
        if (!it.name || seen2.has(k)) continue;
        seen2.add(k);
        latest.push(it);
      }
    }
    latest.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    return sendJson(res, 200, {
      ok: true,
      hot: hot.slice(0, 18),
      latest: latest.slice(0, 36),
      sources: srcKeys.length,
    });
  }

  /* 3. 列表（分类/年份/地区/排序） */
  if (action === 'list') {
    const cat = u.searchParams.get('cat') || 'anime';
    const year = u.searchParams.get('year') || '';
    const area = u.searchParams.get('area') || '';
    const pg = u.searchParams.get('pg') || '1';
    const srcKeys = (u.searchParams.get('src') || '').trim()
      ? [u.searchParams.get('src').trim()]
      : Object.keys(SOURCES).filter((k) => SOURCES[k].enabled);

    // 上游的 area 参数不可靠（除 ffzy 外全被忽略），只传 year，地区在本地过滤
    const extra = (k) => {
      const p = {};
      if (year) p.year = year;
      return p;
    };

    // 有地区筛选时需要更大的候选池，否则本地过滤后只剩几条。
    // 每页对外是 120 条，所以第 pg 页对应上游 (pg-1)*step+1 起。
    const step = area ? 3 : 1;
    const startPg = (Math.max(1, Number(pg) || 1) - 1) * step + 1;
    const results = await fetchByCat(srcKeys, cat, extra, { pages: step, startPg });
    const matchArea = areaMatcher(area);
    const items = [];
    const seen = new Set();
    let total = 0;
    const errors = [];
    for (const r of results) {
      if (!r.ok) { errors.push({ src: r.src, error: r.error }); continue; }
      total += Number(r.json.total) || 0;
      for (const v of r.json.list || []) {
        const it = normalizeItem(v, r.src);
        const k = nameKey(it.name) + '|' + it.year;
        if (!it.name || seen.has(k)) continue;
        // 日漫频道默认只看日本地区
        if (matchArea) { if (!matchArea(it)) continue; }
        else if (cat === 'jpanime' && it.area && it.area !== '日本') continue;
        seen.add(k);
        items.push(it);
      }
    }
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    // 一次合并 5 个源的多个二级分类，条数会很多；前端一次只渲染一屏，截断到 120 条
    const LIMIT = 120;
    const sliced = items.slice(0, LIMIT);

    return sendJson(res, 200, {
      ok: true, cat, year, area, pg: Number(pg),
      total, count: sliced.length, list: sliced, hasMore: items.length > LIMIT, errors,
    });
  }

  /* 4. 搜索（跨源合并） */
  if (action === 'search') {
    const kw = (u.searchParams.get('kw') || '').trim();
    if (!kw) return sendJson(res, 200, { ok: true, list: [], count: 0, kw });
    const pg = u.searchParams.get('pg') || '1';
    const srcKeys = (u.searchParams.get('src') || '').trim()
      ? [u.searchParams.get('src').trim()]
      : Object.keys(SOURCES).filter((k) => SOURCES[k].enabled);

    const collect = (results) => {
      const items = [];
      const seen = new Set();
      const errors = [];
      for (const r of results) {
        if (!r.ok) { errors.push({ src: r.src, error: r.error }); continue; }
        for (const v of r.json.list || []) {
          const it = normalizeItem(v, r.src);
          const k = nameKey(it.name);
          if (seen.has(k)) continue;
          seen.add(k);
          items.push(it);
        }
      }
      return { items, errors };
    };

    let results = await fetchMulti(srcKeys, { ac: 'detail', wd: kw, pg });
    let { items, errors } = collect(results);
    let matchedAs = '';

    // 日文/假名原名在采集站基本搜不到 → 用 B 站换中文名再搜一轮
    if (!items.length && JP_RE.test(kw)) {
      const names = await biliTitleMap(kw);
      for (const cn of names) {
        const rs = await fetchMulti(srcKeys, { ac: 'detail', wd: cn, pg });
        const got = collect(rs);
        if (got.items.length) {
          items = got.items;
          errors = errors.concat(got.errors);
          matchedAs = cn;
          break;
        }
      }
    }

    return sendJson(res, 200, { ok: true, kw, pg: Number(pg), count: items.length, list: items, errors, matchedAs });
  }

  /* 5. 专题：特摄 / 剧场版 */
  if (action === 'topic') {
    const topic = u.searchParams.get('topic') || 'tokusatsu';
    const srcKeys = Object.keys(SOURCES).filter((k) => SOURCES[k].enabled);
    const items = [];
    const seen = new Set();
    const errors = [];

    if (topic === 'tokusatsu') {
      // 逐个关键词并发（每源多词太慢，改成按词并发跨源）
      const perKeyword = await Promise.all(
        TOKUSATSU_KEYWORDS.map(async (kw) => {
          const rs = await fetchMulti(srcKeys, { ac: 'detail', pg: 1, wd: kw }, { settleTimeout: 20000 });
          const out = [];
          for (const r of rs) {
            if (!r.ok) continue;
            for (const v of r.json.list || []) out.push(normalizeItem(v, r.src));
          }
          return out;
        })
      );
      for (const arr of perKeyword) {
        for (const it of arr) {
          const k = nameKey(it.name);
          if (!it.name || seen.has(k)) continue;
          seen.add(k);
          items.push(it);
        }
      }
    } else {
      // 剧场版：动漫电影类型 + 「剧场版」关键词
      const [byCat, byKw] = await Promise.all([
        fetchByCat(srcKeys, 'animeMovie', { pg: 1 }, { settleTimeout: 20000 }),
        fetchMulti(srcKeys, { ac: 'detail', pg: 1, wd: '剧场版' }, { settleTimeout: 20000 }),
      ]);
      for (const r of [...byCat, ...byKw]) {
        if (!r.ok) continue;
        for (const v of r.json.list || []) {
          const it = normalizeItem(v, r.src);
          const k = nameKey(it.name);
          if (!it.name || seen.has(k)) continue;
          seen.add(k);
          items.push(it);
        }
      }
      // 剧场版优先展示名字里带「剧场版」的
      items.sort((a, b) => {
        const sa = /剧场版|电影版|THE MOVIE/i.test(a.name) ? 0 : 1;
        const sb = /剧场版|电影版|THE MOVIE/i.test(b.name) ? 0 : 1;
        return sa - sb;
      });
    }

    return sendJson(res, 200, { ok: true, topic, count: items.length, list: items, errors });
  }

  /* 6. 详情（含播放线路 + 多源同片） */
  if (action === 'detail') {
    const src = u.searchParams.get('src');
    const id = u.searchParams.get('id');
    if (!src || !id) return sendJson(res, 400, { ok: false, error: '缺少 src/id' });

    let vod;
    let err;
    try {
      const j = await fetchCms(src, { ac: 'detail', ids: id });
      vod = (j.list || [])[0];
    } catch (e) { err = e.message; }

    if (!vod) {
      // 有的源不认 ids，退回全量翻页找（很少走到）
      return sendJson(res, 200, { ok: false, error: err || '未找到该影片' });
    }

    const base = normalizeItem(vod, src);
    const lines = parseLines(vod);

    // 顺手找同名资源的其它源（换源用）
    let others = [];
    try {
      const srcKeys = Object.keys(SOURCES).filter((k) => k !== src);
      const rs = await fetchMulti(srcKeys, { ac: 'detail', wd: base.name }, { settleTimeout: 12000 });
      const nk = nameKey(base.name);
      for (const r of rs) {
        if (!r.ok) continue;
        for (const v of r.json.list || []) {
          if (nameKey(v.vod_name) !== nk) continue;
          const it = normalizeItem(v, r.src);
          if (it.lines === 0) continue;
          others.push(it);
        }
      }
      const seen = new Set();
      others = others.filter((o) => {
        if (seen.has(o.src + o.id)) return false;
        seen.add(o.src + o.id);
        return true;
      });
    } catch (e) { /* 换源失败不影响主流程 */ }

    return sendJson(res, 200, {
      ok: true,
      item: {
        ...base,
        content: cleanContent(vod.vod_content),
        pubdate: String(vod.vod_pubdate || ''),
        total: String(vod.vod_total || ''),
        weekday: String(vod.vod_weekday || ''),
      },
      lines,
      others,
    });
  }

  return sendJson(res, 400, { ok: false, error: '未知 action: ' + action });
}

/* --- /api/schedule ------------------------------------------------ */
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

async function anilistPost(q, variables) {
  const payload = Buffer.from(JSON.stringify({ query: q, variables }), 'utf8');
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://graphql.anilist.co',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': payload.length,
          'User-Agent': UA,
        },
        timeout: 18000,
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(new Error('AniList 返回非 JSON')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handleSchedule(u, res) {
  const key = 'schedule:v3';
  const hit = cacheGet(key);
  if (hit) return sendJson(res, 200, hit);

  const q = `query($from:Int,$to:Int){
    Page(perPage:50){
      airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){
        airingAt episode
        media{ id title{romaji native} coverImage{large} popularity format status genres isAdult siteUrl }
      }
    }
  }`;

  // AniList 单页最多 50 条 → 按天分 7 个窗口并发查，每天各取最多 50 部
  const nowD = new Date();
  const weekStart = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - nowD.getDay(), 0, 0, 0, 0);
  const dayMs = 86400e3;

  const perDay = await Promise.all(
    WEEK_CN.map(async (label, idx) => {
      const from = Math.floor((weekStart.getTime() + idx * dayMs) / 1000);
      const to = Math.floor((weekStart.getTime() + (idx + 1) * dayMs) / 1000) - 1;
      try {
        const data = await anilistPost(q, { from, to });
        const list = (data && data.data && data.data.Page && data.data.Page.airingSchedules) || [];
        return { label, idx, list };
      } catch (e) {
        return { label, idx, list: [] };
      }
    })
  );
  const days = WEEK_CN.map((label, idx) => ({ day: idx, label, list: [] }));
  const seen = new Set();

  for (const bucket of perDay) {
    const dayList = days[bucket.idx].list;
    for (const a of bucket.list) {
      const m = a.media;
      if (!m || m.isAdult) continue;
      const d = new Date(a.airingAt * 1000);
      const title = (m.title && (m.title.native || m.title.romaji)) || '未知';
      const dedupeKey = m.id + '|' + a.episode + '|' + bucket.idx;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      dayList.push({
        id: m.id,
        title,
        romaji: (m.title && m.title.romaji) || '',
        cover: (m.coverImage && m.coverImage.large) || '',
        episode: a.episode,
        airingAt: a.airingAt,
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        ts: d.getTime(),
        popularity: m.popularity || 0,
        format: m.format || '',
        genres: m.genres || [],
      });
    }
  }

  days.forEach((d) => d.list.sort((x, y) => x.ts - y.ts));
  const out = {
    ok: true,
    updatedAt: Date.now(),
    today: new Date().getDay(),
    total: days.reduce((a, d) => a + d.list.length, 0),
    days,
  };
  cacheSet(key, out, 3 * 3600 * 1000);
  return sendJson(res, 200, out);
}

/* --- /api/danmaku ------------------------------------------------ */
const DANMAKU_FILE = path.join(DATA_DIR, 'danmaku.json');
let danmakuStore = null;

function loadDanmaku() {
  if (danmakuStore) return danmakuStore;
  try {
    danmakuStore = JSON.parse(fs.readFileSync(DANMAKU_FILE, 'utf8'));
  } catch (e) {
    danmakuStore = {};
  }
  if (!danmakuStore || typeof danmakuStore !== 'object') danmakuStore = {};
  return danmakuStore;
}

let saveTimer = null;
function scheduleSaveDanmaku() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DANMAKU_FILE, JSON.stringify(danmakuStore), 'utf8');
    } catch (e) { /* 落盘失败不影响播放 */ }
  }, 800);
}

async function handleDanmaku(u, req, res) {
  const key = u.searchParams.get('key') || '';
  if (!key) return sendJson(res, 400, { ok: false, error: '缺少 key' });
  const store = loadDanmaku();

  if (req.method === 'GET') {
    const arr = store[key] || [];
    return sendJson(res, 200, { ok: true, key, count: arr.length, list: arr });
  }

  if (req.method === 'POST') {
    const body = await readBody(req, 8 * 1024);
    let payload;
    try { payload = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
    const text = String(payload.text || '').slice(0, 120).trim();
    if (!text) return sendJson(res, 400, { ok: false, error: '弹幕不能为空' });
    const rec = {
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      t: Math.max(0, Number(payload.t) || 0),
      text,
      color: /^#[0-9a-f]{6}$/i.test(payload.color || '') ? payload.color : '#ffffff',
      mode: ['rtl', 'top', 'bottom'].includes(payload.mode) ? payload.mode : 'rtl',
      at: Date.now(),
    };
    if (!store[key]) store[key] = [];
    store[key].push(rec);
    if (store[key].length > 4000) store[key] = store[key].slice(-4000);
    scheduleSaveDanmaku();
    return sendJson(res, 200, { ok: true, item: rec });
  }

  return sendJson(res, 405, { ok: false, error: '不支持的方法' });
}

/* --- /api/img ---------------------------------------------------- */
function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 图床拿不到时给一张带片名的渐变占位图，避免卡片出现黑洞 */
function svgPlaceholder(res, name, status = 200) {
  const label = (name || '').trim().slice(0, 10);
  const hue = (() => {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 360;
    return h;
  })();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="hsl(${hue},32%,22%)"/>
    <stop offset="100%" stop-color="hsl(${(hue + 40) % 360},28%,13%)"/>
  </linearGradient></defs>
  <rect width="300" height="420" fill="url(#g)"/>
  <g fill="none" stroke="rgba(255,255,255,.07)" stroke-width="1">
    <path d="M0 300 L300 140 M0 360 L300 200"/>
  </g>
  <text x="150" y="205" text-anchor="middle" font-size="26" font-family="Microsoft YaHei,Noto Sans SC,sans-serif"
    fill="rgba(255,255,255,.55)">${escXml(label || '暂无封面')}</text>
  <text x="150" y="240" text-anchor="middle" font-size="12" font-family="sans-serif"
    fill="rgba(255,255,255,.28)">NO POSTER</text>
</svg>`;
  const buf = Buffer.from(svg, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=600',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

async function handleImg(u, res) {
  const target = u.searchParams.get('u') || '';
  const label = u.searchParams.get('n') || '';
  if (!/^https?:\/\//i.test(target)) {
    return svgPlaceholder(res, label, 200);
  }
  const key = 'img:' + target;
  const hit = cacheGet(key);
  if (hit && hit.fail) return svgPlaceholder(res, label, 200);
  if (hit && hit.buf) {
    res.writeHead(200, {
      'Content-Type': hit.type,
      'Cache-Control': 'public, max-age=604800',
      'Content-Length': hit.buf.length,
    });
    return res.end(hit.buf);
  }
  try {
    const r = await httpGet(target, {
      timeout: 9000,
      headers: {
        Referer: new URL(target).origin + '/',
        Accept: 'image/avif,image/webp,image/*,*/*',
        'User-Agent': UA,
      },
    });
    if (r.status !== 200) return svgPlaceholder(res, label, 200);
    const type = r.headers['content-type'] || 'image/jpeg';
    if (!/^image\//.test(type)) return svgPlaceholder(res, label, 200);
    cacheSet(key, { type, buf: r.body }, 24 * 3600 * 1000);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=604800',
      'Content-Length': r.body.length,
    });
    res.end(r.body);
  } catch (e) {
    // 图床被墙/连接被重置：给占位图，别让前端卡片空掉
    cacheSet(key, { type: 'image/svg+xml; charset=utf-8', buf: null, fail: true }, 10 * 60 * 1000);
    return svgPlaceholder(res, label, 200);
  }
}

/* --- /api/proxy --------------------------------------------------- *
 * HLS 流代理：源站普遍不带 CORS 头，浏览器直连必失败。
 * 这里把 m3u8 里的所有相对地址改写成走本代理的绝对地址，
 * 分片/密钥/子播放列表因此都能正常加载，同时顺带解决防盗链 Referer。
 * ------------------------------------------------------------------ */
const PROXY_TIMEOUT = 25000;

function proxyBase(req) {
  return `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
}

/** 把 playlist 里出现的 URI 改写成代理地址 */
function rewritePlaylist(text, baseUrl, req) {
  const base = proxyBase(req);
  const mk = (abs) => `${base}/api/proxy?u=${encodeURIComponent(abs)}`;

  const abs = (ref) => {
    try { return new URL(ref, baseUrl).href; } catch (e) { return ref; }
  };

  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { out.push(rawLine); continue; }

    // 标签行：改写其中的 URI="..." （EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF）
    if (line.startsWith('#')) {
      out.push(
        line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${mk(abs(ref))}"`)
      );
      continue;
    }
    // 普通行：子播放列表或分片
    out.push(mk(abs(line)));
  }
  return out.join('\n');
}

async function handleProxy(u, req, res) {
  const target = u.searchParams.get('u') || '';
  if (!/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('bad url'); }

  let origin = '';
  try { origin = new URL(target).origin + '/'; } catch (e) { origin = ''; }

  const upstreamHeaders = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: origin,
  };
  // 透传 Range，让 mp4 / ts 支持拖动
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;

  try {
    const r = await httpGet(target, {
      timeout: PROXY_TIMEOUT,
      headers: upstreamHeaders,
      redirects: 4,
    });

    if (r.status !== 200 && r.status !== 206) {
      res.writeHead(r.status === 404 ? 404 : 502, { 'Access-Control-Allow-Origin': '*' });
      return res.end('upstream ' + r.status);
    }

    const type = (r.headers['content-type'] || '').toLowerCase();
    const head = r.body.slice(0, 300).toString('utf8');
    const looksM3u8 =
      /mpegurl/i.test(type) ||
      head.trimStart().startsWith('#EXTM3U') ||
      /\.m3u8(\?|$)/i.test(target);

    if (looksM3u8) {
      const text = r.body.toString('utf8');
      const rewritten = rewritePlaylist(text, target, req);
      const buf = Buffer.from(rewritten, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(buf);
    }

    // 分片 / 密钥 / mp4：原样透传
    const hdr = {
      'Content-Type': r.headers['content-type'] || 'application/octet-stream',
      'Content-Length': r.body.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    };
    if (r.headers['content-range']) hdr['Content-Range'] = r.headers['content-range'];
    if (r.headers['accept-ranges']) hdr['Accept-Ranges'] = r.headers['accept-ranges'];
    res.writeHead(r.status, hdr);
    res.end(r.body);
  } catch (e) {
    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
    res.end('proxy error: ' + (e && e.message));
  }
}

/* --- 静态文件 ----------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 兜底
      if (!path.extname(rel)) {
        const index = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(index, (e2, buf) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': buf.length });
          res.end(buf);
        });
      }
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(full).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const cacheable = /vendor|\.(png|jpg|webp|svg|woff2)$/i.test(full);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ================================================================== *
 * 启动
 * ================================================================== */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  try {
    if (p === '/api/cms') return await handleCms(u, res);
    if (p === '/api/schedule') return await handleSchedule(u, res);
    if (p === '/api/danmaku') return await handleDanmaku(u, req, res);
    if (p === '/api/img') return await handleImg(u, res);
    if (p === '/api/proxy') return await handleProxy(u, req, res);
    if (p === '/api/health') return sendJson(res, 200, { ok: true, uptime: process.uptime(), sources: Object.keys(SOURCES).length });
    return serveStatic(p, res);
  } catch (e) {
    console.error('[ERR]', p, e && e.message);
    try { sendJson(res, 500, { ok: false, error: String(e && e.message || e) }); } catch (_) {}
  }
});

server.listen(PORT, HOST, () => {
  const line = '='.repeat(56);
  console.log(line);
  console.log('  拾光影院 已启动');
  console.log(`  本地地址 : http://${HOST}:${PORT}`);
  console.log(`  片源     : ${Object.keys(SOURCES).join(', ')} (${Object.keys(SOURCES).length} 个)`);
  console.log(`  数据目录 : ${DATA_DIR}`);
  console.log(line);
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
