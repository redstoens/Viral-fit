// Viral-fit — Popup Controller

// ── 버전 표시 ─────────────────────────────────────────────
const manifest = chrome.runtime.getManifest();
document.getElementById('versionBadge').textContent = `v${manifest.version}`;

// ── 탭 전환 ──────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'generate') refreshSourceSelect();
    if (btn.dataset.tab === 'queue') renderQueue();
  });
});

// ── Threads 탭 유틸 ──────────────────────────────────────
function isThreadsUrl(url) {
  return url && (url.includes('threads.net') || url.includes('threads.com'));
}

async function getThreadsTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(t => isThreadsUrl(t.url)) || null;
}

async function ensureContentScript(tabId) {
  try {
    await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (res) => {
        if (chrome.runtime.lastError || !res) reject();
        else resolve();
      });
    });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 400));
  }
}

// ── 설정 불러오기 ─────────────────────────────────────────
async function getSettings() {
  return new Promise(resolve =>
    chrome.storage.local.get(['claudeApiKey', 'openaiApiKey', 'defaultModel', 'publishDelay'], resolve)
  );
}

// ── 수집 탭 ──────────────────────────────────────────────
const progressLabel  = document.getElementById('progressLabel');
const progressCount  = document.getElementById('progressCount');
const progressFill   = document.getElementById('progressFill');
const progressDetail = document.getElementById('progressDetail');
const collectedCount = document.getElementById('collectedCount');
const collectedList  = document.getElementById('collectedList');

function setProgress(label, count, target, detail = '') {
  progressLabel.textContent  = label;
  progressCount.textContent  = `${count} / ${target}`;
  progressFill.style.width   = target > 0 ? `${Math.min((count / target) * 100, 100)}%` : '0%';
  progressDetail.textContent = detail;
}

document.getElementById('btnStartCollect').addEventListener('click', async () => {
  const tab = await getThreadsTab();
  if (!tab) {
    setProgress('Threads를 먼저 열어주세요', 0, 0, 'threads.com 또는 threads.net');
    return;
  }

  setProgress('연결 중...', 0, 0);
  await ensureContentScript(tab.id);

  const config = {
    minViews:    parseInt(document.getElementById('minViews').value),
    targetCount: parseInt(document.getElementById('targetCount').value),
    delay:       parseInt(document.getElementById('delay').value),
  };

  setProgress('수집 시작', 0, config.targetCount);
  document.getElementById('btnStartCollect').disabled = true;
  document.getElementById('btnStopCollect').disabled  = false;

  chrome.tabs.sendMessage(tab.id, { action: 'startCollect', config });
});

document.getElementById('btnStopCollect').addEventListener('click', async () => {
  const tab = await getThreadsTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { action: 'stopCollect' });
  document.getElementById('btnStartCollect').disabled = false;
  document.getElementById('btnStopCollect').disabled  = true;
  progressLabel.textContent = '수집 중지됨';
});

