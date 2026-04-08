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
      if (!data.isRunning) {
        stopProgressPoll();
        resetSearchUI();
      }
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
    resetSearchUI();

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
        scrapeContacts: document.getElementById('opt-contacts').checked
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
    startProgressPoll();
  } catch (err) {
    showToast('Erro ao parar', 'error');
  }
}

function resetSearchUI() {
  const panel = document.getElementById('progress-panel');
  const btn = document.getElementById('btn-search');
  if (panel) panel.classList.remove('active');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '🚀 Buscar';
  }
  loadStats();
  loadLeads();
}

// ============ Stats ============
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    document.getElementById('stat-total').textContent = stats.total || 0;
    document.getElementById('stat-with-site').textContent = stats.withSite || 0;
    document.getElementById('stat-with-email').textContent = stats.withEmail || 0;
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
          ${lead.website && !lead.email ? `<button class="btn btn-icon btn-secondary" onclick="scrapeLeadContacts(${lead.id})" title="Buscar contatos">📧</button>` : ''}
          <button class="btn btn-icon btn-secondary" onclick="deleteLead(${lead.id})" title="Remover" style="color:var(--red);">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');

  updateSelectionControls();
}

function getStatusBadges(lead) {
  const badges = [];
  if (lead.email) {
    badges.push('<span class="badge badge-green">📧 Com Email</span>');
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

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    // ignore and redirect anyway
  }
  window.location.href = '/login';
}

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

