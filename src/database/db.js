const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'leads.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    website TEXT,
    email TEXT,
    whatsapp TEXT,
    rating REAL,
    reviews_count INTEGER,
    category TEXT,
    search_query TEXT,
    search_location TEXT,
    has_site INTEGER DEFAULT 0,
    site_analyzed INTEGER DEFAULT 0,
    email_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    performance_score REAL,
    accessibility_score REAL,
    best_practices_score REAL,
    seo_score REAL,
    has_ssl INTEGER DEFAULT 0,
    is_responsive INTEGER DEFAULT 0,
    load_time REAL,
    suggestions TEXT,
    raw_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS emails_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    to_email TEXT NOT NULL,
    status TEXT DEFAULT 'sent',
    error_message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
`);

// Prepared statements
const insertLead = db.prepare(`
  INSERT INTO leads (name, address, phone, website, email, whatsapp, rating, reviews_count, category, search_query, search_location, has_site)
  VALUES (@name, @address, @phone, @website, @email, @whatsapp, @rating, @reviews_count, @category, @search_query, @search_location, @has_site)
`);

const updateLeadContact = db.prepare(`
  UPDATE leads SET email = @email, whatsapp = @whatsapp WHERE id = @id
`);

const markSiteAnalyzed = db.prepare(`
  UPDATE leads SET site_analyzed = 1 WHERE id = @id
`);

const markEmailSent = db.prepare(`
  UPDATE leads SET email_sent = 1 WHERE id = @id
`);

const insertDiagnostic = db.prepare(`
  INSERT INTO diagnostics (lead_id, performance_score, accessibility_score, best_practices_score, seo_score, has_ssl, is_responsive, load_time, suggestions, raw_data)
  VALUES (@lead_id, @performance_score, @accessibility_score, @best_practices_score, @seo_score, @has_ssl, @is_responsive, @load_time, @suggestions, @raw_data)
`);

const insertEmailRecord = db.prepare(`
  INSERT INTO emails_sent (lead_id, to_email, status, error_message)
  VALUES (@lead_id, @to_email, @status, @error_message)
`);

module.exports = {
  db,

  insertLead(data) {
    const result = insertLead.run({
      name: data.name || '',
      address: data.address || '',
      phone: data.phone || '',
      website: data.website || '',
      email: data.email || '',
      whatsapp: data.whatsapp || '',
      rating: data.rating || null,
      reviews_count: data.reviews_count || null,
      category: data.category || '',
      search_query: data.search_query || '',
      search_location: data.search_location || '',
      has_site: data.website ? 1 : 0
    });
    return result.lastInsertRowid;
  },

  updateLeadContact(id, email, whatsapp) {
    updateLeadContact.run({ id, email: email || '', whatsapp: whatsapp || '' });
  },

  markSiteAnalyzed(id) {
    markSiteAnalyzed.run({ id });
  },

  markEmailSent(id) {
    markEmailSent.run({ id });
  },

  insertDiagnostic(data) {
    const result = insertDiagnostic.run({
      lead_id: data.lead_id,
      performance_score: data.performance_score || null,
      accessibility_score: data.accessibility_score || null,
      best_practices_score: data.best_practices_score || null,
      seo_score: data.seo_score || null,
      has_ssl: data.has_ssl ? 1 : 0,
      is_responsive: data.is_responsive ? 1 : 0,
      load_time: data.load_time || null,
      suggestions: JSON.stringify(data.suggestions || []),
      raw_data: JSON.stringify(data.raw_data || {})
    });
    return result.lastInsertRowid;
  },

  insertEmailRecord(data) {
    insertEmailRecord.run({
      lead_id: data.lead_id,
      to_email: data.to_email,
      status: data.status || 'sent',
      error_message: data.error_message || null
    });
  },

  getLeads(filters = {}) {
    let query = 'SELECT * FROM leads WHERE 1=1';
    const params = {};

    if (filters.search_query) {
      query += ' AND search_query = @search_query';
      params.search_query = filters.search_query;
    }
    if (filters.search_location) {
      query += ' AND search_location = @search_location';
      params.search_location = filters.search_location;
    }
    if (filters.has_site !== undefined) {
      query += ' AND has_site = @has_site';
      params.has_site = filters.has_site ? 1 : 0;
    }
    if (filters.email_sent !== undefined) {
      query += ' AND email_sent = @email_sent';
      params.email_sent = filters.email_sent ? 1 : 0;
    }

    query += ' ORDER BY created_at DESC';

    if (filters.limit) {
      query += ' LIMIT @limit';
      params.limit = filters.limit;
    }

    return db.prepare(query).all(params);
  },

  getLeadById(id) {
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  },

  getDiagnosticByLeadId(leadId) {
    return db.prepare('SELECT * FROM diagnostics WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1').get(leadId);
  },

  getStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
    const withSite = db.prepare('SELECT COUNT(*) as count FROM leads WHERE has_site = 1').get().count;
    const analyzed = db.prepare('SELECT COUNT(*) as count FROM leads WHERE site_analyzed = 1').get().count;
    const emailed = db.prepare('SELECT COUNT(*) as count FROM leads WHERE email_sent = 1').get().count;
    const withEmail = db.prepare("SELECT COUNT(*) as count FROM leads WHERE email != ''").get().count;
    return { total, withSite, analyzed, emailed, withEmail };
  }
};