document.getElementById('btnExportCSV').addEventListener('click', () => {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    if (!collectedPosts.length) return;
    const header = 'author,views,text,imageUrl,postUrl\n';
    const rows = collectedPosts.map(p =>
      `"${p.author}","${p.views}","${(p.text||'').replace(/"/g,'""')}","${p.imageUrl||''}","${p.postUrl||''}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'viral-fit_export.csv' });
  });
});

// content.js → popup 메시지 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'collectProgress') {
    setProgress('수집 중', msg.count, msg.target, msg.currentText || '');
    loadAndRenderPosts();
  }
  if (msg.action === 'collectDone') {
    setProgress('수집 완료!', msg.count, msg.count, `${msg.count}개 저장됨`);
    document.getElementById('btnStartCollect').disabled = false;
    document.getElementById('btnStopCollect').disabled  = true;
    loadAndRenderPosts();
  }
  if (msg.action === 'publishDone') {
    showNotification('발행 완료!');
    renderQueue();
  }
  if (msg.action === 'publishFailed') {
    showNotification(`발행 실패: ${msg.error}`, true);
    renderQueue();
  }
});

function showNotification(message, isError = false) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Viral-fit',
    message,
  });
}

function loadAndRenderPosts() {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    renderCollectedPosts(collectedPosts);
  });
}

function renderCollectedPosts(posts) {
  collectedCount.textContent = `수집된 게시물 ${posts.length}개`;
  collectedList.innerHTML = '';

  if (!posts.length) {
    collectedList.innerHTML = '<div class="empty">수집된 게시물 없음</div>';
    return;
  }

  posts.slice().reverse().forEach(p => {
    const card = document.createElement('div');
    card.className = 'post-card';

    if (p.imageUrl && /^https?:\/\//.test(p.imageUrl)) {
      const img = document.createElement('img');
      img.className = 'post-thumb';
      img.src = p.imageUrl;
      img.onerror = () => img.replaceWith(makePlaceholder());
      card.appendChild(img);
    } else {
      card.appendChild(makePlaceholder());
    }

    const info = document.createElement('div');
    info.className = 'post-info';

    const views = document.createElement('div');
    views.className = 'post-views';
    views.textContent = `조회수 ${Number(p.views).toLocaleString()}회`;

    const text = document.createElement('div');
    text.className = 'post-text';
    text.textContent = p.text || '(텍스트 없음)';

    const author = document.createElement('div');
    author.className = 'post-author';
    author.textContent = `@${p.author || '알 수 없음'}`;

    info.appendChild(views);
    info.appendChild(text);
    info.appendChild(author);
    card.appendChild(info);
    collectedList.appendChild(card);
  });
}

function makePlaceholder() {
  const el = document.createElement('div');
  el.className = 'post-thumb-placeholder';
  el.textContent = '📄';
  return el;
}

// 초기 로드
loadAndRenderPosts();

// ── AI 생성 탭 ────────────────────────────────────────────
function refreshSourceSelect() {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    const sel = document.getElementById('sourcePost');
    sel.innerHTML = '<option value="">전체 분석 (패턴 종합)</option>';
    collectedPosts.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `@${p.author} — ${(p.text||'').slice(0, 35)}...`;
      sel.appendChild(opt);
    });
  });
}

document.getElementById('btnGenerate').addEventListener('click', async () => {
  const settings = await getSettings();
  const model    = document.getElementById('aiModel').value;
  const apiKey   = model === 'claude' ? settings.claudeApiKey : settings.openaiApiKey;

  if (!apiKey) { alert('설정 탭에서 API 키를 먼저 입력하세요.'); return; }

  chrome.storage.local.get('collectedPosts', async ({ collectedPosts = [] }) => {
    const idx        = document.getElementById('sourcePost').value;
    const userPrompt = document.getElementById('userPrompt').value;

    let analysisText;
    if (idx === '') {
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
- 500자 이내, 해시태그 없음`;

    const userContent = `다음 바이럴 게시물을 참고해서 새로운 Threads 게시글을 작성해주세요.\n\n${analysisText}${userPrompt ? `\n\n추가 요구사항: ${userPrompt}` : ''}`;

    const loadingEl = document.getElementById('generateLoading');
    loadingEl.classList.remove('hidden');
    document.getElementById('generatedSection').classList.add('hidden');

    try {
      const result = await chrome.runtime.sendMessage({ action: 'generateText', model, apiKey, systemPrompt, userContent });
      loadingEl.classList.add('hidden');
      if (result.error) throw new Error(result.error);
      document.getElementById('generatedText').value = result.text;
      document.getElementById('generatedSection').classList.remove('hidden');
    } catch (e) {
      loadingEl.classList.add('hidden');
      alert('생성 실패: ' + e.message);
    }
  });
});

document.getElementById('btnRegenerate').addEventListener('click', () => document.getElementById('btnGenerate').click());

document.getElementById('btnSendToQueue').addEventListener('click', () => {
  const text = document.getElementById('generatedText').value.trim();
  if (!text) return;
  document.getElementById('composeText').value = text;
  document.querySelector('[data-tab="queue"]').click();
});

// ── 발행 큐 탭 ────────────────────────────────────────────
let pendingImages = [];

document.getElementById('btnImageUpload').addEventListener('click', () => document.getElementById('imageFileInput').click());

document.getElementById('imageFileInput').addEventListener('change', (e) => {
  Array.from(e.target.files).forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => { pendingImages.push({ dataUrl: ev.target.result, mimeType: file.type }); renderPreviews(); };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});

