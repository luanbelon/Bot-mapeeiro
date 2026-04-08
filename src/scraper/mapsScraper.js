/**
 * Scrape Google Maps for businesses
 * @param {string} query - Business type (e.g., "Restaurantes")
 * @param {string} location - City/neighborhood (e.g., "Salvador BA")
 * @param {function} onProgress - Callback for progress updates
 * @param {{maxResults?: number, shouldStop?: function}} options
 * @returns {Promise<Array>} Array of business objects
 */
async function scrapeGoogleMaps(query, location, onProgress = () => {}, options = {}) {
  const { launchBrowser } = require('./puppeteerLaunch');
  const searchTerm = `${query} em ${location}`;
  const maxResults = clampResults(options.maxResults);
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  onProgress({ step: 'init', message: `Iniciando busca: "${searchTerm}"` });

  const browser = await launchBrowser();

  const businesses = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    // Google Maps mantém conexões abertas: networkidle2 pode travar ou demorar demais.
    await page.setDefaultNavigationTimeout(45000);
    await page.setDefaultTimeout(15000);

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
    onProgress({ step: 'navigating', message: 'Abrindo Google Maps...' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    await delay(3000);

    try {
      const acceptBtn = await page.$('button[aria-label="Aceitar tudo"]');
      if (acceptBtn) await acceptBtn.click();
      await delay(1000);
    } catch (e) {
      /* no cookie prompt */
    }

    onProgress({ step: 'scrolling', message: 'Carregando resultados...' });

    const resultsSelector = 'div[role="feed"]';
    await page.waitForSelector(resultsSelector, { timeout: 15000 }).catch(() => null);

    for (let i = 0; i < 5; i++) {
      if (shouldStop()) {
        onProgress({ step: 'stopped', message: 'Busca interrompida pelo usuário.' });
        return businesses;
      }
      await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (feed) feed.scrollTop = feed.scrollHeight;
      }, resultsSelector);
      await delay(2000 + Math.random() * 2000);
      onProgress({
        step: 'scrolling',
        message: `Scroll ${i + 1}/5 - carregando mais resultados...`
      });
    }

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
          const href = link.getAttribute('href') || '';
          items.push({ name, href });
        } catch (e) {
          /* skip item */
        }
      });

      return items;
    });

    const limitedResults = results.slice(0, maxResults);

    onProgress({
      step: 'details',
      message: `Encontrados ${results.length} negócios. Coletando até ${limitedResults.length} detalhes...`
    });

    for (let i = 0; i < limitedResults.length; i++) {
      if (shouldStop()) {
        onProgress({ step: 'stopped', message: 'Busca interrompida pelo usuário.' });
        return businesses;
      }
      const biz = limitedResults[i];
      onProgress({
        step: 'details',
        message: `Coletando detalhes: ${biz.name} (${i + 1}/${limitedResults.length})`,
        current: i + 1,
        total: limitedResults.length
      });

      try {
        if (biz.href) {
          await gotoPlacePage(page, biz.href, shouldStop);
          await delay(1500 + Math.random() * 1000);

          const details = await page.evaluate(() => {
            let phone = '';
            let website = '';

            const phoneBtn =
              document.querySelector('button[data-tooltip="Copiar o número de telefone"]') ||
              document.querySelector('button[aria-label*="Telefone"]') ||
              document.querySelector('a[href^="tel:"]');
            if (phoneBtn) {
              const phoneText = phoneBtn.getAttribute('aria-label') || phoneBtn.textContent;
              const phoneMatch = phoneText.match(/[\d\s()+\-]{8,}/);
              if (phoneMatch) phone = phoneMatch[0].trim();
            }

            if (!phone) {
              const allButtons = document.querySelectorAll('button[data-item-id]');
              allButtons.forEach((btn) => {
                const itemId = btn.getAttribute('data-item-id') || '';
                if (itemId.startsWith('phone:')) {
                  phone = itemId.replace('phone:tel:', '').replace('phone:', '');
                }
              });
            }

            const websiteLink =
              document.querySelector('a[data-item-id="authority"]') ||
              document.querySelector('a[aria-label*="Site"]') ||
              document.querySelector('a[aria-label*="Website"]');
            if (websiteLink) {
              website = websiteLink.getAttribute('href') || '';
            }

            if (!website) {
              const allLinks = document.querySelectorAll('a[data-item-id]');
              allLinks.forEach((link) => {
                const itemId = link.getAttribute('data-item-id') || '';
                if (itemId === 'authority') {
                  website = link.getAttribute('href') || link.textContent.trim();
                }
              });
            }

            return { phone, website };
          });

          biz.phone = details.phone || biz.phone || '';
          biz.website = details.website || '';
        }

        businesses.push({
          name: biz.name,
          address: '',
          phone: biz.phone || '',
          website: biz.website || '',
          rating: null,
          reviews_count: null,
          category: '',
          email: '',
          whatsapp: ''
        });
      } catch (err) {
        if (err && err.code === 'STOPPED') {
          onProgress({ step: 'stopped', message: 'Busca interrompida pelo usuário.' });
          return businesses;
        }
        console.warn(`Detalhe do lead "${biz.name}":`, err.message);
        businesses.push({
          name: biz.name,
          address: '',
          phone: biz.phone || '',
          website: '',
          rating: null,
          reviews_count: null,
          category: '',
          email: '',
          whatsapp: ''
        });
      }
    }

    onProgress({
      step: 'done',
      message: `Busca concluída! ${businesses.length} negócios encontrados.`
    });
  } catch (error) {
    onProgress({ step: 'error', message: `Erro: ${error.message}` });
    throw error;
  } finally {
    await browser.close();
  }

  return businesses;
}

/**
 * Abre a página do lugar sem networkidle2 (Maps quase nunca fica "idle").
 * Opcionalmente interrompe navegação ao parar a busca.
 */
async function gotoPlacePage(page, href, shouldStop) {
  const NAV_TIMEOUT_MS = 22000;
  let intervalId;
  const stopPromise = new Promise((_, reject) => {
    intervalId = setInterval(() => {
      if (shouldStop()) {
        reject(Object.assign(new Error('Parado pelo usuário'), { code: 'STOPPED' }));
      }
    }, 400);
  });
  try {
    await Promise.race([
      page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }),
      stopPromise
    ]);
  } catch (err) {
    if (err && err.code === 'STOPPED') {
      try {
        const client = await page.target().createCDPSession();
        await client.send('Page.stopLoading');
      } catch (_) {
        /* ignore */
      }
      throw err;
    }
    // Timeout ou falha de rede: segue com HTML parcial para o evaluate
    console.warn(`goto place (continua com dados parciais): ${err.message}`);
  } finally {
    if (intervalId) clearInterval(intervalId);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampResults(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(30, Math.max(20, Math.trunc(parsed)));
}

module.exports = { scrapeGoogleMaps };
