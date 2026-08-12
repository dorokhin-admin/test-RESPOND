const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRecommendationForCriterion } = require('../server');

test('buildRecommendationForCriterion returns actionable recommendations', () => {
  const page = {
    title: 'Сервис для малого бизнеса',
    headings: ['Как мы помогаем'],
    buttonCount: 0,
    hasCtaTerms: false,
    visibleText: 'Мы помогаем компаниям автоматизировать процессы',
    textLength: 500,
    formCount: 0,
    hasTrustSignals: false,
    hasPriceMention: false,
    linkCount: 25,
    imageCount: 1,
    viewportMeta: true
  };

  const recommendation = buildRecommendationForCriterion('cta_visibility', page);
  assert.match(recommendation, /CTA|кнопку|призыв/i);
});
