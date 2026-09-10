// ==UserScript==
// @name         划词翻译 - DeepSeek 悬浮卡片
// @namespace    http://tampermonkey.net/
// @version      19.9.9
// @description  划词后在当前页面弹出暗色悬浮卡片（高度完全自适应，最大480），后台标签页中的 DeepSeek 静默翻译并实时回传，无多余窗口
// @author       KniphH
// @license      MIT
// @match        *://*/*
// @match        https://chat.deepseek.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

/*
 * ⚠️ 使用说明：
 * 1. 本脚本是「窗口版」的替代方案，采用页面内悬浮卡片显示译文。
 *    安装/启用本脚本时，请先停用旧的「划词翻译 - DeepSeek 自动发送」，
 *    否则划词时会出现两个🌐按钮。
 *
 * 2. 架构演进史（踩坑记录）：
 *    v19.8.1 工作窗口完全移出屏幕 → Chrome"遮挡节流"冻结页面，回传卡死；
 *    v19.8.2 工作窗口留 50px 小角 → 依旧被节流（用户点回页面看卡片时
 *            主窗口盖住工作窗口，照样触发遮挡）；
 *    v19.9   改用【后台标签页】当工作页——浏览器对后台标签从不冻结
 *            JS（只节流计时器），这是所有网页自动化依赖的可靠行为。
 *    另外：曾想用隐藏 iframe 当工作页，但 DeepSeek 响应头带
 *            CSP: frame-ancestors 'none'，官方封死了 iframe 嵌入。
 *
 * 3. 工作方式：
 *    - 点击🌐 → 当前页面弹出悬浮卡片；
 *    - 首次使用会打开一个 DeepSeek 标签页（标题显示"翻译助手"），
 *      它会常驻后台复用：之后的翻译直接走后台，零弹窗零闪烁；
 *    - 工作页把流式译文通过 GM 存储跨标签通知 + postMessage 双通道
 *      实时回传给卡片；
 *    - 工作页空闲 3 分钟自动关闭，下次划词自动重开；
 *    - 卡片左上角握把可拖动，拖后位置固定；✕ 关闭卡片。
 */

