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
  const reportType = document.getElementById('report-type');
  const includeArchived = document.getElementById('include-archived');
  const loadMoreButton = document.getElementById('load-more');
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
  let lastQuery = '';
  let lastItems = [];
  let loadedExtra = 0;

  function setSummary(text) {
    summary.textContent = text;
    summary.hidden = false;
  }

  function appendResult(item, index) {
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
    open.dataset.testid = `open-detail-${index + 1}`;
    open.id = `open-detail-${index + 1}`;
    open.addEventListener('click', () => openDetail(item));
    li.append(title, body, open);
    results.append(li);
  }

  function summaryText(query, count) {
    const filters = [];
    if (reportType && reportType.value !== 'all') filters.push(`筛选：${reportType.options[reportType.selectedIndex].text}`);
    if (includeArchived?.checked) filters.push('含归档');
    const base = loadedExtra > 0
      ? `已加载 ${count} 条（关键词“${query}”）`
      : `找到 ${count} 条与“${query}”相关的结果`;
    return filters.length > 0 ? `${base} · ${filters.join(' · ')}` : base;
  }

  function renderResults(query, items) {
    results.replaceChildren();
    lastQuery = query;
    lastItems = items;
    loadedExtra = 0;
    for (const [index, item] of items.entries()) appendResult(item, index);
    setSummary(summaryText(query, items.length));
    if (loadMoreButton) loadMoreButton.hidden = items.length === 0;
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

  reportType?.addEventListener('change', () => {
    if (lastItems.length > 0) {
      const filtered = lastItems.filter((item) => {
        if (reportType.value === 'all') return true;
        return (item.category ?? '') === reportType.value;
      });
      if (includeArchived?.checked) filtered.push({ title: '归档 · 历史季度报告', body: '已归档的数据，仅供审计。', category: 'archived' });
      loadedExtra = 0;
      results.replaceChildren();
      for (const [index, item] of filtered.entries()) appendResult(item, index);
      setSummary(summaryText(lastQuery, filtered.length));
      if (loadMoreButton) loadMoreButton.hidden = filtered.length === 0;
    } else {
      setSummary(reportType.value === 'all' ? '' : `筛选：${reportType.options[reportType.selectedIndex].text}`);
    }
  });

  includeArchived?.addEventListener('change', () => {
    if (lastItems.length > 0) {
      const items = includeArchived.checked
        ? [...lastItems, { title: '归档 · 历史季度报告', body: '已归档的数据，仅供审计。', category: 'archived' }]
        : lastItems;
      loadedExtra = 0;
      results.replaceChildren();
      for (const [index, item] of items.entries()) appendResult(item, index);
      setSummary(summaryText(lastQuery, items.length));
      if (loadMoreButton) loadMoreButton.hidden = items.length === 0;
    } else {
      setSummary(includeArchived?.checked ? '含归档' : '');
    }
  });

  loadMoreButton?.addEventListener('click', () => {
    if (!lastQuery) return;
    const baseCount = results.querySelectorAll('li').length;
    for (let index = 0; index < 3; index += 1) {
      loadedExtra += 1;
      appendResult(
        { title: `扩展结果 ${loadedExtra} · ${lastQuery}`, body: '由“加载更多”追加的确定性结果。', category: 'extra' },
        baseCount + index,
      );
    }
    setSummary(summaryText(lastQuery, results.querySelectorAll('li').length));
    if (loadMoreButton) loadMoreButton.hidden = false;
  });

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