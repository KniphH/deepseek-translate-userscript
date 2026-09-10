# 划词翻译 - DeepSeek 自动发送

> ◆ 这是一个纯 **Vibe Coding** 项目——代码由 AI 生成，README 也不例外。

一个 Tampermonkey 油猴脚本：在任意网页**划词 → 点🌐按钮**，自动把选中文本发给 DeepSeek，只回传译文。

> ► GitHub 仓库：https://github.com/KniphH/deepseek-translate-userscript

提供两个分支，任选其一安装（**不要同时启用**，划词按钮会重复）。

## 一键下载

- ▭ 悬浮卡片版（ScriptCat）：https://scriptcat.org/zh-CN/script-show-page/7847
- ▣ 独立窗口版（ScriptCat）：https://scriptcat.org/zh-CN/script-show-page/7846

## 两个分支

### ▣ 分支一：独立窗口版（`划词翻译 - DeepSeek 自动发送.user.js`，v19.8.12）

划词后弹出一个小窗口，自动填充发送，自动隐藏侧边栏等杂项元素，直接观看对话与译文：

- 自动隐藏 DS 页面的侧边栏/导航等杂项元素（含指定的乱码哈希类 + `aside`/`nav` 结构兜底）
- 窗口高度随译文自适应：初始只有一条缝，译文输出后长高到刚好放下，上限 480px（超出内部滚动）
- **同一对话链**：第二次划词不再新开窗口，也不会新建对话——译文接在同一个对话链后面，窗口移动到鼠标旁。置前采用「同文档导航」：给地址加一个只变 `#hash` 的片段再 `window.open` 命中已有窗口（属于页面内跳转，**不重新加载**），借此把窗口带到最前
- **跨网页共用对话链**（v19.8.12 新增）：DS 窗口会把当前对话地址写进脚本存储（对所有网页可见），因此在**任意网页**划词，打开/复用的都是同一条对话链，而不是每个网页各建一条；窗口还会持续发送存活心跳，其它网页据此直接复用已有窗口；若有更新的窗口出现，旧窗口会自动关闭（任意时刻只保留一个翻译窗口）
- 译文定位使用 DeepSeek 官方固定类名 `.ds-markdown`，不依赖每次改版都会变化的乱码哈希类名
- 窗口位置跟随鼠标，右侧空间不够自动换到左边
- 局限：Chrome 强制弹出窗口显示地址栏（`location=no` 已被浏览器忽略）、强制最小窗口高度约 100px；复用时脚本对窗口的 `focus()` 调用可能被浏览器的防抢焦点策略忽略（窗口会移动到鼠标旁作为可见反馈，但不一定跳到最前），均为浏览器安全限制，脚本无法突破

### ▭ 分支二：悬浮卡片版（`划词翻译 - DeepSeek 悬浮卡片.user.js`，v19.9.9）

划词后在**当前页面**直接弹出暗色悬浮卡片：

- 卡片高度完全自适应（页面内元素不受浏览器最小窗口限制），上限 480px
- 左上角拖动手柄可拖动，拖后位置固定；右上角 ✕ 关闭
- 翻译工作在后台标签页（标题"翻译助手"）中完成，**所有标签页共享同一工作页**（心跳检测存活，跨标签页复用）：每个浏览器会话只需打开一次，空闲 3 分钟自动关闭，下次划词自动重开
- 已尝试过滤 DeepSeek 的"深度思考"过程，只回传最终译文

## 已知问题

