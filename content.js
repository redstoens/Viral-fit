// Viral-fit — Content Script (Threads DOM 조작)

let collectRunning = false;
let collectPaused  = false;
let collectedPosts = [];
let collectConfig  = {};

// ── GraphQL 조회수 캐시 ───────────────────────────────────
// inject.js(MAIN world)가 fetch를 가로채서 CustomEvent로 전달
const viewCountCache = new Map(); // postCode → viewCount

window.addEventListener('__vf_views__', e => {
  let added = 0;
  for (const { code, views } of (e.detail || [])) {
    if (views > 0 && !viewCountCache.has(code)) {
      viewCountCache.set(code, views);
      added++;
    }
  }
  if (added > 0) {
    chrome.runtime.sendMessage({
      action: 'logMsg',
      text: `[GraphQL] 조회수 ${added}개 캐시 업데이트 (누적 ${viewCountCache.size}개)`,
    });
  }
});

// ── 메시지 수신 ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ ok: true });
    return;
  }
  if (msg.action === 'startCollect') {
    collectConfig = msg.config;
    startCollecting();
  }
  if (msg.action === 'pauseCollect') {
    collectPaused = true;
  }
  if (msg.action === 'resumeCollect') {
    collectPaused = false;
  }
  if (msg.action === 'stopCollect') {
    collectRunning = false;
    collectPaused  = false;
    chrome.runtime.sendMessage({ action: 'closeCheckWindow' });
  }
  if (msg.action === 'publishPost') {
    publishPost(msg.item);
  }
});

// ── 수집 로직 ─────────────────────────────────────────────
async function startCollecting() {
  collectRunning = true;
  const { minViews, targetCount, delay } = collectConfig;

  // 기존 수집 데이터 로드
  const stored = await chrome.storage.local.get('collectedPosts');
  collectedPosts = stored.collectedPosts || [];

  while (collectRunning && collectedPosts.length < targetCount) {
    const posts = findPostElements();
    for (const el of posts) {
      if (!collectRunning) break;
      if (collectedPosts.length >= targetCount) break;

      // 일시중지 대기
      while (collectPaused && collectRunning) await sleep(500);
      if (!collectRunning) break;

      const nextIndex = collectedPosts.length + 1;
      const data = await extractPostData(el, minViews, nextIndex);
      if (!data) continue;

      const views = typeof data.views === 'number' ? data.views : parseViews(String(data.views));
      if (views < minViews) {
        chrome.runtime.sendMessage({ action: 'collectSkipped', views });
        continue;
      }
      chrome.runtime.sendMessage({ action: 'collectFound', author: data.author, views });

      // 중복 제거
      if (collectedPosts.some(p => p.postUrl === data.postUrl)) continue;

      collectedPosts.push({ ...data, views });
      await chrome.storage.local.set({ collectedPosts });

      // 백그라운드 탭 캡처 결과 (background.js에서 이미 저장 완료)
      if (data.captureFilename) {
        chrome.runtime.sendMessage({ action: 'captureSaved', filename: data.captureFilename });
      }

      chrome.runtime.sendMessage({
        action: 'collectProgress',
        count: collectedPosts.length,
        target: targetCount,
        currentText: (data.text || '').slice(0, 50),
      });

      await sleep(delay);
    }

    if (collectedPosts.length < targetCount && collectRunning) {
      // 스크롤 다운해서 더 로드
      window.scrollBy(0, window.innerHeight * 1.5);
      await sleep(2500);
    }
  }

  if (collectRunning) {
    collectRunning = false;
    chrome.runtime.sendMessage({ action: 'collectDone', count: collectedPosts.length });
    chrome.runtime.sendMessage({ action: 'closeCheckWindow' });
  }
}

function findPostElements() {
  // Threads 게시물 컨테이너 셀렉터 (UI 변경 시 업데이트 필요)
  return Array.from(document.querySelectorAll(
    'article, [data-pressable-container], div[role="article"]'
  ));
}

