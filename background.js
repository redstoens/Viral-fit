// ViralPick Pro — Background Service Worker

// ── AI 텍스트 생성 ────────────────────────────────────────
async function generateWithGemini(apiKey, systemPrompt, userContent) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

async function generateWithGPT4(apiKey, systemPrompt, userContent) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

// ── DALL-E 이미지 생성 ────────────────────────────────────
async function generateImageDalle(apiKey, prompt, size) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  const b64 = data.data[0].b64_json;
  return `data:image/png;base64,${b64}`;
}

// ── 외부 이미지 → DataURL 변환 ───────────────────────────
const ALLOWED_IMAGE_ORIGINS = ['https://www.threads.net', 'https://scontent'];

async function fetchImageAsDataUrl(url) {
  // Threads 도메인 이미지만 허용
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('잘못된 URL'); }
  if (parsed.protocol !== 'https:') throw new Error('HTTPS URL만 허용됩니다.');
  const allowed = ALLOWED_IMAGE_ORIGINS.some(o => parsed.origin.startsWith(o) || parsed.hostname.includes('threads') || parsed.hostname.includes('cdninstagram') || parsed.hostname.includes('fbcdn'));
  if (!allowed) throw new Error(`허용되지 않은 이미지 출처: ${parsed.hostname}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지 fetch 실패: ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw new Error('이미지 파일이 아닙니다.');

  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── 조회수 확인용 영구 팝업 창 (viral-pick 방식) ────────────
// 매 게시물마다 탭을 생성/제거하지 않고 창 하나를 재사용
let checkWindowId = null;
let checkTabId    = null;

async function getOrCreateCheckWindow(url) {
  if (checkWindowId !== null) {
    try {
      await chrome.windows.get(checkWindowId);       // 창이 살아있는지 확인
      await chrome.tabs.update(checkTabId, { url }); // URL만 교체
      return checkTabId;
    } catch {
      checkWindowId = null;
      checkTabId    = null;
    }
  }
  // 새 팝업 창 생성 (작고, 포커스 없음)
  const win = await chrome.windows.create({
    url,
    width: 480,
    height: 700,
    left: 50,
    top: 50,
    type: 'popup',
    focused: false,
  });
  checkWindowId = win.id;
  checkTabId    = win.tabs[0].id;
  return checkTabId;
}

async function closeCheckWindow() {
  if (checkWindowId !== null) {
    try { await chrome.windows.remove(checkWindowId); } catch {}
    checkWindowId = null;
    checkTabId    = null;
  }
}

// 사용자가 수동으로 창을 닫은 경우 감지
chrome.windows.onRemoved.addListener(wid => {
  if (wid === checkWindowId) { checkWindowId = null; checkTabId = null; }
});

// ── 탭에 주입하는 조회수 읽기 스크립트 ────────────────────
// viral-pick과 동일한 폴링 방식:
// "활동 보기" 클릭 → "조회" 텍스트 옆 콤마 포함 정확한 숫자 읽기
function getViewCountScript() {
  return () => new Promise(resolve => {
    let phase    = 'find-button';
    let attempts = 0;
    const MAX    = 30;

    function tick() {
      attempts++;
      if (attempts > MAX) { resolve(null); return; }

      if (phase === 'find-button') {
        // 이미 조회수가 보이는지 먼저 확인
        const early = tryRead();
        if (early) { resolve(early); return; }

        // "활동 보기" / "View activity" 버튼 탐색 후 클릭
        const all = document.querySelectorAll('span[dir="auto"], div, span');
        for (const el of all) {
          const t = el.textContent.trim();
          if (t === '활동 보기' || t === 'View activity') {
            const target = el.closest('[role="button"]') || el.closest('a') ||
                           el.closest('[tabindex]') || el;
            target.click();
            phase = 'read';
            setTimeout(tick, 1500); // 패널 열리기 대기
            return;
          }
        }
        setTimeout(tick, 500);

      } else { // phase === 'read'
        const result = tryRead();
        if (result) { resolve(result); return; }
        setTimeout(tick, 500);
      }
    }

    // "조회" / "Views" 텍스트 엘리먼트를 찾아 인접 숫자 반환
    function tryRead() {
      const all = document.querySelectorAll('div, span');
      for (const el of all) {
        const t = el.textContent.trim();
        if (t === '조회' || t === 'Views') {
          const parent = el.closest('div');
          if (!parent) continue;
          for (const n of parent.querySelectorAll('*')) {
            const nt = n.textContent.trim();
            if (/^[\d,]+$/.test(nt)) {
              const num = parseInt(nt.replace(/,/g, ''), 10);
              if (num > 0) return nt; // "12,345" 형식 그대로 반환
            }
          }
        }
      }
      return null;
    }

    if (document.readyState === 'complete') setTimeout(tick, 2000);
    else window.addEventListener('load', () => setTimeout(tick, 2000));
  });
}

// ── 조회수 확인 (캡처는 content.js에서 담당) ────────────────
async function getViewCountFromUrl(postUrl) {
  try {
    const tabId = await getOrCreateCheckWindow(postUrl);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 20000);
      const listener = (tid, info) => {
        if (tid !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: getViewCountScript(),
    });

    const viewText = results?.[0]?.result || null;
    if (!viewText) return { views: 0 };
    return { views: parseInt(viewText.replace(/,/g, ''), 10) };

  } catch {
    return { views: 0 };
  }
}

// ── 예약 발행 스케줄러 ────────────────────────────────────
async function schedulePost(item) {
  const delay = Math.max(item.scheduledAt - Date.now(), 0);
  const alarmName = `publish_${item.id}`;
  // chrome.alarms: 최소 1분 단위이므로 60초 미만은 setTimeout으로 처리
  if (delay < 60000) {
    setTimeout(() => triggerPublish(item.id), delay);
  } else {
    chrome.alarms.create(alarmName, { when: item.scheduledAt });
  }
}

async function triggerPublish(itemId) {
  const { queue = [] } = await chrome.storage.local.get('queue');
  const item = queue.find(i => i.id === itemId);
  if (!item || item.status !== 'pending') return;

  // Threads 탭 찾기
  const tabs = await chrome.tabs.query({ url: 'https://www.threads.net/*' });
  if (!tabs.length) {
    // Threads 탭 없으면 새로 열기
    const newTab = await chrome.tabs.create({ url: 'https://www.threads.net/' });
    // 탭 로딩 대기 후 발행
    setTimeout(() => {
      chrome.tabs.sendMessage(newTab.id, { action: 'publishPost', item });
    }, 4000);
    return;
  }
  chrome.tabs.sendMessage(tabs[0].id, { action: 'publishPost', item });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('publish_')) return;
  const itemId = alarm.name.replace('publish_', '');
  await triggerPublish(itemId);
});

// ── 메시지 핸들러 ─────────────────────────────────────────
const VALID_ACTIONS = new Set([
  'generateText', 'generateImage', 'fetchImageAsDataUrl',
  'schedulePost', 'updateQueueStatus',
  'getViewCount', 'captureTab', 'download', 'closeCheckWindow', 'logMsg',
  'collectSessionDir',
]);

const CAPTURE_FOLDER = 'viral-fit_captures';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 같은 확장 프로그램에서 온 메시지만 허용 (popup, content script 모두 포함)
  if (sender.id !== chrome.runtime.id) return;
  if (!msg.action || !VALID_ACTIONS.has(msg.action)) return;

  (async () => {
    try {
      if (msg.action === 'generateText') {
        const text = msg.model === 'gemini'
          ? await generateWithGemini(msg.apiKey, msg.systemPrompt, msg.userContent)
          : await generateWithGPT4(msg.apiKey, msg.systemPrompt, msg.userContent);
        sendResponse({ text });
      }

      else if (msg.action === 'generateImage') {
        const dataUrl = await generateImageDalle(msg.apiKey, msg.prompt, msg.size);
        sendResponse({ dataUrl });
      }

      else if (msg.action === 'fetchImageAsDataUrl') {
        const dataUrl = await fetchImageAsDataUrl(msg.url);
        sendResponse({ dataUrl });
      }

      else if (msg.action === 'schedulePost') {
        await schedulePost(msg.item);
        sendResponse({ ok: true });
      }

      else if (msg.action === 'getViewCount') {
        const result = await getViewCountFromUrl(msg.postUrl);
        sendResponse(result); // { views }
      }

      else if (msg.action === 'captureTab') {
        // viral-pick과 동일한 구조:
        // 피드 창을 포커스한 뒤 captureVisibleTab으로 정확히 캡처
        const senderTab = sender.tab;
        if (!senderTab) { sendResponse(null); return; }
        try {
          await chrome.windows.update(senderTab.windowId, { focused: true });
          await new Promise(r => setTimeout(r, 200));
          const dataUrl = await chrome.tabs.captureVisibleTab(senderTab.windowId, {
            format: 'png',
            quality: 100,
          });
          sendResponse(dataUrl);
        } catch {
          sendResponse(null);
        }
      }

      else if (msg.action === 'download') {
        await chrome.downloads.download({ url: msg.dataUrl, filename: msg.filename, saveAs: false });
        sendResponse({ ok: true });
      }

      else if (msg.action === 'closeCheckWindow') {
        await closeCheckWindow();
        sendResponse({ ok: true });
      }

      else if (msg.action === 'logMsg') {
        // popup이 열려 있으면 로그 전달
        await chrome.runtime.sendMessage({ action: 'popupLog', text: msg.text }).catch(() => {});
        sendResponse({ ok: true });
      }

      else if (msg.action === 'collectSessionDir') {
        // content.js → background → popup 포워딩
        await chrome.runtime.sendMessage({ action: 'collectSessionDir', dir: msg.dir }).catch(() => {});
        sendResponse({ ok: true });
      }

      else if (msg.action === 'saveCapture') {
        const filename = await saveCapture(msg.post, msg.index, sender.tab?.id);
        sendResponse({ ok: true, filename });
      }

      else if (msg.action === 'updateQueueStatus') {
        const { queue = [] } = await chrome.storage.local.get('queue');
        const idx = queue.findIndex(i => i.id === msg.itemId);
        if (idx !== -1) {
          queue[idx].status = msg.status;
          await chrome.storage.local.set({ queue });
        }
        sendResponse({ ok: true });
      }

    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true; // 비동기 응답 허용
});

// 미완료 큐 복구 (확장 재시작 시)
chrome.runtime.onStartup.addListener(async () => {
  const { queue = [] } = await chrome.storage.local.get('queue');
  const now = Date.now();
  for (const item of queue) {
    if (item.status !== 'pending') continue;
    if (item.scheduledAt > now) {
      await schedulePost(item);
    } else {
      // 이미 지난 예약 → 즉시 발행
      await triggerPublish(item.id);
    }
  }
});
