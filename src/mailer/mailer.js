const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

let transporter = null;

/**
 * Initialize the email transporter
 */
function initMailer() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('⚠️  Credenciais de email não configuradas. Configure GMAIL_USER e GMAIL_APP_PASSWORD no .env');
    return false;
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  return true;
}

/**
 * Send diagnostic report email
 * @param {Object} lead - Lead data
 * @param {Object} diagnostic - Diagnostic results
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendDiagnosticEmail(lead, diagnostic) {
  if (!transporter) {
    if (!initMailer()) {
      return { success: false, error: 'Email não configurado. Configure as credenciais no .env' };
    }
  }

  if (!lead.email) {
    return { success: false, error: 'Lead não possui email' };
  }

  try {
    // Load and compile template
    const templatePath = path.join(__dirname, 'templates', 'report.hbs');
    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const template = handlebars.compile(templateSource);

    // Prepare template data
    const suggestions = typeof diagnostic.suggestions === 'string'
      ? JSON.parse(diagnostic.suggestions)
      : diagnostic.suggestions || [];

    const templateData = {
      businessName: lead.name,
      websiteUrl: lead.website,
      performanceScore: diagnostic.performance_score,
      accessibilityScore: diagnostic.accessibility_score,
      bestPracticesScore: diagnostic.best_practices_score,
      seoScore: diagnostic.seo_score,
      hasSSL: diagnostic.has_ssl,
      isResponsive: diagnostic.is_responsive,
      loadTime: diagnostic.load_time != null ? Number(diagnostic.load_time).toFixed(1) : 'N/A',
      suggestions: suggestions,
      companyName: process.env.COMPANY_NAME || 'Nossa Empresa',
      contactEmail: process.env.CONTACT_EMAIL || process.env.GMAIL_USER,
      contactWhatsapp: process.env.CONTACT_WHATSAPP || '',
      contactPhone: process.env.CONTACT_PHONE || '',
      year: new Date().getFullYear(),
      performanceColor: getScoreColor(diagnostic.performance_score),
      seoColor: getScoreColor(diagnostic.seo_score),
      accessibilityColor: getScoreColor(diagnostic.accessibility_score),
      bestPracticesColor: getScoreColor(diagnostic.best_practices_score)
    };

    const html = template(templateData);

    // Send email
    const mailOptions = {
      from: `"${process.env.COMPANY_NAME || 'Diagnóstico Web'}" <${process.env.GMAIL_USER}>`,
      to: lead.email,
      subject: `📊 Diagnóstico Gratuito do Site - ${lead.name}`,
      html: html
    };

    await transporter.sendMail(mailOptions);
    return { success: true };

  } catch (error) {
    console.error('Erro ao enviar email:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send a test email to verify configuration
 */
async function sendTestEmail(toEmail) {
  if (!transporter) {
    if (!initMailer()) {
      return { success: false, error: 'Email não configurado' };
    }
  }

  try {
    await transporter.sendMail({
      from: `"Bot Mapeeiro - Teste" <${process.env.GMAIL_USER}>`,
      to: toEmail,
      subject: '✅ Bot Mapeeiro - Email de Teste',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
          <h2 style="color: #22c55e;">✅ Configuração de Email OK!</h2>
          <p>O Bot Mapeeiro está configurado corretamente para enviar emails.</p>
          <p style="color: #666; font-size: 12px;">Este é um email de teste automático.</p>
        </div>
      `
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getScoreColor(score) {
  if (score === null || score === undefined) return '#888';
  if (score >= 90) return '#22c55e';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

module.exports = { initMailer, sendDiagnosticEmail, sendTestEmail };
