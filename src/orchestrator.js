const { scrapeGoogleMaps } = require('./scraper/mapsScraper');
const { scrapeContacts } = require('./scraper/contactScraper');
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
   * Run the full pipeline: Search → Scrape Contacts
   */
  async runFullPipeline(query, location, options = {}) {
    if (this.isRunning) {
      throw new Error('Uma busca já está em andamento');
    }

    this.isRunning = true;
    this.shouldStop = false;
    this.currentSearch = { query, location };

    const {
      scrapeContacts: shouldScrapeContacts = true,
      maxResults = 20
    } = options;

    try {
      this.emit('progress', {
        phase: 'scraping',
        message: 'Buscando no Google Maps...',
        percent: 5
      });

      const businesses = await scrapeGoogleMaps(
        query,
        location,
        (progress) => {
          this.emit('progress', {
            phase: 'scraping',
            message: progress.message,
            percent: 5 + (progress.current ? Math.round((progress.current / progress.total) * 30) : 10),
            detail: progress
          });
        },
        {
          maxResults,
          shouldStop: () => this.shouldStop
        }
      );

      if (this.shouldStop) return this.stopResult();

      this.emit('progress', {
        phase: 'saving',
        message: `Salvando ${businesses.length} negócios no banco de dados...`,
        percent: 40
      });

      const leadIds = [];
      for (const biz of businesses) {
        const id = await db.insertLead({
          ...biz,
          search_query: query,
          search_location: location
        });
        leadIds.push(id);
      }

      if (this.shouldStop) return this.stopResult();

      if (shouldScrapeContacts) {
        const leadsWithSite = [];
        for (const id of leadIds) {
          const lead = await db.getLeadById(id);
          if (lead && lead.website) leadsWithSite.push(lead);
        }

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
              await db.updateLeadContact(
                lead.id,
                contacts.emails[0] || lead.email,
                contacts.whatsapps[0] || lead.whatsapp
              );
            }
          } catch (err) {
            console.error(`Erro ao buscar contatos de ${lead.name}:`, err.message);
          }

          await delay(1000 + Math.random() * 2000);
        }
      }

      this.emit('progress', {
        phase: 'done',
        message: 'Pipeline concluído!',
        percent: 100
      });

      const stats = await db.getStats();
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
    this.emit('progress', { phase: 'done', message: 'Busca interrompida pelo usuário', percent: 100 });
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = new Orchestrator();
