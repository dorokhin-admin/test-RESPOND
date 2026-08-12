const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const rootDir = __dirname;
const storageDir = path.join(rootDir, 'storage');
const screenshotsDir = path.join(storageDir, 'screenshots');
const analysesDir = path.join(storageDir, 'analyses');
const reportsDir = path.join(storageDir, 'reports');

for (const dir of [storageDir, screenshotsDir, analysesDir, reportsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(rootDir, 'public')));
app.use('/storage', express.static(storageDir));

const methodology = JSON.parse(fs.readFileSync(path.join(rootDir, 'methodology.json'), 'utf8'));
const systemPrompt = fs.readFileSync(path.join(rootDir, 'prompts', 'system-prompt.txt'), 'utf8');

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function isValidUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: 25000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
  });
  return {
    html: response.data,
    statusCode: response.status,
    finalUrl: response.request?.res?.responseUrl || url
  };
}

function parsePage(html, url) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || 'Без заголовка';
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const visibleText = bodyText.slice(0, 4000);
  const headings = $('h1, h2, h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean)
    .slice(0, 10);
  const links = $('a[href]')
    .map((_, el) => $(el).attr('href'))
    .get()
    .filter(Boolean);
  const buttons = $('button, a[role="button"], input[type="submit"], [class*="btn"], [class*="button"]').length;
  const forms = $('form').length;
  const images = $('img').length;
  const pricePattern = /\b(от|руб|р\.|usd|eur|€|£|цена|стоимость|price)\b/i;
  const hasPriceMention = pricePattern.test(visibleText);
  const trustTerms = ['отзыв', 'гарантия', 'доставка', 'сертификат', 'кейc', 'кейс', 'надежно', 'безопасно', 'проверено'];
  const hasTrustSignals = trustTerms.some((term) => visibleText.toLowerCase().includes(term));
  const ctaTerms = ['купить', 'заказать', 'получить', 'записаться', 'оставить заявку', 'связаться', 'консультацию', 'вступить'];
  const hasCtaTerms = ctaTerms.some((term) => visibleText.toLowerCase().includes(term));
  const viewportMeta = $('meta[name="viewport"]').length > 0;
  const hasForm = forms > 0;
  const inputCount = $('input').length;

  return {
    url,
    title,
    metaDescription,
    visibleText,
    headings,
    linkCount: links.length,
    buttonCount: buttons,
    formCount: forms,
    imageCount: images,
    inputCount,
    hasPriceMention,
    hasTrustSignals,
    hasCtaTerms,
    viewportMeta,
    hasForm,
    textLength: visibleText.length
  };
}

