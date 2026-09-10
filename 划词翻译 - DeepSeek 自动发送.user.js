// ==UserScript==
// @name         划词翻译 - DeepSeek 自动发送
// @namespace    http://tampermonkey.net/
// @version      19.8.12
// @description  划词打开 DeepSeek 独立窗口（鼠标旁，自适应左右），自动填充发送，隐藏杂项元素，窗口高度随译文自适应；所有网页共用同一条对话链，翻译窗口自动接管
// @author       KniphH
// @match        *://*/*
// @match        https://chat.deepseek.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @license MIT
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        targetLang: '中文',
        deepseekUrl: 'https://chat.deepseek.com/',
        buttonDelay: 300,
        windowWidth: 320,
        windowHeight: 480,
        heightPadding: 20,   // 高度补偿：窗口里是 DS 页面本身（非蒙版），需额外容纳页面上下元素
        offsetX: 20,   // 水平偏移量（正数表示向右，如果右侧空间不够则向左偏移相同距离）
        offsetY: 20,   // 垂直偏移量（始终向下）
    };

    const isDeepSeek = location.href.startsWith('https://chat.deepseek.com/');

    // 跨页共享状态（GM 存储对所有网页可见，这是唯一能跨页通信的通道）
    const SHARED_URL_KEY = 'ds_last_url';        // 最近一次翻译所在的对话地址
    const WORKER_OWNER_KEY = 'ds_worker_owner';  // 翻译窗口存活心跳（含 id/出生时间/地址）
    const TASK_CLAIM_KEY = 'ds_task_claim';      // 任务认领：避免多个窗口把同一任务发两遍

    function log(msg, data) {
        console.log(`[划词翻译] ${msg}`, data || '');
    }

    // ============================================================
    //  普通网页部分（划词按钮）
    // ============================================================
    if (!isDeepSeek) {
        GM_addStyle(`
            #translate-popup-btn {
                position: fixed;
                z-index: 999999;
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
        `);

        let selectedText = '';
        let popupBtn = null;
        let hideTimer = null;
        let currentMouseX = 0;
        let currentMouseY = 0;

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
                openDeepSeekWindow(selectedText, currentMouseX, currentMouseY);
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

        let dsWin = null;   // 本页面打开的 DeepSeek 窗口引用（用于复用）
        let dsWinUrl = '';  // DS 窗口当前地址（由 DS 页回传，用于同文档导航置前）

        // DS 窗口会回传自己的当前地址：复用置前时用它拼一个"仅片段不同"的
        // 地址（同文档导航），既能把窗口带到最前，又不会重新加载页面，
        // 对话链与页面状态因此完整保留。
        window.addEventListener('message', function(e) {
            if (!e.origin || !e.origin.startsWith('https://chat.deepseek.com')) return;
            const d = e.data;
            if (d && d.source === 'ds-window-info' && typeof d.url === 'string') {
                dsWinUrl = d.url;
            }
        });

        // 读取"最近一次翻译所在的对话地址"。该地址由 DS 窗口写进 GM 存储，
        // 对所有网页可见——这正是不同网页能共用同一条对话链的关键。
        function readSharedConversationUrl() {
            try { return GM_getValue(SHARED_URL_KEY, '') || ''; } catch(e) { return ''; }
        }

        // 读取并校验"翻译窗口存活登记"：心跳超过 4 秒没更新就视为窗口已关闭。
        // 有了它，别的网页也能知道"已经有一个翻译窗口开着"，从而复用它
        // 而不是再开一个、各自新建对话链。
        function getLiveWorker() {
            try {
                const raw = GM_getValue(WORKER_OWNER_KEY, null);
                if (!raw) return null;
                const info = JSON.parse(raw);
                if (info && typeof info.ts === 'number' && (Date.now() - info.ts) < 4000) {
                    return info;
                }
            } catch(e) {}
            return null;
        }

        function openDeepSeekWindow(text, mouseX, mouseY) {
            if (!text || text.trim().length === 0) return;

            // 先计算窗口位置：水平方向自适应左右。
            // ⚠️ left/top 必须在下方 GM_setValue 引用它们之前定义——
            // let/const 存在暂时性死区，声明前访问会抛 ReferenceError，
            // 导致整个点击流程中断（v19.8.5 引入、19.8.7 修复）。
            const screenWidth = window.screen.availWidth;
            const screenHeight = window.screen.availHeight;

            // 先尝试向右偏移
            let left = mouseX + CONFIG.offsetX;
            // 检查是否超出右边界
            if (left + CONFIG.windowWidth > screenWidth) {
                // 改为向左偏移
                left = mouseX - CONFIG.offsetX - CONFIG.windowWidth;
            }
            // 确保不超出左边界
            if (left < 0) left = 10;

            // 垂直方向：向下偏移
            let top = mouseY + CONFIG.offsetY;
            // 防止超出底部（但仍保留适应性）
            if (top + CONFIG.windowHeight > screenHeight) {
                top = screenHeight - CONFIG.windowHeight - 10;
            }
            if (top < 0) top = 10;

            // 复用判定：
            //  · 本页面开的窗口还活着 → 复用（同文档导航置前，最可靠）
            //  · 其它网页开的窗口还活着（跨页心跳登记）→ 也复用，这样所有
            //    网页共用同一个对话链，而不是各开各的
            const localAlive = !!(dsWin && !dsWin.closed);
            const liveWorker = getLiveWorker();
            const reusing = localAlive || !!liveWorker;

            // 对话地址来源优先级：本页实时回传 > 存活窗口自报 > 全局共享。
            // 注意这里**不**回退到首页：reuse 时若已知地址为空，宁可只做位置
            // 校正也不导航——否则会把窗口导到首页、把对话链重置成新对话。
            const sharedUrl = readSharedConversationUrl();
            const knownUrl = dsWinUrl
                || (liveWorker && liveWorker.url)
                || sharedUrl
                || '';

            // left/top 一并下发：features 对已存在的命名窗口无效（几何参数
            // 会被忽略），由 DS 端加载完成后自行 moveTo 到鼠标旁兜底
            //
            // freshWindow 的依据是 localAlive（本页自己的窗口），而不是
            // reusing：跨站打开时浏览器多半会新建窗口（命名窗口按"浏览上下文
            // 组"隔离），此时该由新窗口来处理，旧窗口要主动让位；只有"本页自己
            // 的窗口"才直接交由它处理。
            GM_setValue('pending_translation', JSON.stringify({
                text: text.trim(),
                targetLang: CONFIG.targetLang,
                timestamp: Date.now(),
                seq: Date.now(),   // 序号去重：复用窗口时 DS 窗口据此识别新任务
                freshWindow: !localAlive,
                left: left,
                top: top
            }));

            const features = [
                `width=${CONFIG.windowWidth}`,
                `height=8`,   // 初始高度压到最小（浏览器会强制钳到自身最小高度），译文输出后再自适应展开
                `left=${left}`,
                `top=${top}`,
                'menubar=no',
                'toolbar=no',
                'location=no',
                'status=no',
                'scrollbars=yes',
                'resizable=yes'
            ].join(',');

            // 复用优先：只要已有一个翻译窗口活着（本页的或其它网页的），就
            // 复用它而不是再开一个——这是"所有网页共用同一条对话链"的落点。
            // 普通弹窗唯一可靠的置前手段是"同名 open"：脚本对跨源弹窗调用
            // focus() 会被防抢焦点策略忽略。若新地址与窗口当前地址仅片段
            // 不同，即为同文档导航，既置前又不重载，对话链完整保留。
            if (reusing) {
                // 置前且不重载：对"已存在的命名窗口"调用 window.open 会把
                // 它带到最前；只要新地址与当前地址**仅片段不同**，就是同文档
                // 导航（只改 hash，不重新加载页面），页面状态与对话链完整保留。
                // 地址来自 DS 窗口实时回传；拿不到时退回纯位置校正。
                try {
                    // 拼一个"仅片段不同"的地址：既让浏览器把已存在的同名窗口带到最前
                    // （同文档导航，不重载），又通过 #ds-worker 标记让 DS 页确认
                    // "这是划词脚本打开的翻译窗口"。地址未知时退化为只校正位置。
                    const focusUrl = knownUrl
                        ? knownUrl.split('#')[0] + '#ds-worker-' + Date.now()
                        : null;
                    if (focusUrl) {
                        dsWin = window.open(focusUrl, 'ds_translate_window', features);
                        log('复用 DeepSeek 窗口（同文档导航置前，不重载）');
                    } else {
                        log('复用 DeepSeek 窗口（地址未知，仅校正位置）');
                    }
                } catch(e) {
                    log('置前失败（不影响翻译）', e);
                }
                // 几何校正：命名窗口会忽略 features 的位置参数，分多次重试
                //（DS 端收到 task.left/top 后也会自行 moveTo，双保险）
                [0, 150, 500, 1200].forEach(function(delay) {
                    setTimeout(function() {
                        try {
                            if (dsWin && !dsWin.closed) {
                                dsWin.moveTo(left, top);
                                dsWin.resizeTo(CONFIG.windowWidth, 8);
                                dsWin.focus();
                            }
                        } catch(e) {}
                    }, delay);
                });
                return;
            }

            // 命名窗口：即使本页面中途刷新过（dsWin 引用丢失），同名 open
            // 也能找回并接管已有窗口，而不是再开一个。若已知它停在哪个对话，
            // 优先导航回该地址，避免重载后掉出原对话链；地址未知才回首页。
            // 一律带上 #ds-worker 标记，供 DS 页识别"这是翻译窗口"。
            const reopenUrl = (knownUrl || CONFIG.deepseekUrl).split('#')[0]
                + '#ds-worker-' + Date.now();
            dsWinUrl = '';
            dsWin = window.open(reopenUrl, 'ds_translate_window', features);
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
    //  DeepSeek 页面部分（仅自动发送）
    // ============================================================
    } else {
        log('DeepSeek 页面已加载');

        // 关键辨识：只有"由划词脚本打开的翻译窗口"才参与跨页共享与自动发送。
        // 否则用户自己开着的普通 DeepSeek 标签页也会收到任务通知、抢走翻译，
        // 甚至被"接管"逻辑误关。判别方式：翻译窗口一定由外部网页 window.open
        // 打开，因此 window.opener 存在且来自非 deepseek 站点。
        // 可靠凭据：划词脚本打开的窗口一律带 #ds-worker-<时间戳> 片段，加载时
        // 把它记进 sessionStorage（随窗口存活、跨刷新保持）。这样即便后续 SPA
        // 改写地址、或浏览器清空了 window.name，仍能认出"这是翻译窗口"。
        try {
            if (location.hash.indexOf('#ds-worker') === 0) {
                sessionStorage.setItem('ds_is_worker', '1');
            }
        } catch(e) {}

        const isTranslateWindow = (function() {
            // ① 标记（最可靠）：普通 DS 标签页永远不会带这个标记
            try { if (sessionStorage.getItem('ds_is_worker') === '1') return true; } catch(e) {}
            // ② 窗口名：window.open 的同名 target
            if (window.name === 'ds_translate_window') return true;
            // ③ opener 兜底：翻译窗口必由外部网页打开
            try {
                if (!window.opener) return false;
                const openerHref = window.opener.location.href;   // 跨源会抛错
                return !openerHref.startsWith('https://chat.deepseek.com');
            } catch(e) {
                return true;   // 跨源 opener → 正是翻译窗口
            }
        })();

        var workerId = '';       // 本窗口唯一标识（翻译窗口才会被赋值）
        var myBorn = 0;          // 本窗口"出生时间"，用于判断谁更新
        var superseded = false;  // 是否已被更新的窗口接管（接管后不再处理任务）
        var busy = false;        // 是否有一次翻译正在进行
        var pendingClose = false;// 被接管时若正忙，等这次翻译做完再关

        if (isTranslateWindow) {
            // ============================================================
            //  身份与跨页登记：对话地址回传 + 全局共享 + 存活心跳。
            // ============================================================
            // 借 sessionStorage 天然"随窗口存活、跨刷新保持、不同窗口互不相同"
            // 的特性生成稳定标识。刷新页面时 id/出生时间不变，避免把自己误判成
            // "被新窗口接管"而自我关闭。
            try {
                var savedWorker = JSON.parse(sessionStorage.getItem('ds_worker') || 'null');
                if (savedWorker && savedWorker.id && savedWorker.born) {
                    workerId = savedWorker.id;
                    myBorn = savedWorker.born;
                } else {
                    workerId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
                    myBorn = Date.now();
                    sessionStorage.setItem('ds_worker', JSON.stringify({ id: workerId, born: myBorn }));
                }
            } catch(e) {
                workerId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
                myBorn = Date.now();
            }

            var lastReportedUrl = '';
            var reportUrl = function() {
                try {
                    // 去掉置前/身份标记用的 #ds-worker-… 片段，登记干净的对话地址
                    const cleanUrl = location.href.split('#')[0];
                    if (location.href !== lastReportedUrl) {
                        lastReportedUrl = location.href;
                        // ① 全局登记当前对话地址（所有网页可见）
                        GM_setValue(SHARED_URL_KEY, cleanUrl);
                        // ② 回传地址给划词页，供其实现同文档导航置前
                        if (window.opener && !window.opener.closed) {
                            window.opener.postMessage({ source: 'ds-window-info', url: cleanUrl }, '*');
                        }
                    }
                    // ③ 心跳：登记"本窗口还活着"，附出生时间用于新旧判断
                    if (!superseded) {
                        GM_setValue(WORKER_OWNER_KEY, JSON.stringify({
                            id: workerId, born: myBorn, ts: Date.now(), url: cleanUrl
                        }));
                    }
                } catch(e) {}
            };
            reportUrl();
            setInterval(reportUrl, 1500);

            // 接管与自我关闭：当另一个"更年轻"的翻译窗口出现时，说明本窗口已被
            // 取代——主动关闭，保证任意时刻只有一个翻译窗口，避免多窗口抢任务。
            // 只认 born（出生时间）而非 ts（心跳时间），否则双方心跳都在刷新，
            // 永远分不出谁新谁旧。
            if (typeof GM_addValueChangeListener === 'function') {
                GM_addValueChangeListener(WORKER_OWNER_KEY, function(name, oldValue, newValue, remote) {
                    if (!remote || !newValue || superseded) return;
                    try {
                        const info = JSON.parse(newValue);
                        if (info && info.id && info.id !== workerId
                            && (Date.now() - info.ts) < 4000
                            && info.born > myBorn + 300) {
                            superseded = true;
                            log('翻译窗口已被更新的窗口接管，本窗口自动关闭');
                            tryCloseSelf();
                        }
                    } catch(e) {}
                });
            }
        }

        // 读取当前登记的翻译窗口心跳（判断"是否已有更新的窗口出现了"）
        function readWorkerInfo() {
            try {
                const raw = GM_getValue(WORKER_OWNER_KEY, null);
                return raw ? JSON.parse(raw) : null;
            } catch(e) { return null; }
        }

        // 被接管后就该关闭本窗口；但若此刻正在发送翻译，先让它发完再关，
        // 否则会丢掉这次正在进行的翻译。
        function tryCloseSelf() {
            if (!superseded) return;
            if (busy) { pendingClose = true; return; }
            setTimeout(function() { try { window.close(); } catch(e) {} }, 300);
        }

        // ============================================================
        //  杂项元素隐藏 + 窗口高度自适应
        //  v19.8.6 起不再使用全屏蒙版（纯净视图），直接观看 DS 页面
        //  本身：只隐藏侧边栏等杂项元素，窗口高度跟随最后一条回复。
        //  注意：所有状态变量必须声明在任何调用之前（v19.0 因声明
        //  顺序触发 TDZ 错误导致无法发送，19.1 已修复）。
        // ============================================================
        var pageStyleSetup = false;
        var syncScheduled = false;
        var lastTaskSeq = 0;      // 已处理的最大任务序号（复用窗口时去重）

        function setupPageStyle() {
            // 幂等：隐藏规则和监听只需建立一次
            if (pageStyleSetup) return;
            pageStyleSetup = true;

            // 隐藏杂项元素：用户指定的哈希类 + 结构兜底（侧边栏/导航）
            GM_addStyle(`
                ._2be88ba, ._871cbca { display: none !important; }
                aside, nav, [class*="sidebar"] { display: none !important; }
            `);

            // 监听 DOM：回复输出过程中持续调整窗口高度
            const mo = new MutationObserver(() => {
                if (syncScheduled) return;
                syncScheduled = true;
                setTimeout(() => {
                    syncScheduled = false;
                    adaptWindowSize();
                }, 150);
            });
            mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        }

        // 根据最后一条回复的实际渲染高度自适应窗口高度（上限 480，无人为下限）
        function adaptWindowSize() {
            const outputs = document.querySelectorAll('.ds-markdown');
            if (!outputs.length) return;
            // 最后一条回复的真实渲染高度（已含段落间距、换行、代码块等）
            const contentH = Math.ceil(outputs[outputs.length - 1].getBoundingClientRect().height);
            // 补偿浏览器边框/地址栏占用的内外高度差
            const chromeH = (window.outerHeight - window.innerHeight) || 0;
            // + 顶部内边距约 14 + 底部呼吸空间 32 + 显示补偿 20（窗口里现在是
            // DS 页面本身而非蒙版，需额外空间容纳页面上下的固定元素）
            const target = Math.min(CONFIG.windowHeight, contentH + 14 + 32 + 2 + CONFIG.heightPadding);
            if (Math.abs(target + chromeH - window.outerHeight) <= 1) return;
            try { window.resizeTo(CONFIG.windowWidth, target + chromeH); } catch(e) {}
        }

        // ============================================================
        //  翻译任务处理（与纯净视图初始化分开，互不影响）
        // ============================================================
        // 只有翻译窗口才读取/消费任务——普通 DS 标签页若也读取，会把任务
        // 提前删掉，导致真正的翻译窗口读不到任务而"发送失败"。
        let pendingTask = null;
        if (isTranslateWindow) {
            const pendingRaw = GM_getValue('pending_translation', null);
            if (pendingRaw) {
                try {
                    const pending = JSON.parse(pendingRaw);
                    if (Date.now() - pending.timestamp > 30000) {
                        GM_deleteValue('pending_translation');
                        log('任务已过期');
                    } else {
                        GM_deleteValue('pending_translation');
                        log('获取到翻译任务', pending);
                        pendingTask = pending;
                    }
                } catch(e) {
                    log('解析任务失败', e);
                }
            } else {
                log('没有待翻译任务');
            }
        }

        // 接收翻译任务：首载读取与"复用窗口"时的存储变更通知共用同一条路径
        function acceptTask(task) {
            if (!task) return;
            if (!isTranslateWindow) return;   // 普通 DS 标签页不参与
            if (superseded) return;           // 已被接管，不再抢任务

            // 跨窗口任务认领：多个窗口可能同时收到同一条任务通知（复用与新建
            // 交替的瞬间），只允许一个真正发送。做法是"先查后写"——若这条任务
            // 已被别的窗口认领就直接退出，避免同一句翻译在对话里发两遍。
            const ticket = String(task.seq || task.timestamp || '');
            try {
                const rawClaim = GM_getValue(TASK_CLAIM_KEY, null);
                const claim = rawClaim ? JSON.parse(rawClaim) : null;
                if (claim && claim.ticket === ticket && claim.by !== workerId) {
                    log('任务已被其它窗口认领，跳过', ticket);
                    return;
                }
                GM_setValue(TASK_CLAIM_KEY, JSON.stringify({ ticket: ticket, by: workerId, ts: Date.now() }));
            } catch(e) {}

            if (task.seq) {
                if (task.seq <= lastTaskSeq) return;   // 本窗口内重复/过期任务
                lastTaskSeq = task.seq;
            }
            // 消费掉任务：万一页面被重载，启动路径不会把同一任务再读出来发一次
            try { GM_deleteValue('pending_translation'); } catch(e) {}
            log('收到翻译任务', task.seq);
            // 兜底定位：划词页的 moveTo 重试若全部失效，由本窗口自行挪到鼠标旁
            if (typeof task.left === 'number' && typeof task.top === 'number') {
                const reposition = function() {
                    try {
                        window.moveTo(task.left, task.top);
                        window.resizeTo(CONFIG.windowWidth, 8);
                    } catch(e) {
                        log('窗口自行定位失败（不影响翻译）', e);
                    }
                };
                reposition();
                setTimeout(reposition, 500);
            }
            try {
                setupPageStyle();
            } catch(e) {
                log('杂项隐藏初始化失败（不影响翻译）', e);
            }
            busy = true;
            Promise.resolve(autoTranslate(task.text, task.targetLang)).then(afterTranslate, afterTranslate);

            function afterTranslate() {
                busy = false;
                // 若翻译期间已被新窗口接管，等这次发完再关闭，避免丢翻译
                if (pendingClose || superseded) tryCloseSelf();
            }
        }

        if (isTranslateWindow && pendingTask) {
            acceptTask(pendingTask);
        }

        // 复用窗口的关键：划词页更新任务时，本窗口收到存储变更通知，
        // 直接开始新一轮翻译（原地复用，页面不重载、对话链保留）
        if (isTranslateWindow && typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener('pending_translation', function(name, oldValue, newValue, remote) {
                if (!remote || !newValue) return;
                try {
                    const task = JSON.parse(newValue);
                    // freshWindow 的任务是"发给新窗口"的：是否真开了新窗口要看情况——
                    //  · 跨站打开：浏览器多半新建窗口，新窗口会自报心跳并处理任务，
                    //    本窗口应让位（随后被接管自动关闭）
                    //  · 同源复用：浏览器复用了本窗口（同文档导航，不重载），不会
                    //    有新窗口出现，本窗口必须自己处理，否则任务会丢
                    // 因此先等一小会儿，看有没有"更年轻的窗口"冒出来，再决定。
                    if (task.freshWindow) {
                        log('检测到新窗口任务，等待确认是否真的开了新窗口', task.seq);
                        setTimeout(function() {
                            if (superseded) return;   // 已被新窗口接管 → 交给它
                            const live = readWorkerInfo();
                            if (live && live.id !== workerId && live.born > myBorn + 300) {
                                log('确认已有新窗口接管，本窗口让位');
                                return;
                            }
                            acceptTask(task);
                        }, 4000);
                        return;
                    }
                    acceptTask(task);
                } catch(e) {
                    log('任务解析失败', e);
                }
            });
        }

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
                                log('发送按钮超时未启用，请手动点击发送');
                                alert('DeepSeek 发送按钮未就绪，请手动点击发送按钮。');
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

            // 轮询等待元素出现。直接打开"某个对话"的链接时（窗口被关掉后
            // 再划词就是这种情况），SPA 要先加载历史消息，输入框/发送按钮会
            // 明显晚于脚本启动才就绪；固定 sleep 会误判"未找到输入框"而丢任务。
            async function waitFor(fn, timeout) {
                const start = Date.now();
                while (Date.now() - start < timeout) {
                    const el = fn();
                    if (el) return el;
                    await sleep(250);
                }
                return null;
            }

            return (async function() {
                // 不再点"新对话"：每次翻译都接在同一个对话链后面，复用窗口
                // 时上下文连续，也不会把 DS 历史记录堆满零散的小对话。
                const input = await waitFor(function() {
                    const el = findInput();
                    return (el && !el.disabled) ? el : null;
                }, 15000);
                if (!input) {
                    alert('未找到输入框，请手动粘贴');
                    return;
                }

                fillInput(input, prompt);
                await sleep(400);

                const sendBtn = await waitFor(findSendButton, 10000);
                if (sendBtn) {
                    await clickSendButton(sendBtn, input);
                } else {
                    alert('未找到发送按钮，请手动点击发送。');
                }
            })();
        }

        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    }

})();