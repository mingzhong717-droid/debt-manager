/* ============================================================
   Service Worker - 个人负债管理中心
   策略：Cache First（优先缓存，离线可用）
   ============================================================ */

const CACHE_NAME = 'debt-manager-v1';

// 需要缓存的核心资源
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './data.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 需要缓存的 CDN 资源
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js'
];

// ===== 安装：预缓存所有资源 =====
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 缓存本地资源
      await cache.addAll(CORE_ASSETS);
      // 缓存 CDN 资源（忽略失败，网络不好时跳过）
      await Promise.allSettled(
        CDN_ASSETS.map(url =>
          fetch(url).then(res => cache.put(url, res)).catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

// ===== 激活：清理旧缓存 =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ===== 拦截请求：Cache First 策略 =====
self.addEventListener('fetch', (event) => {
  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // 缓存未命中，走网络
      return fetch(event.request).then(response => {
        // 只缓存成功的响应
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // 网络也失败了，返回离线提示（仅对 HTML 请求）
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ===== 接收消息：强制更新缓存 =====
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (event.data === 'clearCache') {
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0]?.postMessage('cleared');
    });
  }
});
