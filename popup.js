// Viral-fit — Popup Controller

// ── 버전 ──────────────────────────────────────────────────
document.getElementById('versionBadge').textContent =
  `v${chrome.runtime.getManifest().version}`;

// ── Threads 열기 버튼 ─────────────────────────────────────
document.getElementById('btnOpenThreads').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.threads.com/' });
});

// ── 탭 전환 ──────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'generate') refreshSourceSelect();
    if (btn.dataset.tab === 'queue')    renderQueue();
  });
});

// ── 플로팅 로그 ──────────────────────────────────────────
const logBox      = document.getElementById('logBox');
const floatLog    = document.getElementById('floatLog');
const toggleBtn   = document.getElementById('btnToggleLog');

document.getElementById('btnCloseLog').addEventListener('click', () => {
  floatLog.classList.add('hidden');
  toggleBtn.classList.remove('hidden');
});

toggleBtn.addEventListener('click', () => {
  floatLog.classList.remove('hidden');
  toggleBtn.classList.add('hidden');
  logBox.scrollTop = logBox.scrollHeight;
});

function addLog(message, type = '') {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${time}] ${message}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

document.getElementById('btnClearLog').addEventListener('click', () => {
  logBox.innerHTML = '';
  addLog('로그 초기화됨', 'dim');
});

// ── 공통 토스트 (alert 대체) ─────────────────────────────
let _toastTimer = null;
function showToast(msg, type = 'ok', ms = 3500) {
  const el = document.getElementById('mainToast');
  el.textContent = msg;
  el.className   = `main-toast ${type}`;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

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
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, res => {
        if (chrome.runtime.lastError || !res) reject();
        else resolve();
      });
    });
  } catch {
    addLog('콘텐츠 스크립트 주입 중...', 'dim');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 400));
  }
}

async function getSettings() {
  return new Promise(resolve =>
    chrome.storage.local.get(['geminiApiKey','openaiApiKey','defaultModel','publishDelay'], resolve)
  );
}

// ── 수집 탭 ──────────────────────────────────────────────
const progressLabel  = document.getElementById('progressLabel');
const progressCount  = document.getElementById('progressCount');
const progressFill   = document.getElementById('progressFill');
const progressDetail = document.getElementById('progressDetail');

function setProgress(label, count, target, detail = '') {
  progressLabel.textContent  = label;
  progressCount.textContent  = `${count} / ${target}`;
  progressFill.style.width   = target > 0 ? `${Math.min((count/target)*100,100)}%` : '0%';
  progressDetail.textContent = detail;
}

document.getElementById('btnStartCollect').addEventListener('click', async () => {
  const tab = await getThreadsTab();
  if (!tab) {
    addLog('Threads 탭을 찾을 수 없습니다. threads.com을 열어주세요.', 'error');
    return;
  }

  setProgress('연결 중...', 0, 0);
  addLog('Threads 탭 연결 확인 중...', 'dim');
  await ensureContentScript(tab.id);

  const config = {
    minViews:    parseInt(document.getElementById('minViews').value),
    targetCount: parseInt(document.getElementById('targetCount').value),
    delay:       parseInt(document.getElementById('delay').value),
  };

  addLog(`수집 시작 — 목표: ${config.targetCount}개, 최소 조회수: ${config.minViews.toLocaleString()}회`);
  setProgress('수집 중', 0, config.targetCount, '피드 스캔 중...');

  document.getElementById('btnStartCollect').disabled = true;
  document.getElementById('btnPauseCollect').disabled = false;
  document.getElementById('btnStopCollect').disabled  = false;

  chrome.tabs.sendMessage(tab.id, { action: 'startCollect', config });
});

document.getElementById('btnPauseCollect').addEventListener('click', async () => {
  const tab = await getThreadsTab();
  const btn = document.getElementById('btnPauseCollect');
  if (!tab) return;

  if (btn.dataset.paused !== 'true') {
    chrome.tabs.sendMessage(tab.id, { action: 'pauseCollect' });
    btn.textContent = '▶ 재개';
    btn.dataset.paused = 'true';
    progressLabel.textContent = '일시중지';
    addLog('수집 일시중지', 'warn');
  } else {
    chrome.tabs.sendMessage(tab.id, { action: 'resumeCollect' });
    btn.textContent = '⏸ 일시중지';
    btn.dataset.paused = 'false';
    progressLabel.textContent = '수집 중';
    addLog('수집 재개', 'ok');
  }
});

