const axios = require('axios');
const https = require('https');
const { URL } = require('url');

/**
 * Analyze a website using Google PageSpeed Insights API (free, no key needed)
 * @param {string} url - Website URL to analyze
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeSite(url) {
  if (!url) throw new Error('URL não fornecida');

  // Normalize URL
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  // Resolve shortened URLs (bit.ly, goo.gl, etc.) to their final destination
  url = await resolveUrl(url);
  console.log(`Analisando URL final: ${url}`);

  const results = {
    url,
    performance_score: null,
    accessibility_score: null,
    best_practices_score: null,
    seo_score: null,
    has_ssl: false,
    is_responsive: false,
    load_time: null,
    suggestions: [],
    raw_data: {}
  };

  // 1. Check SSL
  results.has_ssl = await checkSSL(url);

  // 2. Check responsiveness (viewport meta tag)
  results.is_responsive = await checkResponsive(url);

  // Filter out social media pages that can't be meaningfully analyzed
  const socialDomains = ['instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com', 'linktr.ee', 'linktree.com', 'tr.ee'];
  const urlLower = url.toLowerCase();
  const isSocial = socialDomains.some(d => urlLower.includes(d));

  if (isSocial) {
    results.suggestions.push({
      type: 'warning',
      title: '⚠️ Link de Rede Social',
      description: `O endereço (${url}) é uma página de rede social, não um site próprio. Recomendamos criar um site profissional para ter mais credibilidade e controle sobre sua presença digital.`
    });
    return results;
  }

  // 3. PageSpeed Insights API (free, no API key needed) - with retry for rate limits
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const pageSpeedUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=accessibility&category=best-practices&category=seo`;

      const response = await axios.get(pageSpeedUrl, { timeout: 120000 });
      const data = response.data;

      if (data.lighthouseResult) {
        const categories = data.lighthouseResult.categories;

        results.performance_score = Math.round((categories.performance?.score || 0) * 100);
        results.accessibility_score = Math.round((categories.accessibility?.score || 0) * 100);
        results.best_practices_score = Math.round((categories['best-practices']?.score || 0) * 100);
        results.seo_score = Math.round((categories.seo?.score || 0) * 100);

        // Load time metrics
        const audits = data.lighthouseResult.audits;
        if (audits['speed-index']) {
          results.load_time = parseFloat(audits['speed-index'].numericValue / 1000) || null;
        }

        // Generate suggestions based on scores
        results.suggestions = generateSuggestions(results, audits);

        // Store key audits in raw_data
        results.raw_data = {
          firstContentfulPaint: audits['first-contentful-paint']?.displayValue,
          speedIndex: audits['speed-index']?.displayValue,
          largestContentfulPaint: audits['largest-contentful-paint']?.displayValue,
          totalBlockingTime: audits['total-blocking-time']?.displayValue,
          cumulativeLayoutShift: audits['cumulative-layout-shift']?.displayValue,
          interactive: audits['interactive']?.displayValue
        };
      }
      break; // Success, exit retry loop

    } catch (error) {
      const is429 = error.response && error.response.status === 429;
      console.error(`Erro no PageSpeed Insights para ${url} (tentativa ${attempt}/${maxRetries}):`, error.message);

      if (is429 && attempt < maxRetries) {
        // Wait longer before retrying (exponential backoff: 15s, 30s)
        const waitTime = 15000 * attempt;
        console.log(`Rate limit (429). Aguardando ${waitTime / 1000}s antes de tentar novamente...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      results.suggestions.push({
        type: 'error',
        title: 'Análise de Performance',
        description: is429
          ? 'Muitas análises feitas em sequência. Tente novamente em alguns minutos (limite da API gratuita do Google).'
          : 'Não foi possível analisar a performance do site. O site pode estar fora do ar ou muito lento.'
      });
    }
  }

  return results;
}

/**
 * Check if site has valid SSL certificate
 */
async function checkSSL(url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'https:') {
      return new Promise((resolve) => {
        const req = https.request({
          hostname: parsedUrl.hostname,
          port: 443,
          method: 'HEAD',
          timeout: 10000
        }, (res) => {
          resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });
    }

    // Try HTTPS version
    return new Promise((resolve) => {
      const req = https.request({
        hostname: new URL(url).hostname,
        port: 443,
        method: 'HEAD',
        timeout: 10000
      }, () => resolve(true));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  } catch {
    return false;
  }
}

/**
 * Check if site has viewport meta tag (mobile responsive)
 */
async function checkResponsive(url) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const html = response.data.toString().toLowerCase();
    return html.includes('viewport') && html.includes('width=device-width');
  } catch {
    return false;
  }
}

/**
 * Generate improvement suggestions based on analysis scores
 */
