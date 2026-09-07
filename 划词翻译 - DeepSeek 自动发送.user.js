// ==UserScript==
// @name         划词翻译 - DeepSeek 自动发送
// @namespace    http://tampermonkey.net/
// @version      19.8.1
// @description  划词打开 DeepSeek 独立窗口（鼠标旁，自适应左右），自动填充发送，纯净视图只显示译文
// @author       YourName
// @match        *://*/*
// @match        https://chat.deepseek.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
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
        maxTextLength: 999999,
        offsetX: 20,   // 水平偏移量（正数表示向右，如果右侧空间不够则向左偏移相同距离）
        offsetY: 20,   // 垂直偏移量（始终向下）
    };

    const isDeepSeek = location.href.startsWith('https://chat.deepseek.com/');

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
            popupBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
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

        function openDeepSeekWindow(text, mouseX, mouseY) {
            if (!text || text.trim().length === 0) return;
            if (text.trim().length > CONFIG.maxTextLength) {
                alert(`选中的文本过长（超过 ${CONFIG.maxTextLength} 字符），请减少选择。`);
                return;
            }
            GM_setValue('pending_translation', JSON.stringify({
                text: text.trim(),
                targetLang: CONFIG.targetLang,
                timestamp: Date.now()
            }));

            // 计算窗口位置：水平方向自适应左右
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

            window.open(CONFIG.deepseekUrl, '_blank', features);
        }

        let mouseX = 0, mouseY = 0;
        let showButtonTimer = null;

        document.addEventListener('mouseup', function(e) {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            if (text.length > 0 && text.length <= CONFIG.maxTextLength) {
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

        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
                const sel = window.getSelection().toString().trim();
                if (sel) {
                    e.preventDefault();
                    const x = currentMouseX || window.innerWidth / 2;
                    const y = currentMouseY || window.innerHeight / 2;
                    openDeepSeekWindow(sel, x, y);
                }
            }
        });

        createPopupButton();
        log('普通网页部分已加载');

    // ============================================================
    //  DeepSeek 页面部分（仅自动发送）
    // ============================================================
    } else {
        log('DeepSeek 页面已加载');

        // ============================================================
        //  纯净视图：窗口里只显示最新一条 AI 回复（译文）
        //  原理：监听 DOM，一旦出现 .ds-markdown（DeepSeek 回复容器，
        //  官方类名、不随版本变化），就把它的内容同步到一个全屏遮罩里，
        //  遮罩之下的一切多余元素（侧边栏、顶栏、输入框等）都被盖住。
        //  右上角 ✕ 可随时退出，恢复完整页面。
        //  注意：所有状态变量必须声明在任何调用之前（v19.0 因声明
        //  顺序触发 TDZ 错误导致无法发送，19.1 已修复）。
        // ============================================================
        const CLEAN_OVERLAY_ID = 'ds-clean-translate-view';
        var cleanOverlay = null;
        var cleanContent = null;
        var cleanCloseBtn = null;
        var cleanViewExited = false;
        var lastSyncedHTML = '';
        var syncScheduled = false;

        function enableCleanSession() {
            // 隐藏杂项元素：用户指定的哈希类 + 结构兜底（侧边栏/导航）
            GM_addStyle(`
                ._2be88ba, ._871cbca { display: none !important; }
                aside, nav, [class*="sidebar"] { display: none !important; }
            `);

            // 纯净视图固定暗色主题：不检测系统/网页主题，直接暗底白字
            GM_addStyle(`
                #${CLEAN_OVERLAY_ID} {
                    background: #000000 !important;
                    color: #f3f5f7 !important;
                }
                #${CLEAN_OVERLAY_ID} * {
                    color: #f3f5f7 !important;
                }
                #${CLEAN_OVERLAY_ID} a {
                    color: #6ea8ff !important;
                    text-decoration: underline;
                }
                #${CLEAN_OVERLAY_ID} code,
                #${CLEAN_OVERLAY_ID} pre {
                    background: rgba(255, 255, 255, 0.08) !important;
                }
                #${CLEAN_OVERLAY_ID} table,
                #${CLEAN_OVERLAY_ID} th,
                #${CLEAN_OVERLAY_ID} td {
                    border-color: rgba(255, 255, 255, 0.25) !important;
                }
                #${CLEAN_OVERLAY_ID}-close {
                    background: rgba(255, 255, 255, 0.12) !important;
                    color: #c9ccd4 !important;
                }
            `);

            const mo = new MutationObserver(() => {
                if (syncScheduled) return;
                syncScheduled = true;
                setTimeout(() => {
                    syncScheduled = false;
                    syncCleanView();
                }, 150);
            });
            mo.observe(document.body, { childList: true, subtree: true, characterData: true });
            syncCleanView();
        }

        function ensureCleanOverlay() {
            if (cleanOverlay) return;

            cleanOverlay = document.createElement('div');
            cleanOverlay.id = CLEAN_OVERLAY_ID;
            cleanOverlay.style.cssText =
                'position:fixed;inset:0;z-index:2147483000;overflow-y:auto;' +
                'padding:14px 16px 46px;box-sizing:border-box;';

            cleanContent = document.createElement('div');
            cleanContent.style.cssText = 'max-width:100%;word-break:break-word;';
            cleanOverlay.appendChild(cleanContent);

            cleanCloseBtn = document.createElement('div');
            cleanCloseBtn.id = CLEAN_OVERLAY_ID + '-close';
            cleanCloseBtn.textContent = '✕';
            cleanCloseBtn.title = '退出纯净视图（显示完整 DeepSeek 页面）';
            cleanCloseBtn.style.cssText =
                'position:fixed;top:8px;right:10px;z-index:2147483001;' +
                'width:26px;height:26px;line-height:26px;text-align:center;border-radius:50%;' +
                'cursor:pointer;font-size:13px;user-select:none;';
            cleanCloseBtn.addEventListener('mouseenter', function() {
                cleanCloseBtn.style.background = 'rgba(255,255,255,0.25)';
            });
            cleanCloseBtn.addEventListener('mouseleave', function() {
                cleanCloseBtn.style.background = 'rgba(255,255,255,0.12)';
            });
            cleanCloseBtn.addEventListener('click', function() {
                cleanViewExited = true;
                if (cleanOverlay) { cleanOverlay.remove(); cleanOverlay = null; }
                if (cleanCloseBtn) { cleanCloseBtn.remove(); cleanCloseBtn = null; }
                cleanContent = null;
                log('已退出纯净视图');
            });

            document.documentElement.appendChild(cleanOverlay);
            document.documentElement.appendChild(cleanCloseBtn);
            log('纯净视图已创建');
        }

        // 根据译文实际渲染高度自适应窗口高度（上限 480，无人为下限，
        // 公式自带的内边距+呼吸空间即自然下限）
        function adaptWindowSize() {
            if (!cleanOverlay || !cleanContent) return;
            // 补偿浏览器边框/地址栏占用的内外高度差
            const chromeH = (window.outerHeight - window.innerHeight) || 0;
            // 内容真实渲染高度（已含段落间距、换行、代码块等）
            // + 上下内边距 14*2 + 底部呼吸空间 32，避免文字顶到窗口底边
            const contentH = Math.ceil(cleanContent.getBoundingClientRect().height);
            const target = Math.min(CONFIG.windowHeight, contentH + 28 + 32 + 2);
            if (Math.abs(target + chromeH - window.outerHeight) <= 1) return;
            try { window.resizeTo(CONFIG.windowWidth, target + chromeH); } catch(e) {}
        }

        function syncCleanView() {
            if (cleanViewExited) return;
            const outputs = document.querySelectorAll('.ds-markdown');
            if (!outputs.length) return;
            const last = outputs[outputs.length - 1];
            const html = last.innerHTML;
            if (!html || html === lastSyncedHTML) return;
            lastSyncedHTML = html;
            ensureCleanOverlay();
            if (!cleanOverlay || !cleanContent) return;
            cleanContent.innerHTML = html;
            adaptWindowSize();
            if (targetReachedMax()) {
                cleanOverlay.scrollTop = cleanOverlay.scrollHeight;
            }
        }

        // 高度已到上限时才需要内部滚动
        function targetReachedMax() {
            const chromeH = (window.outerHeight - window.innerHeight) || 0;
            const contentH = Math.ceil(cleanContent ? cleanContent.getBoundingClientRect().height : 0);
            return contentH + 30 >= CONFIG.windowHeight;
        }

        // ============================================================
        //  翻译任务处理（与纯净视图初始化分开，互不影响）
        // ============================================================
        const pendingRaw = GM_getValue('pending_translation', null);
        let pendingTask = null;

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

        if (pendingTask) {
            // 纯净视图初始化失败不应影响翻译发送，单独捕获
            try {
                enableCleanSession();
            } catch(e) {
                log('纯净视图初始化失败（不影响翻译）', e);
            }
            autoTranslate(pendingTask.text, pendingTask.targetLang);
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

            (async function() {
                const newBtn = document.querySelector('button[aria-label="新对话"], button[aria-label="新建对话"], .new-chat-btn');
                if (newBtn) newBtn.click();

                await sleep(500);

                const input = findInput();
                if (!input) {
                    alert('未找到输入框，请手动粘贴');
                    return;
                }

                fillInput(input, prompt);
                await sleep(400);

                const sendBtn = findSendButton();
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