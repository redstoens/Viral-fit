// ViralPick Pro — Popup Controller

// ── 탭 전환 ──────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'generate') refreshSourceSelect();
    if (btn.dataset.tab === 'queue') renderQueue();
  });
});

// ── 유틸 ─────────────────────────────────────────────────
function setStatus(el, msg, type = '') {
  el.textContent = msg;
  el.className = `status-bar ${type}`;
  el.classList.remove('hidden');
}

async function getSettings() {
  return new Promise(resolve =>
    chrome.storage.local.get(['claudeApiKey', 'openaiApiKey', 'defaultModel', 'publishDelay'], resolve)
  );
}

// ── 수집 탭 ──────────────────────────────────────────────
const collectStatus = document.getElementById('collectStatus');
const collectedCountEl = document.getElementById('collectedCount');
const collectedListEl = document.getElementById('collectedList');

let isCollecting = false;

document.getElementById('btnStartCollect').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url.includes('threads.net')) {
    setStatus(collectStatus, 'Threads 탭을 열고 탐색 피드로 이동하세요.', 'error');
    return;
  }

  isCollecting = true;
  document.getElementById('btnStartCollect').disabled = true;
  document.getElementById('btnStopCollect').disabled = false;
  setStatus(collectStatus, '수집 중...');

  const config = {
    minViews: parseInt(document.getElementById('minViews').value),
    targetCount: parseInt(document.getElementById('targetCount').value),
    delay: parseInt(document.getElementById('delay').value),
  };

  chrome.tabs.sendMessage(tab.id, { action: 'startCollect', config });
});

document.getElementById('btnStopCollect').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'stopCollect' });
  isCollecting = false;
  document.getElementById('btnStartCollect').disabled = false;
  document.getElementById('btnStopCollect').disabled = true;
  setStatus(collectStatus, '수집 중지됨');
});

