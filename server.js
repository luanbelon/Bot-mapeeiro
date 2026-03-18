require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./src/database/db');
const orchestrator = require('./src/orchestrator');
const { analyzeSite } = require('./src/analyzer/siteAnalyzer');
const { scrapeContacts } = require('./src/scraper/contactScraper');
const { sendDiagnosticEmail, sendTestEmail, initMailer } = require('./src/mailer/mailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store progress for SSE
let currentProgress = null;
let sseClients = [];

// SSE endpoint for real-time progress
app.get('/api/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });

  // Send current status
  if (currentProgress) {
    res.write(`data: ${JSON.stringify(currentProgress)}\n\n`);
  }
});

function broadcastProgress(data) {
  currentProgress = data;
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// Listen to orchestrator events
orchestrator.on('progress', broadcastProgress);
orchestrator.on('complete', (stats) => {
  broadcastProgress({ phase: 'done', message: 'Concluído!', percent: 100, stats });
});
orchestrator.on('error', (error) => {
  broadcastProgress({ phase: 'error', message: error, percent: 0 });
});

// ============ API Routes ============

// Start a new search
app.post('/api/search', async (req, res) => {
  const { query, location, autoAnalyze, autoEmail, scrapeContacts: sc } = req.body;

  if (!query || !location) {
    return res.status(400).json({ error: 'Query e location são obrigatórios' });
  }

  if (orchestrator.isRunning) {
    return res.status(409).json({ error: 'Uma busca já está em andamento' });
  }

  // Run in background
  orchestrator.runFullPipeline(query, location, {
    autoAnalyze: autoAnalyze !== false,
    autoEmail: autoEmail === true,
    scrapeContacts: sc !== false
  }).catch(err => {
    console.error('Pipeline error:', err);
  });

  res.json({ success: true, message: 'Busca iniciada!' });
});

// Stop current search
app.post('/api/stop', (req, res) => {
  orchestrator.stop();
  res.json({ success: true, message: 'Parando busca...' });
});

// Get search status
app.get('/api/status', (req, res) => {
  res.json(orchestrator.getStatus());
});

// Get all leads
app.get('/api/leads', (req, res) => {
  const filters = {};
  if (req.query.has_site !== undefined) filters.has_site = req.query.has_site === 'true';
  if (req.query.email_sent !== undefined) filters.email_sent = req.query.email_sent === 'true';
  if (req.query.search_query) filters.search_query = req.query.search_query;
  if (req.query.search_location) filters.search_location = req.query.search_location;
  if (req.query.limit) filters.limit = parseInt(req.query.limit);

  const leads = db.getLeads(filters);
  res.json(leads);
});

// Get single lead
app.get('/api/leads/:id', (req, res) => {
  const lead = db.getLeadById(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

  const diagnostic = db.getDiagnosticByLeadId(lead.id);
  res.json({ ...lead, diagnostic });
});

// Analyze a single lead's site
app.post('/api/analyze/:id', async (req, res) => {
  const lead = db.getLeadById(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  if (!lead.website) return res.status(400).json({ error: 'Lead não possui site' });

  try {
    const analysis = await analyzeSite(lead.website);
    db.insertDiagnostic({ lead_id: lead.id, ...analysis });
    db.markSiteAnalyzed(lead.id);

    const diagnostic = db.getDiagnosticByLeadId(lead.id);
    res.json({ success: true, diagnostic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scrape contacts for a single lead
app.post('/api/scrape-contacts/:id', async (req, res) => {
  const lead = db.getLeadById(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  if (!lead.website) return res.status(400).json({ error: 'Lead não possui site' });

  try {
    const contacts = await scrapeContacts(lead.website);
    if (contacts.emails.length > 0 || contacts.whatsapps.length > 0) {
      db.updateLeadContact(
        lead.id,
        contacts.emails[0] || lead.email,
        contacts.whatsapps[0] || lead.whatsapp
      );
    }
    const updatedLead = db.getLeadById(lead.id);
    res.json({ success: true, lead: updatedLead, contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send email to a single lead
app.post('/api/send-email/:id', async (req, res) => {
  const lead = db.getLeadById(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  if (!lead.email) return res.status(400).json({ error: 'Lead não possui email' });

  const diagnostic = db.getDiagnosticByLeadId(lead.id);
  if (!diagnostic) return res.status(400).json({ error: 'Site ainda não foi analisado' });

  try {
    const result = await sendDiagnosticEmail(lead, diagnostic);
    db.insertEmailRecord({
      lead_id: lead.id,
      to_email: lead.email,
      status: result.success ? 'sent' : 'failed',
      error_message: result.error || null
    });
    if (result.success) {
      db.markEmailSent(lead.id);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send test email
app.post('/api/test-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email é obrigatório' });

  const result = await sendTestEmail(email);
  res.json(result);
});

// Get stats
app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

// Delete a lead
app.delete('/api/leads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.db.prepare('DELETE FROM emails_sent WHERE lead_id = ?').run(id);
  db.db.prepare('DELETE FROM diagnostics WHERE lead_id = ?').run(id);
  db.db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  res.json({ success: true });
});

// Check email config
app.get('/api/email-config', (req, res) => {
  res.json({
    configured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    user: process.env.GMAIL_USER ? process.env.GMAIL_USER.replace(/(.{3}).*(@.*)/, '$1***$2') : null
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🤖 Bot Mapeeiro rodando em http://localhost:${PORT}\n`);

  // Initialize mailer
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    initMailer();
    console.log('📧 Email configurado com:', process.env.GMAIL_USER);
  } else {
    console.log('⚠️  Email não configurado. Edite o arquivo .env');
  }

  console.log('');
});
