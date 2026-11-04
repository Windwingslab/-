// 版式测试（3.8）：把面板的版式规格固定下来，以后改样式不会悄悄退回去
//   · 两边边距都是 12px，按键铺满宽度：260 / 320 / 400 / 560px 宽时 5 / 6 / 8 / 12 列，键宽 44 / 46 / 43.5 / 41
//   · 工具按键是正方形；240px（最小宽度）没有横向滚动
//   · 提示栏固定 64px：悬停任何按钮高度都不变；点完按钮马上悬停别的按钮，立刻显示那个按钮的用法（不被结果挡住）
//   · 中文从不放进等宽字体；只用 5 种字号；字重不超过 500；界面上没有 Geist 里没有的符号（⌥ ⌘ ✎ ★ ✓）
//   · 命令搜索：输入时输入框不跳；对话框：Tab 不跑出去，Esc 关掉后焦点回到打开它的按钮
//   · 编辑模式：点一下选中，⌥↓ 下移，Delete 删除，Esc 退出
"use strict";
const path = require("path");
const { chromium } = require("playwright");

const EXT = process.env.MH_EXT || path.join(__dirname, "../com.windwings.motionhub");
let failures = 0;
function check(name, cond, detail) {
    console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : "：" + (detail || "")));
    if (!cond) failures++;
}

// st：这个页面自己的后台状态（移除过的脚本）
function fakeHost(name, args, st) {
    const ok = (data, msg) => ({ ok: true, msg: msg || "", data: data || {} });
    let a = {};
    try { a = JSON.parse(args || "{}"); } catch (e) {}
    switch (name) {
        case "init": return ok({ libPath: "/lib", version: "x", ae: "24.3.0", canWrite: true, os: "mac" });
        case "ctx": return ok({ comp: "合成 1", layers: 3, keys: 4, exprProps: 1, precomps: 1, projComps: 1, lib: "/lib" });
        case "scan": return ok({ items: [
            { path: "/lib/动画/弹跳.jsx", key: "/动画/弹跳.jsx", name: "弹跳", file: "弹跳.jsx", cat: "动画", ext: "jsx", desc: "给选中图层加弹跳", author: "", type: "脚本" },
            { path: "/lib/动画/甩动.jsx", key: "/动画/甩动.jsx", name: "甩动", file: "甩动.jsx", cat: "动画", ext: "jsx", desc: "", author: "", type: "脚本" },
            { path: "/lib/工具/整理.jsx", key: "/工具/整理.jsx", name: "整理项目", file: "整理.jsx", cat: "工具", ext: "jsx", desc: "", author: "", type: "脚本" }
        ].filter(it => !(st && st.removed.includes(it.path))), categories: ["动画", "工具"], libPath: "/lib" });
        case "remove": if (st) st.removed.push(a.path); return ok({}, "已移除");
        case "loadConfig": return ok({ text: null });
        case "loadSnippets": return ok({ text: null, libPath: "/lib" });
        case "listEffects": return ok({ effects: [] });
        case "pickFiles": return ok({ files: [{ name: "新脚本.jsx", path: "/Downloads/新脚本.jsx" }] });
        case "install": return ok({ keys: ["/动画/弹跳.jsx"] }, "已添加 1 个脚本");
        default: return ok({}, "已完成：" + name);
    }
}

// o.delay：{ 后台工具名: 毫秒 }，让这一步晚一点回来（比如启动还没做完时先打开一个对话框）
async function open(browser, n, width, height, init, o) {
    o = o || {};
    const page = await browser.newPage({ viewport: { width, height: height || 900 }, deviceScaleFactor: 1 });
    const errors = [], st = { removed: [] };
    page.on("pageerror", e => errors.push(e.message));
    await page.exposeFunction("__mhHost", async (name, args) => {
        if (o.delay && o.delay[name]) await new Promise(r => setTimeout(r, o.delay[name]));
        return JSON.stringify(fakeHost(name, args, st));
    });
    await page.addInitScript(([n, init]) => {
        try { localStorage.clear(); } catch (e) {}
        if (init) for (const k in init) localStorage.setItem(k, JSON.stringify(init[k]));
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.panel" + n, getSystemPath: () => "", registerKeyEventsInterest() {},
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb("object"), 1);
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                if (!m) return setTimeout(() => cb("undefined"), 1);
                (window.__calls = window.__calls || []).push(m[1]);
                window.__mhHost(m[1], m[2]).then(r => setTimeout(() => cb(r), 1));
            }
        };
    }, [n, init || null]);
    await page.goto("file://" + EXT + "/index.html");
    await page.waitForTimeout(500);
    page.__errors = errors;
    return page;
}

