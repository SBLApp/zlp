(function () {
  const els = {
    tabs: Array.from(document.querySelectorAll('.tab')),
    docKindLabel: document.getElementById('doc-kind-label'),
    date: document.getElementById('doc-date'),
    role: document.getElementById('job-role'),
    fio: document.getElementById('fio'),
    fioGen: document.getElementById('fio-gen'),
    product: document.getElementById('product'),
    article: document.getElementById('article'),
    quantity: document.getElementById('quantity'),
    eo: document.getElementById('eo'),
    authorSelect: document.getElementById('author-select'),
    author: document.getElementById('author'),
    authorRole: document.getElementById('author-role'),
    settingsPanel: document.getElementById('memos-settings-panel'),
    supervisorsList: document.getElementById('supervisors-list'),
    supervisorName: document.getElementById('supervisor-name'),
    btnAddSupervisor: document.getElementById('btn-add-supervisor'),
    btnSettings: document.getElementById('btn-settings'),
    formCommon: document.getElementById('form-common'),
    formTc: document.getElementById('form-tc'),
    tcCompany: document.getElementById('tc-company'),
    tcViolator: document.getElementById('tc-violator'),
    tcTaskArea: document.getElementById('tc-task-area'),
    tcProduct: document.getElementById('tc-product'),
    tcArticle: document.getElementById('tc-article'),
    tcQuantity: document.getElementById('tc-quantity'),
    tcPlace: document.getElementById('tc-place'),
    tcEo: document.getElementById('tc-eo'),
    tcTime: document.getElementById('tc-time'),
    tcDateIncident: document.getElementById('tc-date-incident'),
    tcDateMemo: document.getElementById('tc-date-memo'),
    tcBrigadier: document.getElementById('tc-brigadier'),
    formExp: document.getElementById('form-exp'),
    expOp: document.getElementById('exp-op'),
    expIssue: document.getElementById('exp-issue'),
    expReason1: document.getElementById('exp-reason-1'),
    expReason2: document.getElementById('exp-reason-2'),
    expMeasures: document.getElementById('exp-measures'),
    output: document.getElementById('output'),
    btnGenerate: document.getElementById('btn-generate'),
    btnClear: document.getElementById('btn-clear'),
    btnCopy: document.getElementById('btn-copy'),
    btnPrint: document.getElementById('btn-print'),
    btnDownload: document.getElementById('btn-download'),
  };

  const DI = {
    receiving: {
      label: 'Кладовщик (участок приема)',
      duty: 'раздел 3 ДИ, п. 3.1.1 (приемка ТМЦ, работа в ТСД/учетных системах, контроль корректности операций), раздел 3.1.3 (отчетность)',
      resp: 'раздел 5 ДИ (ответственность за ненадлежащее исполнение обязанностей, последствия ошибок, материальный ущерб)',
    },
    placement: {
      label: 'Кладовщик (участок размещения)',
      duty: 'раздел 3 ДИ, п. 3.1.1 (размещение ТМЦ, работа в ТСД/учетных системах, корректное оформление операций), раздел 3.1.3 (отчетность)',
      resp: 'раздел 5 ДИ (персональная ответственность за последствия решений и ошибок в операциях)',
    },
    forklift: {
      label: 'Водитель погрузчика (участок размещения)',
      duty: 'раздел 3 ДИ, п. 3.1.1 и 3.1.2 (выполнение работ ПРТ и погрузо-разгрузочных операций по установленным правилам)',
      resp: 'раздел 5 ДИ (ответственность за нарушения требований, причиненный ущерб и последствия решений)',
    },
  };

  const STORAGE_KEY_SUPERVISORS = 'memos_supervisors';

  function getSupervisors() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SUPERVISORS);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveSupervisors(arr) {
    localStorage.setItem(STORAGE_KEY_SUPERVISORS, JSON.stringify(arr));
  }

  function attrEsc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderSupervisorsSelect() {
    const select = els.authorSelect;
    if (!select) return;
    const list = getSupervisors();
    const currentVal = select.value;
    select.innerHTML = '<option value="">— Выберите или введите ниже —</option>' +
      list.map(name => '<option value="' + attrEsc(name) + '">' + esc(name) + '</option>').join('');
    if (list.indexOf(currentVal) !== -1) select.value = currentVal;
  }

  function renderSupervisorsList() {
    const ul = els.supervisorsList;
    if (!ul) return;
    const list = getSupervisors();
    ul.innerHTML = list.map((name, i) =>
      '<li><span>' + esc(name) + '</span><button type="button" class="btn-remove" data-index="' + i + '" aria-label="Удалить">× Удалить</button></li>'
    ).join('');
    ul.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        const arr = getSupervisors();
        arr.splice(idx, 1);
        saveSupervisors(arr);
        renderSupervisorsList();
        renderSupervisorsSelect();
      });
    });
  }

  const DOC_KIND = {
    bidu: 'Служебная (BIDU)',
    surplus: 'Служебная (Излишки)',
    tc: 'Служебная ТС',
    exp: 'Объяснительная',
  };

  let kind = 'bidu';
  let generatedText = '';

  function setToday() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    els.date.value = `${d.getFullYear()}-${m}-${day}`;
  }

  function fmtDate(v) {
    if (!v) return '___ . ___ . ______';
    const [y, m, d] = v.split('-');
    return `${d}.${m}.${y}`;
  }

  function nonEmpty(v, fallback) {
    return (v || '').trim() || fallback;
  }

  function ruPlural(n, one, few, many) {
    const num = Math.abs(Number(n));
    if (!Number.isFinite(num)) return many;
    const mod10 = num % 10;
    const mod100 = num % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function qtyWithWord(raw, one, few, many) {
    const text = String(raw || '').trim().replace(',', '.');
    if (!text) return '________________';
    const n = Number(text);
    if (!Number.isFinite(n)) return text;
    return `${text} ${ruPlural(n, one, few, many)}`;
  }

  function fioNominative() {
    return nonEmpty(els.fio.value, '________________');
  }

  function fioGenitive() {
    const g = (els.fioGen.value || '').trim();
    return g || fioNominative();
  }

  function buildHeader(title, subtitle) {
    return [
      'СЛУЖЕБНАЯ ЗАПИСКА',
      subtitle,
      '',
      `Дата: ${fmtDate(els.date.value)}`,
      '',
    ].join('\n');
  }

  function buildBidu() {
    const r = DI[els.role.value];
    return [
      buildHeader('СЛУЖЕБНАЯ ЗАПИСКА', 'О выявленных нарушениях в процессе работы'),
      `Настоящим сообщаю, что ${fmtDate(els.date.value)} у сотрудника ${fioGenitive()} выявлено нарушение:`,
      'некорректное применение кода BIDU.',
      '',
      `Товар: ${nonEmpty(els.product.value, '________________')}`,
      `Артикул: ${nonEmpty(els.article.value, '________________')}`,
      `Количество: ${qtyWithWord(els.quantity.value, 'единица', 'единицы', 'единиц')}`,
      `ЕО: ${nonEmpty(els.eo.value, '________________')}`,
      '',
      'Обоснование (ДИ):',
      `1. Нарушены обязанности: ${r.duty}.`,
      `2. Подлежит оценке ответственность: ${r.resp}.`,
      '',
      'Прошу:',
      '1. Запросить письменную объяснительную у сотрудника.',
      '2. Провести служебную проверку обстоятельств.',
      '3. Принять решение о мерах воздействия в соответствии с локальными актами и ТК РФ.',
      '',
      `Составил: ${nonEmpty(els.author.value, '________________')}`,
      `Должность: ${nonEmpty(els.authorRole.value, '________________')}`,
      'Подпись: __________________',
    ].join('\n');
  }

  function buildSurplus() {
    const r = DI[els.role.value];
    return [
      buildHeader('СЛУЖЕБНАЯ ЗАПИСКА', 'О выявленных нарушениях в процессе работы'),
      `Настоящим сообщаю, что ${fmtDate(els.date.value)} у сотрудника ${fioGenitive()} выявлено нарушение формирования отправления:`,
      'обнаружен излишек ТМЦ.',
      '',
      `Товар: ${nonEmpty(els.product.value, '________________')}`,
      `Артикул: ${nonEmpty(els.article.value, '________________')}`,
      `Излишек в количестве: ${qtyWithWord(els.quantity.value, 'единица', 'единицы', 'единиц')}`,
      `ЕО: ${nonEmpty(els.eo.value, '________________')}`,
      '',
      'Обоснование (ДИ):',
      `1. Нарушены обязанности: ${r.duty}.`,
      `2. Подлежит оценке ответственность: ${r.resp}, при наличии ущерба — с учетом ст. 243 ТК РФ.`,
      '',
      'Прошу:',
      '1. Запросить письменную объяснительную у сотрудника.',
      '2. Провести служебную проверку причин возникновения излишка.',
      '3. Принять корректирующие меры для исключения повторения.',
      '',
      `Составил: ${nonEmpty(els.author.value, '________________')}`,
      `Должность: ${nonEmpty(els.authorRole.value, '________________')}`,
      'Подпись: __________________',
    ].join('\n');
  }

  function fmtDateTc(v) {
    if (!v) return '___ . ___ . ______';
    const [y, m, d] = String(v).split('-');
    return `${d}.${m}.${y}`;
  }

  const TC_RECIPIENT = 'Геращенко И.С.';

  /** Канонические названия компаний для СЗ */
  const TC_COMPANY_NAMES = {
    'два колеса': 'ООО "Два Колеса"',
    '2 колеса': 'ООО "Два Колеса"',
    'ооо "два колеса"': 'ООО "Два Колеса"',
    'мувинг': 'ООО "Мувинговая компания"',
    'мувинговая': 'ООО "Мувинговая компания"',
    'мувинговая компания': 'ООО "Мувинговая компания"',
    'ооо "мувинговая компания"': 'ООО "Мувинговая компания"',
    'градус': 'ООО "Градус"',
    'ооо "градус"': 'ООО "Градус"',
    'эни ком сервис': 'ООО "Эни Ком Сервис"',
    'эни сервис ком': 'ООО "Эни Ком Сервис"',
    'эск': 'ООО "Эни Ком Сервис"',
    'ооо "эни ком сервис"': 'ООО "Эни Ком Сервис"',
  };

  function formatCompanyForSz(raw) {
    if (raw == null || String(raw).trim() === '') return '________________';
    const key = String(raw).trim().toLowerCase();
    return TC_COMPANY_NAMES[key] || (key.startsWith('ооо "') ? raw.trim() : 'ООО "' + raw.trim() + '"');
  }

  function getTcTaskPhrase() {
    const v = els.tcTaskArea && els.tcTaskArea.value;
    return v === 'kdk' ? 'выполнял задачу в КДК' : 'выполняя задачу в хранении';
  }

  function buildTcText() {
    const recipient = TC_RECIPIENT;
    const org = 'СТПС ООО «СберЛогистика»';
    const sender = nonEmpty(els.author.value, '________________');
    const senderRole = nonEmpty(els.authorRole.value, 'Начальник смены');
    const dateInc = els.tcDateIncident && els.tcDateIncident.value ? fmtDateTc(els.tcDateIncident.value) : fmtDate(els.date.value);
    const dateMemo = els.tcDateMemo && els.tcDateMemo.value ? fmtDateTc(els.tcDateMemo.value) : fmtDate(els.date.value);
    const companyRaw = nonEmpty(els.tcCompany.value, '');
    const company = formatCompanyForSz(companyRaw || '________________');
    const violator = nonEmpty(els.tcViolator.value, '________________');
    const product = nonEmpty(els.tcProduct && els.tcProduct.value, '________________');
    const article = nonEmpty(els.tcArticle && els.tcArticle.value, '________________');
    const quantity = nonEmpty(els.tcQuantity && els.tcQuantity.value, '1');
    const place = nonEmpty(els.tcPlace && els.tcPlace.value, '________________');
    const eo = nonEmpty(els.tcEo.value, '________________');
    const timeStr = nonEmpty(els.tcTime && els.tcTime.value, '');
    const dateTimeStr = timeStr ? dateInc + ' ' + timeStr : dateInc;
    const brigadierCompany = formatCompanyForSz(els.tcBrigadier && els.tcBrigadier.value ? els.tcBrigadier.value.trim() : companyRaw);
    const brigadier = brigadierCompany !== '________________' ? 'Бригадир ' + brigadierCompany : '________________';
    const barcode = ''; // в ручном шаблоне штрихкод не заполняется отдельно
    const utLine = article !== '________________' ? (barcode ? article + ' / ШК' + barcode : article) : '________________';
    return [
      `Начальнику склада\n${org}\n${recipient}\nОт ${senderRole}\n${sender}`,
      '',
      'СЛУЖЕБНАЯ ЗАПИСКА',
      'О выявленных нарушениях в процессе работы',
      '',
      `Настоящим сообщаю, что ${dateInc}, со стороны сотрудника ${company} были выявлены следующие нарушения:`,
      '',
      `За сотрудником ${violator}`,
      'выявлено нарушение по п.1 приложения №4 от 01.01.2025, а именно нарушение формирования отправления товара:',
      `«${product}»`,
      utLine,
      `в количестве: ${quantity} шт`,
      `Место: ${place}`,
      `EO: ${eo}`,
      `Время: ${dateTimeStr}`,
      '',
      senderRole,
      'Подпись: __________________  ФИО: ' + sender,
      'Дата: ' + dateMemo,
      'Подпись: __________________',
      '',
      'Со служебной запиской ознакомлен',
      'Нарушения подтверждаю',
      brigadier,
      'Подпись: __________________  ФИО: __________________',
    ].join('\n');
  }

  function buildTcHtml() {
    const recipient = TC_RECIPIENT;
    const org = 'СТПС ООО «СберЛогистика»';
    const sender = nonEmpty(els.author.value, '________________');
    const senderRole = nonEmpty(els.authorRole.value, 'Начальник смены');
    const dateInc = els.tcDateIncident && els.tcDateIncident.value ? fmtDateTc(els.tcDateIncident.value) : fmtDate(els.date.value);
    const dateMemo = els.tcDateMemo && els.tcDateMemo.value ? fmtDateTc(els.tcDateMemo.value) : fmtDate(els.date.value);
    const companyRaw = nonEmpty(els.tcCompany.value, '');
    const company = formatCompanyForSz(companyRaw || '________________');
    const violator = nonEmpty(els.tcViolator.value, '________________');
    const product = nonEmpty(els.tcProduct && els.tcProduct.value, '________________');
    const article = nonEmpty(els.tcArticle && els.tcArticle.value, '________________');
    const quantity = nonEmpty(els.tcQuantity && els.tcQuantity.value, '1');
    const place = nonEmpty(els.tcPlace && els.tcPlace.value, '________________');
    const eo = nonEmpty(els.tcEo.value, '________________');
    const timeStr = nonEmpty(els.tcTime && els.tcTime.value, '');
    const dateTimeStr = timeStr ? (dateInc + ' ' + timeStr) : dateInc;
    const brigadierCompany = formatCompanyForSz(els.tcBrigadier && els.tcBrigadier.value ? els.tcBrigadier.value.trim() : companyRaw);
    const utDisplay = article !== '________________' ? article : '—';
    const parts = [];
    parts.push('<div class="doc-right">');
    parts.push('<p>' + esc('Начальнику склада') + '</p>');
    parts.push('<p>' + esc(org) + '</p>');
    parts.push('<p>' + esc(recipient) + '</p>');
    parts.push('<p>' + esc('От ' + senderRole) + '</p>');
    parts.push('<p>' + esc(sender) + '</p>');
    parts.push('</div>');
    parts.push('<div class="doc-center">СЛУЖЕБНАЯ ЗАПИСКА</div>');
    parts.push('<div class="doc-sub">О выявленных нарушениях в процессе работы</div>');
    parts.push('<p class="doc-p">Настоящим сообщаю, что <strong>' + esc(dateInc) + '</strong>, со стороны сотрудника ' + esc(company) + ' были выявлены следующие нарушения:</p>');
    parts.push('<p class="doc-p no-indent">За сотрудником <strong>' + esc(violator) + '</strong></p>');
    parts.push('<p class="doc-p no-indent">выявлено нарушение по п.1 приложения №4 от 01.01.2025, а именно нарушение формирования отправления товара:</p>');
    parts.push('<p class="doc-p no-indent">«<strong>' + esc(product) + '</strong>»</p>');
    parts.push('<p class="doc-p no-indent"><strong>' + esc(utDisplay) + '</strong></p>');
    parts.push('<p class="doc-p no-indent"><strong>в количестве:</strong> ' + esc(quantity) + ' шт</p>');
    parts.push('<p class="doc-p no-indent"><strong>Место:</strong> ' + esc(place) + '</p>');
    parts.push('<p class="doc-p no-indent"><strong>EO:</strong> ' + esc(eo) + '</p>');
    parts.push('<p class="doc-p no-indent"><strong>Время:</strong> ' + esc(dateTimeStr) + '</p>');
    parts.push('<div class="doc-sign-row">');
    parts.push('<div class="doc-tc-sign">');
    parts.push('<p><strong>Начальник смены</strong></p>');
    parts.push('<p>Подпись: __________________</p>');
    parts.push('<p>ФИО: ' + esc(sender) + '</p>');
    parts.push('<p>Дата: ' + esc(dateMemo) + '</p>');
    parts.push('<p>Подпись: __________________</p>');
    parts.push('</div>');
    parts.push('<div class="doc-tc-ack">');
    parts.push('<p>Со служебной запиской ознакомлен</p>');
    parts.push('<p>Нарушения подтверждаю</p>');
    parts.push('<p><strong>Бригадир ' + esc(company) + '</strong></p>');
    parts.push('<p>Подпись: __________________ &nbsp; ФИО: __________________</p>');
    parts.push('</div>');
    parts.push('</div>');
    return parts.join('\n');
  }

  function buildExp() {
    const r = DI[els.role.value];
    const measures = (els.expMeasures.value || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const measuresBlock = measures.length
      ? measures.map((m, i) => `${i + 1}. ${m}`).join('\n')
      : '1. Усилить самоконтроль при выполнении операций.\n2. Проводить двойную сверку по ТСД.';

    return [
      'ОБЪЯСНИТЕЛЬНАЯ ЗАПИСКА',
      '',
      `Я, ${fioNominative()}, должность «${r.label}», по факту нарушения от ${fmtDate(els.date.value)} сообщаю следующее:`,
      '',
      `В ходе операции «${nonEmpty(els.expOp.value, '________________')}» по товару «${nonEmpty(els.product.value, '________________')}» (артикул ${nonEmpty(els.article.value, '________________')}, ЕО ${nonEmpty(els.eo.value, '________________')}) мной была допущена ошибка:`,
      `${nonEmpty(els.expIssue.value, '________________')}`,
      '',
      'Причины:',
      `1. ${nonEmpty(els.expReason1.value, '________________')}`,
      `2. ${nonEmpty(els.expReason2.value, '________________')}`,
      '',
      'Признаю, что нарушение относится к требованиям должностной инструкции:',
      `1. ${r.duty}.`,
      `2. ${r.resp}.`,
      '',
      'Для недопущения повторения обязуюсь:',
      measuresBlock,
      '',
      `Дата: ${fmtDate(els.date.value)}`,
      `Подпись: __________________ / ${fioNominative()}`,
    ].join('\n');
  }

  function render() {
    if (kind === 'tc') {
      generatedText = buildTcText();
      els.output.innerHTML = buildTcHtml();
    } else {
      generatedText = kind === 'bidu'
        ? buildBidu()
        : kind === 'surplus'
          ? buildSurplus()
          : buildExp();
      renderPaper(generatedText);
    }
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderPaper(text) {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let inList = false;
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length) blocks.push(`<div class="doc-center">${esc(lines[i])}</div>`);
    i++;
    if (i < lines.length && lines[i].trim()) blocks.push(`<div class="doc-sub">${esc(lines[i])}</div>`);
    i++;

    for (; i < lines.length; i++) {
      const ln = lines[i];
      const t = ln.trim();
      if (!t) continue;
      if (inList && !/^\d+\.\s+/.test(t)) {
        blocks.push('</ol>');
        inList = false;
      }
      if (t.startsWith('Дата:')) {
        blocks.push(`<div class="doc-date">${esc(t)}</div>`);
        continue;
      }
      if (t === 'Прошу:' || t === 'Причины:' || t.startsWith('Обоснование')) {
        blocks.push(`<p class="doc-p no-indent"><b>${esc(t)}</b></p>`);
        continue;
      }
      if (/^\d+\.\s+/.test(t)) {
        if (!inList) {
          blocks.push('<ol class="doc-list">');
          inList = true;
        }
        blocks.push(`<li>${esc(t.replace(/^\d+\.\s+/, ''))}</li>`);
        continue;
      }
      if (t.startsWith('Составил:') || t.startsWith('Должность:') || t.startsWith('Подпись:')) {
        blocks.push(`<p class="doc-p no-indent doc-sign">${esc(t)}</p>`);
        continue;
      }
      blocks.push(`<p class="doc-p">${esc(t)}</p>`);
    }
    if (inList) blocks.push('</ol>');
    els.output.innerHTML = blocks.join('\n');
  }

  function switchKind(next) {
    kind = next;
    els.tabs.forEach(t => t.classList.toggle('active', t.dataset.kind === next));
    els.formExp.classList.toggle('hidden', next !== 'exp');
    if (els.formCommon) els.formCommon.classList.toggle('hidden', next === 'tc');
    if (els.formTc) els.formTc.classList.toggle('hidden', next !== 'tc');
    els.docKindLabel.textContent = DOC_KIND[next] || next;
    render();
  }

  function clearFields() {
    [
      els.fio, els.product, els.article, els.quantity, els.eo,
      els.fioGen, els.author, els.authorRole, els.expOp, els.expIssue, els.expReason1, els.expReason2, els.expMeasures,
    ].forEach(el => { if (el) el.value = ''; });
    if (els.authorSelect) els.authorSelect.value = '';
    [
      els.tcCompany, els.tcViolator, els.tcProduct, els.tcArticle, els.tcQuantity, els.tcPlace, els.tcEo, els.tcTime, els.tcBrigadier,
    ].forEach(el => { if (el) el.value = ''; });
    if (els.tcTaskArea) els.tcTaskArea.value = 'storage';
    setToday();
    if (els.tcDateIncident) els.tcDateIncident.value = els.date.value;
    if (els.tcDateMemo) els.tcDateMemo.value = els.date.value;
    render();
  }

  function copyOutput() {
    const text = generatedText.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      els.btnCopy.textContent = 'Скопировано';
      setTimeout(() => { els.btnCopy.textContent = 'Скопировать'; }, 1200);
    });
  }

  function downloadOutput() {
    const htmlBody = els.output.innerHTML || '';
    const htmlDoc = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Документ</title>
  <style>
    @page { size: A4; margin: 20mm; }
    body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.45; color: #000; }
    .doc-center { text-align: center; font-weight: 700; }
    .doc-sub { text-align: center; margin-top: 4px; }
    .doc-date { text-align: right; margin-top: 10px; margin-bottom: 14px; }
    .doc-p { text-align: justify; text-indent: 1.25cm; margin: 0 0 8px 0; }
    .doc-p.no-indent { text-indent: 0; }
    .doc-list { margin: 0 0 10px 0; padding-left: 20px; }
    .doc-list li { margin-bottom: 4px; }
    .doc-sign { margin-top: 18px; }
    .doc-right { text-align: right; margin-bottom: 14px; }
    .doc-right p { margin: 2px 0; }
    .doc-sign-row { display: flex; justify-content: space-between; margin-top: 18px; gap: 24px; }
    .doc-tc-sign { flex: 1; }
    .doc-tc-sign p { margin: 4px 0; }
    .doc-sign-inline { margin-top: 6px; }
    .doc-tc-ack { flex: 1; text-align: right; max-width: 50%; margin-top: 0; }
    .doc-tc-ack p { margin: 2px 0; }
  </style>
</head>
<body>${htmlBody}</body>
</html>`;
    const blob = new Blob([htmlDoc], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `документ_${kind}_${els.date.value || 'без_даты'}.doc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function printOutput() {
    window.focus();
    window.print();
  }

  els.tabs.forEach(tab => tab.addEventListener('click', () => switchKind(tab.dataset.kind)));
  els.btnGenerate.addEventListener('click', render);
  els.btnClear.addEventListener('click', clearFields);
  els.btnCopy.addEventListener('click', copyOutput);
  els.btnPrint.addEventListener('click', printOutput);
  els.btnDownload.addEventListener('click', downloadOutput);

  if (els.authorSelect) {
    els.authorSelect.addEventListener('change', () => {
      const val = els.authorSelect.value;
      if (val && els.author) els.author.value = val;
      if (val && els.authorRole) els.authorRole.value = 'Начальник смены';
      render();
    });
  }
  if (els.btnSettings && els.settingsPanel) {
    els.btnSettings.addEventListener('click', () => {
      els.settingsPanel.classList.toggle('hidden');
    });
  }
  function addSupervisor() {
    const name = (els.supervisorName && els.supervisorName.value || '').trim();
    if (!name) return;
    const list = getSupervisors();
    if (list.indexOf(name) !== -1) return;
    list.push(name);
    saveSupervisors(list);
    renderSupervisorsList();
    renderSupervisorsSelect();
    els.supervisorName.value = '';
  }
  if (els.btnAddSupervisor && els.supervisorName) {
    els.btnAddSupervisor.addEventListener('click', addSupervisor);
    els.supervisorName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSupervisor(); } });
  }

  [els.role, els.date, els.authorSelect].forEach(el => el && el.addEventListener('change', render));
  [els.tcCompany, els.tcViolator, els.tcTaskArea, els.tcProduct, els.tcArticle, els.tcQuantity, els.tcPlace, els.tcEo, els.tcTime, els.tcDateIncident, els.tcDateMemo, els.tcBrigadier, els.author, els.authorRole].forEach(el => {
    if (el) el.addEventListener('input', render);
    if (el && el.type === 'date') el.addEventListener('change', render);
  });

  setToday();
  if (els.tcDateIncident) els.tcDateIncident.value = els.date.value;
  if (els.tcDateMemo) els.tcDateMemo.value = els.date.value;
  renderSupervisorsSelect();
  renderSupervisorsList();
  render();
})();
