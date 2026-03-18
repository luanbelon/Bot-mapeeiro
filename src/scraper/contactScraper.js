const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Scrape contact info (email, WhatsApp) from a business website
 * @param {string} url - Website URL
 * @returns {Promise<{emails: string[], whatsapps: string[]}>}
 */
async function scrapeContacts(url) {
  const result = { emails: [], whatsapps: [] };

  if (!url) return result;

  // Normalize URL
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  try {
    const baseUrl = new URL(url).origin;
    const pagesToCheck = [
      url,
      baseUrl + '/contato',
      baseUrl + '/contact',
      baseUrl + '/sobre',
      baseUrl + '/about',
      baseUrl + '/fale-conosco',
    ];

    for (const pageUrl of pagesToCheck) {
      try {
        const { emails, whatsapps } = await extractContactsFromPage(pageUrl);
        result.emails.push(...emails);
        result.whatsapps.push(...whatsapps);
      } catch (e) {
        // Page doesn't exist or can't be reached, skip
      }
    }

    // Deduplicate
    result.emails = [...new Set(result.emails)];
    result.whatsapps = [...new Set(result.whatsapps)];

  } catch (error) {
    console.error(`Erro ao buscar contatos de ${url}:`, error.message);
  }

  return result;
}

/**
 * Extract emails and WhatsApp numbers from a single page
 */
async function extractContactsFromPage(url) {
  const emails = [];
  const whatsapps = [];

  const response = await axios.get(url, {
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    maxRedirects: 5,
    validateStatus: (status) => status < 400
  });

  const html = response.data;
  const $ = cheerio.load(html);

  // --- Extract Emails ---

  // From mailto: links
  $('a[href^="mailto:"]').each((_, el) => {
    const email = $(el).attr('href').replace('mailto:', '').split('?')[0].trim().toLowerCase();
    if (isValidEmail(email)) {
      emails.push(email);
    }
  });

  // From page text using regex
  const textContent = $('body').text();
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const foundEmails = textContent.match(emailRegex) || [];
  foundEmails.forEach(email => {
    const clean = email.toLowerCase().trim();
    if (isValidEmail(clean)) {
      emails.push(clean);
    }
  });

  // From HTML source (sometimes emails are in attributes)
  const htmlStr = html.toString();
  const htmlEmails = htmlStr.match(emailRegex) || [];
  htmlEmails.forEach(email => {
    const clean = email.toLowerCase().trim();
    if (isValidEmail(clean)) {
      emails.push(clean);
    }
  });

  // --- Extract WhatsApp ---

  // From wa.me links
  $('a[href*="wa.me"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/wa\.me\/(\d+)/);
    if (match) whatsapps.push(match[1]);
  });

  // From api.whatsapp.com links
  $('a[href*="api.whatsapp.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/phone=(\d+)/);
    if (match) whatsapps.push(match[1]);
  });

  // From web.whatsapp.com links
  $('a[href*="web.whatsapp.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/phone=(\d+)/);
    if (match) whatsapps.push(match[1]);
  });

  // From text content - look for WhatsApp mentions near phone numbers
  const whatsappRegex = /(?:whatsapp|wpp|zap|whats)\s*:?\s*([\d\s()+\-]{10,})/gi;
  const whatsMatches = textContent.matchAll(whatsappRegex);
  for (const match of whatsMatches) {
    const number = match[1].replace(/\D/g, '');
    if (number.length >= 10) {
      whatsapps.push(number);
    }
  }

  return {
    emails: [...new Set(emails)],
    whatsapps: [...new Set(whatsapps)]
  };
}

/**
 * Validate email address
 */
function isValidEmail(email) {
  if (!email || email.length < 5) return false;

  // Exclude common false positives
  const excludePatterns = [
    /\.png$/i, /\.jpg$/i, /\.gif$/i, /\.svg$/i, /\.css$/i, /\.js$/i,
    /example\.com/i, /test\.com/i, /email\.com$/i,
    /wixpress\.com/i, /sentry\.io/i, /webpack/i
  ];

  if (excludePatterns.some(p => p.test(email))) return false;

  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

module.exports = { scrapeContacts };