(async () => {
    const browser = await chromium.launch();

    console.log("网格与边距：");
    const want = { 260: [5, 44], 320: [6, 46], 400: [8, 43.5], 560: [12, 41] };
    for (const w of [260, 320, 400, 560]) {
        for (const n of [1, 3]) {
            const page = await open(browser, n, w);
            const m = await page.evaluate(() => {
                const L = document.querySelector("#layout"), r = L.getBoundingClientRect(), cs = getComputedStyle(L);
                // 1×1 的工具键：分组网格里直接放着的、不跨列的按键
                const keys = Array.from(document.querySelectorAll("#layout .key-grid > .cell")).filter(c => !c.style.gridColumn || /span 1$/.test(c.style.gridColumn))
                    .map(c => c.querySelector(".tile")).filter(Boolean).map(t => t.getBoundingClientRect());
                const notSquare = keys.filter(k => Math.abs(k.width - k.height) > 0.6).length;
                return { left: r.left, right: window.innerWidth - r.right, cols: +cs.getPropertyValue("--cols"), key: parseFloat(cs.getPropertyValue("--key")), keys: keys.length, notSquare };
            });
            const [cols, key] = want[w];
            check("面板 " + n + " · " + w + "px：左右边距 12px、" + cols + " 列、键宽 " + key + "px、工具键都是正方形（" + m.keys + " 个）",
                Math.abs(m.left - 12) < 0.6 && Math.abs(m.right - 12) < 0.6 && m.cols === cols && Math.abs(m.key - key) < 0.01 && m.notSquare === 0 && m.keys > 0, JSON.stringify(m));
            await page.close();
        }
    }
    {
        const page = await open(browser, 1, 240);
        const h = await page.evaluate(() => { const pg = document.querySelector("#page-panel"); return { sw: pg.scrollWidth, cw: pg.clientWidth, body: document.body.scrollWidth }; });
        check("最小宽度 240px：没有横向滚动", h.sw <= h.cw && h.body <= 240, JSON.stringify(h));
        await page.close();
    }

    console.log("提示栏：");
    {
        const page = await open(browser, 1, 320);
        const heights = new Set(), stuck = [];
        const tiles = await page.$$("#layout .tile, #layout .chip, #layout .preset");
        for (const t of tiles.slice(0, 60)) {
            await t.hover().catch(() => {});
            const st = await page.evaluate(() => {
                const h = document.querySelector("#hint");
                return { h: Math.round(h.getBoundingClientRect().height), over: h.scrollHeight > h.clientHeight + 1, rows: h.querySelectorAll(".h-row").length };
            });
            heights.add(st.h);
            if (st.rows > 3) stuck.push(st.rows);
        }
        check("悬停 60 个按钮：提示栏一直是 64px、最多 3 行", heights.size === 1 && heights.has(64) && !stuck.length, JSON.stringify({ heights: [...heights], stuck }));
        // 点完一个按钮（结果写进提示栏），马上悬停另一个：立刻显示那个按钮的用法
        await page.click('#layout .tile[aria-label="复制合成"]');
        await page.waitForTimeout(120);
        const afterClick = await page.textContent("#hint");
        await page.hover('#layout .tile[aria-label="解散预合成"]');
        const next = await page.textContent("#hint");
        check("点完按钮后马上悬停别的按钮：同一帧就换成那个按钮的用法", /已完成/.test(afterClick) && /解散预合成/.test(next), JSON.stringify({ afterClick, next }));
        // 脚本库里搜索让列表重绘：提示不会停在已经不存在的那一行上
        await page.click(".tab[data-tab=library]");
        await page.hover("#lib-list .lib-item >> nth=1");
        const h1 = await page.textContent("#hint");
        await page.fill("#lib-q", "整理");
        await page.waitForTimeout(50);
        const h2 = await page.textContent("#hint");
        check("列表重绘后提示跟着鼠标下面现在的那一行走", /甩动/.test(h1) && !/甩动/.test(h2), JSON.stringify({ h1, h2 }));
        check("提示栏场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }

    console.log("字体：");
    for (const n of [1, 2, 3, 4]) {
        const page = await open(browser, n, 320);
        const r = await page.evaluate(() => {
            const CJK = /[㐀-鿿＀-￯]/, BAD = /[⌥⌘⌃✎★✓◇]/;
            const monoCJK = [], sizes = new Set(), heavy = [], glyphs = [];
            const walk = (root) => {
                const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                let t;
                while ((t = tw.nextNode())) {
                    const s = t.nodeValue;
                    if (!/\S/.test(s)) continue;
                    const el = t.parentElement;
                    if (!el || !el.getClientRects().length) continue;
                    const cs = getComputedStyle(el);
                    if (cs.visibility === "hidden" || cs.display === "none") continue;
                    if (/^"?Geist Mono/.test(cs.fontFamily) && CJK.test(s)) monoCJK.push(s.trim().slice(0, 16));
                    sizes.add(cs.fontSize);
                    if (+cs.fontWeight > 500) heavy.push(s.trim().slice(0, 12));
                    if (BAD.test(s)) glyphs.push(s.trim().slice(0, 20));
                }
            };
            walk(document.body);
            return { monoCJK, sizes: [...sizes], heavy, glyphs };
        });
        const allowed = new Set(["10px", "11px", "12px", "13px", "20px"]);
        check("面板 " + n + "：中文没有放进等宽字体", !r.monoCJK.length, JSON.stringify(r.monoCJK));
        check("面板 " + n + "：只用 10 / 11 / 12 / 13 / 20px 五种字号，字重不超过 500", r.sizes.every(s => allowed.has(s)) && !r.heavy.length, JSON.stringify(r));
        check("面板 " + n + "：界面文字里没有 Geist 缺的符号（⌥ ⌘ ⌃ ✎ ★ ✓ ◇）", !r.glyphs.length, JSON.stringify(r.glyphs));
        await page.close();
    }

    console.log("对话框与命令搜索：");
    {
        const page = await open(browser, 1, 320, 720);
        await page.click("#btn-search");
        await page.waitForTimeout(150);
        const y0 = await page.evaluate(() => document.querySelector(".pal-input").getBoundingClientRect().top);
        await page.keyboard.type("锚");
        const y1 = await page.evaluate(() => document.querySelector(".pal-input").getBoundingClientRect().top);
        await page.keyboard.type("点中心");
        const r = await page.evaluate(() => ({ y: document.querySelector(".pal-input").getBoundingClientRect().top, first: (document.querySelector(".pal-list .cat-item") || {}).textContent || "" }));
        check("命令搜索：输入时输入框位置不变（贴着顶部）", y0 === y1 && y1 === r.y && y0 < 30, JSON.stringify({ y0, y1, y2: r.y }));
        check("命令搜索：能直接搜到九宫格的锚点位置", /锚点 · 中心/.test(r.first), r.first);
        await page.keyboard.press("Escape");
        // 对话框：Tab 不跑出去；Esc 关掉以后焦点回到打开它的按钮
        await page.focus('#layout .tile[aria-label="批量重命名"]').catch(() => {});
        const trigger = await page.$('#layout .tile[aria-label="批量重命名"]');
        if (trigger) {
            await trigger.focus();
            await page.keyboard.press("Enter");
            await page.waitForTimeout(150);
            const inside = [];
            for (let i = 0; i < 6; i++) {
                await page.keyboard.press("Tab");
                inside.push(await page.evaluate(() => !!document.activeElement.closest(".dialog")));
            }
            await page.keyboard.press("Escape");
            await page.waitForTimeout(50);
            const back = await page.evaluate(() => ({ modal: document.querySelector("#modal").hidden, label: document.activeElement.getAttribute("aria-label") }));
            check("对话框：连按 Tab 焦点一直在对话框里", inside.every(Boolean), JSON.stringify(inside));
            check("对话框：Esc 关掉后焦点回到打开它的按钮", back.modal && back.label === "批量重命名", JSON.stringify(back));
        } else check("面板 1 有「批量重命名」按钮", false, "没找到");
        check("对话框场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }

    console.log("编辑模式：");
    {
        const page = await open(browser, 3, 320);
        const order = () => page.evaluate(() => window.MHDebug.config().items.map(i => i.id));
        const o0 = await order();
        await page.click("#btn-edit");
        await page.click('#layout .cell[data-id="' + o0[2] + '"]');
        const sel = await page.evaluate(() => ({ sel: document.querySelectorAll("#layout .cell.sel").length, bar: document.querySelector("#eb-sel").classList.contains("on") }));
        check("编辑模式：点一下选中一个组件，编辑条出现针对它的操作", sel.sel === 1 && sel.bar, JSON.stringify(sel));
        await page.keyboard.press("Alt+ArrowDown");
        const o1 = await order();
        check("编辑模式：⌥↓ 把选中的组件往后挪一位", o1[3] === o0[2] && o1[2] === o0[3], JSON.stringify({ o0: o0.slice(0, 5), o1: o1.slice(0, 5) }));
        await page.keyboard.press("Delete");
        const o2 = await order();
        check("编辑模式：Delete 从面板删掉选中的组件", o2.length === o0.length - 1 && o2.indexOf(o0[2]) === -1, JSON.stringify({ before: o0.length, after: o2.length }));
        await page.keyboard.press("Escape");
        const done = await page.evaluate(() => !document.body.classList.contains("editing"));
        check("编辑模式：Esc 退出", done);
        check("编辑模式没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }

    console.log("审查回归（3.8.0）：");
    const layout = (items) => ({ "mh.panel3": { schema: 2, name: "测试", accent: "#FF5900", items: items.map((it, i) => Object.assign({ id: "i" + i }, it)) } });
    {
        // 宽面板：小按键和成对的组件不挤在同一行（按键不会被拉成长条）；奇数列时右边的组件也贴到右边距
        for (const w of [560, 520, 600]) {
            const page = await open(browser, 3, w, 900, layout([{ type: "heading", en: "A", zh: "甲" }, { type: "ease" }, { type: "keys" }, { type: "alignLeft" }, { type: "alignRight" }, { type: "distH" }, { type: "quick" }]));
            const m = await page.evaluate(() => {
                const keys = Array.from(document.querySelectorAll("#layout .sec .key-grid .tile")).map(t => t.getBoundingClientRect());
                const L = document.querySelector("#layout").getBoundingClientRect();
                const pairs = Array.from(document.querySelectorAll("#layout .pair-grid > .cell")).map(c => c.getBoundingClientRect());
                return { keys: keys.map(k => [Math.round(k.width), Math.round(k.height)]), right: pairs.length ? Math.round(L.right - Math.max(...pairs.map(r => r.right))) : -1, n: pairs.length };
            });
            check("宽面板 " + w + "px：按键都是正方形（不和组件挤在一行），成对的右边那个、单独的那个都贴到右边距", m.keys.length === 3 && m.keys.every(k => Math.abs(k[0] - k[1]) <= 1) && m.right === 0 && m.n === 3, JSON.stringify(m));
            await page.close();
        }
    }
    {
        // 编辑模式：把按键往上挪过一个组件，画面上一定看得出来
        const page = await open(browser, 3, 320, 900, layout([{ type: "heading", en: "A", zh: "甲" }, { type: "alignLeft" }, { type: "ease" }, { type: "alignRight" }, { type: "alignTop" }]));
        await page.click("#btn-edit");
        await page.click('#layout .cell[data-id="i3"]');
        const y0 = await page.evaluate(() => document.querySelector('#layout .cell[data-id="i3"]').getBoundingClientRect().top);
        await page.keyboard.press("Alt+ArrowUp");
        const y1 = await page.evaluate(() => document.querySelector('#layout .cell[data-id="i3"]').getBoundingClientRect().top);
        check("编辑模式：按键往上挪过一个组件，画面上真的移上去了", y1 < y0 - 20, JSON.stringify({ y0, y1 }));
        // 窄面板的编辑条：选中分组标题时「完成」也完整可见
        await page.setViewportSize({ width: 240, height: 900 });
        await page.click('#layout .cell[data-id="i0"]');
        const eb = await page.evaluate(() => { const d = document.querySelector("#eb-done").getBoundingClientRect(); return { right: d.right, w: d.width, vw: window.innerWidth }; });
        check("240px：编辑条里的「完成」完整可见", eb.right <= eb.vw - 4 && eb.w >= 30, JSON.stringify(eb));
        await page.close();
    }
    {
        // 删除类确认：焦点不在按钮上时按回车，不会确认
        const page = await open(browser, 1, 320, 720);
        await page.click(".tab[data-tab=settings]");
        await page.click("#set-usage-reset");
        await page.waitForTimeout(100);
        await page.click("#dlg-body p");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(100);
        const stillOpen = await page.evaluate(() => !document.querySelector("#modal").hidden);
        check("删除类确认：点了说明文字再按回车，不会确认（对话框还开着）", stillOpen);
        await page.keyboard.press("Escape");
        // 添加脚本：对话框打开后焦点在对话框里，回车 = 添加，不会再点一次背后的按钮
        await page.click(".tab[data-tab=library]");
        await page.click("#lib-add");
        await page.waitForTimeout(150);
        const f = await page.evaluate(() => ({ inside: document.querySelector(".dialog").contains(document.activeElement), label: document.activeElement.textContent }));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(250);
        const closed = await page.evaluate(() => document.querySelector("#modal").hidden);
        check("添加脚本：焦点落在对话框里，回车就是「添加」", f.inside && /添加/.test(f.label) && closed, JSON.stringify({ f, closed }));
        // 命令搜索：Tab 不跑出对话框
        await page.click("#btn-search");
        await page.waitForTimeout(100);
        const ins = [];
        for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); ins.push(await page.evaluate(() => !!document.activeElement.closest(".dialog"))); }
        check("命令搜索：连按 Tab 焦点一直在对话框里", ins.every(Boolean), JSON.stringify(ins));
        await page.keyboard.press("Escape");
        check("审查回归场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }
    {
        // 后台消息不会被鼠标一扫就清掉
        const page = await open(browser, 1, 320, 900);
        await page.evaluate(() => window.MHDebug.note({ ok: false, msg: "测试：后台消息要留满时间" }));
        const tiles = await page.$$("#layout .tile");
        await tiles[2].hover(); await tiles[5].hover();
        const h = await page.textContent("#hint");
        check("后台消息：鼠标移过两个按钮后还在提示栏里", /后台消息要留满时间/.test(h), h);
        await page.close();
    }
    {
        // 「我的脚本」分组里的「添加脚本」：脚本放进「我的脚本」，不是放到「代码片段」下面
        const page = await open(browser, 4, 320, 900);
        await page.click("#layout .sec-empty .btn.accent");
        await page.waitForTimeout(150);
        await page.click("#dlg-btns .btn:last-child");
        await page.waitForTimeout(300);
        const order = await page.evaluate(() => window.MHDebug.config().items.map(i => i.type === "heading" ? "H:" + i.en : i.type));
        check("「我的脚本」里添加的脚本放进「我的脚本」分组", order.indexOf("script") > order.indexOf("H:MY SCRIPTS") && order.indexOf("script") < order.indexOf("H:SNIPPETS"), JSON.stringify(order));
        await page.close();
    }
    {
        // 脚本库的行内按钮：键盘能 Tab 到
        const page = await open(browser, 1, 320, 900);
        await page.click(".tab[data-tab=library]");
        await page.focus("#lib-q");
        let reached = false;
        for (let i = 0; i < 6 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => !!document.activeElement.closest(".lib-item .acts")); }
        check("脚本库：键盘能 Tab 到行内的按钮", reached);
        await page.close();
    }
    {
        // 在片段编辑框里拖选文字、松手在遮罩上：对话框不关
        const page = await open(browser, 1, 320, 800);
        await page.click(".tab[data-tab=library]");
        await page.click("#lib-seg button[data-seg=snippets]");
        await page.locator("#lib-snippets .lib-group").nth(0).locator(".act").click();
        await page.waitForTimeout(100);
        const ta = await page.$("#dlg-body textarea");
        const b = await ta.boundingBox();
        await page.mouse.move(b.x + 20, b.y + 20); await page.mouse.down();
        await page.mouse.move(b.x + 20, 780, { steps: 4 }); await page.mouse.up();
        const open2 = await page.evaluate(() => !document.querySelector("#modal").hidden);
        check("片段编辑：拖选文字松手在遮罩上，对话框不关（没保存的内容还在）", open2);
        await page.close();
    }

    console.log("第二轮复核回归（3.8.0）：");
    {
        // 片段编辑：Tab 在代码框里插入缩进；名称没填时点保存不关（写好的代码还在）；输入法组字时的回车不算
        const page = await open(browser, 1, 320, 800);
        await page.click(".tab[data-tab=library]");
        await page.click("#lib-seg button[data-seg=snippets]");
        await page.locator("#lib-snippets .lib-group").nth(0).locator(".act").click();
        await page.waitForTimeout(100);
        await page.click("#dlg-body textarea");
        await page.keyboard.type("if (a) {");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Tab");
        const ta = await page.evaluate(() => ({ v: document.querySelector("#dlg-body textarea").value, focus: document.activeElement.tagName }));
        check("片段编辑：Tab 在代码框里插入 4 个空格，焦点不跑", ta.v === "if (a) {\n    " && ta.focus === "TEXTAREA", JSON.stringify(ta));
        await page.click("#dlg-btns .btn:last-child");
        await page.waitForTimeout(120);
        const kept = await page.evaluate(() => ({ open: !document.querySelector("#modal").hidden, v: document.querySelector("#dlg-body textarea").value }));
        check("片段编辑：名称没填就点保存，对话框不关、代码还在", kept.open && /if \(a\)/.test(kept.v), JSON.stringify(kept));
        await page.evaluate(() => { const n = document.querySelector("#dlg-body input[type=text]"); n.focus(); n.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })); });
        await page.waitForTimeout(60);
        const ime = await page.evaluate(() => !document.querySelector("#modal").hidden);
        check("输入法组字时按回车（确认拼音）：对话框不关", ime);
        // 有对话框开着时拖文件进来：不叠第二个对话框，原来的还在
        await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.items.add(new File(["// x"], "拖进来.jsx", { type: "text/plain" }));
            document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
            document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        await page.waitForTimeout(120);
        const drop = await page.evaluate(() => ({ title: document.querySelector("#dlg-title").textContent, v: document.querySelector("#dlg-body textarea") ? document.querySelector("#dlg-body textarea").value : "" }));
        check("对话框开着时拖文件进来：原来的对话框和写好的代码都还在", /片段/.test(drop.title) && /if \(a\)/.test(drop.v), JSON.stringify(drop));
        await page.keyboard.press("Escape");
        check("片段编辑场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }
    {
        // 双击组件库里的一项：只加组件，第二下不会落到面板上的按钮上
        const page = await open(browser, 3, 320, 900);
        await page.click("#layout .add-row .tile");
        await page.waitForTimeout(150);
        await page.evaluate(() => { window.__calls = []; });
        await page.dblclick("#dlg-body .cat-item >> nth=0");
        await page.waitForTimeout(300);
        // 加组件会保存布局（saveConfig），那不算；不能有任何工具调用
        const calls = await page.evaluate(() => window.__calls.filter(c => !/^(ctx|saveConfig|loadConfig|saveSnippets|loadSnippets)$/.test(c)));
        const added = await page.evaluate(() => window.MHDebug.config().items.length);
        check("双击组件库里的一项：只加了组件，面板上的按钮没被顺带点到", calls.length === 0 && added > 0, JSON.stringify({ calls, added }));
        await page.close();
    }
    {
        // 进出编辑模式不打断后台消息
        const page = await open(browser, 1, 320, 900);
        await page.evaluate(() => window.MHDebug.note({ ok: false, msg: "测试：后台消息要留满时间" }));
        await page.click("#btn-edit");
        await page.waitForTimeout(80);
        const h = await page.textContent("#hint");
        check("进入编辑模式时，正在显示的后台消息不被打断", /后台消息要留满时间/.test(h), h);
        await page.close();
    }
    {
        // 300px：选中组件时「完成」仍然靠右（12px 边距），编辑条不变高
        const page = await open(browser, 3, 300, 900);
        await page.click("#btn-edit");
        const r0 = await page.evaluate(() => ({ r: document.querySelector("#eb-done").getBoundingClientRect().right, h: document.querySelector("#edit-bar").offsetHeight }));
        await page.click("#layout .key-grid .cell >> nth=0");
        const r1 = await page.evaluate(() => ({ r: document.querySelector("#eb-done").getBoundingClientRect().right, h: document.querySelector("#edit-bar").offsetHeight }));
        check("300px 编辑条：选中组件前后「完成」都贴着右边距、编辑条高度不变", Math.abs(r0.r - 288) < 1 && Math.abs(r1.r - 288) < 1 && r0.h === r1.h, JSON.stringify({ r0, r1 }));
        await page.close();
    }
    {
        // 命令搜索、组件库、设置页、片段页：中文也不放进等宽字体
        const page = await open(browser, 1, 320, 800);
        const scan = () => page.evaluate(() => {
            const CJK = /[\u3400-\u9fff]/, bad = [];
            const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let t;
            while ((t = tw.nextNode())) {
                const el = t.parentElement;
                if (!el || !el.getClientRects().length || !CJK.test(t.nodeValue)) continue;
                if (/^"?Geist Mono/.test(getComputedStyle(el).fontFamily)) bad.push(t.nodeValue.trim().slice(0, 12));
            }
            return bad;
        });
        await page.click("#btn-search"); await page.waitForTimeout(100);
        const a = await scan(); await page.keyboard.press("Escape");
        await page.click("#layout .add-row .tile"); await page.waitForTimeout(100);
        const b = await scan(); await page.keyboard.press("Escape");
        await page.click(".tab[data-tab=settings]"); await page.waitForTimeout(100);
        const c = await scan();
        check("命令搜索、组件库、设置页：中文没有放进等宽字体", !a.length && !b.length && !c.length, JSON.stringify({ a, b, c }));
        await page.close();
    }

    console.log("第三轮复核回归（3.8.0）：");
    const inDialog = () => !!document.activeElement.closest(".dialog");
    const hintText = (page) => page.textContent("#hint");
    {
        // 命令搜索：右键过一行（或在一行上按下、拖开再松手）以后按 Tab，焦点不跑出对话框，Space 不会切换背后的标签页；
        // 焦点被程序挪到对话框外面，也拉回对话框里
        const page = await open(browser, 1, 320, 800);
        await page.click(".tab[data-tab=library]");
        await page.click("#btn-search"); await page.waitForTimeout(120);
        await page.click("#dlg-body .cat-item >> nth=3", { button: "right" });
        await page.keyboard.press("Tab");
        const t1 = await page.evaluate(inDialog);
        await page.keyboard.press("Space"); await page.waitForTimeout(80);
        const tab = await page.evaluate(() => document.querySelector(".tab.on").dataset.tab);
        const r = await page.locator("#dlg-body .cat-item >> nth=2").boundingBox();
        await page.mouse.move(r.x + 30, r.y + r.height / 2); await page.mouse.down();
        await page.mouse.move(r.x + 30, r.y + 160, { steps: 4 }); await page.mouse.up();
        await page.keyboard.press("Tab");
        const t2 = await page.evaluate(inDialog);
        await page.evaluate(() => document.querySelector(".tab[data-tab=settings]").focus());
        const t3 = await page.evaluate(() => ({ inside: !!document.activeElement.closest(".dialog"), open: !document.querySelector("#modal").hidden }));
        check("命令搜索：右键过一行再按 Tab，焦点留在对话框里，Space 不会切换背后的标签页", t1 && tab === "library", JSON.stringify({ t1, tab }));
        check("命令搜索：在一行上按下、拖开再松手后按 Tab，焦点留在对话框里", t2, String(t2));
        check("对话框开着时焦点被挪到外面：拉回对话框里", t3.inside && t3.open, JSON.stringify(t3));
        await page.keyboard.press("Escape");
        check("命令搜索焦点场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }
    {
        // 片段编辑的代码框：Shift+Tab 减少缩进、选了几行按 Tab 每行缩进、Ctrl+Z 能撤销；Esc 跳出代码框落到「保存」上
        // （对话框不关、代码还在），再按 Esc 才关；⌘↩ / Ctrl+Enter 在哪儿按都是保存，名称没填时不关；代码框下面写着这些按键
        const page = await open(browser, 1, 320, 800);
        await page.click(".tab[data-tab=library]");
        await page.click("#lib-seg button[data-seg=snippets]");
        const newSnip = async () => { await page.locator("#lib-snippets .lib-group").nth(0).locator(".act").click(); await page.waitForTimeout(100); };
        const ta = () => page.evaluate(() => { const t = document.querySelector("#dlg-body textarea"); return { v: t.value, s: t.selectionStart, e: t.selectionEnd, focus: document.activeElement === t }; });
        await newSnip();
        await page.click("#dlg-body textarea");
        await page.keyboard.type("if (a) {"); await page.keyboard.press("Enter"); await page.keyboard.press("Tab"); await page.keyboard.type("b();");
        await page.keyboard.press("Shift+Tab");
        const a1 = await ta();
        await page.keyboard.press("Control+a"); await page.keyboard.press("Tab");
        const a2 = await ta();
        await page.keyboard.press("Shift+Tab");
        const a3 = await ta();
        await page.keyboard.press("Control+z");
        const a4 = await ta();
        await page.keyboard.press("Control+z");
        const a5 = await ta();
        check("代码框：Shift+Tab 去掉这一行前面的 4 个空格（不插入空格），焦点留在代码框里", a1.v === "if (a) {\nb();" && a1.focus, JSON.stringify(a1));
        check("代码框：全选后按 Tab，每一行前面加 4 个空格（代码没被换成空格），选区盖住这几行", a2.v === "    if (a) {\n    b();" && a2.s === 0 && a2.e === a2.v.length, JSON.stringify(a2));
        check("代码框：选了几行按 Shift+Tab，每一行都减少缩进", a3.v === "if (a) {\nb();", JSON.stringify(a3));
        check("代码框：缩进以后 Ctrl+Z 能一步步撤销回去", a4.v === "    if (a) {\n    b();" && a5.v === "if (a) {\nb();", JSON.stringify({ a4, a5 }));
        await page.keyboard.press("Escape");
        const e1 = await page.evaluate(() => { const a = document.activeElement; return { open: !document.querySelector("#modal").hidden, save: !!a.closest("#dlg-btns") && /保存/.test(a.textContent), ring: a.matches(":focus-visible"), v: document.querySelector("#dlg-body textarea").value }; });
        await page.keyboard.press("Escape");
        const e2 = await page.evaluate(() => document.querySelector("#modal").hidden);
        check("代码框里按 Esc：对话框不关，焦点落到「保存」上（有焦点框），代码还在；再按 Esc 才关", e1.open && e1.save && e1.ring && e1.v === "if (a) {\nb();" && e2, JSON.stringify({ e1, e2 }));
        await newSnip();
        const k = await page.evaluate(() => {
            const n = document.querySelector("#dlg-body .code-keys"), t = document.querySelector("#dlg-body textarea"), probe = document.createElement("i");
            probe.style.color = "var(--muted)"; document.body.appendChild(probe);
            const r = { text: n ? n.textContent : "", font: n ? getComputedStyle(n).fontFamily : "", grey: n ? getComputedStyle(n).color === getComputedStyle(probe).color : false, cmdIcon: !!(n && n.querySelector(".kc svg")), mono: getComputedStyle(t).fontFamily, sans: getComputedStyle(document.body).fontFamily };
            probe.remove();
            return r;
        });
        check("代码框下面一行灰字写着按键（Tab 缩进 · ⇧Tab 减少缩进 · Esc 跳出代码框 · ⌘↩ 保存），中文不用等宽字体", /Tab 缩进/.test(k.text) && /⇧Tab 减少缩进/.test(k.text) && /Esc 跳出代码框/.test(k.text) && /↩ 保存/.test(k.text) && k.cmdIcon && k.grey && !/^"?Geist Mono/.test(k.font), JSON.stringify(k));
        // 代码里的中文注释：拉丁字母用 Geist Mono，中文退回到和正文一样的中文字体（排在通用的 monospace 前面）
        const fam = (s) => s.split(",").map(x => x.trim().replace(/^["']|["']$/g, ""));
        const mono = fam(k.mono), cjk = fam(k.sans).filter(f => !/^(Geist|sans-serif)$/.test(f));
        check("等宽字体（代码框、片段预览）里的中文退回到正文用的那几种中文字体", mono[0] === "Geist Mono" && cjk.length >= 5 && cjk.every(f => mono.indexOf(f) > 0 && mono.indexOf(f) < mono.indexOf("monospace")), JSON.stringify({ mono, cjk }));
        await page.click("#dlg-body textarea"); await page.keyboard.type("value * 2");
        await page.keyboard.press("Control+Enter"); await page.waitForTimeout(80);
        const s1 = await page.evaluate(() => ({ open: !document.querySelector("#modal").hidden, focus: document.activeElement.type, v: document.querySelector("#dlg-body textarea").value }));
        await page.keyboard.type("翻倍");
        await page.keyboard.press("Meta+Enter"); await page.waitForTimeout(250);
        const s2 = await page.evaluate(() => ({ open: !document.querySelector("#modal").hidden, saved: window.MHDebug.snippets().some(s => s.name === "翻倍" && s.code === "value * 2") }));
        check("片段编辑：名称没填时按 Ctrl+Enter 不关（焦点到名称上、代码还在）", s1.open && s1.focus === "text" && s1.v === "value * 2", JSON.stringify(s1));
        check("片段编辑：⌘↩ / Ctrl+Enter 就是「保存」", !s2.open && s2.saved, JSON.stringify(s2));
        check("代码框按键场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }
    {
        // 后台消息在显示时：没有气泡的结果（从组件库加组件、拖进来的文件不对）照样显示在提示栏，鼠标移过按钮也还在；
        // 到时间后后台消息回来，显示完它剩下的时间；两个都是错误时合成一句；有气泡的点击结果不顶掉后台消息
        const page = await open(browser, 1, 320, 900);
        await page.evaluate(() => window.MHDebug.note({ ok: true, msg: "测试：后台已同步 2 个代码片段" }));
        await page.click("#layout .add-row .tile"); await page.waitForTimeout(120);
        await page.click("#dlg-body .cat-item >> nth=0"); await page.waitForTimeout(60);
        const h1 = await hintText(page);
        await page.hover("#layout .tile >> nth=1"); await page.hover("#layout .tile >> nth=4");
        const h2 = await hintText(page);
        const back = await page.waitForFunction(() => /后台已同步/.test(document.querySelector("#hint").textContent), null, { timeout: 4000 }).then(() => true, () => false);
        check("后台消息在显示时从组件库加组件：提示栏显示「已添加…」，鼠标移过按钮也还在", /已添加/.test(h1) && /已添加/.test(h2), JSON.stringify({ h1, h2 }));
        check("「已添加…」到时间后，后台消息回来显示完它剩下的时间", back, await hintText(page));
        await page.evaluate(() => window.MHDebug.note({ ok: false, msg: "测试：读取脚本库失败：磁盘忙" }));
        await page.evaluate(() => {
            const dt = new DataTransfer(); dt.items.add(new File(["x"], "说明.txt", { type: "text/plain" }));
            document.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        });
        const h3 = await hintText(page);
        check("后台的错误在显示时拖进不支持的文件：两句合成一句，都看得到", /只支持 \.jsx/.test(h3) && /磁盘忙/.test(h3), h3);
        await page.evaluate(() => window.MHDebug.note({ ok: true, msg: "测试：后台消息要留满时间" }));
        await page.click('#layout .tile[aria-label="复制合成"]'); await page.waitForTimeout(150);
        const h4 = await hintText(page), b4 = await page.evaluate(() => { const f = document.querySelector(".fb"); return f && !f.hidden ? f.textContent : ""; });
        check("有气泡的点击结果：后台消息还在显示时不顶掉它（结果在按钮旁的气泡里）", /后台消息要留满时间/.test(h4) && /已完成/.test(b4), JSON.stringify({ h4, b4 }));
        check("后台消息和结果场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }
    {
        // 提示栏放不下的消息：键盘打开全文、Esc 关掉后焦点不掉到 <body>；看全文时又来了一条放不下的消息：关掉后焦点回到提示栏
        const LONG = "测试：代码片段没写进磁盘：/Users/someone/Library/Application Support/MotionHub/very/long/path/that/keeps/going/_snippets.json（EACCES: permission denied）。检查 MotionHub 文件夹是否可写，改动先存在这台电脑的缓存里";
        const page = await open(browser, 1, 260, 800);
        await page.evaluate((m) => window.MHDebug.note({ ok: false, msg: m }), LONG);
        await page.focus("#hint"); await page.keyboard.press("Enter"); await page.waitForTimeout(100);
        const o1 = await page.evaluate(() => !document.querySelector("#modal").hidden);
        await page.keyboard.press("Escape"); await page.waitForTimeout(60);
        const f1 = await page.evaluate(() => document.activeElement === document.body ? "<body>" : document.activeElement.id || document.activeElement.tagName);
        check("提示栏的全文：键盘打开、Esc 关掉后焦点不掉到 <body>", o1 && f1 !== "<body>", JSON.stringify({ o1, f1 }));
        await page.evaluate((m) => window.MHDebug.note({ ok: false, msg: m }), LONG.replace("代码片段", "曲线预设"));
        await page.focus("#hint"); await page.keyboard.press("Enter"); await page.waitForTimeout(100);
        await page.evaluate((m) => window.MHDebug.note({ ok: false, msg: m }), LONG.replace("代码片段", "面板布局"));
        await page.keyboard.press("Escape"); await page.waitForTimeout(60);
        const f2 = await page.evaluate(() => document.activeElement.id);
        check("看全文时又来了一条放不下的消息：关掉后焦点回到提示栏", f2 === "hint", f2);
        await page.close();
    }
    {
        // 脚本库：鼠标点行里的「移除」、在确认框里用鼠标点「取消」：鼠标移开后这一行不再亮着；键盘打开、Esc 取消：焦点回到这个按钮。
        // 键盘移除一行、删掉一个片段：焦点落到顶替它的那一行的同一个按钮上；键盘新建片段保存后：焦点回到分组的「+」
        const page = await open(browser, 1, 320, 800);
        await page.click(".tab[data-tab=library]");
        const row = page.locator("#lib-list .lib-item").first();
        await row.hover(); await row.locator(".act.danger").click(); await page.waitForTimeout(100);
        await page.click("#dlg-btns .btn:first-child"); await page.waitForTimeout(100);
        await page.mouse.move(150, 790); await page.waitForTimeout(60);
        const m1 = await page.evaluate(() => ({ lit: document.querySelector("#lib-list .lib-item").matches(":focus-within"), focus: document.activeElement.tagName }));
        check("鼠标点「移除」再点「取消」：鼠标移开后这一行不再亮着", !m1.lit, JSON.stringify(m1));
        await row.locator(".act.danger").focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(100);
        await page.keyboard.press("Escape"); await page.waitForTimeout(60);
        const k1 = await page.evaluate(() => { const a = document.activeElement; return { trash: a.classList.contains("danger") && !!a.closest(".lib-item"), ring: a.matches(":focus-visible") }; });
        check("键盘按「移除」、Esc 取消：焦点回到这个按钮（有焦点框）", k1.trash && k1.ring, JSON.stringify(k1));
        const where = () => page.evaluate(() => { const a = document.activeElement, li = a.closest && a.closest(".lib-item"); return { row: li ? li.querySelector(".nm").textContent : (a === document.body ? "<body>" : a.tagName), act: li ? [...li.querySelectorAll(".act")].indexOf(a) : -1, key: a.dataset ? a.dataset.actKey || "" : "" }; });
        await page.locator("#lib-list .lib-item").nth(1).locator(".act.danger").focus();
        await page.keyboard.press("Enter"); await page.waitForTimeout(100);
        await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
        const k2 = await where(), rows = await page.evaluate(() => [...document.querySelectorAll("#lib-list .lib-item .nm")].map(n => n.textContent));
        check("键盘移除一行：焦点落到顶替它的那一行的同一个按钮上（不掉到 <body>）", !rows.includes("甩动") && k2.row === "整理项目" && k2.act === 3, JSON.stringify({ k2, rows }));
        await page.click("#lib-seg button[data-seg=snippets]");
        await page.locator("#lib-snippets .lib-group").nth(0).locator(".act").focus();
        await page.keyboard.press("Enter"); await page.waitForTimeout(100);
        await page.keyboard.type("键盘新建");
        await page.fill("#dlg-body textarea", "value + 1");
        await page.focus("#dlg-btns .btn:last-child"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
        const k3 = await where();
        check("键盘新建片段、保存后：焦点回到分组的「+」（不掉到 <body>）", k3.key === "g:expr#0", JSON.stringify(k3));
        const del = page.locator("#lib-snippets .lib-item", { has: page.locator(".nm", { hasText: "键盘新建" }) });
        // 顶替它的那一行：下一行，没有就上一行；那一行有同一个按钮（第 4 个「删除」）就落在它上面，没有就落在那一行的第一个按钮上
        const want = await del.evaluate((li) => { const sib = (n, d) => { for (n = d > 0 ? n.nextElementSibling : n.previousElementSibling; n; n = d > 0 ? n.nextElementSibling : n.previousElementSibling) if (n.classList.contains("lib-item")) return n; return null; }; const r = sib(li, 1) || sib(li, -1); return { row: r.querySelector(".nm").textContent, act: r.querySelectorAll(".act").length > 3 ? 3 : 0 }; });
        await del.locator('.act[aria-label="删除"]').focus();
        await page.keyboard.press("Enter"); await page.waitForTimeout(100);
        await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
        const k4 = await where(), gone = await page.evaluate(() => ![...document.querySelectorAll("#lib-snippets .nm")].some(n => n.textContent === "键盘新建"));
        check("键盘删掉一个片段：焦点落到顶替它的那一行的同一个按钮上（没有就那一行的第一个），不掉到 <body>", gone && k4.row === want.row && k4.act === want.act, JSON.stringify({ k4, want, gone }));
        check("脚本库焦点场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }
    {
        // 设置页：用键盘改自定义主题色，焦点留在自定义颜色上（自定义的颜色没有选中的色块，以前会掉到 <body>）
        const page = await open(browser, 1, 320, 800);
        await page.click(".tab[data-tab=settings]");
        await page.focus("#set-accent .sw.custom input");
        await page.evaluate(() => { const i = document.activeElement; i.value = "#12ab34"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); });
        const c1 = await page.evaluate(() => ({ type: document.activeElement.type || document.activeElement.tagName, accent: window.MHDebug.config().accent }));
        check("设置页：用键盘改自定义主题色，焦点留在自定义颜色上", c1.type === "color" && c1.accent === "#12AB34", JSON.stringify(c1));
        await page.close();
    }
    {
        // 编辑模式的「组件颜色」：键盘打开时焦点进到色板里，方向键在色块之间走；Esc 关掉回到按钮（不退出编辑模式）；
        // Tab 走过最后一个也关掉回到按钮；回车选色后焦点回到按钮
        const page = await open(browser, 3, 320, 900);
        await page.click("#btn-edit");
        await page.click("#layout .key-grid .cell >> nth=0");
        const swIdx = () => page.evaluate(() => [...document.querySelectorAll("#pop .sw")].indexOf(document.activeElement));
        await page.focus("#eb-color"); await page.keyboard.press("Enter"); await page.waitForTimeout(60);
        const p1 = await page.evaluate(() => ({ open: !document.querySelector("#pop").hidden, inPop: !!document.activeElement.closest("#pop") }));
        const i0 = await swIdx();
        await page.keyboard.press("ArrowRight");
        const i1 = await swIdx();
        await page.keyboard.press("Escape");
        const p2 = await page.evaluate(() => ({ open: !document.querySelector("#pop").hidden, focus: document.activeElement.id, editing: document.body.classList.contains("editing") }));
        check("「组件颜色」用键盘打开：焦点进到色板里，方向键在色块之间走", p1.open && p1.inPop && i0 >= 0 && i1 === i0 + 1, JSON.stringify({ p1, i0, i1 }));
        check("色板里按 Esc：关掉色板，焦点回到「组件颜色」，不退出编辑模式", !p2.open && p2.focus === "eb-color" && p2.editing, JSON.stringify(p2));
        await page.keyboard.press("Enter"); await page.waitForTimeout(60);
        let n = 0;
        while (n < 30 && await page.evaluate(() => !document.querySelector("#pop").hidden)) { await page.keyboard.press("Tab"); n++; }
        const p3 = await page.evaluate(() => document.activeElement.id);
        check("色板里一直按 Tab：走过最后一个就关掉色板，焦点回到「组件颜色」", n > 1 && n < 30 && p3 === "eb-color", JSON.stringify({ n, p3 }));
        await page.keyboard.press("Enter"); await page.waitForTimeout(60);
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter"); await page.waitForTimeout(100);
        const p4 = await page.evaluate(() => { const sel = document.querySelector("#layout .cell.sel"); return { focus: document.activeElement.id, color: sel ? (window.MHDebug.config().items.find(i => i.id === sel.dataset.id) || {}).color : null }; });
        check("色板里按回车选色：颜色改了，焦点回到「组件颜色」", p4.focus === "eb-color" && !!p4.color, JSON.stringify(p4));
        // 输入法组字时的 Esc 是给输入法的：不退出编辑模式（前面的步骤没通过时也先回到编辑模式，这几条各自成立）
        await page.evaluate(() => { if (!document.body.classList.contains("editing")) document.querySelector("#btn-edit").click(); });
        await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
        const ime = await page.evaluate(() => document.body.classList.contains("editing"));
        check("编辑模式：输入法组字时按 Esc 不退出编辑模式", ime);
        // 把选中的组件拖到最后：编辑条的「上移」可用、「下移」不可用（跟着新位置变）
        await page.evaluate(() => { if (!document.body.classList.contains("editing")) document.querySelector("#btn-edit").click(); });
        const d = await page.evaluate(() => {
            const cells = [...document.querySelectorAll("#layout .cell[data-id]")], src = cells[0], dst = cells[cells.length - 1];
            src.click();
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
            const rr = dst.getBoundingClientRect(), o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rr.right - 2, clientY: rr.bottom - 2 };
            dst.dispatchEvent(new DragEvent("dragover", o)); dst.dispatchEvent(new DragEvent("drop", o));
            src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
            const items = window.MHDebug.config().items, sel = document.querySelector("#layout .cell.sel");
            return { idx: sel ? items.findIndex(i => i.id === sel.dataset.id) : -1, n: items.length, up: document.querySelector("#eb-up").disabled, down: document.querySelector("#eb-down").disabled };
        });
        check("编辑模式：把选中的组件拖到最后，「上移」可用、「下移」不可用", d.idx === d.n - 1 && !d.up && d.down, JSON.stringify(d));
        // 窄面板里选中组件后编辑条折成两行：滚动定位让出的高度马上是变高以后的（编辑条高度 + 8px）
        await page.setViewportSize({ width: 240, height: 900 });
        await page.addStyleTag({ content: "#edit-bar { padding-right: 96px !important; }" });
        const s = await page.evaluate(() => {
            document.querySelector("#page-panel").click();
            const bar = document.querySelector("#edit-bar"), h0 = bar.offsetHeight;
            document.querySelector("#layout .key-grid .cell").click();
            return { h0, h1: bar.offsetHeight, pad: document.querySelector("#page-panel").style.scrollPaddingTop };
        });
        check("窄面板：选中组件后编辑条变高，滚动定位让出的高度跟着变", s.h1 > s.h0 && s.pad === (s.h1 + 8) + "px", JSON.stringify(s));
        check("编辑模式第三轮场景没有 JS 错误", !page.__errors.length, page.__errors.join(" | "));
        await page.close();
    }
    {
        // 加载失败的脚本按钮（布局文件里的脚本 key 坏了）：单独占一整行，不挤在 110px 的脚本格子里；很长的说明（路径）折行，不被切掉
        for (const w of [260, 320]) {
            const page = await open(browser, 3, w, 900, layout([{ type: "heading", en: "RUN", zh: "运行" }, { type: "script", key: "/动画/弹跳.jsx" }, { type: "script", key: 123 }, { type: "snippet", sid: "builtin:wiggle" }]));
            const r = await page.evaluate(() => {
                const b = document.querySelector("#layout .cell.broken");
                if (!b) return null;
                const msg = b.querySelector(".broken-msg");
                msg.textContent = "这个组件加载失败：脚本 · ENOENT:/Users/someone/Library/Application_Support/Adobe/CEP/extensions/com.windwings.motionhub/very_long_path_without_any_spaces/renderer.js";
                const br = b.getBoundingClientRect(), rg = document.createRange(); rg.selectNodeContents(msg);
                const lines = [...rg.getClientRects()].filter(x => x.width > 0), inR = br.left + b.clientLeft + b.clientWidth;
                return { inRun: !!b.closest(".run-grid"), block: b.parentElement.className, spillR: Math.max(0, ...lines.map(x => x.right - inR)), spillB: Math.max(0, ...lines.map(x => x.bottom - br.bottom)), runs: document.querySelectorAll("#layout .run-grid .cell").length };
            });
            check(w + "px：加载失败的脚本按钮单独占一整行，很长的说明折行显示完整", r && !r.inRun && /full-block/.test(r.block) && r.spillR <= 0.5 && r.spillB <= 0.5 && r.runs === 2, JSON.stringify(r));
            await page.close();
        }
    }
    {
        // 很矮的面板：气泡里的字只画在气泡里面（少显示几行，行尾省略）
        const LONG = "这次操作在 AE 里出错了，后台本身正常：换个选区再试，或把这条提示发给开发者。".repeat(6);
        for (const h of [90, 120]) {
            const page = await open(browser, 1, 260, h);
            const r = await page.evaluate((m) => {
                window.MHBridge.show(null, "err", m);
                const b = document.querySelector(".fb"), s = b.querySelector("span"), br = b.getBoundingClientRect(), sr = s.getBoundingClientRect();
                return { fbTop: br.top, fbBottom: br.bottom, spanBottom: sr.bottom, H: innerHeight };
            }, LONG);
            check(h + "px 高的面板：气泡里的字不画到气泡外面", r.spanBottom <= r.fbBottom + 0.5 && r.fbTop >= 0 && r.fbBottom <= r.H, JSON.stringify(r));
            await page.close();
        }
    }
    {
        // 启动时的「按钮搬家了」说明：用户已经打开了对话框（命令搜索）就先等着，关掉以后再出来，不把正在用的对话框换掉
        const old = { "mh.panel1": { name: "旧布局", accent: "#FF5900", items: [{ id: "a", type: "heading", en: "KEYS", zh: "关键帧" }, { id: "b", type: "easeBoth" }, { id: "c", type: "alignLeft" }] } };
        const page = await open(browser, 1, 320, 800, old, { delay: { scan: 900 } });
        await page.click("#btn-search"); await page.waitForTimeout(1000);
        const m1 = await page.evaluate(() => ({ open: !document.querySelector("#modal").hidden, palette: !!document.querySelector("#dlg-head .pal-input") }));
        await page.keyboard.press("Escape");
        const shown = await page.waitForFunction(() => !document.querySelector("#modal").hidden && /按钮搬家了/.test(document.querySelector("#dlg-title").textContent), null, { timeout: 3000 }).then(() => true, () => false);
        check("启动时的迁移说明：有对话框开着时先等着，关掉以后再出来", m1.open && m1.palette && shown, JSON.stringify({ m1, shown }));
        await page.close();
    }

    await browser.close();
    console.log(failures ? "✗ 版式测试：" + failures + " 项没通过" : "✓ 版式测试全部通过");
    process.exit(failures ? 1 : 0);
})();
