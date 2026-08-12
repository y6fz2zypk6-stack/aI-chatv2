/* このファイルはテンプレート。ビルド時に scripts/build-sw.mjs が
   下の2つの差し込み位置を埋めて dist/sw.js を作る。直接読み込まれることはない。
   （置換対象の語をこのコメントに書かないこと。先に当たって本体が埋まらなくなる）

   会話データ（/api）はキャッシュしない — サーバが唯一の正（§11） */

/** ビルドごとに変わる。中身が変われば新しいキャッシュに入れ替わる */
const VERSION = '__VERSION__';
const CACHE = `charchat-${VERSION}`;

/**
 * install の時点で取りに行くもの（アプリの起動に要る一式）。
 * ページ側のfetchはSWが制御を持つ前に走ってしまうため、
 * ここで自分で取りに行かないと「インストール直後にオフライン」で起動できない。
 */
const PRECACHE = __PRECACHE__;

/** 書体のwoff2は全部で10MB超あるので、precacheせず使ったものだけ拾う */
function isRuntimeCacheable(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/assets/') ||
      url.pathname.startsWith('/fonts/') ||
      url.pathname.startsWith('/icons/'))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // 会話データはキャッシュしない

  // ナビゲーションはネットワーク優先。
  // 新しいビルドを配ったときに古いindex.htmlを掴み続けないようにする
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // 静的アセットはキャッシュ優先。ファイル名にハッシュが入っているので中身は変わらない
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && isRuntimeCacheable(url)) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return res;
      });
    }),
  );
});
