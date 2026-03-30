require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./src/database/db');
const orchestrator = require('./src/orchestrator');
const { analyzeSite } = require('./src/analyzer/siteAnalyzer');
const { scrapeContacts } = require('./src/scraper/contactScraper');
const { sendDiagnosticEmail, sendTestEmail, initMailer } = require('./src/mailer/mailer');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sseClients = [];

async function broadcastProgress(data) {
  try {
    await db.saveJobProgress(data);
  } catch (err) {
    console.error('Erro ao salvar progresso:', err.message);
  }
  sseClients.forEach((client) => {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      /* client gone */
    }
  });
}

app.get('/api/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });

  db.getJobProgress()
    .then((payload) => {
      if (payload && Object.keys(payload).length > 0) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    })
    .catch(() => {});
});

app.get('/api/job-status', async (req, res) => {
  try {
    const progress = await db.getJobProgress();
    const status = orchestrator.getStatus();
    res.json({
      isRunning: status.isRunning,
      currentSearch: status.currentSearch,
      progress: progress && Object.keys(progress).length > 0 ? progress : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

orchestrator.on('progress', (data) => {
  broadcastProgress(data);
});
orchestrator.on('complete', (stats) => {
  broadcastProgress({ phase: 'done', message: 'Concluído!', percent: 100, stats });
});
orchestrator.on('error', (error) => {
  broadcastProgress({ phase: 'error', message: error, percent: 0 });
});

app.post('/api/search', async (req, res) => {
  const { query, location, autoAnalyze, autoEmail, scrapeContacts: sc } = req.body;

  if (!query || !location) {
    return res.status(400).json({ error: 'Query e location são obrigatórios' });
  }

  if (orchestrator.isRunning) {
    return res.status(409).json({ error: 'Uma busca já está em andamento' });
  }

  const pipeline = orchestrator
    .runFullPipeline(query, location, {
      autoAnalyze: autoAnalyze !== false,
      autoEmail: autoEmail === true,
      scrapeContacts: sc !== false
    })
    .catch((err) => {
      console.error('Pipeline error:', err);
    });

  if (process.env.VERCEL) {
    try {
      const { waitUntil } = require('@vercel/functions');
      waitUntil(pipeline);
    } catch (e) {
      console.error('waitUntil:', e.message);
    }
  }

  res.json({ success: true, message: 'Busca iniciada!' });
});

app.post('/api/stop', (req, res) => {
  orchestrator.stop();
  res.json({ success: true, message: 'Parando busca...' });
});

app.get('/api/status', (req, res) => {
  res.json(orchestrator.getStatus());
});

app.get('/api/leads', async (req, res) => {
  try {
    const filters = {};
    if (req.query.has_site !== undefined) filters.has_site = req.query.has_site === 'true';
    if (req.query.email_sent !== undefined) filters.email_sent = req.query.email_sent === 'true';
    if (req.query.search_query) filters.search_query = req.query.search_query;
    if (req.query.search_location) filters.search_location = req.query.search_location;
    if (req.query.limit) filters.limit = parseInt(req.query.limit, 10);

    const leads = await db.getLeads(filters);
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const lead = await db.getLeadById(parseInt(req.params.id, 10));
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const diagnostic = await db.getDiagnosticByLeadId(lead.id);
    res.json({ ...lead, diagnostic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze/:id', async (req, res) => {
  try {
    const lead = await db.getLeadById(parseInt(req.params.id, 10));
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.website) return res.status(400).json({ error: 'Lead não possui site' });

    const analysis = await analyzeSite(lead.website);
    await db.insertDiagnostic({ lead_id: lead.id, ...analysis });
    await db.markSiteAnalyzed(lead.id);

    const diagnostic = await db.getDiagnosticByLeadId(lead.id);
    res.json({ success: true, diagnostic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape-contacts/:id', async (req, res) => {
  try {
    const lead = await db.getLeadById(parseInt(req.params.id, 10));
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.website) return res.status(400).json({ error: 'Lead não possui site' });

    const contacts = await scrapeContacts(lead.website);
    if (contacts.emails.length > 0 || contacts.whatsapps.length > 0) {
      await db.updateLeadContact(
        lead.id,
        contacts.emails[0] || lead.email,
        contacts.whatsapps[0] || lead.whatsapp
      );
    }
    const updatedLead = await db.getLeadById(lead.id);
    res.json({ success: true, lead: updatedLead, contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-email/:id', async (req, res) => {
  try {
    const lead = await db.getLeadById(parseInt(req.params.id, 10));
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.email) return res.status(400).json({ error: 'Lead não possui email' });

    const diagnostic = await db.getDiagnosticByLeadId(lead.id);
    if (!diagnostic) return res.status(400).json({ error: 'Site ainda não foi analisado' });

    const result = await sendDiagnosticEmail(lead, diagnostic);
    await db.insertEmailRecord({
      lead_id: lead.id,
      to_email: lead.email,
      status: result.success ? 'sent' : 'failed',
      error_message: result.error || null
    });
    if (result.success) {
      await db.markEmailSent(lead.id);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/test-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email é obrigatório' });

  const result = await sendTestEmail(email);
  res.json(result);
});

app.get('/api/stats', async (req, res) => {
  try {
    res.json(await db.getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await db.deleteLead(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email-config', (req, res) => {
  res.json({
    configured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    user: process.env.GMAIL_USER
      ? process.env.GMAIL_USER.replace(/(.{3}).*(@.*)/, '$1***$2')
      : null
  });
});

if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  initMailer();
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🤖 Bot Mapeeiro rodando em http://localhost:${PORT}\n`);
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      console.log('📧 Email configurado com:', process.env.GMAIL_USER);
    } else {
      console.log('⚠️  Email não configurado. Edite o arquivo .env');
    }
    console.log('');
  });
}

module.exports = app;
