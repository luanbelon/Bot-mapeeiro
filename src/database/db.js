const { Pool } = require('@neondatabase/serverless');

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL não está definido. Configure a connection string do Neon.');
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = getPool();
      await p.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          address TEXT,
          phone TEXT,
          website TEXT,
          email TEXT,
          whatsapp TEXT,
          rating DOUBLE PRECISION,
          reviews_count INTEGER,
          category TEXT,
          search_query TEXT,
          search_location TEXT,
          has_site INTEGER DEFAULT 0,
          site_analyzed INTEGER DEFAULT 0,
          email_sent INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS diagnostics (
          id SERIAL PRIMARY KEY,
          lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          performance_score DOUBLE PRECISION,
          accessibility_score DOUBLE PRECISION,
          best_practices_score DOUBLE PRECISION,
          seo_score DOUBLE PRECISION,
          has_ssl INTEGER DEFAULT 0,
          is_responsive INTEGER DEFAULT 0,
          load_time DOUBLE PRECISION,
          suggestions JSONB,
          raw_data JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS emails_sent (
          id SERIAL PRIMARY KEY,
          lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
          to_email TEXT NOT NULL,
          status TEXT DEFAULT 'sent',
          error_message TEXT,
          sent_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS job_progress (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await p.query(`
        INSERT INTO job_progress (id, payload) VALUES (1, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING;
      `);
    })();
  }
  return schemaReady;
}

async function saveJobProgress(data) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO job_progress (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [JSON.stringify(data)]
  );
}

async function getJobProgress() {
  await ensureSchema();
  const { rows } = await getPool().query(
    'SELECT payload, updated_at FROM job_progress WHERE id = 1'
  );
  if (!rows.length) return null;
  const payload = rows[0].payload;
  if (!payload || (typeof payload === 'object' && Object.keys(payload).length === 0)) {
    return null;
  }
  return payload;
}

module.exports = {
  async insertLead(data) {
    await ensureSchema();
    const { rows } = await getPool().query(
      `INSERT INTO leads (name, address, phone, website, email, whatsapp, rating, reviews_count, category, search_query, search_location, has_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        data.name || '',
        data.address || '',
        data.phone || '',
        data.website || '',
        data.email || '',
        data.whatsapp || '',
        data.rating ?? null,
        data.reviews_count ?? null,
        data.category || '',
        data.search_query || '',
        data.search_location || '',
        data.website ? 1 : 0
      ]
    );
    return rows[0].id;
  },

  async updateLeadContact(id, email, whatsapp) {
    await ensureSchema();
    await getPool().query(
      'UPDATE leads SET email = $1, whatsapp = $2 WHERE id = $3',
      [email || '', whatsapp || '', id]
    );
  },

  async markSiteAnalyzed(id) {
    await ensureSchema();
    await getPool().query('UPDATE leads SET site_analyzed = 1 WHERE id = $1', [id]);
  },

  async markEmailSent(id) {
    await ensureSchema();
    await getPool().query('UPDATE leads SET email_sent = 1 WHERE id = $1', [id]);
  },

  async insertDiagnostic(data) {
    await ensureSchema();
    const suggestions = data.suggestions || [];
    const raw = data.raw_data || {};
    const { rows } = await getPool().query(
      `INSERT INTO diagnostics (lead_id, performance_score, accessibility_score, best_practices_score, seo_score, has_ssl, is_responsive, load_time, suggestions, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       RETURNING id`,
      [
        data.lead_id,
        data.performance_score ?? null,
        data.accessibility_score ?? null,
        data.best_practices_score ?? null,
        data.seo_score ?? null,
        data.has_ssl ? 1 : 0,
        data.is_responsive ? 1 : 0,
        data.load_time ?? null,
        JSON.stringify(Array.isArray(suggestions) ? suggestions : []),
        JSON.stringify(typeof raw === 'object' ? raw : {})
      ]
    );
    return rows[0].id;
  },

  async insertEmailRecord(data) {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO emails_sent (lead_id, to_email, status, error_message)
       VALUES ($1, $2, $3, $4)`,
      [
        data.lead_id,
        data.to_email,
        data.status || 'sent',
        data.error_message || null
      ]
    );
  },

  async getLeads(filters = {}) {
    await ensureSchema();
    let query = 'SELECT * FROM leads WHERE 1=1';
    const params = [];
    let n = 1;

    if (filters.search_query) {
      query += ` AND search_query = $${n++}`;
      params.push(filters.search_query);
    }
    if (filters.search_location) {
      query += ` AND search_location = $${n++}`;
      params.push(filters.search_location);
    }
    if (filters.has_site !== undefined) {
      query += ` AND has_site = $${n++}`;
      params.push(filters.has_site ? 1 : 0);
    }
    if (filters.email_sent !== undefined) {
      query += ` AND email_sent = $${n++}`;
      params.push(filters.email_sent ? 1 : 0);
    }

    query += ' ORDER BY created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${n++}`;
      params.push(filters.limit);
    }

    const { rows } = await getPool().query(query, params);
    return rows;
  },

  async getLeadById(id) {
    await ensureSchema();
    const { rows } = await getPool().query('SELECT * FROM leads WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async getDiagnosticByLeadId(leadId) {
    await ensureSchema();
    const { rows } = await getPool().query(
      'SELECT * FROM diagnostics WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
      [leadId]
    );
    return rows[0] || null;
  },

  async getStats() {
    await ensureSchema();
    const p = getPool();
    const total = (await p.query('SELECT COUNT(*)::int AS count FROM leads')).rows[0].count;
    const withSite = (await p.query('SELECT COUNT(*)::int AS count FROM leads WHERE has_site = 1')).rows[0]
      .count;
    const analyzed = (await p.query('SELECT COUNT(*)::int AS count FROM leads WHERE site_analyzed = 1')).rows[0]
      .count;
    const emailed = (await p.query('SELECT COUNT(*)::int AS count FROM leads WHERE email_sent = 1')).rows[0]
      .count;
    const withEmail = (await p.query("SELECT COUNT(*)::int AS count FROM leads WHERE email IS NOT NULL AND email != ''"))
      .rows[0].count;
    return { total, withSite, analyzed, emailed, withEmail };
  },

  async deleteLead(id) {
    await ensureSchema();
    const p = getPool();
    await p.query('DELETE FROM emails_sent WHERE lead_id = $1', [id]);
    await p.query('DELETE FROM diagnostics WHERE lead_id = $1', [id]);
    await p.query('DELETE FROM leads WHERE id = $1', [id]);
  },

  saveJobProgress,
  getJobProgress
};
