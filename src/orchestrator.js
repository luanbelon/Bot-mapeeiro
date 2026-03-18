const { scrapeGoogleMaps } = require('./scraper/mapsScraper');
const { scrapeContacts } = require('./scraper/contactScraper');
const { analyzeSite } = require('./analyzer/siteAnalyzer');
const { sendDiagnosticEmail } = require('./mailer/mailer');
const db = require('./database/db');
const EventEmitter = require('events');

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.currentSearch = null;
    this.shouldStop = false;
  }

  /**
   * Run the full pipeline: Search → Scrape Contacts → Analyze → Email
   */
  async runFullPipeline(query, location, options = {}) {
    if (this.isRunning) {
      throw new Error('Uma busca já está em andamento');
    }

    this.isRunning = true;
    this.shouldStop = false;
    this.currentSearch = { query, location };

    const {
      autoAnalyze = true,
      autoEmail = false,
      scrapeContacts: shouldScrapeContacts = true
    } = options;

    try {
      // Step 1: Scrape Google Maps
      this.emit('progress', {
        phase: 'scraping',
        message: 'Buscando no Google Maps...',
        percent: 5
      });

      const businesses = await scrapeGoogleMaps(query, location, (progress) => {
        this.emit('progress', {
          phase: 'scraping',
          message: progress.message,
          percent: 5 + (progress.current ? Math.round((progress.current / progress.total) * 30) : 10),
          detail: progress
        });
      });

      if (this.shouldStop) return this.stopResult();

      // Step 2: Save to database
      this.emit('progress', {
        phase: 'saving',
        message: `Salvando ${businesses.length} negócios no banco de dados...`,
        percent: 40
      });

      const leadIds = [];
      for (const biz of businesses) {
        const id = db.insertLead({
          ...biz,
          search_query: query,
          search_location: location
        });
        leadIds.push(id);
      }

      if (this.shouldStop) return this.stopResult();

      // Step 3: Scrape contacts from websites
      if (shouldScrapeContacts) {
        const leadsWithSite = leadIds
          .map(id => db.getLeadById(id))
          .filter(lead => lead && lead.website);

        for (let i = 0; i < leadsWithSite.length; i++) {
          if (this.shouldStop) return this.stopResult();

          const lead = leadsWithSite[i];
          this.emit('progress', {
            phase: 'contacts',
            message: `Buscando contatos: ${lead.name} (${i + 1}/${leadsWithSite.length})`,
            percent: 40 + Math.round((i / leadsWithSite.length) * 20),
            current: i + 1,
            total: leadsWithSite.length
          });

          try {
            const contacts = await scrapeContacts(lead.website);
            if (contacts.emails.length > 0 || contacts.whatsapps.length > 0) {
              db.updateLeadContact(
                lead.id,
                contacts.emails[0] || lead.email,
                contacts.whatsapps[0] || lead.whatsapp
              );
            }
          } catch (err) {
            console.error(`Erro ao buscar contatos de ${lead.name}:`, err.message);
          }

          // Small delay between requests
          await delay(1000 + Math.random() * 2000);
        }
      }

      if (this.shouldStop) return this.stopResult();

      // Step 4: Analyze sites
      if (autoAnalyze) {
        // Filter out social media links that can't be analyzed
        const socialDomains = ['instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com', 'linktr.ee', 'linktree.com', 'tr.ee'];
        const leadsToAnalyze = leadIds
          .map(id => db.getLeadById(id))
          .filter(lead => {
            if (!lead || !lead.website || lead.site_analyzed) return false;
            const urlLower = lead.website.toLowerCase();
            const isSocial = socialDomains.some(d => urlLower.includes(d));
            if (isSocial) {
              console.log(`Pulando ${lead.name} - link de rede social: ${lead.website}`);
            }
            return !isSocial;
          });

        for (let i = 0; i < leadsToAnalyze.length; i++) {
          if (this.shouldStop) return this.stopResult();

          const lead = leadsToAnalyze[i];
          this.emit('progress', {
            phase: 'analyzing',
            message: `Analisando site: ${lead.name} (${i + 1}/${leadsToAnalyze.length})`,
            percent: 60 + Math.round((i / leadsToAnalyze.length) * 25),
            current: i + 1,
            total: leadsToAnalyze.length
          });

          try {
            const analysis = await analyzeSite(lead.website);
            db.insertDiagnostic({
              lead_id: lead.id,
              ...analysis
            });
            db.markSiteAnalyzed(lead.id);
          } catch (err) {
            console.error(`Erro ao analisar site de ${lead.name}:`, err.message);
          }

          // PageSpeed API rate limit: wait longer between requests to avoid 429
          await delay(10000 + Math.random() * 5000);
        }
      }

      if (this.shouldStop) return this.stopResult();

      // Step 5: Send emails (only if autoEmail is enabled)
      if (autoEmail) {
        const leadsToEmail = leadIds
          .map(id => db.getLeadById(id))
          .filter(lead => lead && lead.email && lead.site_analyzed && !lead.email_sent);

        for (let i = 0; i < leadsToEmail.length; i++) {
          if (this.shouldStop) return this.stopResult();

          const lead = leadsToEmail[i];
          const diagnostic = db.getDiagnosticByLeadId(lead.id);

          if (!diagnostic) continue;

          this.emit('progress', {
            phase: 'emailing',
            message: `Enviando email: ${lead.name} (${i + 1}/${leadsToEmail.length})`,
            percent: 85 + Math.round((i / leadsToEmail.length) * 14),
            current: i + 1,
            total: leadsToEmail.length
          });

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
          } catch (err) {
            console.error(`Erro ao enviar email para ${lead.name}:`, err.message);
          }

          // Gmail rate limiting
          await delay(2000 + Math.random() * 3000);
        }
      }

      // Done
      this.emit('progress', {
        phase: 'done',
        message: 'Pipeline concluído!',
        percent: 100
      });

      const stats = db.getStats();
      this.emit('complete', stats);

      return {
        success: true,
        leadsFound: leadIds.length,
        stats
      };

    } catch (error) {
      this.emit('error', error.message);
      throw error;
    } finally {
      this.isRunning = false;
      this.currentSearch = null;
    }
  }

  stop() {
    this.shouldStop = true;
    this.emit('progress', { phase: 'stopping', message: 'Parando...', percent: 0 });
  }

  stopResult() {
    this.isRunning = false;
    this.currentSearch = null;
    return { success: false, message: 'Busca interrompida pelo usuário' };
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      currentSearch: this.currentSearch
    };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = new Orchestrator();
