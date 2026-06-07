// ViralPick Pro — Background Service Worker

// ── AI 텍스트 생성 ────────────────────────────────────────
async function generateWithClaude(apiKey, systemPrompt, userContent) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content[0].text;
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

// ── 조회수 읽기 (백그라운드 탭) ───────────────────────────
function parseViewsInTab() {
  // 이 함수는 별도 탭에서 실행됨
  const text = document.body?.innerText || '';
  const patterns = [
    /조회\s*([\d,.]+\s*(만|천|억)?)\s*회/,
    /([\d,.]+)\s*(만|천|억)\s*회/,
    /([\d,]+)\s*회/,
    /([\d,.]+\s*[KMBkmb])\s*views?/i,
    /([\d,]+)\s*views?/i,
    /views\s*[·\s]\s*([\d,.]+\s*[KMB]?)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const raw = m[0].replace(/,/g, '').trim();
      let num = 0;
      if (/만/.test(raw))      num = parseFloat(raw) * 10000;
      else if (/천/.test(raw)) num = parseFloat(raw) * 1000;
      else if (/억/.test(raw)) num = parseFloat(raw) * 100000000;
      else if (/[KkK]/.test(raw)) num = parseFloat(raw) * 1000;
      else if (/M/.test(raw))  num = parseFloat(raw) * 1000000;
      else if (/B/.test(raw))  num = parseFloat(raw) * 1000000000;
      else num = parseInt(raw) || 0;
      if (num > 0) return num;
    }
  }
  return 0;
}

// ── 조회수 확인 + 기준 충족 시 캡처 (백그라운드 탭) ────────
async function getViewCountFromUrl(postUrl, minViews = 0, captureIndex = 0, author = 'unknown') {
  return new Promise(resolve => {
    let tabId = null;
    let done  = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      resolve(result);
    };

    // 15초 타임아웃
    const timer = setTimeout(() => finish({ views: 0, captureFilename: null }), 15000);

    const onUpdated = async (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;

      // React 렌더링 대기
      await new Promise(r => setTimeout(r, 2500));

      try {
        // 1. 조회수 읽기
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: parseViewsInTab,
        });
        const views = results[0]?.result || 0;

        // 2. 기준 충족 시 → 해당 백그라운드 탭 캡처
        let captureFilename = null;
        if (views >= minViews && minViews > 0) {
          captureFilename = await captureTab(tabId, captureIndex, author);
        }

        clearTimeout(timer);
        finish({ views, captureFilename });
      } catch {
        clearTimeout(timer);
        finish({ views: 0, captureFilename: null });
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.create({ url: postUrl, active: false })
      .then(tab => { tabId = tab.id; })
      .catch(() => { clearTimeout(timer); resolve({ views: 0, captureFilename: null }); });
  });
}

// ── 탭 캡처 및 저장 ──────────────────────────────────────
async function captureTab(tabId, index, author) {
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeAuthor = (author || 'unknown').replace(/[^a-zA-Z0-9가-힣_]/g, '_').slice(0, 20);
  const baseName   = `${String(index).padStart(3, '0')}_${safeAuthor}_${timestamp}`;
  const filename   = `${CAPTURE_FOLDER}/${baseName}.png`;

  try {
    // Chrome 116+: captureTab API — 비활성 탭도 캡처 가능
    const dataUrl = await chrome.tabs.captureTab(tabId, { format: 'png' });
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return filename;
  } catch {
    // fallback: 탭을 잠깐 활성화해서 캡처
    try {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(r => setTimeout(r, 600));
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      return filename;
    } catch {
      return null;
    }
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
  'schedulePost', 'updateQueueStatus', 'saveCapture',
  'getViewCount', 'logMsg',
]);

const CAPTURE_FOLDER = 'viral-fit_captures';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 같은 확장 프로그램에서 온 메시지만 허용 (popup, content script 모두 포함)
  if (sender.id !== chrome.runtime.id) return;
  if (!msg.action || !VALID_ACTIONS.has(msg.action)) return;

  (async () => {
    try {
      if (msg.action === 'generateText') {
        const text = msg.model === 'claude'
          ? await generateWithClaude(msg.apiKey, msg.systemPrompt, msg.userContent)
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
        const result = await getViewCountFromUrl(msg.postUrl, msg.minViews, msg.captureIndex, msg.author);
        sendResponse(result); // { views, captureFilename }
      }

      else if (msg.action === 'logMsg') {
        // popup이 열려 있으면 로그 전달
        const views = await chrome.runtime.sendMessage({ action: 'popupLog', text: msg.text })
          .catch(() => {});
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
