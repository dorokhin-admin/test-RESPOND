const {
  isValidUrl,
  fetchPage,
  parsePage,
  captureScreenshots,
  makeFallbackAnalysis,
  callLLM,
  enrichChecklistWithRecommendations,
  buildReportHtml
} = require('../lib/analysis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const { url } = req.body || {};

    if (!url || !isValidUrl(url)) {
      return res.status(400).json({
        error: 'Введите корректный публичный URL.'
      });
    }

    console.log(`Начинаю анализ: ${url}`);

    const pageData = await fetchPage(url);
    const parsed = parsePage(pageData.html, pageData.finalUrl);

    const analysisId = `analysis-${Date.now()}`;

    const screenshots = await captureScreenshots(
      pageData.finalUrl,
      analysisId
    );

    let analysis = makeFallbackAnalysis(
      parsed,
      screenshots,
      analysisId
    );

    const llmResult = await callLLM(
      parsed,
      analysisId
    );

    if (llmResult && llmResult.checklist && llmResult.backlog) {
      const enrichedChecklist =
        enrichChecklistWithRecommendations(
          llmResult.checklist,
          parsed
        );

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
    }

    return res.status(200).json({
      success: true,
      analysisId,
      analysis,
      reportHtml: buildReportHtml(analysis)
    });

  } catch (error) {
    console.error('ANALYZE ERROR:', error);

    return res.status(500).json({
      error: 'Анализ не удался.',
      details: error.message
    });
  }
};
