// ViralPick Pro — Content Script (Threads DOM 조작)

let collectRunning = false;
let collectPaused  = false;
let collectedPosts = [];
let collectConfig  = {};

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

      const data = await extractPostData(el);
      if (!data) continue;

      // 일시중지 대기
      while (collectPaused && collectRunning) await sleep(500);
      if (!collectRunning) break;

      const views = parseViews(data.views);
      if (views < minViews) {
        chrome.runtime.sendMessage({ action: 'collectSkipped', views });
        continue;
      }
      chrome.runtime.sendMessage({ action: 'collectFound', author: data.author, views });

      // 중복 제거
      if (collectedPosts.some(p => p.postUrl === data.postUrl)) continue;

      collectedPosts.push({ ...data, views });
      await chrome.storage.local.set({ collectedPosts });

      // 캡처 저장 요청
      chrome.runtime.sendMessage({
        action: 'saveCapture',
        post: { ...data, views },
        index: collectedPosts.length,
      }, res => {
        if (res?.filename) {
          chrome.runtime.sendMessage({ action: 'captureSaved', filename: res.filename });
        }
      });

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
    chrome.runtime.sendMessage({
      action: 'collectDone',
      count: collectedPosts.length,
    });
  }
}

function findPostElements() {
  // Threads 게시물 컨테이너 셀렉터 (UI 변경 시 업데이트 필요)
  return Array.from(document.querySelectorAll(
    'article, [data-pressable-container], div[role="article"]'
  ));
}

async function extractPostData(el) {
  try {
    // 텍스트 추출
    const textEl = el.querySelector('span[dir="auto"], div[dir="auto"]');
    const text = textEl ? textEl.innerText.trim() : '';

    // 작성자 추출
    const authorEl = el.querySelector('a[href*="/@"] span, [data-testid*="username"]');
    const author = authorEl
      ? authorEl.innerText.trim().replace('@', '')
      : extractAuthorFromUrl(el);

    // 이미지 추출
    const imgEl = el.querySelector('img:not([alt=""])');
    const imageUrl = imgEl ? imgEl.src : '';

    // 게시물 URL
    const linkEl = el.querySelector('a[href*="/post/"], a[href*="/t/"]');
    const postUrl = linkEl ? linkEl.href : '';

    // 조회수 — 게시물을 열어야 확인 가능한 경우
    let views = await getViewCount(el, postUrl);

    if (!text && !postUrl) return null;
    return { text, author, imageUrl, postUrl, views };
  } catch {
    return null;
  }
}

async function getViewCount(el) {
  // 현재 요소 텍스트에서 조회수 패턴 검색
  const allText = el.innerText;
  const viewMatch = allText.match(/([\d,\.]+)\s*(만|천|k|M)?\s*(회|views?|조회)/i);
  if (viewMatch) return viewMatch[0];
  // 피드에서 조회수가 안 보이는 경우 — 기본값 반환 (개별 게시물 페이지에서만 확인 가능)
  return '0';
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
