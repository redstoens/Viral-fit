// Viral-fit — Fetch/XHR Interceptor (MAIN world)
// Threads GraphQL 응답에서 조회수(view_count)를 추출해 content.js로 전달
(function () {
  if (window.__vf_hooked) return;
  window.__vf_hooked = true;

  // ── Fetch 인터셉터 ──────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _fetch.apply(this, args);
    const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) ?? '';
    if (url.includes('/api/graphql')) {
      response.clone().json()
        .then(json => emit(json))
        .catch(() => {});
    }
    return response;
  };

  // ── XHR 인터셉터 (fallback) ────────────────────────────
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (m, url, ...r) {
    this.__vfUrl = String(url);
    return _xhrOpen.call(this, m, url, ...r);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', () => {
      if (!(this.__vfUrl || '').includes('/api/graphql')) return;
      try { emit(JSON.parse(this.responseText)); } catch {}
    });
    return _xhrSend.call(this, body);
  };

  // ── GraphQL JSON 재귀 탐색 ─────────────────────────────
  function scan(obj, out) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(v => scan(v, out)); return; }

    // Threads post 객체: code(URL 단축코드) + view_count
    const code  = typeof obj.code === 'string' ? obj.code : null;
    const views = typeof obj.view_count === 'number' ? obj.view_count
                : typeof obj.viewCount  === 'number' ? obj.viewCount
                : null;
    if (code && views !== null) out.push({ code, views });

    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') scan(v, out);
    }
  }

  function emit(json) {
    const entries = [];
    scan(json, entries);
    if (entries.length) {
      window.dispatchEvent(new CustomEvent('__vf_views__', { detail: entries }));
    }
  }
})();