function generateSuggestions(results, audits) {
  const suggestions = [];

  // Performance suggestions
  if (results.performance_score !== null) {
    if (results.performance_score < 50) {
      suggestions.push({
        type: 'critical',
        title: '🔴 Performance Crítica',
        description: `Seu site tem um score de performance de ${results.performance_score}/100. Sites lentos perdem até 53% dos visitantes. Recomendamos otimizar imagens, minificar CSS/JS e implementar caching.`
      });
    } else if (results.performance_score < 90) {
      suggestions.push({
        type: 'warning',
        title: '🟡 Performance Pode Melhorar',
        description: `Score de performance: ${results.performance_score}/100. Existem oportunidades de otimização para tornar o carregamento mais rápido.`
      });
    }
  }

  // SEO suggestions
  if (results.seo_score !== null) {
    if (results.seo_score < 50) {
      suggestions.push({
        type: 'critical',
        title: '🔴 SEO Precisa de Atenção Urgente',
        description: `Score SEO: ${results.seo_score}/100. Seu site não está otimizado para mecanismos de busca, dificultando que clientes encontrem você no Google.`
      });
    } else if (results.seo_score < 90) {
      suggestions.push({
        type: 'warning',
        title: '🟡 SEO Pode Melhorar',
        description: `Score SEO: ${results.seo_score}/100. Algumas melhorias de SEO podem aumentar significativamente sua visibilidade no Google.`
      });
    }
  }

  // Accessibility suggestions
  if (results.accessibility_score !== null && results.accessibility_score < 80) {
    suggestions.push({
      type: 'warning',
      title: '🟡 Acessibilidade',
      description: `Score de acessibilidade: ${results.accessibility_score}/100. Melhorar a acessibilidade amplia seu público e pode ter implicações legais.`
    });
  }

  // Best practices
  if (results.best_practices_score !== null && results.best_practices_score < 80) {
    suggestions.push({
      type: 'warning',
      title: '🟡 Boas Práticas',
      description: `Score de boas práticas: ${results.best_practices_score}/100. Existem melhorias técnicas que podem aumentar a segurança e confiabilidade do site.`
    });
  }

  // SSL
  if (!results.has_ssl) {
    suggestions.push({
      type: 'critical',
      title: '🔴 Sem Certificado SSL (HTTPS)',
      description: 'Seu site não possui certificado SSL. Isso faz o navegador exibir "Não Seguro", afastando clientes e prejudicando o ranking no Google.'
    });
  }

  // Responsive
  if (!results.is_responsive) {
    suggestions.push({
      type: 'critical',
      title: '🔴 Site Não é Responsivo',
      description: 'Seu site não está otimizado para dispositivos móveis. Mais de 60% dos acessos hoje vêm de celulares.'
    });
  }

  // Specific audit suggestions
  if (audits) {
    if (audits['uses-optimized-images']?.score === 0) {
      suggestions.push({
        type: 'tip',
        title: '💡 Otimizar Imagens',
        description: 'Imagens não otimizadas estão aumentando o tempo de carregamento. Comprimir e converter para formatos modernos (WebP) pode economizar dados e melhorar a velocidade.'
      });
    }

    if (audits['render-blocking-resources']?.score === 0) {
      suggestions.push({
        type: 'tip',
        title: '💡 Recursos Bloqueantes',
        description: 'Existem recursos CSS/JS bloqueando o carregamento inicial da página. Otimizar isso pode melhorar significativamente o tempo de exibição.'
      });
    }
  }

  // If everything is good
  if (suggestions.length === 0) {
    suggestions.push({
      type: 'success',
      title: '✅ Site Bem Otimizado!',
      description: 'Seu site apresenta bons scores em todos os critérios analisados. Parabéns!'
    });
  }

  return suggestions;
}

/**
 * Resolve shortened/redirected URLs to their final destination
 * Handles bit.ly, goo.gl, t.co, and any other URL shortener
 */
async function resolveUrl(url) {
  try {
    // Common URL shortener domains
    const shorteners = ['bit.ly', 'goo.gl', 't.co', 'tinyurl.com', 'ow.ly', 'is.gd', 'buff.ly', 'adf.ly', 'rb.gy', 'cutt.ly', 'shorturl.at'];
    const hostname = new URL(url).hostname.toLowerCase();

    const isShortened = shorteners.some(s => hostname.includes(s)) || url.length < 35;

    if (isShortened) {
      const response = await axios.head(url, {
        maxRedirects: 10,
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      // axios follows redirects, so response.request.res.responseUrl has the final URL
      const finalUrl = response.request?.res?.responseUrl || response.request?._redirectable?._currentUrl || url;
      if (finalUrl && finalUrl !== url) {
        console.log(`URL resolvida: ${url} → ${finalUrl}`);
        return finalUrl;
      }

      // Try GET if HEAD didn't resolve
      const getResponse = await axios.get(url, {
        maxRedirects: 10,
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const finalGetUrl = getResponse.request?.res?.responseUrl || getResponse.request?._redirectable?._currentUrl || url;
      if (finalGetUrl && finalGetUrl !== url) {
        console.log(`URL resolvida (GET): ${url} → ${finalGetUrl}`);
        return finalGetUrl;
      }
    }

    return url;
  } catch (error) {
    console.error(`Erro ao resolver URL ${url}:`, error.message);
    return url; // Return original if resolution fails
  }
}

module.exports = { analyzeSite };
