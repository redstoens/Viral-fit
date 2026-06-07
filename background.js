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
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 외부 웹페이지에서 온 메시지 차단 (content script 또는 extension 내부만 허용)
  if (sender.origin && !sender.origin.includes('chrome-extension://') &&
      sender.url && !sender.url.startsWith('chrome-extension://')) {
    return;
  }
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
