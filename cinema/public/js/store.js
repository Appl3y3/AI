/* ================================================================
   本地存储：播放记录 / 收藏 / 设置
   ================================================================ */

const K_HIST = 'sg.history.v1';
const K_FAV = 'sg.favorites.v1';
const K_SET = 'sg.settings.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 配额满 */ }
}

/* ---------- 设置 ---------- */
export const DEFAULT_SETTINGS = {
  skipIntro: false,      // 自动跳过片头
  skipOutro: false,      // 自动跳过片尾
  introSeconds: 90,      // 片头时长
  outroSeconds: 90,      // 片尾时长
  autoplayNext: true,    // 自动连播下一集
  danmakuOn: true,       // 默认开弹幕
  danmakuOpacity: 0.9,
  danmakuSize: 18,
  defaultVolume: 0.8,
  rememberRate: true,    // 记住倍速
  lastRate: 1,
  saveHistory: true,
  preferSource: '',
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K_SET, {}) };
}
export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write(K_SET, next);
  return next;
}

/* ---------- 播放记录 ---------- */
/* 一条记录：
   { key, src, id, name, pic, epName, epIndex, lineIndex, t, dur,
     percent, updatedAt, epCount, cat }
*/
export function getHistory() {
  const arr = read(K_HIST, []);
  return Array.isArray(arr) ? arr : [];
}

export function getHistoryOne(key) {
  return getHistory().find((x) => x.key === key) || null;
}

export function saveHistory(rec) {
  const s = getSettings();
  if (!s.saveHistory) return;
  const arr = getHistory().filter((x) => x.key !== rec.key);
  arr.unshift({ ...rec, updatedAt: Date.now() });
  write(K_HIST, arr.slice(0, 300));
}

export function removeHistory(key) {
  write(K_HIST, getHistory().filter((x) => x.key !== key));
}
export function clearHistory() {
  write(K_HIST, []);
}

/** 最近在看（按时间倒序，带进度） */
export function recentList(n = 12) {
  return getHistory()
    .filter((x) => x.percent > 0.01 && x.percent < 0.995)
    .slice(0, n);
}

/* ---------- 收藏 ---------- */
export function getFavorites() {
  const arr = read(K_FAV, []);
  return Array.isArray(arr) ? arr : [];
}
export function isFavorite(key) {
  return getFavorites().some((x) => x.key === key);
}
export function toggleFavorite(item) {
  const arr = getFavorites();
  const i = arr.findIndex((x) => x.key === item.key);
  if (i >= 0) {
    arr.splice(i, 1);
    write(K_FAV, arr);
    return false;
  }
  arr.unshift({ ...item, addedAt: Date.now() });
  write(K_FAV, arr);
  return true;
}
export function removeFavorite(key) {
  write(K_FAV, getFavorites().filter((x) => x.key !== key));
}

/* ---------- 工具 ---------- */
export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}
