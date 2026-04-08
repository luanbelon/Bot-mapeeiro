require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./src/database/db');
const orchestrator = require('./src/orchestrator');
const { scrapeContacts } = require('./src/scraper/contactScraper');

const app = express();

app.use(express.json());

const AUTH_COOKIE_NAME = 'bot_mapeeiro_session';
const LOGIN_USER = process.env.LOGIN_USER || 'luanbelon';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Lulos0812@';
const AUTH_SECRET = process.env.AUTH_SECRET || 'bot-mapeeiro-secret-change-me';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 horas

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const i = part.indexOf('=');
      if (i === -1) return acc;
      const key = part.slice(0, i).trim();
      const val = decodeURIComponent(part.slice(i + 1).trim());
      acc[key] = val;
      return acc;
    }, {});
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[AUTH_COOKIE_NAME];
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base + '='.repeat((4 - (base.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signPayload(payload) {
  return crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateSessionToken(username) {
  const payload = JSON.stringify({
    u: username,
    e: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  });
  const encoded = toBase64Url(payload);
  const signature = signPayload(encoded);
  return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts;
  const expected = signPayload(encoded);
  if (signature !== expected) return false;

  try {
    const data = JSON.parse(fromBase64Url(encoded));
    if (!data || data.u !== LOGIN_USER || !data.e) return false;
    return Math.floor(Date.now() / 1000) < data.e;
  } catch {
    return false;
  }
}

function isAuthenticated(req) {
  const token = getSessionToken(req);
  return verifySessionToken(token);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'Não autenticado' });
}

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) {
    return res.redirect('/');
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== LOGIN_USER || password !== LOGIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Usuário ou senha inválidos' });
  }

  const token = generateSessionToken(username);
  const secureFlag = process.env.NODE_ENV === 'production' || !!process.env.VERCEL ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax${secureFlag}`
  );
  return res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  const secureFlag = process.env.NODE_ENV === 'production' || !!process.env.VERCEL ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secureFlag}`
  );
  return res.json({ success: true });
});

app.get('/api/auth-status', (req, res) => {
  return res.json({ authenticated: isAuthenticated(req) });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/auth-status') return next();
  return requireAuth(req, res, next);
});

app.get('/', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect('/login');
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/index.html', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect('/login');
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
      const status = orchestrator.getStatus();
      if (status.isRunning && payload && Object.keys(payload).length > 0) {
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
      progress: status.isRunning && progress && Object.keys(progress).length > 0 ? progress : null
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
  const { query, location, scrapeContacts: sc, maxResults } = req.body;

  if (!query || !location) {
    return res.status(400).json({ error: 'Query e location são obrigatórios' });
  }

  if (orchestrator.isRunning) {
    return res.status(409).json({ error: 'Uma busca já está em andamento' });
  }

  const pipeline = orchestrator
    .runFullPipeline(query, location, {
      scrapeContacts: sc !== false,
      maxResults
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
    res.json(lead);
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

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🤖 Bot Mapeeiro rodando em http://localhost:${PORT}\n`);
    console.log('');
  });
}

module.exports = app;
