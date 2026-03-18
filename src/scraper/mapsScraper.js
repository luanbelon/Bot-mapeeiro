const puppeteer = require('puppeteer');

/**
 * Scrape Google Maps for businesses
 * @param {string} query - Business type (e.g., "Restaurantes")
 * @param {string} location - City/neighborhood (e.g., "Salvador BA")
 * @param {function} onProgress - Callback for progress updates
 * @returns {Promise<Array>} Array of business objects
 */
async function scrapeGoogleMaps(query, location, onProgress = () => {}) {
  const searchTerm = `${query} em ${location}`;
  onProgress({ step: 'init', message: `Iniciando busca: "${searchTerm}"` });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=pt-BR'
    ]
  });

  const businesses = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to Google Maps search
    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    onProgress({ step: 'navigating', message: 'Abrindo Google Maps...' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for results to load
    await delay(3000);

    // Accept cookies if prompted
    try {
      const acceptBtn = await page.$('button[aria-label="Aceitar tudo"]');
      if (acceptBtn) await acceptBtn.click();
      await delay(1000);
    } catch (e) { /* no cookie prompt */ }

    // Scroll the results panel to load more items
    onProgress({ step: 'scrolling', message: 'Carregando resultados...' });

    const resultsSelector = 'div[role="feed"]';
    await page.waitForSelector(resultsSelector, { timeout: 15000 }).catch(() => null);

    // Scroll to load more results (up to 5 scroll attempts)
    for (let i = 0; i < 5; i++) {
      await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (feed) feed.scrollTop = feed.scrollHeight;
      }, resultsSelector);
      await delay(2000 + Math.random() * 2000);
      onProgress({ step: 'scrolling', message: `Scroll ${i + 1}/5 - carregando mais resultados...` });
    }

    // Extract business data from the results list
    onProgress({ step: 'extracting', message: 'Extraindo dados dos negócios...' });

    const results = await page.evaluate(() => {
      const items = [];
      const links = document.querySelectorAll('div[role="feed"] > div > div > a[href*="/maps/place/"]');

      links.forEach((link) => {
        try {
          const container = link.closest('div[role="feed"] > div > div');
          if (!container) return;

          const nameEl = container.querySelector('.fontHeadlineSmall');
          const name = nameEl ? nameEl.textContent.trim() : '';
          if (!name) return;

          // Get all text content
          const allText = container.textContent;

          // Rating
          const ratingMatch = allText.match(/(\d[.,]\d)\s*\(/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(',', '.')) : null;

          // Reviews count
          const reviewsMatch = allText.match(/\((\d[\d.]*)\)/);
          const reviewsCount = reviewsMatch ? parseInt(reviewsMatch[1].replace('.', '')) : null;

          // Get the href for later navigation
          const href = link.getAttribute('href') || '';

          // Category and address from the text spans
          const spans = container.querySelectorAll('.fontBodyMedium span');
          let category = '';
          let address = '';

          spans.forEach(span => {
            const t = span.textContent.trim();
            if (t.startsWith('·')) return;
            if (!category && t.length > 2 && !t.includes('Aberto') && !t.includes('Fechado') && !t.match(/^\d/)) {
              category = t;
            }
            if (!address && (t.includes(',') || t.match(/\d{5}/)) && t.length > 10) {
              address = t;
            }
          });

          items.push({ name, rating, reviewsCount, category, address, href });
        } catch (e) { /* skip item */ }
      });

      return items;
    });

    onProgress({ step: 'details', message: `Encontrados ${results.length} negócios. Coletando detalhes...` });

    // Visit each business page for details (phone, website)
    for (let i = 0; i < results.length; i++) {
      const biz = results[i];
      onProgress({
        step: 'details',
        message: `Coletando detalhes: ${biz.name} (${i + 1}/${results.length})`,
        current: i + 1,
        total: results.length
      });

      try {
        if (biz.href) {
          await page.goto(biz.href, { waitUntil: 'networkidle2', timeout: 30000 });
          await delay(2000 + Math.random() * 2000);

          const details = await page.evaluate(() => {
            let phone = '';
            let website = '';

            // Look for phone number
            const phoneBtn = document.querySelector('button[data-tooltip="Copiar o número de telefone"]') ||
                             document.querySelector('button[aria-label*="Telefone"]') ||
                             document.querySelector('a[href^="tel:"]');
            if (phoneBtn) {
              const phoneText = phoneBtn.getAttribute('aria-label') || phoneBtn.textContent;
              const phoneMatch = phoneText.match(/[\d\s()+\-]{8,}/);
              if (phoneMatch) phone = phoneMatch[0].trim();
            }

            // Alternative phone search
            if (!phone) {
              const allButtons = document.querySelectorAll('button[data-item-id]');
              allButtons.forEach(btn => {
                const itemId = btn.getAttribute('data-item-id') || '';
                if (itemId.startsWith('phone:')) {
                  phone = itemId.replace('phone:tel:', '').replace('phone:', '');
                }
              });
            }

            // Look for website
            const websiteLink = document.querySelector('a[data-item-id="authority"]') ||
                                document.querySelector('a[aria-label*="Site"]') ||
                                document.querySelector('a[aria-label*="Website"]');
            if (websiteLink) {
              website = websiteLink.getAttribute('href') || '';
            }

            // Alternative website search
            if (!website) {
              const allLinks = document.querySelectorAll('a[data-item-id]');
              allLinks.forEach(link => {
                const itemId = link.getAttribute('data-item-id') || '';
                if (itemId === 'authority') {
                  website = link.getAttribute('href') || link.textContent.trim();
                }
              });
            }

            // Get address from the detail page
            const addressBtn = document.querySelector('button[data-item-id="address"]');
            const address = addressBtn ? (addressBtn.getAttribute('aria-label') || '').replace('Endereço: ', '') : '';

            return { phone, website, address };
          });

          biz.phone = details.phone || biz.phone || '';
          biz.website = details.website || '';
          biz.address = details.address || biz.address || '';
        }

        businesses.push({
          name: biz.name,
          address: biz.address || '',
          phone: biz.phone || '',
          website: biz.website || '',
          rating: biz.rating,
          reviews_count: biz.reviewsCount,
          category: biz.category || '',
          email: '',
          whatsapp: ''
        });

      } catch (err) {
        // Still add the business with whatever data we have
        businesses.push({
          name: biz.name,
          address: biz.address || '',
          phone: biz.phone || '',
          website: '',
          rating: biz.rating,
          reviews_count: biz.reviewsCount,
          category: biz.category || '',
          email: '',
          whatsapp: ''
        });
      }
    }

    onProgress({ step: 'done', message: `Busca concluída! ${businesses.length} negócios encontrados.` });

  } catch (error) {
    onProgress({ step: 'error', message: `Erro: ${error.message}` });
    throw error;
  } finally {
    await browser.close();
  }

  return businesses;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { scrapeGoogleMaps };
