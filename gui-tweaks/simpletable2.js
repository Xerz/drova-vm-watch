// content.js — Tabulator (cdnjs 6.3.1) + server/product names + *_human + Human-only toggle
(() => {
  const inject = (fn) => {
    const s = document.createElement('script');
    s.textContent = '(' + fn.toString() + ')();';
    (document.documentElement || document.head).appendChild(s);
    s.remove();
  };

  inject(function main() {
    'use strict';

    // ---- CONFIG ----
    const TITLE_TEXT = /Играли на ваших станциях/i;
    const SESSIONS_RE = /\/session-manager\/sessions(?:\?|$)/i;
    const NAMES_RE    = /\/server-manager\/servers\/server_names(?:\?|$)/i;
    const PRODUCTS_RE = /\/product-manager\/product\/listfull2(?:\?|$)/i;
    const HIDDEN_ATTR = 'data-ds-hidden-original';

    const CDNJS = {
      css: 'https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.3.1/css/tabulator.min.css',
      js:  'https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.3.1/js/tabulator.min.js',
      name: 'cdnjs@6.3.1'
    };

    // Какие столбцы показывать в «human-only» режиме
    const HUMAN_COLUMNS = [
      'server_name','product_name',
      'created_on_human','finished_on_human','duration_human',
      'creator_ip','billing_type',
      'score','score_reason','score_text'
    ];

    // ---- STATE ----
    let rawSessions = null;
    let serverNames = {};
    let productsById = {};
    let lastSig = '';
    let renderTimer = null;
    let MUTATE_LOCK = 0;
    let tableInstance = null;
    let hiddenNodesCache = [];
    let humanOnly = false; // <— режим показа

    // ---- STATUS PILL ----
    const pill = document.createElement('div');
    pill.id = 'ds-pill';
    const pillCSS = document.createElement('style');
    pillCSS.textContent = `
      #ds-pill{position:fixed;right:8px;bottom:8px;z-index:999999;background:rgba(0,0,0,.75);
        color:#fff;font:12px/1.2 system-ui,Arial,sans-serif;padding:6px 8px;border-radius:8px}
      .ds-wrap{margin-top:8px}
      .ds-toolbar{display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap}
      .ds-toolbar button{padding:6px 10px;border:1px solid rgba(0,0,0,.15);border-radius:6px;background:#f7f7f7;cursor:pointer}
      .ds-native{width:100%;border-collapse:collapse;table-layout:auto}
      .ds-native th,.ds-native td{border:1px solid rgba(0,0,0,.12);padding:6px 8px;font-size:12px;vertical-align:top;word-break:break-word}
      .ds-native thead th{position:sticky;top:0;background:#fff}
    `;
    withLock(() => {
      (document.head || document.documentElement).appendChild(pillCSS);
      (document.body || document.documentElement).appendChild(pill);
    });
    const setPill = (msg) => withLock(() => pill.textContent = 'DS: ' + msg);

    // ---- HELPERS ----
    function withLock(fn) { MUTATE_LOCK++; try { return fn(); } finally { MUTATE_LOCK--; } }

    function tsToHuman(ts) {
      if (ts == null) return '';
      const d = new Date(Number(ts));
      if (isNaN(d.getTime())) return '';
      const Y = d.getFullYear();
      const M = String(d.getMonth()+1).padStart(2,'0');
      const D = String(d.getDate()).padStart(2,'0');
      const h = String(d.getHours()).padStart(2,'0');
      const m = String(d.getMinutes()).padStart(2,'0');
      const s = String(d.getSeconds()).padStart(2,'0');
      return `${Y}-${M}-${D} ${h}:${m}:${s}`;
    }
    function msToHumanDuration(ms) {
      if (!(ms > 0)) return '';
      let sec = Math.floor(ms / 1000);
      const h = Math.floor(sec / 3600); sec -= h*3600;
      const m = Math.floor(sec / 60);   const s = sec - m*60;
      return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
                   : `${m}:${String(s).padStart(2,'0')}`;
    }

    function findSectionHeaderRow(root=document) {
      const headings = Array.from(root.querySelectorAll('h2,h3,h4'));
      const h = headings.find(el => TITLE_TEXT.test(el.textContent || ''));
      if (!h) return null;
      return h.closest('.ivu-row.ivu-row-flex') || h.parentElement;
    }
    function isHeaderRow(el) {
      if (!el) return false;
      const head = el.querySelector(':scope h2, :scope h3, :scope h4');
      return !!head && TITLE_TEXT.test(head.textContent || '');
    }
    function ensureWrap(headerRow) {
      if (!headerRow) return null;
      let wrap = headerRow.nextElementSibling;
      if (wrap?.classList?.contains('ds-wrap')) return wrap;
      withLock(() => {
        wrap = document.createElement('div');
        wrap.className = 'ds-wrap';
        headerRow.after(wrap);
      });
      return wrap;
    }
    function hideOriginalAfter(headerRow) {
      if (!headerRow) return;
      let node = headerRow.nextElementSibling;
      const toHide = [];
      while (node) {
        if (isHeaderRow(node)) break;
        if (node.classList?.contains('ds-wrap')) { node = node.nextElementSibling; continue; }
        if (node.nodeType === 1) toHide.push(node);
        node = node.nextElementSibling;
      }
      withLock(() => {
        toHide.forEach(n => {
          if (!n.hasAttribute(HIDDEN_ATTR)) {
            n.setAttribute(HIDDEN_ATTR, '1');
            if (n.style.display !== 'none') n.style.display = 'none';
            hiddenNodesCache.push(n);
          }
        });
      });
    }

    function loadCSS(href) {
      return new Promise((res, rej) => {
        const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
        l.onload = res; l.onerror = rej; document.head.appendChild(l);
      });
    }
    function loadJS(src) {
      return new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = src; s.async = true;
        s.onload = res; s.onerror = rej; document.head.appendChild(s);
      });
    }
    async function ensureTabulator() {
      if (window.Tabulator) return { ok: true, where: 'present' };
      try {
        setPill(`load ${CDNJS.name}: css`); await loadCSS(CDNJS.css);
        setPill(`load ${CDNJS.name}: js`);  await loadJS(CDNJS.js);
      } catch (e) { return { ok:false, reason:e?.message||'load error' }; }
      return window.Tabulator ? { ok:true, where:CDNJS.name } : { ok:false, reason:'no window.Tabulator' };
    }

    // Список всех возможных колонок (кроме merchant_id); порядок «разумный»
    function getAllColumns(rows) {
      const set = new Set();
      rows.forEach(r => Object.keys(r || {}).forEach(k => set.add(k)));
      set.delete('merchant_id');
      const preferred = [
        'uuid','status',
        'client_id',
        'server_id','server_name',
        'product_id','product_name','useDefaultDesktop',
        'created_on','created_on_human',
        'finished_on','finished_on_human',
        'duration_human',
        'creator_ip',
        'score','score_reason','score_text',
        'abort_comment',
        'billing_type'
      ];
      const rest = Array.from(set).filter(k => !preferred.includes(k)).sort();
      return preferred.filter(k => set.has(k)).concat(rest);
    }

    // Итоговый список колонок с учётом humanOnly
    function getColumns(rows) {
      const set = new Set();
      rows.forEach(r => Object.keys(r || {}).forEach(k => set.add(k)));
      if (humanOnly) {
        return HUMAN_COLUMNS.filter(k => set.has(k));
      }
      return getAllColumns(rows);
    }

    // подпись данных: учитываем режим humanOnly, чтобы ререндерить при переключении
    function mapSig(obj) {
      const keys = Object.keys(obj || {}).sort();
      let h = 0 >>> 0;
      for (let i = 0; i < keys.length; i += Math.max(1, Math.ceil(keys.length/50))) {
        const k = keys[i], v = obj[k];
        const s = k + '|' + (typeof v === 'string' ? v : JSON.stringify(v)?.slice(0,64));
        for (let j=0;j<s.length;j++) h = ((h*31) + s.charCodeAt(j)) >>> 0;
      }
      return keys.length + ':' + h.toString(16);
    }
    function sessionsSig(rows) {
      if (!Array.isArray(rows)) return '0';
      const n = rows.length; let h = 0 >>> 0;
      const step = Math.max(1, Math.ceil(n/20));
      for (let i=0;i<n;i+=step) {
        const s = rows[i] || {};
        const key = (s.uuid||'') + '|' + (s.created_on||'') + '|' + (s.finished_on||'') + '|' + (s.status||'');
        for (let j=0;j<key.length;j++) h = ((h*31) + key.charCodeAt(j)) >>> 0;
      }
      return n + ':' + h.toString(16);
    }
    function fullSig() {
      return [ sessionsSig(rawSessions||[]), mapSig(serverNames), mapSig(productsById), humanOnly ? 'H:1' : 'H:0' ].join('~');
    }

    // обогащаем строки
    function buildAugmentedRows() {
      const src = Array.isArray(rawSessions) ? rawSessions : [];
      return src.map(s => {
        const p = productsById[s.product_id] || null;
        const created_on_human  = tsToHuman(s.created_on);
        const finished_on_human = tsToHuman(s.finished_on);
        const duration_human    = (s.created_on != null && s.finished_on != null)
          ? msToHumanDuration(Number(s.finished_on) - Number(s.created_on))
          : '';
        const obj = {
          ...s,
          server_name: serverNames[s.server_id] || '',
          product_name: p?.title || '',
          useDefaultDesktop: (p?.useDefaultDesktop ?? null),
          created_on_human,
          finished_on_human,
          duration_human,
        };
        delete obj.merchant_id;
        return obj;
      });
    }

    // ---- RENDER ----
    async function renderTable() {
      const sig = fullSig();
      if (sig === lastSig) { setPill('no changes'); return; }
      lastSig = sig;
      if (!rawSessions) { setPill('waiting sessions'); return; }

      const sessions = buildAugmentedRows();

      const headerRow = findSectionHeaderRow();
      if (!headerRow) { setPill('waiting header'); return; }
      const wrap = ensureWrap(headerRow);
      hideOriginalAfter(headerRow);

      // toolbar
      let toolbar = wrap.querySelector('.ds-toolbar');
      if (!toolbar) {
        withLock(() => {
          toolbar = document.createElement('div');
          toolbar.className = 'ds-toolbar';
          toolbar.innerHTML = `
            <button data-act="toggle-human">Human columns: Off</button>
            <button data-act="csv">Export CSV</button>
            <button data-act="clear">Clear filters</button>
            <span style="opacity:.7;font-size:12px">${CDNJS.name} (если CSP не пустит — нативная таблица)</span>
          `;
          wrap.prepend(toolbar);
          toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]'); if (!btn) return;
            if (btn.dataset.act === 'toggle-human') {
              humanOnly = !humanOnly;
              updateHumanButton(toolbar);
              // сбросим сигнатуру, чтобы форснуть рендер с новыми колонками
              lastSig = '';
              scheduleRender(0);
            }
            if (btn.dataset.act === 'csv') {
              if (tableInstance?.download) tableInstance.download('csv', 'drova-sessions.csv');
              else downloadCSVNative(sessions);
            }
            if (btn.dataset.act === 'clear') tableInstance?.clearHeaderFilter?.();
          });
        });
      } else {
        updateHumanButton(toolbar);
      }

      // holder
      let holder = wrap.querySelector('#ds-holder');
      if (!holder) {
        withLock(() => {
          holder = document.createElement('div');
          holder.id = 'ds-holder';
          holder.style.minHeight = '320px';
          wrap.appendChild(holder);
        });
      }

      // Tabulator
      const diag = await ensureTabulator();
      window.__DS_TABULATOR_DIAG__ = diag;
      const cols = getColumns(sessions);
      if (diag.ok) {
        const tabCols = cols.map(k => ({
          title: k, field: k,
          headerFilter: 'input',
          headerFilterPlaceholder: 'фильтр…',
          formatter: (cell) => {
            const v = cell.getValue();
            return (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
          }
        }));
        if (!tableInstance) {
          withLock(() => {
            tableInstance = new window.Tabulator(holder, {
              data: sessions,
              columns: tabCols,
              layout: "fitDataStretch",
              height: "520px",
              pagination: true,
              paginationSize: 25,
              movableColumns: true,
              selectable: false,
              initialSort: [{ column: "created_on", dir: "desc" }],
            });
          });
        } else {
          const current = tableInstance.getColumns().map(c => c.getField());
          const want = tabCols.map(c => c.field);
          const sameCols = current.length === want.length && current.every((f,i)=>f===want[i]);
          withLock(() => {
            if (!sameCols) tableInstance.setColumns(tabCols);
            tableInstance.replaceData(sessions);
          });
        }
        setPill(`Tabulator: ${sessions.length} rows${humanOnly ? ' (Human)' : ''}`);
        return;
      }

      // fallback: native
      setPill(`native table${humanOnly ? ' (Human)' : ''}${diag.reason ? ' — '+diag.reason : ''}`);
      renderNativeTable(holder, sessions, cols);
    }

    function updateHumanButton(toolbar) {
      const btn = toolbar.querySelector('button[data-act="toggle-human"]');
      if (btn) btn.textContent = `Human columns: ${humanOnly ? 'On' : 'Off'}`;
    }

    function renderNativeTable(holder, sessions, cols) {
      let table = holder.querySelector('table.ds-native');
      if (!table) {
        withLock(() => {
          table = document.createElement('table');
          table.className = 'ds-native';
          const thead = document.createElement('thead');
          const trh = document.createElement('tr');
          cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; trh.appendChild(th); });
          thead.appendChild(trh);
          const tbody = document.createElement('tbody');
          table.appendChild(thead); table.appendChild(tbody);
          holder.innerHTML = ''; holder.appendChild(table);
        });
      } else {
        const currentCols = Array.from(table.tHead.rows[0].cells).map(th => th.textContent);
        const needCols = cols.join('|'), haveCols = currentCols.join('|');
        if (needCols !== haveCols) {
          withLock(() => {
            const trh = document.createElement('tr');
            cols.forEach(c => { const th = document.createElement('th'); th.textContent = c; trh.appendChild(th); });
            table.tHead.replaceChildren(trh);
          });
        }
      }
      const tbody = holder.querySelector('table.ds-native tbody');
      const frag = document.createDocumentFragment();
      for (const row of sessions) {
        const tr = document.createElement('tr');
        for (const c of cols) {
          const td = document.createElement('td');
          const v = row?.[c];
          td.textContent = (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
          tr.appendChild(td);
        }
        frag.appendChild(tr);
      }
      withLock(() => { tbody.replaceChildren(frag); });
    }

    function downloadCSVNative(rows) {
      const cols = getColumns(rows);
      const esc = (x) => {
        const s = (x == null) ? '' : String(x);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      };
      const csv = [cols.map(esc).join(',')].concat(
        rows.map(r => cols.map(c => {
          const v = r?.[c];
          return esc(typeof v === 'object' ? JSON.stringify(v) : v);
        }).join(','))
      ).join('\n');
      const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'drova-sessions.csv';
      a.click(); URL.revokeObjectURL(a.href);
    }

    // ---- API HOOKS ----
    const origFetch = window.fetch;
    window.fetch = async function patchedFetch(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const handle = async (clone) => {
          const ct = (clone.headers.get('content-type') || '').toLowerCase();
          let json;
          if (ct.includes('application/json')) json = await clone.json();
          else { const t = await clone.text(); try { json = JSON.parse(t); } catch {} }
          return json;
        };

        if (SESSIONS_RE.test(url)) {
          const json = await handle(res.clone());
          if (Array.isArray(json?.sessions)) {
            rawSessions = json.sessions;
            setPill(`sessions:${rawSessions.length}`);
            scheduleRender(60);
          }
        } else if (NAMES_RE.test(url)) {
          const json = await handle(res.clone());
          if (json && typeof json === 'object' && !Array.isArray(json)) {
            serverNames = { ...serverNames, ...json };
            setPill(`server_names:${Object.keys(serverNames).length}`);
            scheduleRender(40);
          }
        } else if (PRODUCTS_RE.test(url)) {
          const json = await handle(res.clone());
          let list = [];
          if (Array.isArray(json)) list = json;
          else if (Array.isArray(json?.list)) list = json.list;
          if (list.length) {
            for (const p of list) {
              const id = p.productId || p.id || p.uuid;
              if (id) productsById[id] = p;
            }
            setPill(`products:${Object.keys(productsById).length}`);
            scheduleRender(40);
          }
        }
      } catch(_) {}
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
          const ct = (xhr.getResponseHeader('content-type') || '').toLowerCase();
          if (!ct.includes('application/json')) return;

          if (SESSIONS_RE.test(_url)) {
            const json = JSON.parse(xhr.responseText);
            if (Array.isArray(json?.sessions)) {
              rawSessions = json.sessions;
              setPill(`sessions:${rawSessions.length}`);
              scheduleRender(60);
            }
          } else if (NAMES_RE.test(_url)) {
            const json = JSON.parse(xhr.responseText);
            if (json && typeof json === 'object' && !Array.isArray(json)) {
              serverNames = { ...serverNames, ...json };
              setPill(`server_names:${Object.keys(serverNames).length}`);
              scheduleRender(40);
            }
          } else if (PRODUCTS_RE.test(_url)) {
            const json = JSON.parse(xhr.responseText);
            let list = [];
            if (Array.isArray(json)) list = json;
            else if (Array.isArray(json?.list)) list = json.list;
            if (list.length) {
              for (const p of list) {
                const id = p.productId || p.id || p.uuid;
                if (id) productsById[id] = p;
              }
              setPill(`products:${Object.keys(productsById).length}`);
              scheduleRender(40);
            }
          }
        } catch(_) {}
      });
      return xhr;
    };

    // ---- OBSERVER ----
    const observer = new MutationObserver((muts) => {
      if (MUTATE_LOCK > 0) return;
      const wrap = document.querySelector('.ds-wrap');
      const onlyOurs = muts.every(m => {
        const t = m.target;
        if (!(t instanceof Node)) return false;
        if (pill.contains(t)) return true;
        if (wrap && wrap.contains(t)) return true;
        if (t.nodeType === 1 && t.hasAttribute && t.hasAttribute(HIDDEN_ATTR)) return true;
        return false;
      });
      if (onlyOurs) return;
      scheduleRender(150);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    function scheduleRender(delay=80) {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => renderTable(), delay);
    }

    // initial
    setPill('ready');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => scheduleRender(200), { once: true });
    } else {
      scheduleRender(200);
    }
  });
})();
