/* Fixture application behaviour. All state is local; no network beyond this origin. */
(() => {
  const labels = window.__IB_LABELS__ ?? {
    formId: 'search-form',
    inputId: 'keyword',
    submitId: 'search-submit',
    resultTestId: 'result-item',
    summaryTestId: 'results-summary',
  };
  const form = document.getElementById(labels.formId);
  const input = document.getElementById(labels.inputId);
  const error = document.getElementById('form-error');
  const summary = document.getElementById('results-summary');
  const results = document.getElementById('results');
  const reportsPage = document.getElementById('reports-page');
  const main = document.getElementById('main');
  const dialog = document.getElementById('detail-dialog');
  const detailTitle = document.getElementById('detail-title');
  const detailBody = document.getElementById('detail-body');

  const track = (type) => {
    fetch('/__event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type }),
      keepalive: true,
    }).catch(() => {});
  };

  let debounceTimer = 0;
  let requestSeq = 0;

  function setSummary(text) {
    summary.textContent = text;
    summary.hidden = false;
  }

  function renderResults(query, items) {
    results.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'result';
      li.dataset.testid = labels.resultTestId;
      const title = document.createElement('h3');
      title.textContent = item.title;
      const body = document.createElement('p');
      body.textContent = item.body;
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = '查看详情';
      open.dataset.testid = 'open-detail';
      open.addEventListener('click', () => openDetail(item));
      li.append(title, body, open);
      results.append(li);
    }
    setSummary(`找到 ${items.length} 条与“${query}”相关的结果`);
  }

  async function runSearch(query) {
    const seq = ++requestSeq;
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      setSummary('检索失败，请稍后重试');
      return;
    }
    const data = await response.json();
    if (seq !== requestSeq) return;
    renderResults(data.query || query, data.results ?? []);
  }

  if (input) {
    input.addEventListener('input', () => {
      window.clearTimeout(debounceTimer);
      const query = input.value.trim();
      if (!query) {
        results.replaceChildren();
        summary.hidden = true;
        return;
      }
      debounceTimer = window.setTimeout(() => {
        runSearch(query).catch(() => setSummary('检索失败，请稍后重试'));
      }, 180);
    });
  }

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = (input?.value ?? '').trim();
      if (!query) {
        error.hidden = false;
        error.textContent = '请输入关键词后再搜索';
        results.replaceChildren();
        summary.hidden = true;
        return;
      }
      error.hidden = true;
      track('submit');
      runSearch(query).catch(() => setSummary('检索失败，请稍后重试'));
    });
  }

  function openDetail(item) {
    detailTitle.textContent = item.title;
    detailBody.textContent = item.body;
    dialog.hidden = false;
    track('detail');
  }

  document.querySelector('[data-testid="close-detail"]')?.addEventListener('click', () => {
    dialog.hidden = true;
  });
  dialog?.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.hidden = true;
  });

  function showRoute(path) {
    const reports = path.startsWith('/reports');
    if (reportsPage) reportsPage.hidden = !reports;
    const hero = main?.querySelector('.hero');
    const region = document.getElementById('results-region');
    if (hero) hero.hidden = reports;
    if (region) region.hidden = reports;
    document.title = reports ? '报表中心 · IntentBridge Fixture' : 'IntentBridge Fixture';
  }

  for (const link of document.querySelectorAll('[data-nav-link]')) {
    link.addEventListener('click', (event) => {
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      event.preventDefault();
      window.history.pushState({}, '', href);
      track('navigate');
      showRoute(href);
    });
  }
  document.querySelector('[data-testid="reports-back"]')?.addEventListener('click', () => {
    window.history.pushState({}, '', '/');
    track('navigate');
    showRoute('/');
  });
  window.addEventListener('popstate', () => showRoute(window.location.pathname));
  showRoute(window.location.pathname);
})();