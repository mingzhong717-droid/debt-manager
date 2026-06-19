/* ============================================================
   Service Worker - 个人负债管理中心  v21
   更新策略（解决 PWA 全屏模式下更新不生效问题）：
     - 安装时立即 skipWaiting，激活时立即 clients.claim()
     - 激活后主动通知所有客户端"有新版本，请刷新"
     - app.js / style.css / index.html → Network First（永远优先网络）
     - CDN 资源 / 图标              → Cache First（离线可用）
     - Supabase API 请求            → 直接放行，不缓存
   ============================================================ */

const CACHE_NAME = 'debt-manager-v24';

// 只缓存不常变的静态资源（CDN + 图标）
const STATIC_CACHE = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

// ===== 安装：预缓存静态资源，立即激活 =====
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
  // 关键：立即跳过等待，不管旧页面是否还开着
  self.skipWaiting();
});

// ===== 激活：删除旧缓存，立即接管所有页面，然后通知刷新 =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => {
        // 立即接管所有已打开的页面（不等页面重新导航）
        return self.clients.claim();
      })
      .then(() => {
        // 接管后主动通知所有客户端：新版本已就绪，请刷新
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => {
            client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME });
          });
        });
      })
  );
});

// ===== 拦截请求 =====
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Supabase API → 完全不拦截，直接走网络
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('aigc.sankuai.com')) return;

  // 2. 本地 HTML / JS / CSS / JSON → Network First（永远优先网络）
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
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))  // 离线降级到缓存
    );
    return;
  }

  // 3. CDN / 图标 → Cache First（这些版本固定，不会变）
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