async function extractPostData(el, minViews = 0, captureIndex = 0) {
  try {
    // 텍스트 추출 — 앵커(username 링크) 내부 요소는 제외
    let textEl = null;
    const textCandidates = el.querySelectorAll('div[dir="auto"], span[dir="auto"]');
    for (const candidate of textCandidates) {
      // a[href] 내부는 username/링크이므로 건너뜀
      if (candidate.closest('a[href]')) continue;
      const txt = (candidate.innerText || '').trim();
      if (txt.length > 0) { textEl = candidate; break; }
    }
    const text = textEl ? textEl.innerText.trim() : '';

    // 작성자 추출
    const authorEl = el.querySelector(
      'a[href*="/@"] span, ' +
      'a[role="link"][href*="/@"], ' +
      '[data-testid*="username"]'
    );
    const author = authorEl
      ? authorEl.innerText.trim().replace('@', '').split('\n')[0].trim()
      : extractAuthorFromUrl(el);

    // 이미지 추출 (프로필 아이콘 제외)
    const imgEl = el.querySelector('img[srcset], img[src*="scontent"], img[src*="cdninstagram"]');
    const imageUrl = imgEl ? imgEl.src : '';

    // 게시물 URL — 다양한 패턴 지원
    const linkEl = el.querySelector(
      'a[href*="/post/"], ' +
      'a[href*="/t/"], ' +
      'a[href*="threads.com/@"]'
    );
    const postUrl = linkEl ? linkEl.href : '';

    if (!postUrl) return null; // URL 없으면 게시물 아님

    // 조회수 + 캡처 (기준 충족 시 백그라운드 탭에서 바로 캡처)
    const { views, captureFilename } = await getViewCount(el, postUrl, minViews, captureIndex, author);

    return { text, author, imageUrl, postUrl, views, captureFilename };
  } catch {
    return null;
  }
}

// 피드 요소 텍스트에서 조회수 추출 시도
function extractViewsFromText(text) {
  const patterns = [
    /조회\s*([\d,.]+\s*(만|천|억)?)\s*회/,   // 조회 1.2만 회
    /([\d,.]+)\s*(만|천|억)\s*회/,            // 1.2만 회
    /([\d,]+)\s*회/,                           // 12,345회
    /([\d,.]+\s*[KMBkmb])\s*views?/i,         // 12.3K views
    /([\d,]+)\s*views?/i,                      // 12,345 views
    /views\s*·?\s*([\d,.]+\s*[KMB]?)/i,       // views · 12.3K
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = parseViews(m[0]);
      if (v > 0) return v;
    }
  }
  return 0;
}

