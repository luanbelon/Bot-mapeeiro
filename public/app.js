// ============ State ============
let allLeads = [];
let currentFilter = 'all';
let progressPollTimer = null;
let selectedLeadIds = new Set();

// ============ Init ============
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  const isAuth = await ensureAuthenticated();
  if (!isAuth) return;
  loadStats();
  loadLeads();
  connectSSE();
  checkEmailConfig();
  syncJobFromServer();
}

async function ensureAuthenticated() {
  try {
    const res = await fetch('/api/auth-status');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login';
      return false;
    }
    return true;
  } catch {
    window.location.href = '/login';
    return false;
  }
}

async function syncJobFromServer() {
  try {
    const res = await fetch('/api/job-status');
    const data = await res.json();
    if (data.isRunning) {
      startProgressPoll();
      if (data.progress) updateProgress(data.progress);
    }
  } catch (e) {
    /* offline */
  }
}

function startProgressPoll() {
  stopProgressPoll();
  progressPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/job-status');
      const data = await res.json();
      if (data.progress) updateProgress(data.progress);
      if (!data.isRunning) stopProgressPoll();
    } catch (e) {
      /* ignore */
    }
  }, 5000);
}

function stopProgressPoll() {
  if (progressPollTimer) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
}

// ============ SSE Progress (funciona em um único processo; na Vercel o polling cobre o progresso) ============
function connectSSE() {
  const evtSource = new EventSource('/api/progress');
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateProgress(data);
  };
  evtSource.onerror = () => {
    setTimeout(connectSSE, 5000);
  };
}

function updateProgress(data) {
  const panel = document.getElementById('progress-panel');
  const message = document.getElementById('progress-message');
  const percent = document.getElementById('progress-percent');
  const fill = document.getElementById('progress-fill');

  if (data.phase === 'done' || data.phase === 'error') {
    stopProgressPoll();
    panel.classList.remove('active');
    document.getElementById('btn-search').disabled = false;
    document.getElementById('btn-search').innerHTML = '🚀 Buscar';
    loadStats();
    loadLeads();

    if (data.phase === 'done') {
      showToast('Busca concluída com sucesso!', 'success');
    } else {
      showToast('Erro: ' + data.message, 'error');
    }
    return;
  }

  panel.classList.add('active');
  message.textContent = data.message || '';
  percent.textContent = (data.percent || 0) + '%';
  fill.style.width = (data.percent || 0) + '%';
}

// ============ Search ============
async function startSearch() {
  const query = document.getElementById('search-query').value.trim();
  const location = document.getElementById('search-location').value.trim();

  if (!query || !location) {
    showToast('Preencha o tipo de negócio e a localização', 'error');
    return;
  }

  const btn = document.getElementById('btn-search');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Buscando...';

  try {
    const limitEl = document.getElementById('search-limit');
    const maxResults = limitEl ? parseInt(limitEl.value, 10) : 20;
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        location,
        maxResults,
        scrapeContacts: document.getElementById('opt-contacts').checked,
        autoEmail: document.getElementById('opt-email').checked
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erro ao iniciar busca', 'error');
      btn.disabled = false;
      btn.innerHTML = '🚀 Buscar';
    } else {
      startProgressPoll();
    }
  } catch (err) {
    showToast('Erro de conexão', 'error');
    btn.disabled = false;
    btn.innerHTML = '🚀 Buscar';
  }
}

async function stopSearch() {
  try {
    await fetch('/api/stop', { method: 'POST' });
    showToast('Parando busca...', 'info');
  } catch (err) {
    showToast('Erro ao parar', 'error');
  }
}

// ============ Stats ============
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    document.getElementById('stat-total').textContent = stats.total || 0;
    document.getElementById('stat-with-site').textContent = stats.withSite || 0;
    document.getElementById('stat-with-email').textContent = stats.withEmail || 0;
    document.getElementById('stat-analyzed').textContent = stats.analyzed || 0;
    document.getElementById('stat-emailed').textContent = stats.emailed || 0;
  } catch (err) {
    console.error('Erro ao carregar stats:', err);
  }
}

// ============ Leads ============
async function loadLeads() {
  try {
    const res = await fetch('/api/leads');
    allLeads = await res.json();
    renderLeads();
  } catch (err) {
    console.error('Erro ao carregar leads:', err);
  }
}

function filterLeads(filter, btn) {
  currentFilter = filter;

  // Update active button
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  renderLeads();
}

function getFilteredLeads() {
  switch (currentFilter) {
    case 'with-site':
      return allLeads.filter(l => l.has_site);
    case 'with-email':
      return allLeads.filter(l => l.email);
    case 'analyzed':
      return allLeads.filter(l => l.site_analyzed);
    case 'emailed':
      return allLeads.filter(l => l.email_sent);
    default:
      return allLeads;
  }
}

