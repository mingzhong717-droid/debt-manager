/* ============================================================
   Service Worker - 个人负债管理中心
   策略：
     - app.js / style.css / index.html → Network First（优先网络，保证拿到最新代码）
     - CDN 资源 / 图标              → Cache First（离线可用）
     - Supabase API 请求            → 直接放行，不缓存
   ============================================================ */

const CACHE_NAME = 'debt-manager-v9';  // 每次改这里，旧 SW 会被强制替换

// 只缓存不常变的静态资源（CDN + 图标）
const STATIC_CACHE = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

// ===== 安装：只预缓存静态资源 =====
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        STATIC_CACHE.map(url =>
          fetch(url).then(res => { if (res.ok) cache.put(url, res); }).catch(() => {})
        )
      )
    )
  );
  // 立即激活，不等旧 SW 的页面关闭
  self.skipWaiting();
});

// ===== 激活：删除所有旧版本缓存 =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ===== 拦截请求 =====
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Supabase API / Friday AI API → 完全不拦截，直接走网络
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('aigc.sankuai.com')) return;

  // 2. 本地 HTML / JS / CSS / JSON → Network First
  //    优先从网络拿最新版本，网络失败才降级缓存
  const isAppFile = url.origin === self.location.origin &&
    (url.pathname.endsWith('.html') ||
     url.pathname.endsWith('.js') ||
     url.pathname.endsWith('.css') ||
     url.pathname.endsWith('.json') ||
     url.pathname === '/' ||
     url.pathname.endsWith('/'));

  if (isAppFile) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(res => {
          // 网络成功：更新缓存并返回
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))  // 离线降级
    );
    return;
  }

  // 3. CDN / 图标 → Cache First（这些不会变）
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      });
    })
  );
});

// ===== 接收消息 =====
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'clearCache') {
    caches.delete(CACHE_NAME).then(() => event.ports[0]?.postMessage('cleared'));
  }
});
