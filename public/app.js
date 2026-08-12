const form = document.getElementById('analyze-form');
const statusEl = document.getElementById('status');
const resultSection = document.getElementById('result-section');
const resultContent = document.getElementById('result-content');
const downloadLink = document.getElementById('download-link');

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = document.getElementById('page-url').value.trim();

  statusEl.textContent = 'Страница анализируется, это может занять 30–90 секунд…';
  resultSection.classList.add('hidden');

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      console.error('Ответ сервера:', text);
      throw new Error(
        `Сервер вернул не JSON. HTTP ${response.status}. Ответ: ${text.slice(0, 200)}`
      );
    }

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Не удалось получить отчёт.');
    }

    if (data.reportHtml) {
      const blob = new Blob([data.reportHtml], {
        type: 'text/html'
      });

      downloadLink.href = URL.createObjectURL(blob);
      downloadLink.download = 'report.html';
    }

    renderReport(data.analysis);

    statusEl.textContent = 'Отчёт готов';
    resultSection.classList.remove('hidden');

  } catch (error) {
    console.error(error);
    statusEl.textContent = error.message;
  }
});

function renderReport(analysis) {
  const checklistRows = analysis.checklist
    .map((item) => {
      const scoreLabel =
        item.score === 2
          ? 'Хорошо'
          : item.score === 1
            ? 'Частично'
            : 'Плохо';

      return `
        <tr>
          <td>${escapeHtml(item.block)}</td>
          <td>${escapeHtml(item.title)}</td>
          <td>${escapeHtml(scoreLabel)}</td>
          <td>${escapeHtml(item.explanation)}</td>
          <td>${escapeHtml(item.whatToAdd || item.recommendation)}</td>
        </tr>
      `;
    })
    .join('');

  const actionItems = analysis.checklist
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.title)}</strong>: ${escapeHtml(
          item.whatToAdd || item.recommendation
        )}</li>`
    )
    .join('');

  const issueRows = (analysis.issues || [])
    .map(
      (issue) =>
        `<li><strong>${escapeHtml(issue.title)}</strong> — ${escapeHtml(
          issue.location
        )}. ${escapeHtml(issue.explanation)}. ${escapeHtml(
          issue.recommendation
        )}</li>`
    )
    .join('');

  const backlogRows = (analysis.backlog || [])
    .map(
      (task) =>
        `<tr>
          <td>${escapeHtml(task.task)}</td>
          <td>${escapeHtml(task.zone)}</td>
          <td>${escapeHtml(task.priority)}</td>
          <td>${escapeHtml(task.expectedEffect)}</td>
        </tr>`
    )
    .join('');

  resultContent.innerHTML = `
    <h3>Общая оценка</h3>
    <p>
      <strong>${escapeHtml(analysis.overallAssessment.level)}</strong>
      (${analysis.overallAssessment.score}/100)
    </p>

    <p>${escapeHtml(analysis.overallAssessment.summary)}</p>

    <h3>Что добавить</h3>
    <ul>${actionItems}</ul>

    <h3>Оценка по блокам</h3>

    <table>
      <thead>
        <tr>
          <th>Блок</th>
          <th>Пункт</th>
          <th>Оценка</th>
          <th>Что не так</th>
          <th>Что добавить</th>
        </tr>
      </thead>

      <tbody>${checklistRows}</tbody>
    </table>

    <h3>Список проблем</h3>
    <ul>${issueRows}</ul>

    <h3>Беклог задач</h3>

    <table>
      <thead>
        <tr>
          <th>Задача</th>
          <th>Зона страницы</th>
          <th>Приоритет</th>
          <th>Ожидаемый эффект</th>
        </tr>
      </thead>

      <tbody>${backlogRows}</tbody>
    </table>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
