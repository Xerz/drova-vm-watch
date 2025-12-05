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


        // работаем только на странице /my-account
        if (!/^\/my-account(?:\/|$)/.test(location.pathname)) return;


        // ---- CONFIG ----
        const TITLE_TEXT = /Играли на ваших станциях/i;
        const SESSIONS_RE = /\/session-manager\/sessions(?:\?|$)/i;
        const NAMES_RE = /\/server-manager\/servers\/server_names(?:\?|$)/i;
        const PRODUCTS_RE = /\/product-manager\/product\/listfull2(?:\?|$)/i;
        const HIDDEN_ATTR = 'data-ds-hidden-original';

        const CDNJS = {
            css: 'https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.3.1/css/tabulator.min.css',
            js: 'https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.3.1/js/tabulator.min.js',
            name: 'cdnjs@6.3.1'
        };


        // GeoIP база для сопоставления IP → город
        const CITY_DB_URL = 'https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-City.mmdb';
        const ASN_DB_URL = 'https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-ASN.mmdb';

        // Какие столбцы показывать в «human-only» режиме
        const HUMAN_COLUMNS = ['client_id', 'creator_ip', 'city', 'isp', 'product_name', 'server_name', 'created_on_human', 'duration_human', 'billing_type', 'finished_on_human', 'score', 'score_text',];

        // ---- STATE ----
        let rawSessions = null;
        let serverNames = {};
        let productsById = {};
        let lastSig = '';
        let renderTimer = null;
        let MUTATE_LOCK = 0;
        let tableInstance = null;
        let hiddenNodesCache = [];
        let humanOnly = true; // <— режим показа

        let lastSessionsReq = null;    // { url, init }
        let lastServerNamesReq = null; // { url, init }
        let lastProductsReq = null;    // { url, init }


        // GeoIP (город по IP)
        let cityDbReader = null;          // инстанс ридера mmdb (City)
        let cityDbLoading = null;         // промис загрузки, чтобы не гонять параллельно
        const cityCache = Object.create(null); // ip → city (строка)

        // ASN база для сопоставления IP → ISP/AS
        let asnDbReader = null;           // инстанс ридера mmdb (ASN)
        let asnDbLoading = null;          // промис загрузки
        const ispCache = Object.create(null);  // ip → isp (строка)

        // ---- STATUS PILL ----
        const pill = document.createElement('div');
        pill.id = 'ds-pill';
        const pillCSS = document.createElement('style');
        pillCSS.textContent = `
      /* debug pill */
      #ds-pill{
        position:fixed;right:8px;bottom:8px;z-index:999999;
        background:#0b0c0f;color:#e5e7eb;
        font:12px/1.2 system-ui,Arial,sans-serif;
        padding:6px 8px;border-radius:8px;
        box-shadow:0 4px 18px rgba(0,0,0,.4); border:1px solid #1f2937;
      }

      /* our wrapper */
      .ds-wrap{
        margin-top:8px;
        background:#0f1115;
        color:#e5e7eb;
        border:1px solid #1f2937;
        border-radius:10px;
        padding:8px;
      }

      /* toolbar */
      .ds-toolbar{
        display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap
      }
      .ds-toolbar button{
        padding:6px 10px;border-radius:8px;
        background:#111827;color:#e5e7eb;
        border:1px solid #374151; cursor:pointer;
        transition:background .15s ease,border-color .15s ease,transform .02s ease;
      }
      .ds-toolbar button:hover{ background:#0b1220; border-color:#4b5563; }
      .ds-toolbar button:active{ transform:translateY(1px); }
      .ds-toolbar span{ color:#9ca3af; }

      /* fallback native table (dark) */
      .ds-native{
        width:100%; border-collapse:collapse; table-layout:auto;
        background:#0f1115; color:#e5e7eb;
      }
      .ds-native th,.ds-native td{
        border:1px solid #1f2430; padding:6px 8px; font-size:12px;
        vertical-align:top; word-break:break-word;
      }
      .ds-native thead th{
        position:sticky; top:0; background:#111317; color:#e5e7eb;
        border-bottom:1px solid #2a2f3a; z-index:1;
      }
      .ds-native tbody tr:nth-child(even){ background:#0d0f13; }
      .ds-native tbody tr:hover{ background:#1a1f2a; }
    `;
        const dsTabDark = document.createElement('style');
        dsTabDark.textContent = `
      /* Tabulator dark overrides (scoped to our wrapper) */
      .ds-wrap .tabulator{
        background:#0f1115; color:#e5e7eb; border:1px solid #1f2937; border-radius:8px;
      }

      /* Шапка и ячейки шапки */
      .ds-wrap .tabulator .tabulator-header{
        background:#111317 !important;
        border-bottom:1px solid #2a2f3a !important;
      }
      .ds-wrap .tabulator .tabulator-header .tabulator-col{
        background:#111317 !important;
        border-right:1px solid #1f2430 !important;
      }
      .ds-wrap .tabulator .tabulator-header .tabulator-col .tabulator-col-content{
        background:#111317 !important;
      }
      .ds-wrap .tabulator .tabulator-col-title,
      .ds-wrap .tabulator .tabulator-col-title-holder{
        color:#e5e7eb !important;
      }

      /* Ховер по заголовкам */
      .ds-wrap .tabulator .tabulator-header .tabulator-col:hover{
        background:#0f141f !important;
      }

      /* Фильтры в шапке */
      .ds-wrap .tabulator .tabulator-header-filter input,
      .ds-wrap .tabulator .tabulator-header-filter select{
        background:#0b0d11 !important; color:#e5e7eb !important;
        border:1px solid #374151 !important; border-radius:6px; padding:4px 6px;
      }

      /* Тело */
      .ds-wrap .tabulator .tabulator-tableholder{ background:#0f1115; }
      .ds-wrap .tabulator .tabulator-row{
        background:#111317; border-bottom:1px solid #1f2430;
      }
      .ds-wrap .tabulator .tabulator-row:nth-child(even){ background:#0d0f13; }
      .ds-wrap .tabulator .tabulator-row:hover{ background:#1a1f2a; }
      .ds-wrap .tabulator .tabulator-cell{
        border-right:1px solid #1f2430; color:#e5e7eb;
      }

      /* Футер/пагинация */
      .ds-wrap .tabulator .tabulator-footer{
        background:#0f1115; color:#d1d5db; border-top:1px solid #2a2f3a;
      }
      .ds-wrap .tabulator .tabulator-paginator{ color:#d1d5db; }
      .ds-wrap .tabulator .tabulator-page{
        background:#111827; color:#e5e7eb; border:1px solid #374151; border-radius:6px;
      }
      .ds-wrap .tabulator .tabulator-page:hover{ background:#0b1220; border-color:#4b5563; }
      .ds-wrap .tabulator .tabulator-page.active{ background:#1f2937; border-color:#4b5563; }

    `;
        (document.head || document.documentElement).appendChild(dsTabDark);

        withLock(() => {
            (document.head || document.documentElement).appendChild(pillCSS);
            (document.body || document.documentElement).appendChild(pill);
        });
        const setPill = (msg) => withLock(() => pill.textContent = 'DS: ' + msg);

        // ---- HELPERS ----
        // форсим limit=1000 для sessions
        function rewriteSessionsLimit(urlLike) {
            try {
                const u = new URL(typeof urlLike === 'string' ? urlLike : String(urlLike), location.href);
                if (!/\/session-manager\/sessions(?:\/|$)/.test(u.pathname)) return null;
                if (u.searchParams.get('limit') !== '1000') {
                    u.searchParams.set('limit', '1000');
                    return u.href;                    // вернуть переписанный URL
                }
            } catch {
            }
            return null;                          // без изменений
        }

        function cloneHeaders(headers) {
            if (!headers) return undefined;
            if (headers instanceof Headers) {
                const h = new Headers();
                headers.forEach((v, k) => h.append(k, v));
                return h;
            }
            if (Array.isArray(headers)) {
                const h = {};
                headers.forEach(([k, v]) => {
                    h[k] = v;
                });
                return h;
            }
            if (typeof headers === 'object') {
                return {...headers};
            }
            return headers;
        }

        // аккуратно копируем init, чтобы сохранить method/headers/body/credentials и т.п.
        function buildStoredFetchInit(input, init) {
            let base = init;

            // случай fetch(new Request(...)), когда init не передавали
            if (!base && input instanceof Request) {
                base = {
                    method: input.method,
                    headers: input.headers, // body из Request доставать не будем (ReadableStream), но чаще всего им не пользуются
                };
            }

            if (!base) return undefined;

            const stored = {...base};
            if (base.headers) {
                stored.headers = cloneHeaders(base.headers);
            }
            return stored;
        }


        function reloadDataFromApi() {
            try {
                const jobs = [];

                const pushReq = (req) => {
                    if (!req || !req.url) return;
                    jobs.push(fetch(req.url, req.init || {}).catch(() => {
                    }));
                };

                pushReq(lastSessionsReq);
                pushReq(lastServerNamesReq);
                pushReq(lastProductsReq);

                if (jobs.length) {
                    Promise.all(jobs).then(() => {
                        lastSig = '';
                        scheduleRender(150);
                    }).catch(() => {
                        location.reload();
                    });
                } else {
                    // если ни одного fetch-запроса не отловили — падаем назад на полный reload страницы
                    location.reload();
                }
            } catch (e) {
                location.reload();
            }
        }


        function withLock(fn) {
            MUTATE_LOCK++;
            try {
                return fn();
            } finally {
                MUTATE_LOCK--;
            }
        }

        function tsToHuman(ts) {
            if (ts == null) return '';
            const d = new Date(Number(ts));
            if (isNaN(d.getTime())) return '';
            const Y = d.getFullYear();
            const M = String(d.getMonth() + 1).padStart(2, '0');
            const D = String(d.getDate()).padStart(2, '0');
            const h = String(d.getHours()).padStart(2, '0');
            const m = String(d.getMinutes()).padStart(2, '0');
            const s = String(d.getSeconds()).padStart(2, '0');
            return `${Y}-${M}-${D} ${h}:${m}:${s}`;
        }

        function msToHumanDuration(ms) {
            if (!(ms > 0)) return '';
            let sec = Math.floor(ms / 1000);
            const h = Math.floor(sec / 3600);
            sec -= h * 3600;
            const m = Math.floor(sec / 60);
            const s = sec - m * 60;
            return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
        }

        // новый хелпер: "40ч 32м 30с"
        function msToHumanVerbose(ms) {
            if (!(ms > 0)) return '0с';
            let sec = Math.floor(ms / 1000);
            const h = Math.floor(sec / 3600);
            sec -= h * 3600;
            const m = Math.floor(sec / 60);
            const s = sec - m * 60;
            const parts = [];
            if (h) parts.push(`${h}ч`);
            if (m) parts.push(`${m}м`);
            if (s || !parts.length) parts.push(`${s}с`);
            return parts.join(' ');
        }

        function humanDurationToSeconds(str) {
            if (!str) return 0;
            const parts = str.split(':').map(Number);
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return Number(str) || 0;
        }

        function parseDateInputToMs(str) {
            if (!str) return null;
            // ожидаем формат YYYY-MM-DD из <input type="date">
            const [Y, M, D] = str.split('-').map(Number);
            if (!Y || !M || !D) return null;
            const d = new Date(Y, M - 1, D, 0, 0, 0, 0);
            return d.getTime();
        }

        // headerFilter-редактор для created_on (два поля: от/до)
        function createdOnHeaderFilter(cell, onRendered, success, cancel, editorParams) {
            const wrap = document.createElement('div');
            wrap.style.display = 'block';
            wrap.style.padding = '2px';

            const inputFrom = document.createElement('input');
            inputFrom.type = 'date';
            inputFrom.placeholder = 'от';
            inputFrom.style.display = 'block';
            inputFrom.style.width = '100%';
            inputFrom.style.boxSizing = 'border-box';
            inputFrom.style.marginBottom = '2px';

            const inputTo = document.createElement('input');
            inputTo.type = 'date';
            inputTo.placeholder = 'до';
            inputTo.style.display = 'block';
            inputTo.style.width = '100%';
            inputTo.style.boxSizing = 'border-box';

            function update() {
                const fromMs = parseDateInputToMs(inputFrom.value);
                const toMsRaw = parseDateInputToMs(inputTo.value);
                const toMs = toMsRaw != null ? (toMsRaw + 24 * 60 * 60 * 1000 - 1) : null;

                success({from: fromMs, to: toMs});
            }

            inputFrom.addEventListener('change', update);
            inputTo.addEventListener('change', update);

            wrap.appendChild(inputFrom);
            wrap.appendChild(inputTo);

            onRendered(() => {
                inputFrom.focus();
            });

            return wrap;
        }


        // функция фильтрации для created_on
        function createdOnHeaderFilterFunc(range, value, rowData, filterParams) {
            // range = { from: ms | null, to: ms | null }
            if (!range || (range.from == null && range.to == null)) return true;

            if (!value) return false;

            const str = String(value).trim(); // это created_on_human, типа "2025-03-12 14:23:00"
            if (!str) return false;

            const [datePart, timePart = '00:00:00'] = str.split(' ');
            const [Y, M, D] = (datePart || '').split('-').map(Number);
            if (!Y || !M || !D) return true; // если формат странный — не режем строку

            const [h = 0, m = 0, s = 0] = (timePart || '').split(':').map(Number);

            const v = new Date(Y, M - 1, D, h || 0, m || 0, s || 0).getTime();
            if (!v) return false;

            if (range.from != null && v < range.from) return false;
            if (range.to != null && v > range.to) return false;

            return true;
        }

        function findSectionHeaderRow(root = document) {
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
                if (node.classList?.contains('ds-wrap')) {
                    node = node.nextElementSibling;
                    continue;
                }
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
                const l = document.createElement('link');
                l.rel = 'stylesheet';
                l.href = href;
                l.onload = res;
                l.onerror = rej;
                document.head.appendChild(l);
            });
        }

        function loadJS(src) {
            return new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = src;
                s.async = true;
                s.onload = res;
                s.onerror = rej;
                document.head.appendChild(s);
            });
        }

        async function ensureTabulator() {
            if (window.Tabulator) return {ok: true, where: 'present'};
            try {
                setPill(`load ${CDNJS.name}: css`);
                await loadCSS(CDNJS.css);
                setPill(`load ${CDNJS.name}: js`);
                await loadJS(CDNJS.js);
            } catch (e) {
                return {ok: false, reason: e?.message || 'load error'};
            }
            return window.Tabulator ? {ok: true, where: CDNJS.name} : {ok: false, reason: 'no window.Tabulator'};
        }


        // ---- GEOIP (city by IP) ----
        async function ensureCityDb() {
            if (cityDbReader) return cityDbReader;
            if (cityDbLoading) return cityDbLoading;

            cityDbLoading = (async () => {
                try {
                    setPill('load GeoLite2 DB');

                    const [mmdbMod, bufferMod] = await Promise.all([import('https://esm.sh/mmdb-lib@3'), import('https://esm.sh/buffer@6')]);

                    const {Reader} = mmdbMod;
                    const {Buffer} = bufferMod;

                    const resp = await fetch(CITY_DB_URL);
                    const arr = await resp.arrayBuffer();
                    const dbBuf = Buffer.from(arr);

                    cityDbReader = new Reader(dbBuf);
                    setPill('GeoLite2 ready');
                    return cityDbReader;          // ← без scheduleRender
                } catch (e) {
                    console.error('GeoLite2 load error', e);
                    setPill('GeoLite2 error');
                    cityDbReader = null;
                    throw e;
                }
            })();

            return cityDbLoading;
        }

        async function ensureAsnDb() {
            if (asnDbReader) return asnDbReader;
            if (asnDbLoading) return asnDbLoading;

            asnDbLoading = (async () => {
                try {
                    setPill('load GeoLite2 ASN');

                    const [mmdbMod, bufferMod] = await Promise.all([import('https://esm.sh/mmdb-lib@3'), import('https://esm.sh/buffer@6')]);

                    const {Reader} = mmdbMod;
                    const {Buffer} = bufferMod;

                    const resp = await fetch(ASN_DB_URL);
                    const arr = await resp.arrayBuffer();
                    const dbBuf = Buffer.from(arr);

                    asnDbReader = new Reader(dbBuf);
                    setPill('GeoLite2 ASN ready');
                    return asnDbReader;
                } catch (e) {
                    console.error('GeoLite2 ASN load error', e);
                    setPill('GeoLite2 ASN error');
                    asnDbReader = null;
                    throw e;
                }
            })();

            return asnDbLoading;
        }

        function lookupCity(ip) {
            if (!ip) return '! not ip';
            const key = String(ip).trim();
            if (!key) return '! not key';

            // если база ещё не готова — дёрнем загрузку в фоне и вернём пустоту
            if (!cityDbReader) {
                ensureCityDb().catch(() => {
                });
                return '! base not ready';
            }

            if (Object.prototype.hasOwnProperty.call(cityCache, key)) {
                return cityCache[key];
            }

            let city = '';
            try {
                const res = cityDbReader.get(key);
                const names = (res && (res.city?.names || res.registered_country?.names || res.country?.names)) || {};
                city = names.ru || names.en || names.de || names['en'] || '';
            } catch (e) {
                city = '';
            }

            cityCache[key] = city || '';
            return cityCache[key];
        }

        function lookupIsp(ip) {
            if (!ip) return '! no ip';
            const key = String(ip).trim();
            if (!key) return '! key empty';

            // если база ещё не готова — дёрнем загрузку в фоне и вернём пустоту
            if (!asnDbReader) {
                ensureAsnDb().catch(() => {
                });
                return '! asn db is not ready';
            }

            if (Object.prototype.hasOwnProperty.call(ispCache, key)) {
                return ispCache[key];
            }

            let isp = '';
            try {
                const res = asnDbReader.get(key) || {};
                // GeoLite2-ASN: автономная система
                isp = res.autonomous_system_organization || res.organization || '';
            } catch (e) {
                isp = '! error getting isp';
            }

            ispCache[key] = isp || '';
            return ispCache[key];
        }

        // Список всех возможных колонок (кроме merchant_id); порядок «разумный»
        function getAllColumns(rows) {
            const set = new Set();
            rows.forEach(r => Object.keys(r || {}).forEach(k => set.add(k)));
            set.delete('merchant_id');
            const preferred = ['uuid', 'status', 'client_id', 'server_id', 'server_name', 'product_id', 'product_name', 'useDefaultDesktop', 'created_on', 'created_on_human', 'finished_on', 'finished_on_human', 'duration_human', 'creator_ip', 'city', 'isp', 'score', 'score_reason', 'score_text', 'abort_comment', 'billing_type'];
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
            for (let i = 0; i < keys.length; i += Math.max(1, Math.ceil(keys.length / 50))) {
                const k = keys[i], v = obj[k];
                const s = k + '|' + (typeof v === 'string' ? v : JSON.stringify(v)?.slice(0, 64));
                for (let j = 0; j < s.length; j++) h = ((h * 31) + s.charCodeAt(j)) >>> 0;
            }
            return keys.length + ':' + h.toString(16);
        }

        function sessionsSig(rows) {
            if (!Array.isArray(rows)) return '0';
            const n = rows.length;
            let h = 0 >>> 0;
            const step = Math.max(1, Math.ceil(n / 20));
            for (let i = 0; i < n; i += step) {
                const s = rows[i] || {};
                const key = (s.uuid || '') + '|' + (s.created_on || '') + '|' + (s.finished_on || '') + '|' + (s.status || '');
                for (let j = 0; j < key.length; j++) h = ((h * 31) + key.charCodeAt(j)) >>> 0;
            }
            return n + ':' + h.toString(16);
        }

        function fullSig() {
            return [sessionsSig(rawSessions || []), mapSig(serverNames), mapSig(productsById), humanOnly ? 'H:1' : 'H:0'].join('~');
        }

        // обогащаем строки
        function buildAugmentedRows() {
            const src = Array.isArray(rawSessions) ? rawSessions.slice() : [];

            // Accumulate durations and counts per client
            const clientStats = {};
            src.forEach(s => {
                if (s.created_on != null && s.finished_on != null) {
                    const dur = Number(s.finished_on) - Number(s.created_on);
                    if (!clientStats[s.client_id]) {
                        clientStats[s.client_id] = {total: 0, count: 0};
                    }
                    clientStats[s.client_id].total += dur;
                    clientStats[s.client_id].count += 1;
                }
            });

            // Count sessions per client_id
            const clientCounts = {};
            src.forEach(s => {
                clientCounts[s.client_id] = (clientCounts[s.client_id] || 0) + 1;
            });

            // Add stats to each row
            const augmented = src.map(s => {
                const p = productsById[s.product_id] || null;
                const created_on_human = tsToHuman(s.created_on);
                const finished_on_human = tsToHuman(s.finished_on);
                const duration_human = (s.created_on != null && s.finished_on != null) ? msToHumanDuration(Number(s.finished_on) - Number(s.created_on)) : '';
                const stats = clientStats[s.client_id] || {total: 0, count: 0};
                const client_avg_duration_human = stats.count > 0 ? msToHumanDuration(stats.total / stats.count) : '';
                const client_total_duration_human = stats.total > 0 ? msToHumanDuration(stats.total) : '';
                const obj = {
                    ...s,
                    server_name: serverNames[s.server_id] || '',
                    product_name: p?.title || '',
                    useDefaultDesktop: (p?.useDefaultDesktop ?? null),
                    created_on_human,
                    finished_on_human,
                    duration_human,
                    client_sessions: clientCounts[s.client_id],
                    client_avg_duration_human,
                    client_total_duration_human,
                    city: lookupCity(s.creator_ip),
                    isp: lookupIsp(s.creator_ip)
                };
                delete obj.merchant_id;
                return obj;
            });

            return augmented;
        }


        function recalcDurationHeaderStats(rowsOrData) {
            if (!tableInstance || !window.Tabulator) return;

            let data;
            if (Array.isArray(rowsOrData) && rowsOrData.length && typeof rowsOrData[0]?.getData === 'function') {
                // массив RowComponent'ов из dataFiltered
                data = rowsOrData.map(row => row.getData());
            } else if (Array.isArray(rowsOrData)) {
                // уже данные
                data = rowsOrData;
            } else {
                try {
                    // все строки, которые проходят фильтры (не только текущая страница)
                    data = tableInstance.getData("active") || [];
                } catch {
                    data = tableInstance.getData() || [];
                }
            }

            const num = data.length;
            let totalMs = 0;

            data.forEach(s => {
                if (s && s.created_on != null && s.finished_on != null) {
                    totalMs += Number(s.finished_on) - Number(s.created_on);
                }
            });

            const avgMs = num ? (totalMs / num) : 0;
            const baseTitle = 'duration_human';

            const title = num ? `${baseTitle} (num: ${num}, avg: ${msToHumanDuration(avgMs)}, total: ${msToHumanVerbose(totalMs)})` : baseTitle;

            const col = tableInstance.getColumn('duration_human');
            if (col && col.updateDefinition) {
                col.updateDefinition({title});
            }
        }

        let tableBuilt = false;

        // ---- RENDER ----
        async function renderTable() {
            if (!cityDbReader) {
                try {
                    await ensureCityDb();           // блокируем рендер до загрузки базы
                } catch (e) {
                    // Альтернатива, если вдруг захочешь всё-таки рендерить без города:
                    setPill('GeoLite2 failed, city disabled');
                    // // и НЕ делаем return — код ниже выполнится
                }
            }
            if (!asnDbReader) {
                try {
                    await ensureAsnDb();            // блокируем рендер до загрузки ASN базы
                } catch (e) {
                    setPill('GeoLite2 ASN failed, ISP disabled');
                }
            }
            const sig = fullSig();
            if (sig === lastSig) {
                setPill('no changes');
                return;
            }
            lastSig = sig;
            if (!rawSessions) {
                setPill('waiting sessions');
                return;
            }

            const sessions = buildAugmentedRows();

            const headerRow = findSectionHeaderRow();
            if (!headerRow) {
                setPill('waiting header');
                return;
            }
            const wrap = ensureWrap(headerRow);
            hideOriginalAfter(headerRow);

            // toolbar
            let toolbar = wrap.querySelector('.ds-toolbar');
            if (!toolbar) {
                withLock(() => {
                    toolbar = document.createElement('div');
                    toolbar.className = 'ds-toolbar';
                    toolbar.innerHTML = `
            <button data-act="toggle-human">Human only: Off</button>
            <button data-act="csv">Export CSV</button>
            <button data-act="clear">Clear filters</button>
            <button data-act="reload">Reload Data</button>
          `;
                    wrap.prepend(toolbar);
                    updateHumanButton(toolbar);
                    toolbar.addEventListener('click', (e) => {
                        const btn = e.target.closest('button[data-act]');
                        if (!btn) return;

                        if (btn.dataset.act === 'toggle-human') {
                            humanOnly = !humanOnly;
                            updateHumanButton(toolbar);
                            lastSig = '';
                            scheduleRender(0);
                        }

                        if (btn.dataset.act === 'csv') {
                            tableInstance.download('csv', 'drova-sessions.csv');
                        }

                        if (btn.dataset.act === 'clear') {
                            tableInstance?.clearHeaderFilter?.();
                        }

                        if (btn.dataset.act === 'reload') {
                            reloadDataFromApi();
                        }
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
                const tabCols = cols.map(k => {
                    const col = {
                        title: k,
                        field: k,
                        width: 120,
                        headerWordWrap: true,
                        headerFilter: 'input',
                        headerFilterPlaceholder: 'фильтр…',
                        formatter: (cell) => {
                            const v = cell.getValue();
                            return (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
                        }, // Add custom sorter for duration columns
                        sorter: ['duration_human', 'client_avg_duration_human', 'client_total_duration_human'].includes(k) ? (a, b) => humanDurationToSeconds(a) - humanDurationToSeconds(b) : undefined
                    };

                    // для created_on_human — свой кастомный фильтр "от / до"
                    if (k === 'created_on_human') {
                        col.headerFilter = createdOnHeaderFilter;       // редактор с двумя input[type=date]
                        col.headerFilterPlaceholder = undefined;        // не нужен текстовый placeholder
                        col.headerFilterFunc = createdOnHeaderFilterFunc;
                        col.headerFilterLiveFilter = false;             // фильтровать только по change, а не по вводу
                    }

                    return col;

                });


                if (tableInstance) {
                    tableInstance.destroy();
                    tableInstance = null;
                    tableBuilt = false;
                }
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
                            tableBuilt: function () {
                                tableBuilt = true;
                            }
                        });
                        tableInstance.on("dataFiltered", function (filters, rows) {

                            recalcDurationHeaderStats(rows);
                            // Get filtered data
                            console.log('dataFiltered triggered', filters, rows);
                            const filteredData = rows.map(row => row.getData());

                            // Recalculate stats per client_id
                            const clientStats = {};
                            filteredData.forEach(s => {
                                if (s.created_on != null && s.finished_on != null) {
                                    const dur = Number(s.finished_on) - Number(s.created_on);
                                    if (!clientStats[s.client_id]) {
                                        clientStats[s.client_id] = {total: 0, count: 0};
                                    }
                                    clientStats[s.client_id].total += dur;
                                    clientStats[s.client_id].count += 1;
                                }
                            });

                            // Count sessions per client_id
                            const clientCounts = {};
                            filteredData.forEach(s => {
                                clientCounts[s.client_id] = (clientCounts[s.client_id] || 0) + 1;
                            });

                            // Update each row
                            rows.forEach(row => {
                                const s = row.getData();
                                const stats = clientStats[s.client_id] || {total: 0, count: 0};
                                row.update({
                                    client_sessions: clientCounts[s.client_id] || 0,
                                    client_avg_duration_human: stats.count > 0 ? msToHumanDuration(stats.total / stats.count) : '',
                                    client_total_duration_human: stats.total > 0 ? msToHumanDuration(stats.total) : ''
                                });
                            });
                        });

                        // инициализируем заголовок при первой отрисовке
                        recalcDurationHeaderStats();
                    });
                } else {
                    if (tableBuilt) {
                        const current = tableInstance.getColumns().map(c => c.getField());
                        const want = tabCols.map(c => c.field);
                        const sameCols = current.length === want.length && current.every((f, i) => f === want[i]);
                        withLock(() => {
                            if (!sameCols) tableInstance.setColumns(tabCols);
                            tableInstance.replaceData(sessions);
                            // на всякий случай обновим заголовок и тут
                            recalcDurationHeaderStats();
                        });
                    }
                }
                setPill(`Tabulator: ${sessions.length} rows${humanOnly ? ' (Human)' : ''}`);

            }
        }

        function updateHumanButton(toolbar) {
            const btn = toolbar.querySelector('button[data-act="toggle-human"]');
            if (btn) btn.textContent = `Human only: ${humanOnly ? 'On' : 'Off'}`;
        }


        // ---- API HOOKS (fetch) ----
        const origFetch = window.fetch;
        window.fetch = async function patchedFetch(input, init) {
            // 2.1. ДО отправки — переписываем limit
            let modInput = input;
            try {
                const urlStr = typeof input === 'string' ? input : (input instanceof Request ? input.url : input?.url || '');
                const rew = urlStr ? rewriteSessionsLimit(urlStr) : null;
                if (rew) {
                    // строка → строка; Request → новый Request(rew, input); остальное → строка
                    if (typeof input === 'string') {
                        modInput = rew;
                    } else if (input instanceof Request) {
                        modInput = new Request(rew, input);     // клонит body/опции
                    } else {
                        modInput = rew;
                    }
                    // опционально покажем статус
                    setPill?.('rewrite limit→1000');
                }
            } catch {
            }

            // 2.2. отправляем
            const res = await origFetch.apply(this, [modInput, init]);

            // 2.3. ПОСЛЕ — разбираем полезную нагрузку, как раньше
            try {
                const usedUrl = typeof modInput === 'string' ? modInput : (modInput instanceof Request ? modInput.url : modInput?.url || '');

                const handle = async (clone) => {
                    const ct = (clone.headers.get('content-type') || '').toLowerCase();
                    if (ct.includes('application/json')) return clone.json();
                    const t = await clone.text();
                    try {
                        return JSON.parse(t);
                    } catch {
                        return null;
                    }
                };

                if (/\/session-manager\/sessions(?:\?|$)/i.test(usedUrl)) {
                    const json = await handle(res.clone());
                    if (Array.isArray(json?.sessions)) {
                        rawSessions = json.sessions;
                        lastSessionsReq = {url: usedUrl, init: buildStoredFetchInit(input, init)};
                        setPill?.(`sessions:${rawSessions.length}`);
                        scheduleRender(60);
                    }
                } else if (/\/server-manager\/servers\/server_names(?:\?|$)/i.test(usedUrl)) {
                    const json = await handle(res.clone());
                    if (json && typeof json === 'object' && !Array.isArray(json)) {
                        serverNames = {...serverNames, ...json};
                        lastServerNamesReq = {url: usedUrl, init: buildStoredFetchInit(input, init)};
                        setPill?.(`server_names:${Object.keys(serverNames).length}`);
                        scheduleRender(40);
                    }
                } else if (/\/product-manager\/product\/listfull2(?:\?|$)/i.test(usedUrl)) {
                    const json = await handle(res.clone());
                    let list = Array.isArray(json) ? json : (Array.isArray(json?.list) ? json.list : []);
                    if (list.length) {
                        for (const p of list) {
                            const id = p.productId || p.id || p.uuid;
                            if (id) productsById[id] = p;
                        }
                        lastProductsReq = {url: usedUrl, init: buildStoredFetchInit(input, init)};
                        setPill?.(`products:${Object.keys(productsById).length}`);
                        scheduleRender(40);
                    }
                }

            } catch {
            }
            return res;
        };


        // ---- API HOOKS (XHR) ----
        const OrigXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function PatchedXHR() {
            const xhr = new OrigXHR();
            let _url = '';
            const _open = xhr.open;

            xhr.open = function (method, url /*, ...rest */) {
                try {
                    const rew = rewriteSessionsLimit(url);
                    _url = rew || url;                      // сохраняем уже переписанный URL
                    // передаём в оригинальный open с теми же аргами, но с новым URL
                    const args = Array.from(arguments);
                    args[1] = _url;
                    return _open.apply(this, args);
                } catch {
                    _url = url;
                    return _open.apply(this, arguments);
                }
            };

            xhr.addEventListener('load', function () {
                try {
                    const ct = (xhr.getResponseHeader('content-type') || '').toLowerCase();
                    if (!ct.includes('application/json')) return;

                    if (/\/session-manager\/sessions(?:\?|$)/i.test(_url)) {
                        const json = JSON.parse(xhr.responseText);
                        if (Array.isArray(json?.sessions)) {
                            rawSessions = json.sessions;
                            setPill?.(`sessions:${rawSessions.length}`);
                            scheduleRender(60);
                        }
                    } else if (/\/server-manager\/servers\/server_names(?:\?|$)/i.test(_url)) {
                        const json = JSON.parse(xhr.responseText);
                        if (json && typeof json === 'object' && !Array.isArray(json)) {
                            serverNames = {...serverNames, ...json};
                            setPill?.(`server_names:${Object.keys(serverNames).length}`);
                            scheduleRender(40);
                        }
                    } else if (/\/product-manager\/product\/listfull2(?:\?|$)/i.test(_url)) {
                        const json = JSON.parse(xhr.responseText);
                        let list = Array.isArray(json) ? json : (Array.isArray(json?.list) ? json.list : []);
                        if (list.length) {
                            for (const p of list) {
                                const id = p.productId || p.id || p.uuid;
                                if (id) productsById[id] = p;
                            }
                            setPill?.(`products:${Object.keys(productsById).length}`);
                            scheduleRender(40);
                        }
                    }

                } catch {
                }
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
        observer.observe(document.documentElement, {childList: true, subtree: true});

        function scheduleRender(delay = 80) {
            clearTimeout(renderTimer);
            renderTimer = setTimeout(() => renderTable(), delay);
        }

        // initial
        setPill('ready');
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => scheduleRender(200), {once: true});
        } else {
            scheduleRender(200);
        }
    });
})();
