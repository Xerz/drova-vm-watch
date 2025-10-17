// content.js — Drova sessions → Tabulator (filters, pagination, CSV)
(() => {
  // Впрыск в главный контекст страницы
  const inject = (fn) => {
    const s = document.createElement('script');
    s.textContent = '(' + fn.toString() + ')();';
    (document.documentElement || document.head).appendChild(s);
    s.remove();
  };

  inject(function main() {
    'use strict';

    const SECTION_TITLE_RE = /Играли на ваших станциях/i;
    const API_RE = /https?:\/\/services\.drova\.io\/session-manager\/sessions(?:\?|$)/i;

    // --- CDN загрузчик ---
    function loadCSS(href) {
      return new Promise((res, rej) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = href;
        l.onload = () => res(); l.onerror = rej;
        document.head.appendChild(l);
      });
    }
    function loadJS(src) {
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => res(); s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    // --- DOM helpers ---
    function isHeaderRow(el) {
      if (!el || el.nodeType !== 1) return false;
      if (!el.classList.contains('ivu-row') || !el.classList.contains('ivu-row-flex')) return false;
      const acc = el.querySelector(':scope > .account-header h4');
      return !!acc && SECTION_TITLE_RE.test(acc.textContent || '');
    }
    function findSectionHeaderRow(root = document) {
      const rows = Array.from(root.querySelectorAll('div.ivu-row.ivu-row-flex'));
      return rows.find(isHeaderRow) || null;
    }
    function hideOriginalSection(headerRow) {
      let node = headerRow?.nextElementSibling;
      while (node) {
        if (isHeaderRow(node)) break;
        if (node.classList.contains('ivu-row') && node.classList.contains('ivu-row-flex')) {
          node.style.display = 'none';
        }
        node = node.nextElementSibling;
      }
    }
    function ensureWrapper(headerRow) {
      let wrapper = headerRow?.nextElementSibling;
      if (wrapper && wrapper.classList.contains('drova-sessions-table-wrapper')) return wrapper;
      wrapper = document.createElement('div');
      wrapper.className = 'drova-sessions-table-wrapper';
      headerRow.after(wrapper);
      return wrapper;
    }

    // Немного базовых стилей
    const baseCss = document.createElement('style');
    baseCss.textContent = `
      .drova-toolbar{display:flex;gap:8px;align-items:center;margin:8px 0 6px 0;flex-wrap:wrap}
      .drova-toolbar button{padding:6px 10px;border:1px solid rgba(0,0,0,.15);border-radius:6px;background:#f7f7f7;cursor:pointer}
      .drova-sessions-table-wrapper{margin-top:8px}
    `;
    document.head.appendChild(baseCss);

    let lastSessions = null;
    let table = null; // Tabulator instance

    // Собираем список колонок из JSON
    function collectColumns(rows) {
      const set = new Set();
      rows.forEach(r => Object.keys(r||{}).forEach(k => set.add(k)));
      const preferred = ['uuid','client_id','server_id','merchant_id','product_id','created_on','finished_on','creator_ip','abort_comment','billing_type','status'];
      const rest = Array.from(set).filter(k => !preferred.includes(k)).sort();
      const keys = preferred.filter(k => set.has(k)).concat(rest);
      // На каждую колонку — фильтр в заголовке
      return keys.map(k => ({
        title: k,
        field: k,
        headerFilter: 'input',
        headerFilterPlaceholder: 'фильтр…',
        // без форматирования: просто строка/число/JSON
        formatter: (cell) => {
          const v = cell.getValue();
          return (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
      }));
    }

    // Рендер Tabulator
    async function renderTabulator(sessions) {
      const headerRow = findSectionHeaderRow();
      if (!headerRow) return; // подождём секцию
      hideOriginalSection(headerRow);
      const wrapper = ensureWrapper(headerRow);

      // Грузим Tabulator с CDN (CSS + JS)
      if (!window.Tabulator) {
        await loadCSS('https://cdn.jsdelivr.net/npm/tabulator-tables/dist/css/tabulator.min.css');
        await loadJS('https://cdn.jsdelivr.net/npm/tabulator-tables/dist/js/tabulator.min.js');
      }

      // Toolbar
      let toolbar = wrapper.querySelector('.drova-toolbar');
      if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.className = 'drova-toolbar';
        toolbar.innerHTML = `
          <button data-act="csv">Export CSV</button>
          <button data-act="clear">Clear filters</button>
          <span style="opacity:.7;font-size:12px">Tabulator: фильтры в шапке таблицы</span>
        `;
        wrapper.appendChild(toolbar);
        toolbar.addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-act]'); if (!btn) return;
          if (btn.dataset.act === 'csv') table?.download('csv', 'drova-sessions.csv');
          if (btn.dataset.act === 'clear') table?.clearHeaderFilter();
        });
      }

      // Контейнер таблицы
      let holder = wrapper.querySelector('#drova-tabulator');
      if (!holder) {
        holder = document.createElement('div');
        holder.id = 'drova-tabulator';
        holder.style.minHeight = '240px';
        wrapper.appendChild(holder);
      }

      const columns = collectColumns(sessions);

      if (!table) {
        table = new window.Tabulator(holder, {
          data: sessions,
          columns,
          layout: "fitDataStretch",
          height: "500px",
          pagination: true,
          paginationMode: "local",
          paginationSize: 25,
          movableColumns: true,
          selectable: false,
          index: "uuid",        // если есть
          reactiveData: false,  // мы обновляем данными целиком
          initialSort: [{column: "created_on", dir: "desc"}],
        });
      } else {
        // Обновляем колонки, если структура изменилась
        const currentCols = table.getColumns().map(c => c.getField());
        const wantCols = columns.map(c => c.field);
        const same = currentCols.length === wantCols.length && currentCols.every((f,i)=>f===wantCols[i]);
        if (!same) {
          table.setColumns(columns); // перерисует заголовок с фильтрами
        }
        table.replaceData(sessions);
      }
    }

    function tryRenderSoon() {
      if (!lastSessions) return;
      // ждём появления секции; пробуем несколько раз
      let attempts = 0;
      const tick = () => {
        attempts++;
        if (findSectionHeaderRow()) { renderTabulator(lastSessions); }
        else if (attempts < 40) setTimeout(tick, 150);
      };
      tick();
    }

    // === Перехват API (fetch + XHR) ===
    const origFetch = window.fetch;
    window.fetch = async function patchedFetch(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || '';
        if (API_RE.test(url)) {
          const clone = res.clone();
          const ct = (clone.headers.get('content-type') || '').toLowerCase();
          let json;
          if (ct.includes('application/json')) json = await clone.json();
          else { const t = await clone.text(); try { json = JSON.parse(t); } catch {} }
          if (Array.isArray(json?.sessions)) {
            lastSessions = json.sessions;
            tryRenderSoon();
          }
        }
      } catch {}
      return res;
    };

    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function PatchedXHR() {
      const xhr = new OrigXHR();
      let _url = '';
      const _open = xhr.open;
      xhr.open = function (method, url) { _url = url; return _open.apply(this, arguments); };
      xhr.addEventListener('load', function () {
        try {
          if (!API_RE.test(_url)) return;
          const ct = (xhr.getResponseHeader('content-type') || '').toLowerCase();
          if (ct.includes('application/json')) {
            const json = JSON.parse(xhr.responseText);
            if (Array.isArray(json?.sessions)) {
              lastSessions = json.sessions;
              tryRenderSoon();
            }
          }
        } catch {}
      });
      return xhr;
    };

    // Первый заход: если секция уже есть и данные подгружались раньше
    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', tryRenderSoon, { once: true })
      : tryRenderSoon();
  });
})();