async function getViewCount(el, postUrl, minViews = 0, captureIndex = 0, author = 'unknown') {
  // ── Layer 1: 피드 DOM 텍스트 직접 읽기 ──────────────────
  const inFeed = extractViewsFromText(el.innerText || '');
  if (inFeed > 0) return { views: inFeed, captureFilename: null };

  // ── Layer 2: GraphQL 캐시 (빠름·정확, 탭 없음) ───────────
  // URL에서 post code 추출: /@user/post/CODE
  const postCode = postUrl.split('/post/')[1]?.split(/[?/#]/)[0];
  if (postCode && viewCountCache.has(postCode)) {
    const views = viewCountCache.get(postCode);
    chrome.runtime.sendMessage({
      action: 'logMsg',
      text: `[캐시] ${postCode}: ${views.toLocaleString()}회`,
    });
    // 캐시 히트는 별도 탭 없음 → captureFilename null
    return { views, captureFilename: null };
  }

  // ── Layer 3: 백그라운드 탭 (캐시 미스 fallback) ──────────
  if (!postUrl) return { views: 0, captureFilename: null };
  chrome.runtime.sendMessage({
    action: 'logMsg',
    text: `[탭] 확인 중: ${postUrl.split('/').pop()}`,
  });

  const result = await chrome.runtime.sendMessage({
    action: 'getViewCount',
    postUrl,
    minViews,
    captureIndex,
    author,
  });

  return result || { views: 0, captureFilename: null };
}

function parseViews(viewStr) {
  if (typeof viewStr === 'number') return viewStr;
  const s = String(viewStr).replace(/,/g, '').trim();
  if (/만/.test(s)) return parseFloat(s) * 10000;
  if (/천/.test(s)) return parseFloat(s) * 1000;
  if (/k/i.test(s)) return parseFloat(s) * 1000;
  if (/M/i.test(s)) return parseFloat(s) * 1000000;
  return parseInt(s) || 0;
}

function extractAuthorFromUrl(el) {
  const link = el.querySelector('a[href*="/@"]');
  if (!link) return 'unknown';
  const m = link.href.match('\/@([^/]+)');
  return m ? m[1] : 'unknown';
}

// ── 발행 로직 ─────────────────────────────────────────────
async function publishPost(item) {
  try {
    // Threads 새 게시물 작성 버튼 찾기
    await navigateToCompose();
    await sleep(1500);

    // 텍스트 입력
    const composer = await waitForElement(
      'div[contenteditable="true"][role="textbox"], textarea[placeholder], div[data-lexical-editor="true"]',
      8000
    );
    if (!composer) throw new Error('작성 창을 찾을 수 없습니다.');

    composer.focus();
    await typeText(composer, item.text);
    await sleep(500);

    // 이미지 첨부
    if (item.images && item.images.length > 0) {
      await attachImages(item.images);
      await sleep(1500);
    }

    // 발행 버튼 클릭
    const postBtn = await waitForElement(
      'button[type="submit"], div[role="button"][aria-label*="게시"], button:not([disabled])',
      4000
    );

    // 정확히 '게시' 버튼인지 확인
    const buttons = document.querySelectorAll('button, div[role="button"]');
    let targetBtn = null;
    for (const btn of buttons) {
      const t = btn.innerText.trim();
      if (t === '게시' || t === 'Post' || t === '공유하기') {
        targetBtn = btn;
        break;
      }
    }

    if (!targetBtn) throw new Error('게시 버튼을 찾을 수 없습니다.');
    targetBtn.click();
    await sleep(2000);

    // 상태 업데이트
    await chrome.runtime.sendMessage({ action: 'updateQueueStatus', itemId: item.id, status: 'published' });
    chrome.runtime.sendMessage({ action: 'publishDone', itemId: item.id });

  } catch (e) {
    await chrome.runtime.sendMessage({ action: 'updateQueueStatus', itemId: item.id, status: 'failed' });
    chrome.runtime.sendMessage({ action: 'publishFailed', itemId: item.id, error: e.message });
  }
}

async function navigateToCompose() {
  // 새 게시물 버튼 (연필 아이콘 등)
  const composeSelectors = [
    'a[href*="/compose"]',
    'button[aria-label*="새 게시물"], button[aria-label*="New post"], button[aria-label*="Create"]',
    'svg[aria-label*="새 게시물"]',
  ];
  for (const sel of composeSelectors) {
    const btn = document.querySelector(sel);
    if (btn) { btn.click(); return; }
  }
  // 없으면 compose URL로 직접 이동
  if (!window.location.href.includes('/compose')) {
    window.location.href = 'https://www.threads.net/compose';
    await sleep(3000);
  }
}

async function typeText(el, text) {
  el.focus();
  // execCommand는 contenteditable에서 더 안정적
  document.execCommand('insertText', false, text);
  // React synthetic event 트리거
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
}

async function attachImages(images) {
  // 이미지 첨부 버튼 찾기
  const attachBtn = document.querySelector(
    'button[aria-label*="이미지"], button[aria-label*="photo"], button[aria-label*="media"], input[type="file"][accept*="image"]'
  );
  if (!attachBtn) return;

  for (const img of images) {
    // DataURL → File 객체 변환
    const file = dataUrlToFile(img.dataUrl, `image_${Date.now()}.jpg`, img.mimeType);

    // 파일 input 찾아서 주입
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1000);
    }
  }
}

function dataUrlToFile(dataUrl, filename, mimeType) {
  const arr = dataUrl.split(',');
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], filename, { type: mimeType });
}

// ── 유틸 ──────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForElement(selector, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(200);
  }
  return null;
}