document.getElementById('btnStopCollect').addEventListener('click', async () => {
  const tab = await getThreadsTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { action: 'stopCollect' });
  resetCollectButtons();
  progressLabel.textContent = '중지됨';
  addLog('수집 중지됨', 'warn');
});

function resetCollectButtons() {
  const pauseBtn = document.getElementById('btnPauseCollect');
  document.getElementById('btnStartCollect').disabled = false;
  pauseBtn.disabled = true;
  pauseBtn.textContent = '⏸ 일시중지';
  pauseBtn.dataset.paused = 'false';
  document.getElementById('btnStopCollect').disabled = true;
}

// 내보내기
document.getElementById('btnExportCSV').addEventListener('click', () => {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    if (!collectedPosts.length) { addLog('내보낼 데이터 없음', 'warn'); return; }
    const header = 'author,views,text,imageUrl,postUrl\n';
    const rows = collectedPosts.map(p =>
      `"${p.author}","${p.views}","${(p.text||'').replace(/"/g,'""')}","${p.imageUrl||''}","${p.postUrl||''}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'viral-fit_export.csv' });
    addLog(`CSV 내보내기 완료 (${collectedPosts.length}개)`, 'ok');
  });
});

document.getElementById('btnExportJSON').addEventListener('click', () => {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    if (!collectedPosts.length) { addLog('내보낼 데이터 없음', 'warn'); return; }
    const blob = new Blob([JSON.stringify(collectedPosts, null, 2)], { type: 'application/json' });
    chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'viral-fit_export.json' });
    addLog(`JSON 내보내기 완료 (${collectedPosts.length}개)`, 'ok');
  });
});

document.getElementById('btnClearData').addEventListener('click', () => {
  if (!confirm('수집 데이터를 모두 초기화할까요?')) return;
  chrome.storage.local.set({ collectedPosts: [] }, () => {
    renderTable([]);
    setProgress('대기 중', 0, 0);
    addLog('데이터 초기화 완료', 'warn');
  });
});

// content.js / background → popup 메시지
chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'popupLog') {
    addLog(msg.text, 'dim');
    return;
  }
  if (msg.action === 'collectProgress') {
    setProgress('수집 중', msg.count, msg.target, msg.currentText || '');
    if (msg.currentText) addLog(`[${msg.count}/${msg.target}] ${msg.currentText}`, 'ok');
    chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => renderTable(collectedPosts));
  }
  if (msg.action === 'collectFound') {
    addLog(`발견 @${msg.author} — 조회수 ${Number(msg.views).toLocaleString()}회`);
  }
  if (msg.action === 'collectSkipped') {
    addLog(`건너뜀 — 조회수 부족 (${msg.views})`, 'dim');
  }
  if (msg.action === 'collectSessionDir') {
    // 세션 폴더를 폴더 경로 표시에 반영
    const pathEl = document.querySelector('.folder-path');
    if (pathEl) {
      const sub = msg.dir.replace('viral-fit_captures/', '');
      pathEl.textContent = `viral-fit_captures / ${sub}`;
    }
    addLog(`📁 저장 폴더: ${msg.dir}`, 'dim');
    return;
  }
  if (msg.action === 'collectDone') {
    setProgress('수집 완료!', msg.count, msg.count, `${msg.count}개 저장됨`);
    addLog(`수집 완료! 총 ${msg.count}개 저장`, 'ok');
    resetCollectButtons();
    const pathEl = document.querySelector('.folder-path');
    if (pathEl) pathEl.textContent = 'Downloads / viral-fit_captures';
    chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => renderTable(collectedPosts));
    setTimeout(() => window.close(), 1500);
  }
  if (msg.action === 'collectError') {
    addLog(`오류: ${msg.error}`, 'error');
  }
  if (msg.action === 'captureSaved') {
    addLog(`캡처 저장 → viral-fit_captures/${msg.filename}`, 'dim');
  }
  if (msg.action === 'publishDone') {
    chrome.notifications.create({ type:'basic', iconUrl:'icons/icon128.png', title:'Viral-fit', message:'게시물 발행 완료!' });
    renderQueue();
  }
  if (msg.action === 'publishFailed') {
    chrome.notifications.create({ type:'basic', iconUrl:'icons/icon128.png', title:'Viral-fit', message:`발행 실패: ${msg.error}` });
    renderQueue();
  }
});

// 테이블 렌더링 (최근 8개)
function renderTable(posts) {
  document.getElementById('collectedCount').textContent = `수집된 게시물 ${posts.length}개`;
  const tbody = document.getElementById('previewBody');
  tbody.innerHTML = '';

  if (!posts.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">수집된 게시물 없음</td></tr>';
    return;
  }

  posts.slice(-8).reverse().forEach((p, i) => {
    const tr = document.createElement('tr');

    const tdNum = document.createElement('td');
    tdNum.className = 'td-num';
    tdNum.textContent = posts.length - i;

    const tdAuthor = document.createElement('td');
    tdAuthor.className = 'td-author';
    tdAuthor.textContent = `@${p.author || '?'}`;

    const tdViews = document.createElement('td');
    tdViews.className = 'td-views';
    tdViews.textContent = Number(p.views).toLocaleString();

    const tdText = document.createElement('td');
    tdText.className = 'td-text';
    tdText.textContent = p.text || '(없음)';
    tdText.title = p.text || '';

    tr.appendChild(tdNum);
    tr.appendChild(tdAuthor);
    tr.appendChild(tdViews);
    tr.appendChild(tdText);
    tbody.appendChild(tr);
  });
}

// 초기 로드
chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
  renderTable(collectedPosts);
});
addLog('Viral-fit 준비 완료', 'ok');

// 팝업 재오픈 시 수집 상태 복원 (수집 중이면 버튼 활성화)
(async () => {
  const tab = await getThreadsTab();
  if (!tab) return;
  try {
    const state = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { action: 'getCollectState' }, res => {
        if (chrome.runtime.lastError || !res) reject();
        else resolve(res);
      });
    });
    if (!state.running) return;

    document.getElementById('btnStartCollect').disabled = true;
    document.getElementById('btnPauseCollect').disabled = false;
    document.getElementById('btnStopCollect').disabled  = false;

    const target = state.config?.targetCount || 0;
    setProgress(
      state.paused ? '일시중지' : '수집 중',
      state.count,
      target,
      '수집 진행 중...'
    );
    addLog('수집이 진행 중입니다 — 일시중지 또는 중지 가능', 'dim');

    if (state.paused) {
      const btn = document.getElementById('btnPauseCollect');
      btn.textContent    = '▶ 재개';
      btn.dataset.paused = 'true';
    }
  } catch { /* content script 없음 = 수집 중 아님 */ }
})();

// ── AI 생성 탭 ────────────────────────────────────────────
function refreshSourceSelect() {
  chrome.storage.local.get('collectedPosts', ({ collectedPosts = [] }) => {
    const sel = document.getElementById('sourcePost');
    sel.innerHTML = '<option value="">전체 분석 (패턴 종합)</option>';
    collectedPosts.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `@${p.author} — ${(p.text||'').slice(0,35)}...`;
      sel.appendChild(opt);
    });
  });
}

document.getElementById('btnGenerate').addEventListener('click', async () => {
  const settings = await getSettings();
  const model    = document.getElementById('aiModel').value;
  const apiKey   = model === 'gemini' ? settings.geminiApiKey : settings.openaiApiKey;
  if (!apiKey) { showToast('설정 탭에서 API 키를 먼저 입력하세요.', 'warn'); return; }

  chrome.storage.local.get('collectedPosts', async ({ collectedPosts = [] }) => {
    const idx   = document.getElementById('sourcePost').value;
    const extra = document.getElementById('userPrompt').value;
    const tone  = document.getElementById('toneSelect').value;

    let analysisText;
    if (idx === '') {
      if (!collectedPosts.length) { showToast('먼저 게시물을 수집하세요.', 'warn'); return; }
      analysisText = collectedPosts.slice(0,10).map((p,i) =>
        `[${i+1}] @${p.author} (조회수 ${p.views})\n${p.text}`
      ).join('\n\n');
    } else {
      const p = collectedPosts[parseInt(idx)];
      analysisText = `@${p.author} (조회수 ${p.views})\n${p.text}`;
    }

    const toneStr = tone ? `어조: ${tone}` : '';
    const lengthGuide = extra ? '' : '글자 수: 500자 이내';
    const systemPrompt = `당신은 Threads SNS 전문 콘텐츠 작가입니다. 바이럴 게시물의 구조, 어조, 훅, 감정 자극 방식을 분석하고 같은 패턴을 활용해 완전히 새로운 창작 게시물을 작성합니다. 원본과 내용이 겹치지 않게, 자연스럽고 공감 가는 한국어로 해시태그 없이 작성하세요. 추가 요구사항이 있으면 그것을 최우선으로 따르세요.`;
    const conditions = [toneStr, lengthGuide, extra ? `추가 요구사항: ${extra}` : ''].filter(Boolean).join('\n');
    const userContent  = `다음 바이럴 게시물을 참고해서 새로운 Threads 게시글을 작성해주세요.\n\n${analysisText}${conditions ? `\n\n[작성 조건]\n${conditions}` : ''}`;

    document.getElementById('generateLoading').classList.remove('hidden');
    document.getElementById('generatedSection').classList.add('hidden');

    try {
      const result = await chrome.runtime.sendMessage({ action:'generateText', model, apiKey, systemPrompt, userContent });
      document.getElementById('generateLoading').classList.add('hidden');
      if (result.error) throw new Error(result.error);
      const ta = document.getElementById('generatedText');
      ta.value = result.text;
      document.getElementById('generatedSection').classList.remove('hidden');
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    } catch (e) {
      document.getElementById('generateLoading').classList.add('hidden');
      showToast('생성 실패: ' + e.message, 'err', 5000);
    }
  });
});

document.getElementById('generatedText').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = this.scrollHeight + 'px';
});

document.getElementById('btnRegenerate').addEventListener('click', () =>
  document.getElementById('btnGenerate').click()
);

document.getElementById('btnSendToQueue').addEventListener('click', () => {
  const text = document.getElementById('generatedText').value.trim();
  if (!text) return;
  document.getElementById('composeText').value = text;
  document.querySelector('[data-tab="queue"]').click();
});

// ── 발행 큐 탭 ────────────────────────────────────────────
let pendingImages = [];

document.getElementById('btnImageUpload').addEventListener('click', () =>
  document.getElementById('imageFileInput').click()
);

document.getElementById('imageFileInput').addEventListener('change', e => {
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
    if (!withImg.length) { showToast('이미지가 있는 게시물이 없습니다.', 'warn'); return; }
    const list = withImg.slice(0,5).map((p,i) => `${i+1}. @${p.author}`).join('\n');
    const choice = prompt(`이미지 선택 (번호):\n${list}`);
    if (!choice) return;
    const p = withImg[parseInt(choice)-1];
    if (!p) return;
    chrome.runtime.sendMessage({ action:'fetchImageAsDataUrl', url:p.imageUrl }, res => {
      if (res?.dataUrl) { pendingImages.push({ dataUrl:res.dataUrl, mimeType:'image/jpeg' }); renderPreviews(); }
    });
  });
});

document.getElementById('btnImageDalle').addEventListener('click', () =>
  document.getElementById('dallePanel').classList.toggle('hidden')
);

document.getElementById('btnGenerateImage').addEventListener('click', async () => {
  const settings = await getSettings();
  if (!settings.openaiApiKey) { showToast('설정에서 OpenAI API 키를 입력하세요.', 'warn'); return; }
  const promptText = document.getElementById('dallePrompt').value.trim();
  if (!promptText) { showToast('이미지 설명을 입력하세요.', 'warn'); return; }
  const loading = document.getElementById('dalleLoading');
  loading.classList.remove('hidden');
  const result = await chrome.runtime.sendMessage({ action:'generateImage', apiKey:settings.openaiApiKey, prompt:promptText, size:document.getElementById('dalleSize').value });
  loading.classList.add('hidden');
  if (result.error) { showToast('이미지 생성 실패: ' + result.error, 'err', 5000); return; }
  pendingImages.push({ dataUrl:result.dataUrl, mimeType:'image/png' });
  renderPreviews();
  document.getElementById('dallePanel').classList.add('hidden');
});

function renderPreviews() {
  const c = document.getElementById('imagePreviewList');
  c.innerHTML = '';
  pendingImages.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-item';
    const el = document.createElement('img');
    el.src = img.dataUrl;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.addEventListener('click', () => { pendingImages.splice(i,1); renderPreviews(); });
    wrap.appendChild(el);
    wrap.appendChild(rm);
    c.appendChild(wrap);
  });
}

document.getElementById('btnAddQueue').addEventListener('click', () => {
  const text = document.getElementById('composeText').value.trim();
  if (!text) { showToast('게시글 내용을 입력하세요.', 'warn'); return; }
  const scheduleTime = document.getElementById('scheduleTime').value;
  if (!scheduleTime) { showToast('발행 시간을 선택하세요.', 'warn'); return; }
  const scheduledAt = new Date(scheduleTime).getTime();
  if (scheduledAt <= Date.now()) { showToast('미래 시간을 선택하세요.', 'warn'); return; }
  const item = { id: Date.now().toString(), text, images: [...pendingImages], scheduledAt, status: 'pending' };
  chrome.storage.local.get('queue', ({ queue = [] }) => {
    queue.push(item);
    chrome.storage.local.set({ queue }, () => {
      chrome.runtime.sendMessage({ action:'schedulePost', item });
      resetCompose();
      renderQueue();
    });
  });
});

document.getElementById('btnPublishNow').addEventListener('click', async () => {
  const text = document.getElementById('composeText').value.trim();
  if (!text) { showToast('게시글 내용을 입력하세요.', 'warn'); return; }
  const tab = await getThreadsTab();
  if (!tab) { showToast('Threads를 먼저 열어주세요.', 'warn'); return; }
  await ensureContentScript(tab.id);
  const item = { id: Date.now().toString(), text, images: [...pendingImages], scheduledAt: Date.now(), status: 'pending' };
  chrome.tabs.sendMessage(tab.id, { action:'publishPost', item });
  resetCompose();
});

document.getElementById('btnClearQueue').addEventListener('click', () => {
  if (!confirm('예약 목록을 모두 삭제할까요?')) return;
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
    if (!queue.length) {
      container.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:16px;font-size:12px">예약된 게시물 없음</div>';
      return;
    }
    const sc = { pending:'badge-pending', published:'badge-published', failed:'badge-failed' };
    const st = { pending:'예약됨', published:'발행완료', failed:'실패' };

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
      badge.className = `badge ${sc[item.status]||'badge-pending'}`;
      badge.textContent = st[item.status]||'?';

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm btn-danger-outline';
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
  ['geminiApiKey','openaiApiKey','defaultModel','publishDelay'],
  ({ geminiApiKey='', openaiApiKey='', defaultModel='gemini', publishDelay=30 }) => {
    document.getElementById('geminiApiKey').value  = geminiApiKey;
    document.getElementById('openaiApiKey').value  = openaiApiKey;
    document.getElementById('defaultModel').value  = defaultModel;
    document.getElementById('publishDelay').value  = publishDelay;
  }
);

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  const data = {
    geminiApiKey:  document.getElementById('geminiApiKey').value.trim(),
    openaiApiKey:  document.getElementById('openaiApiKey').value.trim(),
    defaultModel:  document.getElementById('defaultModel').value,
    publishDelay:  parseInt(document.getElementById('publishDelay').value),
  };
  chrome.storage.local.set(data, () => {
    const toast = document.getElementById('settingsMsg');
    toast.textContent = '설정이 저장됐습니다.';
    toast.className = 'toast';
    setTimeout(() => toast.classList.add('hidden'), 2200);
  });
});