1. **窗口版·置前不保证**：普通弹窗没有置顶 API。脚本在第二次及以后的翻译时会用「同文档导航」尝试把窗口带到最前（不重载页面），但个别浏览器版本仍可能忽略，此时窗口只会移动到鼠标旁、不一定跳到最前。首次打开的窗口若被其它窗口挡住，脚本层面无法拉到前台。跨网页时若浏览器不允许复用同名窗口（命名窗口按"浏览上下文组"隔离），会短暂出现"旧窗口自动关闭、新窗口接上同一对话链"的现象，属于浏览器安全限制。
2. **窗口版·译文在同一个对话里累积**：为了保持对话链连续，脚本不再自动新建对话，所有翻译会追加到同一个对话中，DS 的上下文会逐渐变长（可在窗口里手动点「新对话」清空）。
3. **窗口版·浏览器限制**：地址栏无法隐藏、最小窗口高度约 100px——浏览器安全限制，脚本层面无解。
4. **卡片版·可能不稳定**：卡片版整体处于实验状态，可能存在 bug，使用体验可能不佳，遇到问题请开 Issue 反馈。
5. **卡片版·思考过滤不完善**：通过"已深度思考"折叠条定位思考容器并排除，但 DeepSeek 改版或 DOM 结构对不上时仍可能泄漏。
6. **卡片版·架构受限**：独立工作窗口会被 Chrome"遮挡节流"冻结（用户点回主页面时窗口被盖住，回传卡死）；iframe 嵌入被 DeepSeek 的 `CSP: frame-ancestors 'none'` 封死；最终只能采用后台标签页方案，首次使用会闪现一个标签页。
7. DeepSeek 页面的乱码哈希类名（`_2be88ba` 等）每次官网更新都会变，追着隐藏不可持续，脚本已全部改用官方固定类名。

## 想征求大家意见的问题

1. 你更喜欢哪种呈现方式：**独立小窗口**还是**页面内悬浮卡片**？
2. 窗口/卡片里要不要同时显示原文对照？
3. 思考过程是直接不显示好，还是折叠成一行"思考中…"可展开？
4. 需要自定义目标语言（中→英等）吗？
5. 如果做成长期项目，哪些功能是刚需？

## 安装

1. 安装 [ScriptCat 脚本猫](https://scriptcat.org/)（目前脚本**只在 ScriptCat 发布**）或 [Tampermonkey](https://www.tampermonkey.net/)
2. 点上面的「一键下载」链接安装，或新建脚本粘贴对应 `.user.js` 的完整内容
3. 确保浏览器已登录过 DeepSeek 网页版（免费额度即可）
4. 若之前装过其他版本，请先停用

## 测试用例

我之前用过划词翻译和沉浸式翻译，但是 API 要钱，而且很多模型审查重，遇到敏感一点的文本直接罢工翻不动。DeepSeek 的审查算是很低的，所以试着薅它的网页版来当免费的划词翻译用。下面是几个不同语言的测试段落，装好后随便划一段试试效果：

**英语（日常新闻体）**

> The European Space Agency announced on Tuesday that its latest Earth-observation satellite has completed calibration and will begin transmitting high-resolution imagery next month. Researchers say the data could significantly improve wildfire tracking in remote regions, where detection delays often stretch from hours to days.

**日语（生活口语）**

> 今朝は雨が降っていたので、傘を持って出かけたのに、昼頃にはすっかり晴れてしまって、鞄の中で邪魔になるだけだった。こういう天気の変化が多い季節は、毎日の予報チェックが本当に大事だと痛感する。

**法语（文学描写）**

> Le vieux libraire essuya ses lunettes avec un mouchoir de lin, regarda par la fenêtre la pluie qui dessinait de longues traînées argentées sur la vitre, et se rappela que, cinquante ans plus tôt, il avait ouvert cette boutique avec moins de cent livres et beaucoup trop d'espoir.

**德语（技术文档风格）**

> Der Installationsassistent erkennt automatisch alle verfügbaren Schnittstellen. Sollte eine Verbindung fehlschlagen, prüfen Sie zunächst die Treiberversion und starten Sie den Rechner neu, bevor Sie den Support kontaktieren.

**俄语（新闻报道体）**

> По данным местного метеорологического центра, температура в городе опустится ниже среднего значения на несколько градусов в течение ближайших суток, поэтому жителям рекомендуют одеваться теплее.

**审查测试**

> こんなに大きなペニスを全部アナルに挿入するのは、本当にエロティックすぎる！～大好き♡～

>皮広げられて唾入れられるの初めて見ましたがえっちすぎる…入れた後に指でなじませられるのもやばい これは動いてなくても出ちゃうの仕方がない 初音ミク好きなのでこんなえっちなの見つけれて最高です

>帰宅直後の娘に手コキしてもらう
