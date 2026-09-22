/**
 * @file popup/modules/render.js
 * @description Funções de renderização da UI do popup.
 *
 * ## Responsabilidade
 *   - renderStatusLine(els, cache)         — atualiza linha de status no topo
 *   - renderMeetingSelect(els, cache)      — popula dropdown de reuniões
 *   - renderRosterSelect(els, cache)       — popula dropdown de arquivos de turma
 *   - renderStartInfo(els, cache)          — exibe hora de início da reunião
 *   - renderTable(els, cache, getRows, fn) — renderiza tabela de participantes
 *   - updateFilterInfo(els, cache, getRows, fn) — atualiza contagem de excluídos
 *   - escapeHtml(text)                     — escapa HTML para exibição segura
 *
 * Depende de: window.MPUtils, window.MP_Constants
 * Expõe: window.MP_PopupRender
 */

(function (global) {
  'use strict';

  /** @type {import('../../lib/utils.js').MPUtils} */
  const U = global.MPUtils;

  /** @type {import('../../lib/constants.js').MP_Constants} */
  const C = global.MP_Constants;

  const ACTIVE_STALE_MS = C ? C.ACTIVE_STALE_MS : 15000;

  // ---------------------------------------------------------------------------
  // Utilidade de escape HTML (prevenção de XSS)
  // ---------------------------------------------------------------------------

  /**
   * Escapa caracteres HTML especiais para exibição segura no DOM.
   *
   * @param {*} text
   * @returns {string}
   */
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------------------
  // Render: status line
  // ---------------------------------------------------------------------------

  /**
   * Atualiza a linha de status indicando se há reunião ativa sendo capturada.
   *
   * @param {object} els   - Referências DOM do popup.
   * @param {object} cache - Estado do popup.
   */
  function renderStatusLine(els, cache) {
    const active = cache.active;
    const fresh =
      active &&
      active.code &&
      active.updatedAt &&
      Date.now() - new Date(active.updatedAt).getTime() < ACTIVE_STALE_MS;

    if (fresh) {
      els.statusLine.innerHTML = `<span class="dot">●</span> Capturando — reunião ${active.code}`;
      return;
    }

    if (cache.index.length > 0) {
      els.statusLine.textContent = 'Última reunião: ' + cache.index[0].code;
      return;
    }

    els.statusLine.textContent = 'Sem reunião ativa';
  }

  // ---------------------------------------------------------------------------
  // Render: dropdown de reuniões
  // ---------------------------------------------------------------------------

  /**
   * Formata o label de uma opção no dropdown de reuniões.
   *
   * @param {{ code:string, startedAt:string, participantCount?:number }} item
   * @returns {string}
   */
  function optionLabel(item) {
    const dt = U.formatDateTimeBR(item.startedAt).slice(0, 16);
    return `${item.code} • ${dt} • ${item.participantCount || 0} pessoas`;
  }

  /**
   * Popula o dropdown de reuniões salvas.
   * Seleciona automaticamente a ativa ou a mais recente.
   *
   * @param {object} els
   * @param {object} cache
   */
  function renderMeetingSelect(els, cache) {
    const select = els.meetingSelect;
    select.innerHTML = '';

    if (!cache.index.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nenhuma reunião salva';
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    const preferred =
      cache.selectedCode ||
      (cache.active && cache.active.code) ||
      cache.index[0].code;

    for (const item of cache.index) {
      const opt = document.createElement('option');
      opt.value = item.code;
      opt.textContent = optionLabel(item);
      if (item.code === preferred) opt.selected = true;
      select.appendChild(opt);
    }

    cache.selectedCode = select.value;
  }

  // ---------------------------------------------------------------------------
  // Render: dropdown de arquivos de turma
  // ---------------------------------------------------------------------------

  /**
   * Popula o dropdown de arquivos de turma salvos.
   *
   * @param {object} els
   * @param {object} cache
   */
  function renderRosterSelect(els, cache) {
    const select = els.rosterSelect;
    select.innerHTML = '';

    if (!cache.emailMaps.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nenhum arquivo salvo';
      select.appendChild(opt);
      select.disabled = true;
      cache.activeEmailMapId = null;
      return;
    }

    select.disabled = false;
    const preferredId =
      cache.activeEmailMapId && cache.emailMaps.some((m) => m.id === cache.activeEmailMapId)
        ? cache.activeEmailMapId
        : cache.emailMaps[0].id;

    for (const map of cache.emailMaps) {
      const opt = document.createElement('option');
      opt.value = map.id;
      const count = Array.isArray(map.entries) ? map.entries.length : 0;
      opt.textContent = `${map.name} • ${count} e-mail(s)`;
      if (map.id === preferredId) opt.selected = true;
      select.appendChild(opt);
    }

    cache.activeEmailMapId = select.value;
  }

  // ---------------------------------------------------------------------------
  // Render: informação de início de reunião
  // ---------------------------------------------------------------------------

  /**
   * Exibe a data/hora de início da reunião selecionada.
   *
   * @param {object} els
   * @param {object} cache
   */
  function renderStartInfo(els, cache) {
    if (!cache.selectedMeeting) {
      els.startInfo.textContent = 'Início: -';
      return;
    }
    els.startInfo.textContent = 'Início: ' + U.formatDateTimeBR(cache.selectedMeeting.startedAt);
  }

  // ---------------------------------------------------------------------------
  // Filtro de tempo mínimo
  // ---------------------------------------------------------------------------

  /**
   * Aplica o filtro de tempo mínimo de permanência.
   *
   * @param {object[]} rows  - Linhas já mescladas.
   * @param {object}   cache - Precisa de cache.minDwellMinutes.
   * @returns {{ filtered: object[], excluded: number }}
   */
  function applyMinDwellFilter(rows, cache) {
    const minSeconds = cache.minDwellMinutes * 60;
    if (minSeconds <= 0) return { filtered: rows, excluded: 0 };
    const filtered = rows.filter((r) => r.totalSeconds >= minSeconds);
    return { filtered, excluded: rows.length - filtered.length };
  }

  /**
   * Atualiza o elemento #filterInfo com a contagem de excluídos.
   *
   * @param {object}   els
   * @param {object}   cache
   * @param {function} getSelectedRows - Função que retorna as linhas atuais.
   */
  function updateFilterInfo(els, cache, getSelectedRows) {
    const allRows = getSelectedRows();
    const { excluded } = applyMinDwellFilter(allRows, cache);
    if (cache.minDwellMinutes > 0 && excluded > 0) {
      els.filterInfo.textContent = `(${excluded} excluído${excluded > 1 ? 's' : ''})`;
    } else {
      els.filterInfo.textContent = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Render: tabela de participantes
  // ---------------------------------------------------------------------------

  /**
   * Renderiza a tabela de participantes.
   * Ordena por tempo decrescente e aplica o filtro de permanência mínima.
   *
   * @param {object}   els
   * @param {object}   cache
   * @param {function} getSelectedRows  - Retorna as linhas atuais (enriquecidas + mescladas).
   */
  function renderTable(els, cache, getSelectedRows) {
    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows, cache);
    const tbody = els.participantsBody;
    tbody.innerHTML = '';

    updateFilterInfo(els, cache, getSelectedRows);

    if (!rows.length) {
      if (allRows.length > 0 && cache.minDwellMinutes > 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhum participante atende ao tempo mínimo configurado.</td></tr>';
      } else {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhum participante capturado nesta reunião.</td></tr>';
      }
      return;
    }

    for (const row of rows) {
      const tr = document.createElement('tr');
      const emailDisplay = row.email
        ? escapeHtml(row.email)
        : '<span class="email-empty" title="E-mail não exposto pelo Meet — importe uma lista Nome;E-mail">—</span>';

      tr.innerHTML = `
        <td>${escapeHtml(row.name || '(sem nome)')}</td>
        <td>${emailDisplay}</td>
        <td>${escapeHtml(U.formatDurationLong(row.totalSeconds))}</td>
        <td>${row.sessions}</td>
        <td>${row.present
          ? '<span class="status-pill"><span class="dot">●</span>Presente</span>'
          : 'Saiu'}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  global.MP_PopupRender = {
    escapeHtml,
    renderStatusLine,
    renderMeetingSelect,
    renderRosterSelect,
    renderStartInfo,
    applyMinDwellFilter,
    updateFilterInfo,
    renderTable
  };
})(window);