function renderLeads() {
  const tbody = document.getElementById('leads-tbody');
  const filtered = getFilteredLeads();

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="8">
        <div class="empty-state">
          <div class="icon">📭</div>
          <h3>Nenhum lead encontrado</h3>
          <p>${currentFilter === 'all' ? 'Use o formulário acima para buscar negócios' : 'Nenhum lead corresponde ao filtro selecionado'}</p>
        </div>
      </td></tr>
    `;
    updateSelectionControls();
    return;
  }

  tbody.innerHTML = filtered.map(lead => `
    <tr data-id="${lead.id}">
      <td class="select-col">
        <input
          type="checkbox"
          class="row-select"
          ${selectedLeadIds.has(lead.id) ? 'checked' : ''}
          onchange="toggleLeadSelection(${lead.id}, this.checked)"
        >
      </td>
      <td class="lead-name" title="${escapeHtml(lead.name)}">${escapeHtml(lead.name)}</td>
      <td>${lead.phone ? `<a href="tel:${lead.phone}" style="color:var(--cyan);text-decoration:none;">${escapeHtml(lead.phone)}</a>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${lead.email ? `<a href="mailto:${lead.email}" style="color:var(--accent);text-decoration:none;" title="${lead.email}">${truncate(lead.email, 25)}</a>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${lead.website ? `<a href="${lead.website}" target="_blank" style="color:var(--green);text-decoration:none;" title="${lead.website}">${truncate(cleanUrl(lead.website), 25)}</a>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>
        ${lead.rating ? `<div class="lead-rating"><span class="star">⭐</span> ${lead.rating}</div>` : '<span style="color:var(--text-muted)">—</span>'}
      </td>
      <td>
        ${getStatusBadges(lead)}
      </td>
      <td>
        <div class="actions-cell">
          ${lead.site_analyzed ? `<button class="btn btn-icon btn-secondary" onclick="viewDiagnostic(${lead.id})" title="Ver diagnóstico">📊</button>` : ''}
          ${lead.website && !lead.email ? `<button class="btn btn-icon btn-secondary" onclick="scrapeLeadContacts(${lead.id})" title="Buscar contatos">📧</button>` : ''}
          ${lead.email && lead.site_analyzed && !lead.email_sent ? `<button class="btn btn-icon btn-green" onclick="sendLeadEmail(${lead.id})" title="Enviar email">✉️</button>` : ''}
          <button class="btn btn-icon btn-secondary" onclick="deleteLead(${lead.id})" title="Remover" style="color:var(--red);">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');

  updateSelectionControls();
}

function getStatusBadges(lead) {
  const badges = [];
  if (lead.email_sent) {
    badges.push('<span class="badge badge-green">✉️ Enviado</span>');
  } else if (lead.site_analyzed) {
    badges.push('<span class="badge badge-purple">📊 Analisado</span>');
  } else if (lead.has_site) {
    badges.push('<span class="badge badge-yellow">🌐 Com Site</span>');
  } else {
    badges.push('<span class="badge badge-red">Sem Site</span>');
  }
  return badges.join(' ');
}

// ============ Actions ============
async function scrapeLeadContacts(id) {
  showToast('Buscando contatos...', 'info');
  try {
    const res = await fetch(`/api/scrape-contacts/${id}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const msg = `Encontrados: ${data.contacts.emails.length} email(s), ${data.contacts.whatsapps.length} WhatsApp(s)`;
      showToast(msg, data.contacts.emails.length > 0 ? 'success' : 'info');
      loadLeads();
      loadStats();
    } else {
      showToast('Erro: ' + (data.error || 'Falha'), 'error');
    }
  } catch (err) {
    showToast('Erro ao buscar contatos', 'error');
  }
}