(function() {
    'use strict';

    const CONFIG = {
        targetLang: '中文',
        deepseekUrl: 'https://chat.deepseek.com/',
        buttonDelay: 300,
        cardWidth: 320,
        cardMaxHeight: 480,
        offsetX: 20,   // 卡片水平偏移量（右侧空间不够则向左）
        offsetY: 20,   // 卡片垂直偏移量（始终向下）
        doneIdleMs: 1500,    // 输出停止多久判定为"完成"
        workerName: 'ds_translate_worker',
        workerIdleCloseMs: 180000,   // 工作页空闲多久后自动关闭（3分钟）
    };

    const isDeepSeek = location.href.startsWith('https://chat.deepseek.com/');
    const RELAY_SOURCE = 'ds-translate-card-relay';
    const TASK_KEY = 'ds_card_task';
    const RELAY_KEY = 'ds_card_relay';
    const HEARTBEAT_KEY = 'ds_worker_heartbeat';
    const HEARTBEAT_INTERVAL = 5000;   // 工作页心跳间隔
    const HEARTBEAT_STALE = 12000;     // 超过此时长视为工作页已死亡

    function log(msg, data) {
        console.log(`[划词翻译-卡片] ${msg}`, data || '');
    }

    // ============================================================
    //  Trusted Types 兼容
    //  YouTube / Google 系站点启用 require-trusted-types-for 后，
    //  Element.innerHTML 等注入点只接受 TrustedHTML，直接赋字符串会
    //  抛 TypeError（v19.9.6 之前在 TT 站点卡片会整个挂掉）。
    //  这里先尝试创建直通策略；若站点 CSP 不允许（或浏览器不支持），
    //  捕获异常并在写入时降级为纯文本——绝不抛错中断卡片。
    // ============================================================
    let ttPolicy = null;
    let ttPolicyTried = false;

    function getTTPolicy() {
        if (ttPolicyTried) return ttPolicy;
        ttPolicyTried = true;
        try {
            if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
                ttPolicy = window.trustedTypes.createPolicy(
                    'dsTranslateCard' + Math.random().toString(36).slice(2, 8),
                    { createHTML: function(s) { return s; } }
                );
            }
        } catch(e) {
            log('Trusted Types 策略创建失败，将降级为纯文本', e);
            ttPolicy = null;
        }
        return ttPolicy;
    }

    function safeSetHTML(el, html, fallbackText) {
        if (!el) return;
        const policy = getTTPolicy();
        try {
            el.innerHTML = policy ? policy.createHTML(html) : html;
        } catch(e) {
            // TT 强制且策略不可用：退化为纯文本（去掉标签），保证不中断
            el.textContent = (fallbackText != null && fallbackText !== '')
                ? fallbackText
                : String(html || '').replace(/<[^>]*>/g, '');
        }
    }

    // ============================================================
    //  普通网页部分（划词按钮 + 悬浮卡片）
    // ============================================================
    if (!isDeepSeek) {
        GM_addStyle(`
            #translate-popup-btn {
                position: fixed;
                z-index: 2147483000;
                background: #4D6BFE;
                color: white;
                border: none;
                border-radius: 50%;
                padding: 6px 6px;
                font-size: 18px;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(77, 107, 254, 0.4);
                transition: all 0.2s ease;
                display: none;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                user-select: none;
                pointer-events: auto;
                line-height: 1;
                width: 32px;
                height: 32px;
                align-items: center;
                justify-content: center;
            }
            #translate-popup-btn:hover {
                background: #3B5DE7;
                transform: scale(1.1);
                box-shadow: 0 6px 20px rgba(77, 107, 254, 0.5);
            }

            /* ---------- 悬浮卡片（固定暗色主题：纯黑底白字） ---------- */
            #ds-translate-card {
                position: fixed;
                z-index: 2147483000;
                width: ${CONFIG.cardWidth}px;
                max-height: ${CONFIG.cardMaxHeight}px;
                background: #000000;
                border: 1px solid #2a2d33;
                border-radius: 10px;
                box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55);
                box-sizing: border-box;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
                font-size: 14px;
                line-height: 1.7;
            }
            #ds-translate-card-scroll {
                max-height: ${CONFIG.cardMaxHeight - 2}px;
                overflow-y: auto;
                padding: 14px 16px 16px;
                box-sizing: border-box;
                border-radius: 10px;
            }
            #ds-translate-card-scroll, #ds-translate-card-scroll * {
                color: #f3f5f7;
            }
            #ds-translate-card-scroll a {
                color: #6ea8ff !important;
                text-decoration: underline;
            }
            #ds-translate-card-scroll code,
            #ds-translate-card-scroll pre {
                background: rgba(255, 255, 255, 0.08) !important;
            }
            #ds-translate-card-scroll table,
            #ds-translate-card-scroll th,
            #ds-translate-card-scroll td {
                border-color: rgba(255, 255, 255, 0.25) !important;
            }
            #ds-translate-card-close {
                position: absolute;
                top: 6px;
                right: 8px;
                width: 24px;
                height: 24px;
                line-height: 24px;
                text-align: center;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.12);
                color: #c9ccd4;
                cursor: pointer;
                font-size: 13px;
                user-select: none;
                z-index: 1;
            }
            #ds-translate-card-close:hover {
                background: rgba(255, 255, 255, 0.25);
            }
            #ds-translate-card-drag {
                position: absolute;
                top: 6px;
                left: 8px;
                width: 24px;
                height: 24px;
                line-height: 24px;
                text-align: center;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.12);
                color: #c9ccd4;
                cursor: move;
                font-size: 12px;
                user-select: none;
                z-index: 1;
            }
            #ds-translate-card-drag:hover {
                background: rgba(255, 255, 255, 0.25);
            }
            #ds-translate-card-status {
                color: #8a8f99 !important;
                font-size: 13px;
            }
            #ds-translate-card-status .dots::after {
                content: '';
                animation: ds-card-dots 1.2s steps(4, end) infinite;
            }
            @keyframes ds-card-dots {
                0%  { content: ''; }
                25% { content: '.'; }
                50% { content: '..'; }
                75% { content: '...'; }
            }
        `);

        let selectedText = '';
        let popupBtn = null;
        let hideTimer = null;
        let currentMouseX = 0;
        let currentMouseY = 0;
        let card = null;
        let cardScroll = null;
        let cardStatus = null;
        let cardBody = null;
        let cardAnchorX = 0;
        let cardAnchorY = 0;
        let cardTimeoutTimer = null;
        let relayPollTimer = null;   // GM 存储轮询定时器（卡片存在期间运行）
        let cardPinned = false;   // 用户拖动后位置固定，不再自动跟随
        let workerWin = null;     // 后台工作标签页引用

        function createPopupButton() {
            if (popupBtn) return;
            popupBtn = document.createElement('button');
            popupBtn.id = 'translate-popup-btn';
            // 内联 SVG 地球图标。注意：必须用 createElementNS 构建，
            // 不能用 innerHTML——YouTube 等站点开启了 Trusted Types
            // 策略，innerHTML 赋值会被直接拦截抛错导致按钮创建失败。
            const svgNS = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(svgNS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '18');
            svg.setAttribute('height', '18');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', '#fff');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            const c = document.createElementNS(svgNS, 'circle');
            c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '10');
            const l = document.createElementNS(svgNS, 'line');
            l.setAttribute('x1', '2'); l.setAttribute('y1', '12'); l.setAttribute('x2', '22'); l.setAttribute('y2', '12');
            const p = document.createElementNS(svgNS, 'path');
            p.setAttribute('d', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z');
            svg.appendChild(c); svg.appendChild(l); svg.appendChild(p);
            popupBtn.appendChild(svg);
            popupBtn.setAttribute('title', '翻译选中内容');
            popupBtn.setAttribute('aria-label', '翻译选中内容');
            document.body.appendChild(popupBtn);

            popupBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                triggerTranslation(selectedText, currentMouseX, currentMouseY);
                hidePopupButton();
            });

            popupBtn.addEventListener('mouseleave', function() {
                hideTimer = setTimeout(hidePopupButton, 300);
            });
            popupBtn.addEventListener('mouseenter', function() {
                clearTimeout(hideTimer);
            });
        }

        function showPopupButton(x, y) {
            if (!popupBtn) createPopupButton();
            popupBtn.style.display = 'flex';
            popupBtn.style.left = (x + 8) + 'px';
            popupBtn.style.top = (y - 16) + 'px';
            clearTimeout(hideTimer);
        }

        function hidePopupButton() {
            if (popupBtn) popupBtn.style.display = 'none';
        }

        // ---------- 悬浮卡片 ----------

        function removeCard() {
            if (cardTimeoutTimer) { clearTimeout(cardTimeoutTimer); cardTimeoutTimer = null; }
            if (relayPollTimer) { clearInterval(relayPollTimer); relayPollTimer = null; }
            if (card) { card.remove(); card = null; }
            cardScroll = null;
            cardStatus = null;
            cardBody = null;
            cardPinned = false;
        }

        function showFloatingCard(x, y) {
            removeCard();
            cardAnchorX = x;
            cardAnchorY = y;

            card = document.createElement('div');
            card.id = 'ds-translate-card';

            cardScroll = document.createElement('div');
            cardScroll.id = 'ds-translate-card-scroll';
            card.appendChild(cardScroll);

            cardStatus = document.createElement('div');
            cardStatus.id = 'ds-translate-card-status';
            // 不用 innerHTML（TT 站点会抛错）：文本 + 独立 dots 节点
            cardStatus.textContent = '翻译中';
            const statusDots = document.createElement('span');
            statusDots.className = 'dots';
            cardStatus.appendChild(statusDots);
            cardScroll.appendChild(cardStatus);

            cardBody = document.createElement('div');
            cardBody.id = 'ds-translate-card-body';
            cardScroll.appendChild(cardBody);

            const closeBtn = document.createElement('div');
            closeBtn.id = 'ds-translate-card-close';
            closeBtn.textContent = '✕';
            closeBtn.title = '关闭卡片';
            closeBtn.addEventListener('click', removeCard);
            card.appendChild(closeBtn);

            // 左上角拖动手柄：按住可把卡片拖到任意位置，拖后位置固定
            const dragHandle = document.createElement('div');
            dragHandle.id = 'ds-translate-card-drag';
            dragHandle.title = '拖动卡片';
            // 握把用 SVG 画六个圆点，替代 ⠿（U+283F）等可能在
            // 部分系统缺失字形的字符，保证任何平台都能显示
            const gripNS = 'http://www.w3.org/2000/svg';
            const grip = document.createElementNS(gripNS, 'svg');
            grip.setAttribute('viewBox', '0 0 16 16');
            grip.setAttribute('width', '12');
            grip.setAttribute('height', '12');
            grip.setAttribute('fill', 'currentColor');
            [4, 8, 12].forEach(function(cy) {
                [5.5, 10.5].forEach(function(cx) {
                    const dot = document.createElementNS(gripNS, 'circle');
                    dot.setAttribute('cx', cx);
                    dot.setAttribute('cy', cy);
                    dot.setAttribute('r', '1.4');
                    grip.appendChild(dot);
                });
            });
            grip.style.display = 'block';
            grip.style.margin = '6px auto 0';
            dragHandle.appendChild(grip);
            makeCardDraggable(dragHandle);
            card.appendChild(dragHandle);

            document.body.appendChild(card);
            positionCard();

            // 超时提示：60s 没有任何译文则提示检查登录状态
            cardTimeoutTimer = setTimeout(function() {
                if (cardStatus && cardBody && !cardBody.firstChild) {
                    cardStatus.textContent = '等待超时：请确认 DeepSeek 已登录';
                }
            }, 60000);
        }

        function makeCardDraggable(handle) {
            handle.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (!card) return;
                cardPinned = true;
                const rect = card.getBoundingClientRect();
                const dx = e.clientX - rect.left;
                const dy = e.clientY - rect.top;

                function onMove(ev) {
                    if (!card) return cleanup();
                    // 拖动时允许大部分移出屏幕，但保留可抓回来的边角
                    let left = Math.min(Math.max(ev.clientX - dx, -rect.width + 48), window.innerWidth - 48);
                    let top = Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 48);
                    card.style.left = left + 'px';
                    card.style.top = top + 'px';
                }
                function cleanup() {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', cleanup);
                }
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', cleanup);
            });
        }

        function positionCard() {
            if (!card || cardPinned) return;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const rect = card.getBoundingClientRect();

            let left = cardAnchorX + CONFIG.offsetX;
            if (left + rect.width > vw) {
                left = cardAnchorX - CONFIG.offsetX - rect.width;
            }
            if (left < 0) left = 10;

            let top = cardAnchorY + CONFIG.offsetY;
            if (top + rect.height > vh) {
                top = vh - rect.height - 10;
            }
            if (top < 0) top = 10;

            card.style.left = left + 'px';
            card.style.top = top + 'px';
        }

        // 接收工作标签页回传的流式译文
        // 双通道：GM 存储跨标签通知（主） + postMessage（备）
        let lastRelayTs = 0;

        function handleRelay(d) {
            if (!card) return;
            if (d.ts) {
                if (d.ts <= lastRelayTs) return;   // 丢弃重复/乱序消息
                lastRelayTs = d.ts;
            }

            if (d.error) {
                if (cardStatus) cardStatus.textContent = '出错了：' + d.error;
                return;
            }

            if (typeof d.html === 'string' && cardBody) {
                // TT 安全写入：策略可用则渲染 HTML，否则降级为纯文本
                safeSetHTML(cardBody, d.html, d.text);
                if (cardStatus) { cardStatus.remove(); cardStatus = null; }
            }

            if (d.done) {
                if (cardTimeoutTimer) { clearTimeout(cardTimeoutTimer); cardTimeoutTimer = null; }
                log('译文接收完成');
            }

            positionCard();
            if (cardScroll) cardScroll.scrollTop = cardScroll.scrollHeight;
        }

        window.addEventListener('message', function(e) {
            if (!e.origin || !e.origin.startsWith('https://chat.deepseek.com')) return;
            const d = e.data;
            if (!d || d.source !== RELAY_SOURCE) return;
            handleRelay(d);
        });

        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(RELAY_KEY, function(name, oldValue, newValue, remote) {
                if (!remote) return;
                try {
                    const d = JSON.parse(newValue);
                    if (d && d.source === RELAY_SOURCE) handleRelay(d);
                } catch(e) {}
            });
        }

        // 第三条通道：主动轮询 GM 存储。
        // Tampermonkey 的跨标签值变更通知有同步延迟（后台任务多时可达数秒），
        // 非 opener 页面又收不到 postMessage，只靠通知会卡顿。
        // 卡片存在期间每 60ms 直接读一次最新值（与工作页 60ms 写入限频对齐），
        // 前台定时器不受节流，配合 handleRelay 的时间戳去重，
        // 与另两条通道互不冲突、谁先到用谁。
        function startRelayPolling() {
            if (relayPollTimer || typeof GM_getValue !== 'function') return;
            relayPollTimer = setInterval(() => {
                if (!card) return;
                try {
                    const raw = GM_getValue(RELAY_KEY, null);
                    if (!raw) return;
                    const d = JSON.parse(raw);
                    if (d && d.source === RELAY_SOURCE) handleRelay(d);
                } catch(e) {}
            }, 60);
        }

        // ---------- 触发翻译 ----------

        function triggerTranslation(text, mouseX, mouseY) {
            if (!text || text.trim().length === 0) return;

            const seq = Date.now();

            // 1. 先把任务写进 GM 存储（工作页无论新旧都能拿到）
            GM_setValue(TASK_KEY, JSON.stringify({
                seq: seq,
                text: text.trim(),
                targetLang: CONFIG.targetLang
            }));

            showFloatingCard(mouseX, mouseY);
            startRelayPolling();
            ensureWorkerTab();
        }

        // 后台工作标签页：常驻复用，绝不以"窗口"形式出现。
        // 浏览器对后台标签页从不冻结 JS（这是所有网页自动化依赖的
        // 可靠行为），所以回传永远不会像离屏窗口那样卡死。
        function isWorkerAlive() {
            // 工作页每 5 秒广播一次心跳（GM 存储是所有标签页共享的），
            // 心跳新鲜 = 某个标签页（哪怕是别的页面开的）里工作页还活着
            try {
                const hb = GM_getValue(HEARTBEAT_KEY, 0);
                return hb && (Date.now() - hb < HEARTBEAT_STALE);
            } catch(e) {
                return false;
            }
        }

        function ensureWorkerTab() {
            if (workerWin && !workerWin.closed) {
                // 本页面自己开的工作页已存活，任务会通过 GM 存储通知它
                log('复用本页工作标签页');
                return;
            }
            if (isWorkerAlive()) {
                // 别的页面打开的工作页还活着：任务照样通过 GM 存储下发，
                // 它监听到后会翻译并回传，本页无需（也不能）重复开新页。
                // （Chrome 的命名窗口只对同一个 opener 复用，跨标签页
                // window.open 同名会开新标签，所以这里绝不能再 open）
                log('检测到其他页面的工作标签页存活，直接复用');
                return;
            }
            // 心跳已死（从未打开/被手动关闭/空闲自动关闭）：开新工作页。
            // 首次会短暂出现在前台加载，之后常驻后台。
            log('打开新的工作标签页');
            workerWin = window.open(CONFIG.deepseekUrl, CONFIG.workerName);
        }

        let mouseX = 0, mouseY = 0;
        let showButtonTimer = null;

        document.addEventListener('mouseup', function(e) {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            if (text.length > 0) {
                selectedText = text;
                mouseX = e.clientX;
                mouseY = e.clientY;
                currentMouseX = mouseX;
                currentMouseY = mouseY;
                clearTimeout(showButtonTimer);
                showButtonTimer = setTimeout(() => {
                    if (window.getSelection().toString().trim() === text) {
                        showPopupButton(mouseX, mouseY);
                    }
                }, CONFIG.buttonDelay);
            } else {
                hidePopupButton();
            }
        });

        document.addEventListener('mousemove', function(e) {
            currentMouseX = e.clientX;
            currentMouseY = e.clientY;
        });

        document.addEventListener('mousedown', function(e) {
            if (popupBtn && !popupBtn.contains(e.target)) hidePopupButton();
        });
        document.addEventListener('scroll', hidePopupButton);

        createPopupButton();
        log('普通网页部分已加载');

    // ============================================================
    //  DeepSeek 页面部分（后台工作标签页：自动发送 + 回传译文）
    // ============================================================
    } else {
        // 标签页标题改成"翻译助手"，方便在标签栏里辨认、和普通 DS 页面区分
        document.title = '翻译助手';

        log('DeepSeek 工作标签页已加载');

        let lastTaskSeq = 0;      // 已处理/已接收的最大任务序号
        let busy = false;         // 当前是否有任务在跑
        let queuedTask = null;    // 忙碌时到达的最新任务（只保留最新）
        let lastActivity = Date.now();   // 最后活动时间（用于空闲自动关闭）
        let relayStarted = false;

        let lastHTML = '';
        let lastText = '';         // 译文纯文本（TT 站点降级显示时用）
        let thinkWrapCache = null; // "思考过程"容器缓存（每轮任务重置）
        let baselineNode = null;   // 本轮开始时的最后一条回复（旧译文基线）
        let baselineHTML = null;   // 该基线当时的内容快照
        let lastChangeTime = 0;
        let doneSent = false;
        let tsSeq = Date.now();
        let lastStorageWrite = 0;

        // ---------- 任务接收 ----------

        function acceptTask(task) {
            if (!task || !task.seq || task.seq <= lastTaskSeq) return;   // 重复/过期任务
            lastTaskSeq = task.seq;
            lastActivity = Date.now();
            if (busy) {
                queuedTask = task;   // 忙碌时只保留最新任务
                log('忙碌中，任务已排队', task.seq);
            } else {
                runTask(task);
            }
        }

        function runTask(task) {
            busy = true;
            doneSent = false;
            lastHTML = '';
            lastText = '';
            thinkWrapCache = null;
            // 基线：新任务开始时旧译文可能还留在 DOM 里，若不排除，第一帧
            // 突变就会把上一轮结果当成新内容回传（卡片先显示上一次译文、
            // 再跳成当前结果）。记录基线后，内容仍等于基线时一律忽略。
            const outs = document.querySelectorAll('.ds-markdown');
            baselineNode = outs.length ? outs[outs.length - 1] : null;
            baselineHTML = baselineNode ? baselineNode.innerHTML : null;
            lastChangeTime = Date.now();
            lastActivity = Date.now();
            log('开始翻译任务', task.seq);
            startRelay();
            autoTranslate(task.text, task.targetLang);
        }

        function finishTask() {
            busy = false;
            lastActivity = Date.now();
            if (queuedTask) {
                const t = queuedTask;
                queuedTask = null;
                setTimeout(() => acceptTask(t), 800);
            }
        }

        // 页面加载时：读取可能已经写入的任务（首次划词后标签页才打开的场景）
        try {
            const raw = GM_getValue(TASK_KEY, null);
            if (raw) {
                const task = JSON.parse(raw);
                // 60 秒内的任务才算数，更早的视为残渣
                if (task && task.seq && Date.now() - task.seq < 60000) {
                    acceptTask(task);
                }
            }
        } catch(e) {
            log('读取初始任务失败', e);
        }

        // 标签页常驻：监听后续任务（划词页直接写入，无需重开标签页）
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(TASK_KEY, function(name, oldValue, newValue, remote) {
                if (!remote) return;
                try {
                    acceptTask(JSON.parse(newValue));
                } catch(e) {
                    log('任务解析失败', e);
                }
            });
        }

        // 心跳广播：让所有划词页知道"工作页还活着"，从而跨标签页复用，
        // 避免每个页面第一次划词都重复开一个新的 DS 标签页。
        // 标签页关闭（手动或空闲自动关闭）后 setInterval 随之消亡，心跳自然停止。
        try { GM_setValue(HEARTBEAT_KEY, Date.now()); } catch(e) {}
        setInterval(() => {
            try { GM_setValue(HEARTBEAT_KEY, Date.now()); } catch(e) {}
        }, HEARTBEAT_INTERVAL);

        // 空闲自动关闭：3 分钟没有任务就自己关掉，保持标签栏干净
        setInterval(() => {
            if (!busy && lastTaskSeq && Date.now() - lastActivity > CONFIG.workerIdleCloseMs) {
                log('空闲超时，自动关闭工作标签页');
                try { window.close(); } catch(e) {}
            }
        }, 15000);

        // ---------- 译文回传 ----------

        function nextTs() {
            tsSeq = Math.max(tsSeq + 1, Date.now());
            return tsSeq;
        }

        // 双通道回传：1) GM 存储跨标签通知（主）；2) postMessage 给 opener（备）。
        // 卡片端按时间戳去重，两条路谁先到用谁。
        function relayMessage(payload) {
            const full = Object.assign({ source: RELAY_SOURCE, ts: nextTs() }, payload);

            // 通道1：GM 存储通知（流式期间限频 60ms，对齐 postMessage 的
            // 实时感；完成/出错立即写）。60ms 是 A 页逐字与 B 页颗粒度
            // 一致的关键——限频太松会让非 opener 页面"一段一段"出字。
            try {
                const now = Date.now();
                if (payload.done || payload.error || now - lastStorageWrite > 60) {
                    lastStorageWrite = now;
                    GM_setValue(RELAY_KEY, JSON.stringify(full));
                }
            } catch(e) {
                log('GM 存储回传失败', e);
            }

            // 通道2：postMessage
            try {
                if (window.opener && !window.opener.closed) {
                    window.opener.postMessage(full, '*');
                }
            } catch(e) {
                log('postMessage 回传失败', e);
            }
        }

        function relayError(msg) {
            log('错误：' + msg);
            relayMessage({ error: msg });
        }

        function startRelay() {
            if (relayStarted) return;
            relayStarted = true;

            // 从所有 .ds-markdown 里挑出"最终译文"，排除思考过程：
            // DeepSeek 的"已深度思考（用时 X 秒）"折叠条和思考内容共用
            // 一个容器，最终译文在这个容器外面。找到该容器的最内层包裹，
            // 排除其中的 markdown，取剩下的最后一条。
            // 若结构对不上（官网改版）则退回旧行为：取最后一条。
            function detectThinkWrap() {
                const hints = document.querySelectorAll('div,button,span');
                for (const el of hints) {
                    const t = (el.textContent || '').trim();
                    // 提示条都是短文本，限制长度防止误伤正文里提到"思考"的段落
                    if (t.length === 0 || t.length > 30) continue;
                    if (!/已深度思考|思考过程|思考中|思考完毕|已搜索到|联网搜索/.test(t)) continue;

                    // 从提示条向上找"最内层的、直接包含 .ds-markdown 的容器"
                    let p = el.parentElement;
                    while (p && p !== document.body) {
                        if (p.querySelector('.ds-markdown')) {
                            // 容器本身不能是 markdown（防止误伤正文），
                            // 思考折叠条是独立于 markdown 的元素
                            if (!p.matches('.ds-markdown')) return p;
                            break;
                        }
                        p = p.parentElement;
                    }
                }
                return null;
            }

            // 性能：思考容器在一次回复内基本不变。找到后缓存复用，
            // 避免每次 DOM 突变都做一次全页 textContent 扫描；每轮任务
            // 开始时由 runTask 重置缓存。
            function getThinkWrap() {
                if (thinkWrapCache && thinkWrapCache.isConnected) return thinkWrapCache;
                thinkWrapCache = detectThinkWrap();
                return thinkWrapCache;
            }

            function pickAnswerMarkdown() {
                const outputs = document.querySelectorAll('.ds-markdown');
                if (!outputs.length) return null;

                const thinkWrap = getThinkWrap();
                if (thinkWrap) {
                    for (let i = outputs.length - 1; i >= 0; i--) {
                        if (!thinkWrap.contains(outputs[i])) return outputs[i];
                    }
                    return null;   // 目前只有思考内容 → 不回传
                }
                return outputs[outputs.length - 1];
            }

            // 防抖：流式输出期间 DOM 每秒突变几十次，若不合并会造成
            // 高频全页扫描 + 高频写 GM 存储（后台标签页尤为明显）。
            let relayScheduled = false;
            function scheduleRelayCheck() {
                if (relayScheduled) return;
                relayScheduled = true;
                setTimeout(function() {
                    relayScheduled = false;
                    const answer = pickAnswerMarkdown();
                    if (!answer) return;
                    const html = answer.innerHTML;
                    if (!html) return;
                    // 仍是上一轮遗留在 DOM 里的旧译文 → 忽略，等新内容出现
                    if (answer === baselineNode && html === baselineHTML) return;
                    if (html !== lastHTML) {
                        lastHTML = html;
                        lastText = answer.textContent || '';
                        lastChangeTime = Date.now();
                        relayMessage({ html: lastHTML, text: lastText, done: false });
                    }
                }, 120);
            }

            const mo = new MutationObserver(scheduleRelayCheck);
            mo.observe(document.body, { childList: true, subtree: true, characterData: true });

            // 完成检测：内容停止变化超过 doneIdleMs 视为输出完毕。
            // 注意：后台标签页的 setInterval 最多被钳到 1 秒一次，
            // 只影响"完成"信号的延迟，不影响流式内容（靠 MutationObserver）。
            setInterval(() => {
                if (doneSent || !lastHTML) return;
                if (Date.now() - lastChangeTime > CONFIG.doneIdleMs) {
                    doneSent = true;
                    relayMessage({ html: lastHTML, text: lastText, done: true });
                    log('译文回传完毕');
                    finishTask();
                }
            }, 300);
        }

        // ---------- 自动填充与发送 ----------

        function autoTranslate(text, targetLang) {
            const prompt = `仅输出${targetLang}译文：
        """
        ${text}
        """

        输出示例：
        The translated text itself`;

            log('提示词已构建');

            function findInput() {
                let input = document.querySelector('textarea[name="search"]');
                if (input) return input;
                input = document.querySelector('textarea.d96f2d2a');
                if (input) return input;
                input = document.querySelector('textarea');
                return input;
            }

            function findSendButton() {
                const candidates = document.querySelectorAll('div[role="button"]');
                for (let btn of candidates) {
                    const svg = btn.querySelector('svg');
                    if (svg) {
                        const path = svg.querySelector('path[d^="M8.3125"]');
                        if (path) return btn;
                    }
                }
                for (let btn of candidates) {
                    if (!btn.classList.contains('ds-button--disabled')) return btn;
                }
                return null;
            }

            function fillInput(input, value) {
                input.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    HTMLTextAreaElement.prototype,
                    'value'
                ).set;
                nativeSetter.call(input, value);
                ['input', 'change', 'keydown', 'keyup'].forEach(type => {
                    input.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
                });
                input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
                input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
                log('输入框已填充');
            }

            function clickSendButton(btn, input) {
                return new Promise((resolve) => {
                    if (btn.classList.contains('ds-button--disabled')) {
                        log('发送按钮禁用，等待启用...');
                        const observer = new MutationObserver(() => {
                            if (!btn.classList.contains('ds-button--disabled')) {
                                observer.disconnect();
                                btn.click();
                                log('点击发送按钮');
                                resolve();
                            }
                        });
                        observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
                        setTimeout(() => {
                            observer.disconnect();
                            if (btn.classList.contains('ds-button--disabled')) {
                                log('发送按钮超时未启用');
                                relayError('DeepSeek 发送按钮未就绪，请重试');
                                finishTask();
                                resolve();
                            }
                        }, 5000);
                    } else {
                        btn.click();
                        log('点击发送按钮');
                        resolve();
                    }
                });
            }

            // 轮询等待元素出现：后台标签页首次加载 / SPA 尚未渲染完时，输入框
            // 会晚于脚本启动才就绪，固定 sleep 会误判"未找到输入框"而丢任务。
            async function waitFor(fn, timeout) {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    const el = fn();
                    if (el) return el;
                    await sleep(250);
                }
                return null;
            }

            (async function() {
                const newBtn = document.querySelector('button[aria-label="新对话"], button[aria-label="新建对话"], .new-chat-btn');
                if (newBtn) newBtn.click();

                await sleep(300);

                const input = await waitFor(function() {
                    const el = findInput();
                    return (el && !el.disabled) ? el : null;
                }, 15000);
                if (!input) {
                    // 不自动关闭：用户可能需要在这个标签页里登录 DeepSeek
                    relayError('DeepSeek 页面未找到输入框，请点击"翻译助手"标签页确认已登录');
                    finishTask();
                    return;
                }

                fillInput(input, prompt);
                await sleep(400);

                const sendBtn = await waitFor(findSendButton, 10000);
                if (sendBtn) {
                    await clickSendButton(sendBtn, input);
                } else {
                    relayError('未找到发送按钮，请重试');
                    finishTask();
                }
            })();
        }

        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    }

})();
