/**
 * @file popup/modules/export.js
 * @description Exportação CSV e JSON da lista de presença.
 *
 * ## Responsabilidade
 *   - csvEscape(v)         — escapa valor para CSV com delimitador ";"
 *   - downloadBlob(...)    — dispara download via Blob URL
 *   - nowFilenameStamp()   — gera sufixo de timestamp para nome de arquivo
 *   - buildExportRows(...) — constrói array de linhas para exportação
 *   - onExportCsv(...)     — handler do botão Exportar CSV
 *   - onExportJson(...)    — handler do botão Exportar JSON
 *
 * Formato CSV (v1.6.0): Nome;E-mail;Data
 *   - Participantes COM e-mail aparecem primeiro
 *   - Participantes SEM e-mail aparecem depois (coluna e-mail vazia)
 *   - UTF-8 com BOM para compatibilidade com Excel
 *
 * Depende de: window.MPUtils
 * Expõe: window.MP_PopupExport
 */

(function (global) {
  'use strict';

  /** @type {import('../../lib/utils.js').MPUtils} */
  const U = global.MPUtils;

  // ---------------------------------------------------------------------------
  // Utilitários
  // ---------------------------------------------------------------------------

  /**
   * Gera sufixo de timestamp para nomes de arquivo.
   * Formato: YYYY-MM-DD_HHmm
   * @returns {string}
   */
  function nowFilenameStamp() {
    const d    = new Date();
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const hh   = String(d.getHours()).padStart(2, '0');
    const mi   = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${hh}${mi}`;
  }

  /**
   * Escapa um valor para uso seguro em CSV com delimitador ";".
   * Envolve em aspas duplas se houver ";", `"` ou quebra de linha.
   *
   * @param {*} v
   * @returns {string}
   */
  function csvEscape(v) {
    const text = String(v || '');
    if (/[;"\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  /**
   * Dispara download de um Blob no navegador.
   *
   * @param {string} content
   * @param {string} mimeType
   * @param {string} filename
   */
  function downloadBlob(content, mimeType, filename) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // ---------------------------------------------------------------------------
  // Construção das linhas de exportação
  // ---------------------------------------------------------------------------

  /**
   * Constrói o array de linhas para exportação com todos os campos necessários.
   *
   * @param {object}   cache          - Estado do popup.
   * @param {function} getSelectedRows - Retorna linhas enriquecidas e mescladas.
   * @param {function} applyMinDwellFilter - Aplica filtro de tempo mínimo.
   * @returns {object[]}
   */
  function buildExportRows(cache, getSelectedRows, applyMinDwellFilter) {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code || !meeting.state) return [];

    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows, cache);

    return rows.map((r) => ({
      nome:          r.name,
      email:         r.email || '',
      primeiraEntrada: U.formatDateTimeBR(r.firstSeenAt),
      ultimaSaida:   U.formatDateTimeBR(r.lastSeenAt),
      tempoHms:      U.formatDurationHMS(r.totalSeconds),
      tempoSeg:      Math.max(0, Math.floor(r.totalSeconds)),
      sessoes:       r.sessions,
      presenteAgora: r.present ? 'Sim' : 'Não',
      reuniao:       meeting.code
    }));
  }

  // ---------------------------------------------------------------------------
  // Exportação CSV
  // ---------------------------------------------------------------------------

  /**
   * Exporta a lista de presença como CSV.
   *
   * Formato: Nome;E-mail;Data
   * Ordem: participantes COM e-mail primeiro, depois SEM e-mail.
   * Deduplicação de segurança por e-mail/nome (mantém maior tempo).
   *
   * @param {object}   cache
   * @param {function} getSelectedRows
   * @param {function} applyMinDwellFilter
   * @param {function} setFeedback
   */
  function onExportCsv(cache, getSelectedRows, applyMinDwellFilter, setFeedback) {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code) {
      setFeedback('Selecione uma reunião para exportar.', true);
      return;
    }

    const rows        = buildExportRows(cache, getSelectedRows, applyMinDwellFilter);
    const meetingDate = new Date().toLocaleDateString('pt-BR');

    // Grupo 1: com e-mail (deduplicado por e-mail, maior tempo vence)
    const withEmail = rows.filter((r) => r.email);
    const byEmail   = {};
    for (const row of withEmail) {
      const key = row.email.toLowerCase().trim();
      if (!byEmail[key] || row.tempoSeg > byEmail[key].tempoSeg) byEmail[key] = row;
    }
    const emailRows = Object.values(byEmail);

    // Grupo 2: sem e-mail (deduplicado por nome normalizado)
    const withoutEmail = rows.filter((r) => !r.email);
    const byName       = {};
    for (const row of withoutEmail) {
      const key = U.normalizeName(row.nome);
      if (!byName[key] || row.tempoSeg > byName[key].tempoSeg) byName[key] = row;
    }
    const noEmailRows = Object.values(byName);

    const header      = 'Nome;E-mail;Data';
    const emailLines  = emailRows.map((r) => [r.nome, r.email, meetingDate].map(csvEscape).join(';'));
    const noEmailLines = noEmailRows.map((r) => [r.nome, '', meetingDate].map(csvEscape).join(';'));

    // BOM UTF-8 para compatibilidade com Excel
    const csv      = '\uFEFF' + [header, ...emailLines, ...noEmailLines].join('\n');
    const filename = `presenca_${meeting.code}_${nowFilenameStamp()}.csv`;
    downloadBlob(csv, 'text/csv;charset=utf-8', filename);

    // Feedback
    const dupRemoved = (withEmail.length - emailRows.length) + (withoutEmail.length - noEmailRows.length);
    let msg = `CSV exportado: ${emailRows.length} com e-mail`;

    if (noEmailRows.length > 0) {
      const preview = noEmailRows.slice(0, 5).map((r) => r.nome).join(', ');
      const extra   = noEmailRows.length > 5 ? ` +${noEmailRows.length - 5}` : '';
      msg += `, ${noEmailRows.length} sem e-mail (${preview}${extra})`;
    }
    if (dupRemoved > 0) msg += `. ${dupRemoved} duplicata(s) removida(s)`;

    setFeedback(msg + '.');
  }

  // ---------------------------------------------------------------------------
  // Exportação JSON
  // ---------------------------------------------------------------------------

  /**
   * Exporta os dados completos da reunião como JSON.
   *
   * @param {object}   cache
   * @param {function} getSelectedRows
   * @param {function} applyMinDwellFilter
   * @param {function} setFeedback
   */
  function onExportJson(cache, getSelectedRows, applyMinDwellFilter, setFeedback) {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code) {
      setFeedback('Selecione uma reunião para exportar.', true);
      return;
    }

    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows, cache);

    const payload = {
      reuniao:        meeting.code,
      dataExportacao: new Date().toLocaleDateString('pt-BR'),
      participantes:  rows.map((r) => ({
        nome:            r.name,
        email:           r.email || '',
        primeiraEntrada: U.formatDateTimeBR(r.firstSeenAt),
        ultimaSaida:     U.formatDateTimeBR(r.lastSeenAt),
        tempoPermanencia: U.formatDurationLong(r.totalSeconds)
      }))
    };

    const filename = `presenca_${meeting.code}_${nowFilenameStamp()}.json`;
    downloadBlob(JSON.stringify(payload, null, 2), 'application/json;charset=utf-8', filename);
    setFeedback('JSON exportado com sucesso.');
  }

  global.MP_PopupExport = {
    csvEscape,
    downloadBlob,
    nowFilenameStamp,
    buildExportRows,
    onExportCsv,
    onExportJson
  };
})(window);