async function sendLeadEmail(id) {
  if (!confirm('Enviar email de diagnóstico para este lead?')) return;

  showToast('Enviando email...', 'info');
  try {
    const res = await fetch(`/api/send-email/${id}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Email enviado com sucesso!', 'success');
      loadLeads();
      loadStats();
    } else {
      showToast('Erro: ' + (data.error || 'Falha ao enviar'), 'error');
    }
  } catch (err) {
    showToast('Erro ao enviar email', 'error');
  }
}

async function deleteLead(id) {
  if (!confirm('Remover este lead?')) return;
  try {
    await fetch(`/api/leads/${id}`, { method: 'DELETE' });
    selectedLeadIds.delete(id);
    showToast('Lead removido', 'info');
    loadLeads();
    loadStats();
  } catch (err) {
    showToast('Erro ao remover', 'error');
  }
}

function toggleLeadSelection(id, checked) {
  if (checked) selectedLeadIds.add(id);
  else selectedLeadIds.delete(id);
  updateSelectionControls();
}

function toggleSelectAllFiltered(checked) {
  const filteredIds = getFilteredLeads().map((l) => l.id);
  if (checked) {
    filteredIds.forEach((id) => selectedLeadIds.add(id));
  } else {
    filteredIds.forEach((id) => selectedLeadIds.delete(id));
  }
  renderLeads();
}

function updateSelectionControls() {
  const btn = document.getElementById('btn-delete-selected');
  const selectAll = document.getElementById('select-all-leads');
  if (!btn || !selectAll) return;

  const filteredIds = getFilteredLeads().map((l) => l.id);
  const selectedVisibleCount = filteredIds.filter((id) => selectedLeadIds.has(id)).length;
  const selectedTotalCount = selectedLeadIds.size;

  btn.disabled = selectedTotalCount === 0;
  btn.textContent = `🗑 Excluir selecionados (${selectedTotalCount})`;
  selectAll.checked = filteredIds.length > 0 && selectedVisibleCount === filteredIds.length;
  selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < filteredIds.length;
}

async function deleteSelectedLeads() {
  const ids = Array.from(selectedLeadIds);
  if (ids.length === 0) return;
  if (!confirm(`Remover ${ids.length} lead(s) selecionado(s)?`)) return;

  try {
    const results = await Promise.allSettled(
      ids.map((id) => fetch(`/api/leads/${id}`, { method: 'DELETE' }))
    );
    const successCount = results.filter((r) => r.status === 'fulfilled').length;
    const failCount = results.length - successCount;

    if (successCount > 0) {
      ids.forEach((id) => selectedLeadIds.delete(id));
      showToast(`${successCount} lead(s) removido(s)`, 'success');
      loadLeads();
      loadStats();
    }
    if (failCount > 0) {
      showToast(`${failCount} exclusão(ões) falharam`, 'error');
    }
    updateSelectionControls();
  } catch (err) {
    showToast('Erro ao excluir selecionados', 'error');
  }
}

async function viewDiagnostic(id) {
  try {
    const res = await fetch(`/api/leads/${id}`);
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    const data = await res.json();

    if (!data.diagnostic) {
      showToast('Diagnóstico não encontrado', 'error');
      return;
    }

    const d = normalizeDiagnostic(data.diagnostic);
    const suggestions = safeParseSuggestions(d.suggestions);
    const rawParsed = parseDiagnosticRaw(d);
    const metricsSection = buildLighthouseMetricsSection(rawParsed, data.website);

    document.getElementById('modal-title').textContent = `📊 Diagnóstico - ${data.name}`;
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted); font-size:13px; margin-bottom:8px;">
        Site: <a href="${data.website}" target="_blank" rel="noopener" style="color:var(--accent);">${escapeHtml(data.website)}</a>
      </p>
      <p style="color:var(--text-muted); font-size:11px; margin-bottom:16px;">
        Motor de análise: <strong style="color:var(--text-secondary);">Google PageSpeed Insights</strong> (Lighthouse, estratégia mobile).
      </p>
      <div class="score-grid">
        <div class="score-item">
          <div class="score-value" style="color:${getScoreColor(d.performance_score)}">${d.performance_score ?? '—'}</div>
          <div class="score-label">⚡ Performance</div>
        </div>
        <div class="score-item">
          <div class="score-value" style="color:${getScoreColor(d.seo_score)}">${d.seo_score ?? '—'}</div>
          <div class="score-label">🔍 SEO</div>
        </div>
        <div class="score-item">
          <div class="score-value" style="color:${getScoreColor(d.accessibility_score)}">${d.accessibility_score ?? '—'}</div>
          <div class="score-label">♿ Acessibilidade</div>
        </div>
        <div class="score-item">
          <div class="score-value" style="color:${getScoreColor(d.best_practices_score)}">${d.best_practices_score ?? '—'}</div>
          <div class="score-label">✅ Boas Práticas</div>
        </div>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px;">
        <div style="flex:1; background:var(--bg-card); border-radius:10px; padding:12px; text-align:center;">
          <div style="font-size:18px;">${d.has_ssl ? '🔒' : '🔓'}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">SSL ${d.has_ssl ? 'Ativo' : 'Inativo'}</div>
        </div>
        <div style="flex:1; background:var(--bg-card); border-radius:10px; padding:12px; text-align:center;">
          <div style="font-size:18px;">${d.is_responsive ? '📱' : '🖥️'}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${d.is_responsive ? 'Responsivo' : 'Não Responsivo'}</div>
        </div>
        <div style="flex:1; background:var(--bg-card); border-radius:10px; padding:12px; text-align:center;">
          <div style="font-size:18px;">⏱️</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${d.load_time != null ? Number(d.load_time).toFixed(1) + 's' : '—'}</div>
        </div>
      </div>

      ${metricsSection}

      ${suggestions.length > 0 ? `
        <h4 style="font-size:14px; margin-bottom:12px;">📋 Sugestões de Melhoria</h4>
        <div class="suggestion-list">
          ${suggestions.map(s => `
            <div class="suggestion-item ${s.type}">
              <div class="suggestion-title">${s.title}</div>
              <div class="suggestion-desc">${s.description}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;

    document.getElementById('modal-overlay').classList.add('active');
  } catch (err) {
    showToast('Erro ao carregar diagnóstico', 'error');
  }
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    // ignore and redirect anyway
  }
  window.location.href = '/login';
}

// ============ Email Test ============
async function testEmail() {
  const email = prompt('Digite seu email para testar o envio:');
  if (!email) return;

  showToast('Enviando email de teste...', 'info');
  try {
    const res = await fetch('/api/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Email de teste enviado! Verifique sua caixa de entrada.', 'success');
    } else {
      showToast('Erro: ' + (data.error || 'Falha no envio'), 'error');
    }
  } catch (err) {
    showToast('Erro ao enviar email de teste', 'error');
  }
}

async function checkEmailConfig() {
  try {
    const res = await fetch('/api/email-config');
    const data = await res.json();
    const btn = document.getElementById('btn-test-email');
    if (!data.configured) {
      btn.style.opacity = '0.5';
      btn.title = 'Email não configurado - edite o .env';
    }
  } catch (err) {}
}

// ============ Modal ============
function closeModal(event) {
  if (event && event.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.remove('active');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ============ Toast ============
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || '📢'}</span> ${message}`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============ Helpers ============
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '...' : str;
}

function cleanUrl(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function getScoreColor(score) {
  if (score === null || score === undefined) return 'var(--text-muted)';
  if (score >= 90) return 'var(--green)';
  if (score >= 50) return 'var(--yellow)';
  return 'var(--red)';
}

function parseDiagnosticRaw(diagnostic) {
  const raw = diagnostic.raw_data;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? raw : null;
}

function safeParseSuggestions(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeDiagnostic(diagnostic) {
  const raw = parseDiagnosticRaw(diagnostic);
  const categories = raw && raw.lighthouseResult && raw.lighthouseResult.categories
    ? raw.lighthouseResult.categories
    : null;

  const pickScore = (current, key) => {
    if (current !== null && current !== undefined) return current;
    const score = categories && categories[key] ? categories[key].score : null;
    if (typeof score !== 'number') return null;
    return Math.round(score * 100);
  };

  return {
    ...diagnostic,
    performance_score: pickScore(diagnostic.performance_score, 'performance'),
    accessibility_score: pickScore(diagnostic.accessibility_score, 'accessibility'),
    best_practices_score: pickScore(diagnostic.best_practices_score, 'best-practices'),
    seo_score: pickScore(diagnostic.seo_score, 'seo')
  };
}

function buildLighthouseMetricsSection(raw, websiteUrl) {
  if (!raw || typeof raw !== 'object') return '';

  const pairs = [
    ['firstContentfulPaint', 'FCP — Primeira pintura de conteúdo'],
    ['largestContentfulPaint', 'LCP — Maior elemento visível'],
    ['totalBlockingTime', 'TBT — Bloqueio da thread principal'],
    ['cumulativeLayoutShift', 'CLS — Estabilidade do layout'],
    ['speedIndex', 'Speed Index'],
    ['interactive', 'TTI — Tempo até interativo']
  ];

  const rows = [];
  for (const [key, label] of pairs) {
    const v = raw[key];
    if (v != null && String(v).trim() !== '') {
      rows.push(`
        <div class="metric-row">
          <span class="metric-row-label">${label}</span>
          <span class="metric-row-value">${escapeHtml(String(v))}</span>
        </div>`);
    }
  }

  if (rows.length === 0) return '';

  let fullUrl = websiteUrl || '';
  if (fullUrl && !fullUrl.startsWith('http')) fullUrl = 'https://' + fullUrl;
  const psHref = fullUrl
    ? `https://pagespeed.web.dev/report?url=${encodeURIComponent(fullUrl)}`
    : 'https://pagespeed.web.dev/';

  return `
    <div class="lighthouse-block">
      <h4 class="lighthouse-block-title">📈 Core Web Vitals e métricas Lighthouse</h4>
      <p class="lighthouse-block-sub">
        Valores medidos no teste mobile. Relatório completo no Google:
        <a href="${psHref}" target="_blank" rel="noopener">abrir no PageSpeed Insights</a>
      </p>
      <div class="metric-table">${rows.join('')}</div>
    </div>`;
}