document.getElementById('btnImageViral').addEventListener('click', () => {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    const withImg = collectedPosts.filter(p => p.imageUrl);
    if (!withImg.length) { alert('이미지가 있는 수집 게시물이 없습니다.'); return; }
    const list = withImg.slice(0, 5).map((p, i) => `${i+1}. @${p.author}`).join('\n');
    const choice = prompt(`이미지 선택 (번호):\n${list}`);
    if (!choice) return;
    const p = withImg[parseInt(choice) - 1];
    if (!p) return;
    chrome.runtime.sendMessage({ action: 'fetchImageAsDataUrl', url: p.imageUrl }, res => {
      if (res?.dataUrl) { pendingImages.push({ dataUrl: res.dataUrl, mimeType: 'image/jpeg' }); renderPreviews(); }
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
  const loading = document.getElementById('dalleLoading');
  loading.classList.remove('hidden');
  const result = await chrome.runtime.sendMessage({ action: 'generateImage', apiKey: settings.openaiApiKey, prompt: promptText, size: document.getElementById('dalleSize').value });
  loading.classList.add('hidden');
  if (result.error) { alert('이미지 생성 실패: ' + result.error); return; }
  pendingImages.push({ dataUrl: result.dataUrl, mimeType: 'image/png' });
  renderPreviews();
  document.getElementById('dallePanel').classList.add('hidden');
});

function renderPreviews() {
  const container = document.getElementById('imagePreviewList');
  container.innerHTML = '';
  pendingImages.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-item';
    const el = document.createElement('img');
    el.src = img.dataUrl;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.addEventListener('click', () => { pendingImages.splice(i, 1); renderPreviews(); });
    wrap.appendChild(el);
    wrap.appendChild(rm);
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
  const item = { id: Date.now().toString(), text, images: [...pendingImages], scheduledAt, status: 'pending' };
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
  const tab = await getThreadsTab();
  if (!tab) { alert('Threads를 먼저 열어주세요.'); return; }
  await ensureContentScript(tab.id);
  const item = { id: Date.now().toString(), text, images: [...pendingImages], scheduledAt: Date.now(), status: 'pending' };
  chrome.tabs.sendMessage(tab.id, { action: 'publishPost', item });
  resetCompose();
});

document.getElementById('btnClearQueue').addEventListener('click', () => {
  if (!confirm('예약 게시물을 모두 삭제할까요?')) return;
  chrome.storage.local.set({ queue: [] }, renderQueue);
});

function resetCompose() {
  document.getElementById('composeText').value = '';
  document.getElementById('scheduleTime').value = '';
  pendingImages = [];
  renderPreviews();
}

function renderQueue() {
  chrome.storage.local.get('queue', ({ queue = [] }) => {
    const container = document.getElementById('queueList');
    container.innerHTML = '';
    if (!queue.length) { container.innerHTML = '<div class="empty">예약된 게시물 없음</div>'; return; }

    const statusClass = { pending: 'badge-pending', published: 'badge-published', failed: 'badge-failed' };
    const statusText  = { pending: '예약됨', published: '발행완료', failed: '실패' };

    queue.slice().reverse().forEach(item => {
      const card = document.createElement('div');
      card.className = 'queue-card';

      const top = document.createElement('div');
      top.className = 'queue-top';

      if (item.images?.[0]) {
        const thumb = document.createElement('img');
        thumb.className = 'queue-thumb';
        thumb.src = item.images[0].dataUrl;
        top.appendChild(thumb);
      }

      const timeEl = document.createElement('div');
      timeEl.className = 'queue-time';
      timeEl.textContent = item.scheduledAt ? new Date(item.scheduledAt).toLocaleString('ko-KR') : '즉시';
      top.appendChild(timeEl);

      const textEl = document.createElement('div');
      textEl.className = 'queue-text';
      textEl.textContent = item.text;

      const bottom = document.createElement('div');
      bottom.className = 'queue-bottom';

      const badge = document.createElement('span');
      badge.className = `badge ${statusClass[item.status] || 'badge-pending'}`;
      badge.textContent = statusText[item.status] || '알 수 없음';

      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger sm';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', () => {
        chrome.storage.local.get('queue', ({ queue: q = [] }) => {
          chrome.storage.local.set({ queue: q.filter(i => i.id !== item.id) }, renderQueue);
        });
      });

      bottom.appendChild(badge);
      bottom.appendChild(delBtn);
      card.appendChild(top);
      card.appendChild(textEl);
      card.appendChild(bottom);
      container.appendChild(card);
    });
  });
}

// ── 설정 탭 ──────────────────────────────────────────────
chrome.storage.local.get(
  ['claudeApiKey', 'openaiApiKey', 'defaultModel', 'publishDelay'],
  ({ claudeApiKey = '', openaiApiKey = '', defaultModel = 'claude', publishDelay = 30 }) => {
    document.getElementById('claudeApiKey').value   = claudeApiKey;
    document.getElementById('openaiApiKey').value   = openaiApiKey;
    document.getElementById('defaultModel').value   = defaultModel;
    document.getElementById('publishDelay').value   = publishDelay;
  }
);

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  const data = {
    claudeApiKey:  document.getElementById('claudeApiKey').value.trim(),
    openaiApiKey:  document.getElementById('openaiApiKey').value.trim(),
    defaultModel:  document.getElementById('defaultModel').value,
    publishDelay:  parseInt(document.getElementById('publishDelay').value),
  };
  chrome.storage.local.set(data, () => {
    const toast = document.getElementById('settingsMsg');
    toast.textContent = '저장됐습니다.';
    toast.classList.remove('hidden', 'err');
    setTimeout(() => toast.classList.add('hidden'), 2000);
  });
});