async function captureScreenshots(url, analysisId) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const desktopPage = await browser.newPage();
    await desktopPage.setViewportSize({ width: 1440, height: 900 });
    await desktopPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const desktopPath = path.join(screenshotsDir, `${analysisId}.desktop.png`);
    await desktopPage.screenshot({ path: desktopPath, fullPage: true });

    const mobilePage = await browser.newPage();
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    await mobilePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const mobilePath = path.join(screenshotsDir, `${analysisId}.mobile.png`);
    await mobilePage.screenshot({ path: mobilePath, fullPage: true });

    return { desktopPath, mobilePath };
  } catch (error) {
    log(`Скриншоты не созданы: ${error.message}`);
    return { desktopPath: null, mobilePath: null, error: error.message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function buildRecommendationForCriterion(criterionId, page) {
  const criterion = methodology.checklist.find((item) => item.id === criterionId);
  const baseRecommendation = criterion?.recommendation || 'Добавить более понятный и конкретный элемент на странице.';
  const text = page.visibleText.toLowerCase();
  const title = page.title || '';

  switch (criterionId) {
    case 'hero_headline':
      if (!title || title.length < 8) {
        return 'Добавить в верхнюю часть экрана короткий заголовок с конкретным результатом и подзаголовок с 1–2 преимуществами.';
      }
      if (page.headings.length === 0) {
        return 'Добавить заголовок H1 и короткий подзаголовок, который объясняет, зачем пользователь попал на страницу.';
      }
      return 'Уточнить заголовок так, чтобы он сразу говорил о результате для пользователя, и добавить рядом короткое объяснение выгоды.';
    case 'value_proposition':
      return 'Добавить блок с 3 конкретными преимуществами и кратким объяснением, как это решает проблему пользователя.';
    case 'cta_visibility':
      return 'Добавить выше первого экрана крупную кнопку CTA с контрастным цветом и текстом вроде «Оставить заявку» или «Получить консультацию».';
    case 'trust_signals':
      return 'Добавить рядом с CTA блок с отзывами, кейсами, цифрами, гарантиями или контактами.';
    case 'price_transparency':
      return 'Добавить явный блок с ценой, сроками, что входит в оффер и условиями оплаты или доставки.';
    case 'form_clarity':
      return 'Сократить форму до 2–3 полей, убрать лишние шаги и добавить короткий текст, зачем нужна форма.';
    case 'mobile_ux':
      return 'Упростить мобильный сценарий: увеличить кнопки, закрепить CTA и убрать лишние блоки до первого действия.';
    case 'load_speed':
      return 'Сократить количество тяжелых блоков на первом экране и убрать лишние изображения/скрипты, чтобы страница воспринималась быстрее.';
    case 'distraction_level':
      return 'Оставить один главный путь действия и убрать вторичные ссылки, меню и блоки, отвлекающие от оффера.';
    case 'primary_visual':
      return 'Заменить слабый визуал на изображение или видео, которое показывает результат использования продукта.';
    case 'offer_specificity':
      return 'Добавить конкретный сценарий: для кого этот оффер, в какой ситуации он нужен и какой результат ожидается.';
    case 'social_proof':
      return 'Добавить отзывы клиентов, кейсы, цифры, бренды или результаты работы рядом с основным предложением.';
    case 'objection_handling':
      return 'Добавить блок с ответами на типовые возражения: гарантия, сроки, доставка, возврат и поддержка.';
    case 'contact_signal':
      return 'Добавить понятный контактный способ: телефон, мессенджер, форму обратной связи или кнопку «Написать» рядом с CTA.';
    case 'mobile_cta':
      return 'Сделать мобильный CTA заметным сразу после знакомства с оффером, чтобы пользователь не скроллил далеко.';
    case 'information_density':
      return 'Разбить текст на короткие блоки с заголовками и оставить только ключевую информацию, чтобы страница не перегружала.';
    default:
      return baseRecommendation;
  }
}

function enrichChecklistWithRecommendations(checklist, page) {
  return (checklist || []).map((item) => {
    const whatToAdd = item.whatToAdd || buildRecommendationForCriterion(item.id, page);
    const recommendation = item.score < 2
      ? (item.recommendation || whatToAdd)
      : (item.recommendation || `Поддержать сильную сторону: ${item.title?.toLowerCase() || 'элемент'}`);

    return {
      ...item,
      whatToAdd,
      recommendation
    };
  });
}

function scoreCriterion(criterion, page) {
  const text = page.visibleText.toLowerCase();
  switch (criterion.id) {
    case 'hero_headline':
      return page.title.length > 12 && page.headings.length > 0 ? 2 : page.title.length > 6 ? 1 : 0;
    case 'value_proposition':
      return /преимущество|решение|помогаем|экономим|ускоряем|повышаем|сервис|платформа|продукт/i.test(text) ? 2 : page.textLength > 300 ? 1 : 0;
    case 'cta_visibility':
      return page.buttonCount > 0 && page.hasCtaTerms ? 2 : page.buttonCount > 0 ? 1 : 0;
    case 'trust_signals':
      return page.hasTrustSignals ? 2 : page.hasForm ? 1 : 0;
    case 'price_transparency':
      return page.hasPriceMention ? 2 : page.textLength > 400 ? 1 : 0;
    case 'form_clarity':
      return page.formCount > 0 && page.inputCount >= 2 ? 2 : page.formCount > 0 ? 1 : 0;
    case 'mobile_ux':
      return page.viewportMeta ? 2 : 1;
    case 'load_speed':
      return page.textLength > 500 ? 2 : 1;
    case 'distraction_level':
      return page.linkCount > 40 ? 0 : page.linkCount > 20 ? 1 : 2;
    case 'primary_visual':
      return page.imageCount > 1 ? 2 : page.imageCount > 0 ? 1 : 0;
    case 'offer_specificity':
      return /для|для кого|кто|когда|как/i.test(text) ? 2 : 1;
    case 'social_proof':
      return page.hasTrustSignals ? 2 : 1;
    case 'objection_handling':
      return /гарантия|доставка|возврат|поддержка|ответим/i.test(text) ? 2 : 1;
    case 'contact_signal':
      return /контакт|телефон|email|whatsapp|telegram|чат|support/i.test(text) ? 2 : 1;
    case 'mobile_cta':
      return page.buttonCount > 0 && page.hasCtaTerms ? 2 : 1;
    case 'information_density':
      return page.textLength > 1500 ? 2 : page.textLength > 600 ? 1 : 0;
    default:
      return 1;
  }
}

function makeFallbackAnalysis(page, screenshots, analysisId) {
  const checklist = methodology.checklist.map((item) => {
    const score = scoreCriterion(item, page);
    const explanation = score === 2
      ? `${item.goodIf}`
      : score === 1
        ? `${item.weakIf}`
        : `${item.badIf}`;
    const whatToAdd = buildRecommendationForCriterion(item.id, page);
    const recommendation = score < 2 ? whatToAdd : `Поддержать сильную сторону: ${item.title.toLowerCase()} — сохранить этот элемент и усилить его на первом экране.`;

    return {
      id: item.id,
      block: item.block,
      title: item.title,
      score,
      maxScore: 2,
      explanation,
      recommendation,
      whatToAdd
    };
  });

  const issues = checklist
    .filter((item) => item.score < 2)
    .slice(0, 8)
    .map((item, index) => ({
      title: item.title,
      location: item.block,
      severity: item.score === 0 ? 'high' : 'medium',
      explanation: item.explanation,
      recommendation: item.recommendation,
      evidence: `Элемент: ${item.title}`
    }));

  const backlog = [
    {
      task: 'Добавить яркий CTA выше первого экрана',
      zone: 'Первый экран',
      priority: page.buttonCount > 0 ? 'medium' : 'high',
      expectedEffect: 'Пользователь быстрее поймёт, что делать дальше и снизит уход до знакомства с оффером.'
    },
    {
      task: 'Уточнить ценностное предложение на главной',
      zone: 'Оффер',
      priority: 'high',
      expectedEffect: 'Чётче объяснит выгоду и повысит долю переходов в следующий шаг.'
    },
    {
      task: 'Добавить признаки доверия и социальной доказательности',
      zone: 'Доверие',
      priority: page.hasTrustSignals ? 'medium' : 'high',
      expectedEffect: 'Снизит сомнения и повысит готовность отправить заявку.'
    },
    {
      task: 'Упростить форму и сократить число обязательных полей',
      zone: 'Форма',
      priority: page.formCount > 0 ? 'medium' : 'low',
      expectedEffect: 'Сократит барьер на этапе отправки заявки.'
    },
    {
      task: 'Оптимизировать мобильную версию под быстрый сценарий',
      zone: 'Мобильная версия',
      priority: 'medium',
      expectedEffect: 'Снизит отказы на мобильных устройствах и улучшит завершение действий.'
    }
  ].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  const enrichedChecklist = enrichChecklistWithRecommendations(checklist, page);
  const avgScore = Math.round(enrichedChecklist.reduce((sum, item) => sum + item.score, 0) / enrichedChecklist.length * 100 / 2);
  const level = avgScore >= 75 ? 'высокий' : avgScore >= 50 ? 'средний' : 'низкий';

  return {
    analysisId,
    createdAt: new Date().toISOString(),
    pageUrl: page.url,
    overallAssessment: {
      score: avgScore,
      level,
      summary: `Страница выглядит ${level === 'высокий' ? 'конкурентоспособной' : level === 'средний' ? 'работоспособной, но с заметными барьерами' : 'слабой с точки зрения конверсии'}. Основные потери происходят из-за неясного оффера в первом экране, слабых признаков доверия и неочевидного следующего шага.`,
      recommendation: 'Сначала добавить на первый экран ясный заголовок, блок с преимуществами, крупный CTA и признаки доверия рядом с ним.'
    },
    checklist: enrichedChecklist,
    issues,
    backlog,
    screenshots: {
      desktopPath: screenshots.desktopPath || null,
      mobilePath: screenshots.mobilePath || null,
      error: screenshots.error || null
    }
  };
}

async function callLLM(page, analysisId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify({ page, methodology }) }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Пустой ответ модели');
    }

    const parsed = JSON.parse(content);
    parsed.analysisId = analysisId;
    parsed.createdAt = new Date().toISOString();
    return parsed;
  } catch (error) {
    log(`LLM-анализ не удался: ${error.message}`);
    return null;
  }
}

