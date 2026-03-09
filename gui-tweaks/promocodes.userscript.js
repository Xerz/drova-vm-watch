// ==UserScript==
// @name         Drova Promo Codes Tweaks
// @description  Adds promo-code count control and patches issue5Promocodes to issue selected amount with list refresh.
// @version      1.0
// @match        https://drova.io/my-account
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    const inject = (fn) => {
        const s = document.createElement('script');
        s.textContent = '(' + fn.toString() + ')();';
        (document.documentElement || document.head).appendChild(s);
        s.remove();
    };

    inject(function main() {
        'use strict';

        if (!/^\/my-account(?:\/|$)/.test(location.pathname)) return;
        if (window.__drovaPromoCodesTweaksInstalled) return;
        window.__drovaPromoCodesTweaksInstalled = true;

        const CONTROL_CLASS = 'pc-count-control';

        let desiredCount = 1;
        let mutateLock = 0;
        let renderTimer = null;
        let isIssuing = false;

        const controls = new Set();
        const patchedIssueOwners = new WeakSet();

        function withLock(fn) {
            mutateLock++;
            try {
                return fn();
            } finally {
                mutateLock--;
            }
        }

        function normalizeCount(value) {
            const digits = String(value ?? '').replace(/\D+/g, '');
            const parsed = Number.parseInt(digits, 10);
            if (!Number.isFinite(parsed) || parsed < 1) return 1;
            return Math.min(parsed, 9999);
        }

        function promoWord(n) {
            const mod10 = n % 10;
            const mod100 = n % 100;
            if (mod10 === 1 && mod100 !== 11) return 'промокод';
            if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'промокода';
            return 'промокодов';
        }

        function promoLabel(n) {
            return `Выпустить ${n} ${promoWord(n)}`;
        }

        function setDesiredCount(next) {
            const normalized = normalizeCount(next);
            if (normalized === desiredCount) return;
            desiredCount = normalized;
            syncControls();
            syncButtons();
        }

        function isPromoButton(button) {
            if (!(button instanceof HTMLButtonElement)) return false;
            const text = (button.textContent || '').toLowerCase();
            return text.includes('выпустить') && text.includes('промокод');
        }

        function getVueFromElement(element) {
            if (!(element instanceof Element)) return null;

            if (element.__vue__) return element.__vue__;

            if (element.__vueParentComponent) {
                return element.__vueParentComponent.proxy || element.__vueParentComponent;
            }

            const keys = Object.keys(element);
            for (const key of keys) {
                if (!key.startsWith('__vue')) continue;
                const value = element[key];
                if (value && typeof value === 'object') {
                    if (value.proxy) return value.proxy;
                    return value;
                }
            }
            return null;
        }

        function getParentVm(vm) {
            if (!vm || typeof vm !== 'object') return null;
            if (vm.$parent) return vm.$parent;
            if (vm.$ && vm.$.parent && vm.$.parent.proxy) return vm.$.parent.proxy;
            if (vm.$ && vm.$.parent) return vm.$.parent;
            return null;
        }

        function findPromoOwnerVm(button) {
            let node = button;
            while (node) {
                const startVm = getVueFromElement(node);
                if (startVm) {
                    const seen = new Set();
                    let vm = startVm;
                    while (vm && !seen.has(vm)) {
                        seen.add(vm);
                        if (typeof vm.issue5Promocodes === 'function') return vm;
                        vm = getParentVm(vm);
                    }
                }
                node = node.parentElement;
            }
            return null;
        }

        function readDurationMinutes(column) {
            if (!(column instanceof Element)) return 1;
            const inputs = Array.from(column.querySelectorAll('.ivu-input-number-input'));
            const durationInput = inputs.find((input) => !input.closest(`.${CONTROL_CLASS}`));
            if (!durationInput) return 1;

            const raw = String(durationInput.value ?? '').trim().replace(',', '.');
            const parsed = Number.parseFloat(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) return 1;
            return Math.min(parsed, 24 * 60 * 365);
        }

        function buildIssueUrl(count, minutes) {
            const ms = Math.max(1000, Math.round(minutes * 60 * 1000));
            return `https://services.drova.io/accounting/prepaid/issue_promocodes/${count}/${ms}`;
        }

        async function issuePromocodesDirect(ownerVm, button) {
            if (!ownerVm || isIssuing) return;

            isIssuing = true;
            const hasButton = button instanceof HTMLButtonElement;
            const prevDisabled = hasButton ? button.disabled : false;
            if (hasButton) button.disabled = true;

            try {
                const token = ownerVm.xauthtoken;
                if (!token) throw new Error('xauthtoken is missing on VM');

                const count = normalizeCount(desiredCount);
                const minutesFromVm = Number(ownerVm.promoMinutesAmount);
                const minutes = Number.isFinite(minutesFromVm) && minutesFromVm > 0
                    ? minutesFromVm
                    : readDurationMinutes(button?.closest('.account-column'));

                const response = await fetch(buildIssueUrl(count, minutes), {
                    method: 'GET',
                    mode: 'cors',
                    credentials: 'omit',
                    headers: {
                        accept: 'application/json, text/plain, */*',
                        'x-auth-token': token
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                if (typeof ownerVm.reinitPromocodes === 'function') {
                    await ownerVm.reinitPromocodes();
                }
            } catch (error) {
                try {
                    ownerVm.reason = error;
                } catch {}
                console.error('Promocode issue failed', error);
            } finally {
                if (hasButton) button.disabled = prevDisabled;
                isIssuing = false;
            }
        }

        function patchIssueMethodForVm(ownerVm, button) {
            if (!ownerVm || typeof ownerVm.issue5Promocodes !== 'function') return false;
            if (patchedIssueOwners.has(ownerVm)) return true;

            ownerVm.issue5Promocodes = function patchedIssue5Promocodes() {
                const vm = this || ownerVm;
                return issuePromocodesDirect(vm, button);
            };

            patchedIssueOwners.add(ownerVm);
            return true;
        }

        function handlePromoButtonClick(event) {
            const target = event.target;
            if (!(target instanceof Element)) return;

            const button = target.closest('.account-column button');
            if (!button || !isPromoButton(button)) return;

            const ownerVm = findPromoOwnerVm(button);
            if (ownerVm) patchIssueMethodForVm(ownerVm, button);
        }

        function updateDownState(control, value) {
            const down = control.querySelector('[data-role="down"]');
            if (!down) return;
            down.classList.toggle('ivu-input-number-controls-outside-btn-disabled', value <= 1);
        }

        function attachControlHandlers(control) {
            if (control.dataset.pcBound === '1') return;
            control.dataset.pcBound = '1';

            const input = control.querySelector('input');
            const down = control.querySelector('[data-role="down"]');
            const up = control.querySelector('[data-role="up"]');
            if (!input || !down || !up) return;

            const commit = (raw) => {
                setDesiredCount(raw);
                input.value = String(desiredCount);
                updateDownState(control, desiredCount);
            };

            down.addEventListener('click', () => {
                commit(desiredCount - 1);
            });

            up.addEventListener('click', () => {
                commit(desiredCount + 1);
            });

            input.addEventListener('input', () => {
                const cleaned = String(input.value || '').replace(/\D+/g, '');
                if (input.value !== cleaned) input.value = cleaned;
            });

            input.addEventListener('change', () => {
                commit(input.value);
            });

            input.addEventListener('blur', () => {
                commit(input.value);
            });
        }

        function createCountControl() {
            const control = document.createElement('div');
            control.className = `margin-right ivu-input-number ivu-input-number-default ivu-input-number-controls-outside ${CONTROL_CLASS}`;
            control.title = 'Количество промокодов';
            control.innerHTML = `
                <div data-role="down" class="ivu-input-number-controls-outside-btn ivu-input-number-controls-outside-down">
                    <i class="ivu-icon ivu-icon-ios-remove"></i>
                </div>
                <div data-role="up" class="ivu-input-number-controls-outside-btn ivu-input-number-controls-outside-up">
                    <i class="ivu-icon ivu-icon-ios-add"></i>
                </div>
                <div class="ivu-input-number-input-wrap">
                    <input autocomplete="off" spellcheck="false" placeholder="Кол-во" class="ivu-input-number-input">
                </div>
            `;

            attachControlHandlers(control);
            const input = control.querySelector('input');
            if (input) input.value = String(desiredCount);
            updateDownState(control, desiredCount);
            controls.add(control);
            return control;
        }

        function syncControls() {
            controls.forEach((control) => {
                if (!control.isConnected) {
                    controls.delete(control);
                    return;
                }

                const input = control.querySelector('input');
                if (input && document.activeElement !== input) {
                    input.value = String(desiredCount);
                }
                updateDownState(control, desiredCount);
            });
        }

        function syncButtons() {
            const buttons = document.querySelectorAll('.account-column button');
            buttons.forEach((button) => {
                if (!isPromoButton(button)) return;
                const labelNode = button.querySelector('span') || button;
                const nextText = promoLabel(desiredCount);
                if ((labelNode.textContent || '').trim() !== nextText) {
                    labelNode.textContent = nextText;
                }
            });
        }

        function ensureControls() {
            withLock(() => {
                const columns = document.querySelectorAll('.account-column');
                columns.forEach((column) => {
                    const button = Array.from(column.querySelectorAll('button')).find(isPromoButton);
                    if (!button) return;

                    let control = column.querySelector(`.${CONTROL_CLASS}`);
                    if (!control) {
                        control = createCountControl();
                        button.before(control);
                    } else {
                        controls.add(control);
                        attachControlHandlers(control);
                    }

                    const ownerVm = findPromoOwnerVm(button);
                    if (ownerVm) patchIssueMethodForVm(ownerVm, button);
                });
            });

            syncControls();
            syncButtons();
        }

        function scheduleEnsure(delay = 0) {
            clearTimeout(renderTimer);
            renderTimer = setTimeout(ensureControls, delay);
        }

        document.addEventListener('click', handlePromoButtonClick, true);

        const observer = new MutationObserver((mutations) => {
            if (mutateLock > 0) return;
            const relevant = mutations.some((m) => {
                const target = m.target;
                if (!(target instanceof Node)) return false;
                const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
                return !!(element && element.closest('.account-column'));
            });
            if (relevant) scheduleEnsure(40);
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => scheduleEnsure(0), { once: true });
        } else {
            scheduleEnsure(0);
        }
    });
})();