document.getElementById('btnExportCSV').addEventListener('click', () => {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    if (!collectedPosts.length) return;
    const header = 'author,views,text,imageUrl,postUrl\n';
    const rows = collectedPosts.map(p =>
      `"${p.author}","${p.views}","${(p.text||'').replace(/"/g,'""')}","${p.imageUrl||''}","${p.postUrl||''}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'viralpick_export.csv' });
  });
});

function sanitize(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderCollectedPosts(posts) {
  collectedCountEl.textContent = `수집된 게시물: ${posts.length}개`;
  collectedListEl.innerHTML = '';
  posts.slice().reverse().forEach((p) => {
    const div = document.createElement('div');
    div.className = 'post-item';

    const views = document.createElement('div');
    views.className = 'post-views';
    views.textContent = `조회수 ${Number(p.views).toLocaleString()}회`;

    const text = document.createElement('div');
    text.className = 'post-text';
    text.textContent = p.text || '(텍스트 없음)';

    const author = document.createElement('div');
    author.className = 'post-author';
    author.textContent = `@${p.author || '알 수 없음'}`;

    div.appendChild(views);
    div.appendChild(text);
    div.appendChild(author);

    if (p.imageUrl && /^https?:\/\//.test(p.imageUrl)) {
      const img = document.createElement('img');
      img.alt = '썸네일';
      img.src = p.imageUrl;
      div.appendChild(img);
    }

    collectedListEl.appendChild(div);
  });
}

// content.js → popup 메시지 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'collectProgress') {
    setStatus(collectStatus, `수집 중... ${msg.count}개 / ${msg.target}개`);
    chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
      renderCollectedPosts(collectedPosts);
    });
  }
  if (msg.action === 'collectDone') {
    isCollecting = false;
    document.getElementById('btnStartCollect').disabled = false;
    document.getElementById('btnStopCollect').disabled = true;
    setStatus(collectStatus, `완료! ${msg.count}개 수집됨`, 'success');
    chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
      renderCollectedPosts(collectedPosts);
    });
  }
  if (msg.action === 'collectError') {
    setStatus(collectStatus, msg.error, 'error');
  }
  if (msg.action === 'publishDone') {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'ViralPick Pro', message: '게시물 발행 완료!'
    });
    renderQueue();
  }
  if (msg.action === 'publishFailed') {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'ViralPick Pro', message: `발행 실패: ${msg.error}`
    });
    renderQueue();
  }
});

// 초기 수집 목록 로드
chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
  renderCollectedPosts(collectedPosts);
});

// ── AI 생성 탭 ────────────────────────────────────────────
function refreshSourceSelect() {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    const sel = document.getElementById('sourcePost');
    sel.innerHTML = '<option value="">-- 수집된 게시물 선택 --</option>';
    collectedPosts.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `@${p.author} — ${(p.text||'').slice(0, 40)}...`;
      sel.appendChild(opt);
    });
  });
}

document.getElementById('btnGenerate').addEventListener('click', async () => {
  const settings = await getSettings();
  const model = document.getElementById('aiModel').value;
  const apiKey = model === 'claude' ? settings.claudeApiKey : settings.openaiApiKey;

  if (!apiKey) {
    alert('설정 탭에서 API 키를 먼저 입력해주세요.');
    return;
  }

  chrome.storage.local.get('collectedPosts', async ({ collectedPosts = [] }) => {
    const idx = document.getElementById('sourcePost').value;
    const userPrompt = document.getElementById('userPrompt').value;

    let analysisText;
    if (idx === '') {
      // 전체 분석
      if (!collectedPosts.length) { alert('먼저 게시물을 수집하세요.'); return; }
      analysisText = collectedPosts.slice(0, 10).map((p, i) =>
        `[${i+1}] @${p.author} (조회수 ${p.views})\n${p.text}`
      ).join('\n\n');
    } else {
      const p = collectedPosts[parseInt(idx)];
      analysisText = `@${p.author} (조회수 ${p.views})\n${p.text}`;
    }

    const systemPrompt = `당신은 Threads SNS 전문 콘텐츠 작가입니다.
바이럴 게시물의 구조, 어조, 훅, 감정 자극 방식을 분석하고
같은 패턴을 활용해 완전히 새로운 창작 게시물을 작성합니다.
- 원본과 내용이 겹치지 않게 작성
- 자연스럽고 공감 가는 한국어
- 500자 이내
- 해시태그 없음`;

    const userContent = `다음 바이럴 게시물을 참고해서 새로운 Threads 게시글을 작성해주세요.\n\n${analysisText}${userPrompt ? `\n\n추가 요구사항: ${userPrompt}` : ''}`;

    const loadingEl = document.getElementById('generateLoading');
    loadingEl.classList.remove('hidden');
    document.getElementById('generatedSection').style.display = 'none';

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'generateText',
        model,
        apiKey,
        systemPrompt,
        userContent,
      });

      loadingEl.classList.add('hidden');
      if (result.error) throw new Error(result.error);

      document.getElementById('generatedText').value = result.text;
      document.getElementById('generatedSection').style.display = 'block';
    } catch (e) {
      loadingEl.classList.add('hidden');
      alert('생성 실패: ' + e.message);
    }
  });
});

document.getElementById('btnUseAll').addEventListener('click', () => {
  document.getElementById('sourcePost').value = '';
  document.getElementById('btnGenerate').click();
});

document.getElementById('btnRegenerate').addEventListener('click', () => {
  document.getElementById('btnGenerate').click();
});

document.getElementById('btnSendToQueue').addEventListener('click', () => {
  const text = document.getElementById('generatedText').value.trim();
  if (!text) return;
  document.getElementById('composeText').value = text;
  // 큐 탭으로 이동
  document.querySelector('[data-tab="queue"]').click();
});

// ── 발행 큐 탭 ────────────────────────────────────────────
let pendingImages = []; // { dataUrl, mimeType }[]

document.getElementById('btnImageUpload').addEventListener('click', () => {
  document.getElementById('imageFileInput').click();
});

document.getElementById('imageFileInput').addEventListener('change', (e) => {
  Array.from(e.target.files).forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => {
      pendingImages.push({ dataUrl: ev.target.result, mimeType: file.type });
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});

document.getElementById('btnImageViral').addEventListener('click', () => {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    const withImages = collectedPosts.filter(p => p.imageUrl);
    if (!withImages.length) { alert('이미지가 있는 수집 게시물이 없습니다.'); return; }
    // 간단한 선택 UI (alert 방식 — 향후 모달로 개선 가능)
    const list = withImages.slice(0, 5).map((p, i) => `${i+1}. @${p.author} (조회수 ${p.views})`).join('\n');
    const choice = prompt(`이미지 선택 (번호 입력):\n${list}`);
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= withImages.length) return;
    const p = withImages[idx];
    // dataUrl로 변환 (background에서 fetch)
    chrome.runtime.sendMessage({ action: 'fetchImageAsDataUrl', url: p.imageUrl }, (res) => {
      if (res && res.dataUrl) {
        pendingImages.push({ dataUrl: res.dataUrl, mimeType: 'image/jpeg' });
        renderImagePreviews();
      }
    });
  });
});

document.getElementById('btnImageDalle').addEventListener('click', () => {
  document.getElementById('dallePanel').classList.toggle('hidden');
});

document.getElementById('btnGenerateImage').addEventListener('click', async () => {
  const settings = await getSettings();
  if (!settings.openaiApiKey) { alert('설정 탭에서 OpenAI API 키를 입력하세요.'); return; }

  const promptText = document.getElementById('dallePrompt').value.trim();
  if (!promptText) { alert('이미지 설명을 입력하세요.'); return; }

  const size = document.getElementById('dalleSize').value;
  const loading = document.getElementById('dalleLoading');
  loading.classList.remove('hidden');

  const result = await chrome.runtime.sendMessage({
    action: 'generateImage',
    apiKey: settings.openaiApiKey,
    prompt: promptText,
    size,
  });

  loading.classList.add('hidden');
  if (result.error) { alert('이미지 생성 실패: ' + result.error); return; }

  pendingImages.push({ dataUrl: result.dataUrl, mimeType: 'image/png' });
  renderImagePreviews();
  document.getElementById('dallePanel').classList.add('hidden');
});

function renderImagePreviews() {
  const container = document.getElementById('imagePreviewList');
  container.innerHTML = '';
  pendingImages.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-item';

    // dataUrl은 extension 내부에서 생성된 것만 허용 (file upload, DALL-E, fetch)
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;

    const btn = document.createElement('button');
    btn.className = 'remove-img';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    });

    wrap.appendChild(imgEl);
    wrap.appendChild(btn);
    container.appendChild(wrap);
  });
}

document.getElementById('btnAddQueue').addEventListener('click', () => {
  const text = document.getElementById('composeText').value.trim();
  if (!text) { alert('게시글 내용을 입력하세요.'); return; }
  const scheduleTime = document.getElementById('scheduleTime').value;
  if (!scheduleTime) { alert('발행 시간을 선택하세요.'); return; }

  const scheduledAt = new Date(scheduleTime).getTime();
  if (scheduledAt <= Date.now()) { alert('미래 시간을 선택하세요.'); return; }

  const item = {
    id: Date.now().toString(),
    text,
    images: [...pendingImages],
    scheduledAt,
    status: 'pending',
  };

  chrome.storage.local.get('queue', ({ queue = [] }) => {
    queue.push(item);
    chrome.storage.local.set({ queue }, () => {
      chrome.runtime.sendMessage({ action: 'schedulePost', item });
      resetCompose();
      renderQueue();
    });
  });
});

document.getElementById('btnPublishNow').addEventListener('click', async () => {
  const text = document.getElementById('composeText').value.trim();
  if (!text) { alert('게시글 내용을 입력하세요.'); return; }

  const item = {
    id: Date.now().toString(),
    text,
    images: [...pendingImages],
    scheduledAt: Date.now(),
    status: 'pending',
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url.includes('threads.net')) {
    alert('Threads 탭으로 이동 후 다시 시도하세요.');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: 'publishPost', item });
  resetCompose();
});

document.getElementById('btnClearQueue').addEventListener('click', () => {
  if (!confirm('예약된 게시물을 모두 삭제할까요?')) return;
  chrome.storage.local.set({ queue: [] }, renderQueue);
});

function resetCompose() {
  document.getElementById('composeText').value = '';
  document.getElementById('scheduleTime').value = '';
  pendingImages = [];
  renderImagePreviews();
}

function renderQueue() {
  chrome.storage.local.get('queue', ({ queue = [] }) => {
    const container = document.getElementById('queueList');
    container.innerHTML = '';
    if (!queue.length) {
      container.innerHTML = '<div style="color:#555;font-size:12px;text-align:center;padding:20px">예약된 게시물 없음</div>';
      return;
    }
    queue.slice().reverse().forEach(item => {
      const statusMap = { pending: '예약됨', published: '발행완료', failed: '실패' };
      const statusClass = { pending: 'status-pending', published: 'status-published', failed: 'status-failed' };

      const div = document.createElement('div');
      div.className = 'queue-item';

      // 썸네일 (dataUrl은 내부 생성만 허용)
      if (item.images && item.images[0]) {
        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.src = item.images[0].dataUrl;
        div.appendChild(thumb);
      }

      const timeEl = document.createElement('div');
      timeEl.className = 'queue-time';
      timeEl.textContent = item.scheduledAt
        ? new Date(item.scheduledAt).toLocaleString('ko-KR')
        : '즉시 발행';

      const textEl = document.createElement('div');
      textEl.className = 'queue-text';
      textEl.textContent = item.text; // textContent로 XSS 방지

      const statusEl = document.createElement('span');
      statusEl.className = `queue-status ${statusClass[item.status] || 'status-pending'}`;
      statusEl.textContent = statusMap[item.status] || '알 수 없음';

      const actions = document.createElement('div');
      actions.className = 'queue-actions';
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm btn-danger';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', () => {
        chrome.storage.local.get('queue', ({ queue: q = [] }) => {
          chrome.storage.local.set({ queue: q.filter(i => i.id !== item.id) }, renderQueue);
        });
      });
      actions.appendChild(delBtn);

      div.appendChild(timeEl);
      div.appendChild(textEl);
      div.appendChild(statusEl);
      div.appendChild(actions);
      container.appendChild(div);
    });
  });
}

// ── 설정 탭 ──────────────────────────────────────────────
chrome.storage.local.get(
  ['claudeApiKey', 'openaiApiKey', 'defaultModel', 'publishDelay'],
  ({ claudeApiKey = '', openaiApiKey = '', defaultModel = 'claude', publishDelay = 30 }) => {
    document.getElementById('claudeApiKey').value = claudeApiKey;
    document.getElementById('openaiApiKey').value = openaiApiKey;
    document.getElementById('defaultModel').value = defaultModel;
    document.getElementById('publishDelay').value = publishDelay;
  }
);

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  const data = {
    claudeApiKey: document.getElementById('claudeApiKey').value.trim(),
    openaiApiKey: document.getElementById('openaiApiKey').value.trim(),
    defaultModel: document.getElementById('defaultModel').value,
    publishDelay: parseInt(document.getElementById('publishDelay').value),
  };
  chrome.storage.local.set(data, () => {
    const msg = document.getElementById('settingsMsg');
    setStatus(msg, '저장되었습니다.', 'success');
    setTimeout(() => msg.classList.add('hidden'), 2000);
  });
});