function buildReportHtml(analysis) {
  const checklistRows = analysis.checklist
    .map((item) => {
      const scoreLabel = item.score === 2 ? 'Хорошо' : item.score === 1 ? 'Частично' : 'Плохо';
      return `<tr><td>${escapeHtml(item.block)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(scoreLabel)}</td><td>${escapeHtml(item.explanation)}</td><td>${escapeHtml(item.whatToAdd || item.recommendation)}</td></tr>`;
    })
    .join('');

  const issueRows = analysis.issues
    .map((issue) => `<li><strong>${escapeHtml(issue.title)}</strong> — ${escapeHtml(issue.location)}. ${escapeHtml(issue.explanation)}. ${escapeHtml(issue.recommendation)}</li>`)
    .join('');

  const backlogRows = analysis.backlog
    .map((task) => `<tr><td>${escapeHtml(task.task)}</td><td>${escapeHtml(task.zone)}</td><td>${escapeHtml(task.priority)}</td><td>${escapeHtml(task.expectedEffect)}</td></tr>`)
    .join('');

  const screenshotSources = [];
  if (analysis.screenshots?.desktopPath) {
    try {
      const imageData = fs.readFileSync(analysis.screenshots.desktopPath, { encoding: 'base64' });
      screenshotSources.push(`<img src="data:image/png;base64,${imageData}" alt="Desktop screenshot" />`);
    } catch (err) {
      screenshotSources.push(`<img src="${analysis.screenshots.desktopPath}" alt="Desktop screenshot" />`);
    }
  }
  if (analysis.screenshots?.mobilePath) {
    try {
      const imageData = fs.readFileSync(analysis.screenshots.mobilePath, { encoding: 'base64' });
      screenshotSources.push(`<img src="data:image/png;base64,${imageData}" alt="Mobile screenshot" />`);
    } catch (err) {
      screenshotSources.push(`<img src="${analysis.screenshots.mobilePath}" alt="Mobile screenshot" />`);
    }
  }

  const screenshotSection = screenshotSources.length > 0
    ? `<div class="gallery">${screenshotSources.join('')}</div>`
    : '<p>Скриншоты недоступны.</p>';

  const actionList = analysis.checklist
    .map((item) => `<li><strong>${escapeHtml(item.title)}</strong>: ${escapeHtml(item.whatToAdd || item.recommendation)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>Отчёт по конверсии</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #18212f; }
      h1, h2 { color: #103a63; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
      th, td { border: 1px solid #d7e0ea; padding: 8px; text-align: left; vertical-align: top; }
      th { background: #f3f7fb; }
      .gallery img { max-width: 48%; margin-right: 2%; border: 1px solid #d7e0ea; }
    </style>
  </head>
  <body>
    <h1>Отчёт по конверсии страницы</h1>
    <p><strong>URL:</strong> ${escapeHtml(analysis.pageUrl)}</p>
    <p><strong>Оценка:</strong> ${escapeHtml(analysis.overallAssessment.level)} (${analysis.overallAssessment.score}/100)</p>
    <p>${escapeHtml(analysis.overallAssessment.summary)}</p>
    <h2>Что добавить</h2>
    <ul>${actionList}</ul>
    <h2>Оценка по блокам</h2>
    <table>
      <thead><tr><th>Блок</th><th>Пункт</th><th>Оценка</th><th>Что не так</th><th>Что добавить</th></tr></thead>
      <tbody>${checklistRows}</tbody>
    </table>
    <h2>Проблемы</h2>
    <ul>${issueRows}</ul>
    <h2>Беклог задач</h2>
    <table>
      <thead><tr><th>Задача</th><th>Зона страницы</th><th>Приоритет</th><th>Ожидаемый эффект</th></tr></thead>
      <tbody>${backlogRows}</tbody>
    </table>
    <h2>Скриншоты</h2>
    ${screenshotSection}
  </body>
</html>`;
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/analyze', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: 'Введите корректный публичный URL.' });
    }

    log(`Начинаю анализ ${url}`);
   const pageData = await fetchPage(url);
    const parsed = parsePage(pageData.html, pageData.finalUrl);
    const analysisId = `analysis-${Date.now()}`;

    const screenshots = await captureScreenshots(pageData.finalUrl, analysisId);
    let analysis = makeFallbackAnalysis(parsed, screenshots, analysisId);

    const llmResult = await callLLM(parsed, analysisId);
    if (llmResult && llmResult.checklist && llmResult.backlog) {
      const enrichedChecklist = enrichChecklistWithRecommendations(llmResult.checklist, parsed);
      analysis = {
        ...analysis,
        ...llmResult,
        checklist: enrichedChecklist,
        screenshots: analysis.screenshots,
        overallAssessment: {
          ...analysis.overallAssessment,
          ...llmResult.overallAssessment
        }
      };
      log('Анализ обновлён данными LLM');
    }

    const reportHtml = buildReportHtml(analysis);
    const reportPath = path.join(reportsDir, `${analysisId}.html`);
    const analysisPath = path.join(analysesDir, `${analysisId}.json`);
    fs.writeFileSync(reportPath, reportHtml, 'utf8');
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf8');

    res.json({
      success: true,
      analysisId,
      analysis,
      reportUrl: `/api/report/${analysisId}`,
      downloadUrl: `/api/report/${analysisId}?download=1`
    });
  } catch (error) {
    log(`Ошибка анализа: ${error.message}`);
    res.status(500).json({ error: 'Анализ не удался. Удостоверьтесь, что страница доступна и не требует авторизации.' });
  }
});

app.get('/api/report/:id', (req, res) => {
  const reportPath = path.join(reportsDir, `${req.params.id}.html`);
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'Отчёт не найден' });
  }

  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="report-${req.params.id}.html"`);
  }

  res.sendFile(reportPath);
});

app.get('/api/analysis/:id', (req, res) => {
  const analysisPath = path.join(analysesDir, `${req.params.id}.json`);
  if (!fs.existsSync(analysisPath)) {
    return res.status(404).json({ error: 'Результат не найден' });
  }
  res.sendFile(analysisPath);
});

if (require.main === module) {
  app.listen(PORT, () => {
    log(`Сервер запущен на http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  buildRecommendationForCriterion
};
