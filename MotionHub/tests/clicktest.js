// 点击测试 + 网络测试
// - 用 Playwright 打开 index.html，mock window.__adobe_cep__：evalScript 记录每次调用并返回假数据，getExtensionId 依次返回 panel1–4
// - 逐个点击 #layout 里的每个控件，断言：每个工具按钮都产生了后台调用或看得见的反馈；页面 JS 错误为 0
// - 拦截所有非 file:// 请求，断言请求数为 0，并且 main.js 在 300ms 内开始运行
// 用法：node clicktest.js            （报告写到 tests/out/clicktest.json）
//      MH_BACKEND_DOWN=1 node clicktest.js   （模拟后台没加载，检查横幅和自动恢复）
"use strict";
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "../com.windwings.motionhub");
// main.js 里声明了 needs 的后台工具名：点了会调用这些工具的按钮，必须带 data-needs
const NEED_TOOLS = (function () {
    const src = fs.readFileSync(path.join(EXT, "js/main.js"), "utf8");
    const m = /var NEEDS = \{([\s\S]*?)\};/.exec(src);
    return new Set((m[1].match(/(\w+):/g) || []).map(x => x.slice(0, -1)));
})();
const OUT = path.join(__dirname, "out");

// 后台假数据
function fakeHost(name, args, state) {
    const ok = (data, msg) => ({ ok: true, msg: msg || "", data: data || {} });
    switch (name) {
        case "init": return ok({ libPath: "/Users/test/Documents/MotionHub/Library", version: "3.6.0", ae: "24.3.0", canWrite: state.canWrite, os: "mac" });
        case "status": return ok({ canWrite: state.canWrite });
        case "ctx": return ok(state.ctx || { comp: "", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0 });
        case "selfCheck": return ok({ version: "3.6.0", ae: "24.3.0", canWrite: state.canWrite, libPath: "/lib", libExists: true, libWritable: state.canWrite, libError: "" });
        case "scan": return ok({
            items: [
                { path: "/lib/动画/弹跳.jsx", key: "/动画/弹跳.jsx", name: "弹跳", file: "弹跳.jsx", cat: "动画", ext: "jsx", desc: "测试脚本", author: "", type: "脚本" },
                { path: "/lib/工具/面板.jsx", key: "/工具/面板.jsx", name: "工具面板", file: "面板.jsx", cat: "工具", ext: "jsx", desc: "", author: "", type: "面板" }
            ], categories: ["动画", "工具"], libPath: "/lib"
        });
        case "loadConfig": return ok({ text: null });
        case "saveConfig": return ok({ saved: true });
        case "loadSnippets": return ok({ text: null });
        case "saveSnippets": return ok({ saved: true });
        case "importSamples": return ok({ copied: 3, existing: 0 }, "已导入 3 个示例脚本");
        case "listEffects": return ok({ effects: [{ match: "ADBE Gaussian Blur 2", name: "高斯模糊", cat: "模糊" }] });
        case "audioInfo": return { ok: false, msg: "先选中一个带声音的图层" };
        case "pickFiles": return ok({ files: [] });
        case "bezierRead": return ok({ bezier: [0.3, 0, 0.2, 1] }, "已读取曲线");
        default: return ok({}, "（测试）" + name + " 完成");
    }
}

async function runPanel(browser, n, opts) {
    const page = await browser.newPage({ viewport: { width: 320, height: 1600 } });
    const errors = [], requests = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
    await page.route("**/*", route => {
        const u = route.request().url();
        if (u.startsWith("file://")) return route.continue();
        requests.push(u);
        return route.abort();
    });
    await page.exposeFunction("__mhHost", (name, argsJSON) => {
        return JSON.stringify(fakeHost(name, JSON.parse(argsJSON || "{}"), opts));
    });
    await page.addInitScript(([n, down, dead]) => {
        try { localStorage.clear(); } catch (e) {}
        window.__calls = [];
        window.__keys = null;
        let loaded = !down;  // 模拟「后台没加载」：第一次 typeof MH 不是 object，$.evalFile 之后才是
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.panel" + n,
            getSystemPath: () => "file:///Users/test/Library/Application%20Support/Adobe/CEP/extensions/com.windwings.motionhub",
            registerKeyEventsInterest: (s) => { window.__keys = s; },
            requestOpenExtension: (id) => { window.__opened = id; },
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb(loaded ? "object" : "undefined"), 2);
                if (code.indexOf("$.evalFile(") === 0) { window.__evalFile = code; loaded = !dead; return setTimeout(() => cb(dead ? "EvalScript error." : "undefined"), 2); }
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                if (!m) return setTimeout(() => cb("EvalScript error."), 2);
                if (!loaded) return setTimeout(() => cb("EvalScript error."), 2);
                window.__calls.push(m[1]);
                window.__mhHost(m[1], m[2]).then(r => setTimeout(() => cb(r), 2));
            }
        };
        // 记录 main.js 开始执行的时间：它第一行就读 window.MHIcons
        let icons;
        Object.defineProperty(window, "MHIcons", {
            configurable: true,
            set(v) { icons = v; },
            get() { if (icons && window.__mainStart === undefined && document.currentScript && /main\.js/.test(document.currentScript.src)) window.__mainStart = performance.now(); return icons; }
        });
    }, [n, !!opts.backendDown || !!opts.backendDead, !!opts.backendDead]);

    await page.goto("file://" + EXT + "/index.html");
    await page.waitForTimeout(600);
    const mainStart = await page.evaluate(() => window.__mainStart);
    const keys = await page.evaluate(() => window.__keys);
    const banner = await page.evaluate(() => { const b = document.querySelector("#banner"); return b && !b.hidden ? b.textContent.trim() : ""; });
    const evalFile = await page.evaluate(() => window.__evalFile || "");

    if (opts.warmup) { await page.close(); return { mainStart, requests }; }
    // 逐个点击 #layout 里的控件（跳过编辑模式下的控件、文字输入框）
    const total = await page.evaluate(() => {
        const list = Array.from(document.querySelectorAll("#layout button, #layout .chip, #layout canvas.wave"));
        list.forEach((el, i) => el.setAttribute("data-ct", i));
        return list.length;
    });
    const results = [];
    for (let i = 0; i < total; i++) {
        const sel = '[data-ct="' + i + '"]';
        const info = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el || !el.isConnected || el.offsetParent === null) return null;
            const cell = el.closest(".cell");
            return {
                cls: el.className, text: (el.textContent || "").trim().slice(0, 24),
                widget: cell ? (cell.querySelector(".w-head") ? cell.querySelector(".w-head").textContent.trim().slice(0, 30) : "") : "",
                isTool: el.classList.contains("tile") && !el.classList.contains("add"),
                needs: el.dataset.needs || ""
            };
        }, sel);
        if (!info) { results.push({ i, skipped: "已不在页面上（之前的点击重绘了组件）" }); continue; }
        const before = await page.evaluate((sel) => ({
            calls: window.__calls.length,
            cls: document.querySelector(sel).className,
            layoutHTML: document.querySelector("#layout").innerHTML.length
        }), sel);
        try { await page.click(sel, { timeout: 1500 }); } catch (e) { results.push({ i, info, error: "点不到：" + e.message.split("\n")[0] }); continue; }
        await page.waitForTimeout(140);   // 原则 1：150ms 内要有反馈
        const after = await page.evaluate(([sel, beforeLen]) => {
            const fb = document.querySelector(".fb");
            const el = document.querySelector(sel);
            return {
                calls: window.__calls.slice(beforeLen),
                bubble: fb && !fb.hidden ? fb.className + " · " + fb.textContent.trim() : "",
                pending: !!(el && (el.classList.contains("pending") || el.classList.contains("st-ok") || el.classList.contains("st-err") || el.classList.contains("flash"))),
                modal: !document.querySelector("#modal").hidden ? document.querySelector("#dlg-title").textContent : "",
                pop: !document.querySelector("#pop").hidden,
                cls: el ? el.className : "(重绘)",
                layoutHTML: document.querySelector("#layout").innerHTML.length,
                hint: document.querySelector("#hint").className
            };
        }, [sel, before.calls]);
        const visible = !!(after.bubble || after.modal || after.pop || after.cls !== before.cls || after.layoutHTML !== before.layoutHTML || after.pending);
        const r = { i, info, calls: after.calls, bubble: after.bubble, modal: after.modal, pop: after.pop, reacted: after.calls.length > 0 || visible };
        results.push(r);
        // 收尾：关掉弹窗 / 浮层，等气泡消失，不影响下一个按钮
        if (after.modal) await page.evaluate(() => { const m = document.querySelector("#modal"); if (m.closeWith) m.closeWith(null); else m.hidden = true; });
        if (after.pop) await page.evaluate(() => { document.querySelector("#pop").hidden = true; });
        await page.waitForTimeout(20);
    }
    await page.close();
    return { panel: n, mainStart, keys, banner, evalFile, requests, errors, total, results };
}

// 审查发现的回归场景
async function runRegressions(browser) {
    const page = await browser.newPage({ viewport: { width: 320, height: 1200 } });
    const errors = [], out = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.exposeFunction("__mhHost", (name, argsJSON) => JSON.stringify(fakeHost(name, JSON.parse(argsJSON || "{}"), { canWrite: true })));
    await page.addInitScript(() => {
        try { localStorage.clear(); } catch (e) {}
        window.__calls = []; window.__saves = [];
        let alive = false;   // 启动时后台连不上，之后「修好」
        window.__revive = () => { alive = true; };
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.panel3",
            getSystemPath: () => "file:///ext",
            registerKeyEventsInterest() {},
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb(alive ? "object" : "undefined"), 2);
                if (code.indexOf("$.evalFile(") === 0) return setTimeout(() => cb(alive ? "undefined" : "EvalScript error."), 2);
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                if (!alive) return setTimeout(() => cb("EvalScript error."), 2);
                window.__calls.push(m[1]);
                if (m[1] === "saveConfig") window.__saves.push(JSON.parse(m[2]));
                window.__mhHost(m[1], m[2]).then(r => setTimeout(() => cb(r), 2));
            }
        };
    });
    await page.goto("file://" + EXT + "/index.html");
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => document.querySelectorAll("#layout .cell").length);
    // 后台不在时编辑布局：删掉第一个组件
    await page.click("#btn-edit");
    await page.click("#layout .cell .cell-ctl button[title='从面板删除']");
    await page.click("#btn-edit");
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.querySelectorAll("#layout .cell").length);
    // 后台恢复，点「重新连接」
    await page.evaluate(() => window.__revive());
    await page.click("#banner-btn");
    await page.waitForTimeout(800);
    const r1 = await page.evaluate(() => ({
        saves: window.__saves.map(s => JSON.parse(s.text).items.length),
        banner: document.querySelector("#banner").hidden,
        cells: document.querySelectorAll("#layout .cell").length,
        bubble: document.querySelector(".fb") && !document.querySelector(".fb").hidden ? document.querySelector(".fb").textContent : ""
    }));
    out.push({ name: "离线时删掉的组件，重新连接后写回磁盘（不被旧布局覆盖）", ok: after === before - 1 && r1.cells === after && r1.saves.length > 0 && r1.saves[r1.saves.length - 1] === after - 1 /* 末尾的「＋」不算组件 */ && r1.banner, detail: JSON.stringify({ before, after, r1 }) });

    // 双击脚本行里的「打开文件夹」按钮：不能顺带运行脚本
    await page.click(".tab[data-tab=library]");
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__calls = []; });
    await page.hover("#lib-list .lib-item");
    const folderBtn = await page.$("#lib-list .lib-item .acts .act");
    await folderBtn.dblclick();
    await page.waitForTimeout(300);
    const calls = await page.evaluate(() => window.__calls.slice());
    out.push({ name: "双击行内按钮不会触发整行的「双击运行」", ok: calls.indexOf("run") === -1 && calls.length > 0, detail: JSON.stringify(calls) });

    // 按钮被自己的操作重绘：气泡仍在按钮原来的位置旁边
    await page.evaluate(() => { const seg = document.querySelectorAll("#lib-seg button"); if (seg[1]) seg[1].click(); });
    await page.waitForTimeout(200);
    await page.hover("#lib-snippets .lib-item");
    const pin = await page.$("#lib-snippets .lib-item .acts .act");
    const pr = await pin.boundingBox();
    await pin.click();
    await page.waitForTimeout(150);
    const fb = await page.evaluate(() => { const f = document.querySelector(".fb"); const r = f.getBoundingClientRect(); return { hidden: f.hidden, top: r.top, bottom: r.bottom, text: f.textContent }; });
    const near = !fb.hidden && (Math.abs(fb.top - (pr.y + pr.height)) < 30 || Math.abs(fb.bottom - pr.y) < 30);
    out.push({ name: "列表重绘后，气泡仍出现在被点按钮旁边", ok: near, detail: JSON.stringify({ btn: pr, fb }) });

    // 对话框开着（在等用户输入）时，不显示「处理中」
    await page.click(".tab[data-tab=panel]");
    await page.waitForTimeout(150);
    await page.click('#layout .tile[data-tool="rename"]');
    await page.waitForTimeout(800);
    const st = await page.evaluate(() => { const f = document.querySelector(".fb"); return { modal: !document.querySelector("#modal").hidden, busyBubble: !!(f && !f.hidden && f.classList.contains("busy")) }; });
    await page.evaluate(() => document.querySelector("#modal").closeWith(null));
    await page.waitForTimeout(100);
    out.push({ name: "对话框开着时不显示「处理中」气泡", ok: st.modal && !st.busyBubble, detail: JSON.stringify(st) });

    out.push({ name: "回归场景里没有 JS 错误", ok: errors.length === 0, detail: errors.join(" | ") });
    await page.close();
    return out;
}

// 阶段 2：选区状态（变暗 / 恢复 / 节流 / 鼠标不在面板时不查 / 变暗仍可点）和自检
async function runNeeds(browser) {
    const page = await browser.newPage({ viewport: { width: 320, height: 1600 } });
    const errors = [], out = [];
    page.on("pageerror", e => errors.push(e.message));
    const state = { canWrite: true, ctx: null };
    await page.exposeFunction("__mhHost", (name, argsJSON) => JSON.stringify(fakeHost(name, JSON.parse(argsJSON || "{}"), state)));
    await page.exposeFunction("__setCtx", (c) => { state.ctx = c; });
    await page.addInitScript(() => {
        try { localStorage.clear(); } catch (e) {}
        window.__calls = [];
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.panel1",
            getSystemPath: () => "file:///ext",
            registerKeyEventsInterest() {},
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb("object"), 2);
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                window.__calls.push(m[1]);
                window.__mhHost(m[1], m[2]).then(r => setTimeout(() => cb(r), 2));
            }
        };
    });
    await page.goto("file://" + EXT + "/index.html");
    await page.waitForTimeout(700);
    const counts = () => page.evaluate(() => ({
        needs: document.querySelectorAll("#layout [data-needs]").length,
        na: document.querySelectorAll("#layout .na").length,
        ctxCalls: window.__calls.filter(c => c === "ctx").length
    }));
    const c0 = await counts();
    out.push({ name: "没有打开合成时，所有声明了 needs 的按钮都变暗", ok: c0.needs > 30 && c0.na === c0.needs, detail: JSON.stringify(c0) });

    // 悬停提示写明缺什么
    await page.hover('#layout .tile.na[data-needs="keys"]');
    const hintKeys = await page.textContent("#hint");
    out.push({ name: "悬停变暗的按钮，提示栏写明缺什么", ok: /现在不可用：先打开一个合成/.test(hintKeys), detail: hintKeys });

    // 变暗的按钮仍然可以点，以后台判断为准
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#layout .tile.na[data-tool="centerComp"]');
    await page.waitForTimeout(200);
    const clicked = await page.evaluate(() => window.__calls.slice());
    out.push({ name: "变暗的按钮仍然可以点，调用了后台", ok: clicked.indexOf("centerComp") !== -1, detail: JSON.stringify(clicked) });

    // 鼠标不动 2 秒：不查询
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__calls = []; });
    await page.waitForTimeout(2000);
    const idle = await page.evaluate(() => window.__calls.filter(c => c === "ctx").length);
    out.push({ name: "鼠标不在面板里移动时，2 秒内不查询选区", ok: idle === 0, detail: "ctx 调用 " + idle + " 次" });

    // 打开合成、选中 1 个图层：图层类按钮恢复，关键帧类仍然暗
    await page.evaluate(() => window.__setCtx({ comp: "主合成", layers: 1, keys: 0, exprProps: 0, precomps: 0, projComps: 0 }));
    await page.evaluate(() => { window.__calls = []; });
    for (let i = 0; i < 20; i++) { await page.mouse.move(40 + i * 5, 300 + (i % 3) * 7); await page.waitForTimeout(50); }   // 约 1 秒内移动 20 次
    await page.waitForTimeout(300);
    const moved = await page.evaluate(() => window.__calls.filter(c => c === "ctx").length);
    out.push({ name: "鼠标在面板里连续移动 1 秒，选区查询被节流到 ≤ 2 次", ok: moved >= 1 && moved <= 2, detail: "ctx 调用 " + moved + " 次" });
    const st1 = await page.evaluate(() => ({
        layerNa: document.querySelectorAll('#layout [data-needs="layer"].na').length,
        layer: document.querySelectorAll('#layout [data-needs="layer"]').length,
        keysNa: document.querySelectorAll('#layout [data-needs="keys"].na').length,
        keys: document.querySelectorAll('#layout [data-needs="keys"]').length,
        l2Na: document.querySelectorAll('#layout [data-needs="layers2"].na').length
    }));
    out.push({ name: "选中 1 个图层后：图层类按钮恢复，关键帧类和「至少 2 个图层」类仍然变暗", ok: st1.layerNa === 0 && st1.layer > 0 && st1.keysNa === st1.keys && st1.keys > 0 && st1.l2Na > 0, detail: JSON.stringify(st1) });

    // 审查回归：⌥ 会放宽条件的工具不该误暗（有合成、没选图层；选了图层、没选属性）
    await page.evaluate(() => window.__setCtx({ comp: "主合成", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0 }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(250);
    const lenient = await page.evaluate(() => ({
        smartRename: document.querySelector('[data-tool="smartRename"]').classList.contains("na"),
        wireframe: Array.from(document.querySelectorAll('[data-needs]')).filter(n => n.closest(".cell") && /WIREFRAME/.test(n.closest(".cell").textContent) && n.querySelector(".lbl") && /生成|线框/.test(n.textContent)).some(n => n.classList.contains("na"))
    }));
    await page.evaluate(() => window.__setCtx({ comp: "主合成", layers: 1, keys: 0, exprProps: 0, precomps: 0, projComps: 0 }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(250);
    const clearNa = await page.evaluate(() => document.querySelector('[data-tool="clearExpr"]').classList.contains("na"));
    out.push({ name: "⌥ 会放宽条件的工具不误暗：智能重命名 / 生成线框只要合成，清除表达式只要图层", ok: !lenient.smartRename && !lenient.wireframe && !clearNa, detail: JSON.stringify({ lenient, clearNa }) });

    // 审查回归：鼠标停在按钮上时选区变了，提示栏跟着更新
    await page.evaluate(() => window.__setCtx({ comp: "", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0 }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(250);
    await page.hover('#layout [data-tool="centerComp"]');
    const hint1 = await page.textContent("#hint");
    await page.evaluate(() => window.__setCtx({ comp: "主合成", layers: 2, keys: 0, exprProps: 0, precomps: 0, projComps: 0 }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(250);
    const hint2 = await page.textContent("#hint");
    out.push({ name: "鼠标停着时选区变化，提示栏的「现在不可用」随之消失", ok: /现在不可用/.test(hint1) && !/现在不可用/.test(hint2), detail: JSON.stringify({ hint1, hint2 }) });

    // 审查回归：节流窗口里的最后一次移动不会被吞掉
    await page.mouse.move(60, 500);
    await page.waitForTimeout(80);
    await page.evaluate(() => window.__setCtx({ comp: "主合成", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0 }));
    await page.mouse.move(70, 510);       // 落在节流窗口里，随后鼠标停住
    await page.waitForTimeout(1300);
    const trailing = await page.evaluate(() => document.querySelector('[data-tool="centerComp"]').classList.contains("na"));
    out.push({ name: "节流窗口里最后一次移动也会补查（鼠标停住后状态仍然正确）", ok: trailing, detail: "centerComp 是否变暗：" + trailing });

    // 全部满足：一个都不暗
    await page.evaluate(() => window.__setCtx({ comp: "主合成", layers: 3, keys: 4, exprProps: 2, precomps: 1, projComps: 1 }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(300);
    const c2 = await counts();
    out.push({ name: "窗口获得焦点时重新查询；条件都满足后没有变暗的按钮", ok: c2.na === 0, detail: JSON.stringify(c2) });

    // 操作完成后查询一次
    await page.evaluate(() => { window.__calls = []; });
    await page.click('#layout .tile[data-tool="centerComp"]');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__calls.slice());
    out.push({ name: "每次操作完成后查询一次选区", ok: after.indexOf("centerComp") !== -1 && after.lastIndexOf("ctx") > after.indexOf("centerComp"), detail: JSON.stringify(after) });

    // 自检
    await page.click(".tab[data-tab=settings]");
    await page.click("#set-recheck");
    await page.waitForTimeout(600);
    const chk = await page.evaluate(() => Array.from(document.querySelectorAll("#set-check li")).map(li => li.className + "|" + li.textContent));
    const names = ["后台连接", "前后端版本", "AE 版本", "写入权限", "脚本库文件夹", "Node.js", "本地字体"];
    const allThere = names.every(n => chk.some(c => c.indexOf(n) !== -1));
    const fontOk = chk.some(c => /^ok\|✓本地字体/.test(c));
    const verOk = chk.some(c => /^ok\|✓前后端版本/.test(c));
    const nodeBad = chk.some(c => /^bad\|!Node\.js/.test(c));   // 浏览器里没有 Node，应当如实报 !
    out.push({ name: "自检列出 7 项；字体和版本 ✓，浏览器里 Node 如实显示 !", ok: allThere && chk.length === 7 && fontOk && verOk && nodeBad, detail: JSON.stringify(chk) });

    // 审查回归：后台没连上时，自检仍列出 7 项
    await page.evaluate(() => { const B = window.MHBridge; B.__h = B.host; });
    await page.evaluate(() => { window.__adobe_cep__.evalScript = (code, cb) => setTimeout(() => cb("EvalScript error."), 2); });
    await page.click("#set-recheck");
    await page.waitForTimeout(800);
    const down = await page.evaluate(() => Array.from(document.querySelectorAll("#set-check li")).map(li => li.className + "|" + li.textContent));
    out.push({ name: "后台没连上时，自检仍列出 7 项（依赖后台的标为无法检查）", ok: down.length === 7 && down.filter(x => /无法检查/.test(x)).length === 4, detail: JSON.stringify(down) });

    out.push({ name: "阶段 2 场景里没有 JS 错误", ok: errors.length === 0, detail: errors.join(" | ") });
    await page.close();
    return out;
}

async function runStudio(browser, opts) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
    const errors = [], requests = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => { const u = route.request().url(); if (u.startsWith("file://")) return route.continue(); requests.push(u); return route.abort(); });
    await page.exposeFunction("__mhHost", (name, argsJSON) => {
        if (name === "listComps") return JSON.stringify({ ok: true, data: { comps: [] } });
        if (name === "pickVideos") return JSON.stringify({ ok: true, data: { files: [] } });
        return JSON.stringify(fakeHost(name, JSON.parse(argsJSON || "{}"), opts));
    });
    await page.addInitScript(() => {
        try { localStorage.clear(); } catch (e) {}
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.studio",
            getSystemPath: () => "file:///ext",
            registerKeyEventsInterest: (s) => { window.__keys = s; },
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb("object"), 2);
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                window.__mhHost(m[1], m[2]).then(r => setTimeout(() => cb(r), 2));
            }
        };
    });
    await page.goto("file://" + EXT + "/studio.html");
    await page.waitForTimeout(500);
    const ids = ["#add-clips", "#add-comp", "#btn-live"];
    const results = [];
    for (const id of ids) {
        await page.click(id);
        await page.waitForTimeout(140);
        results.push(await page.evaluate((id) => {
            const fb = document.querySelector(".fb");
            const m = document.querySelector("#modal");
            const r = { id, bubble: fb && !fb.hidden ? fb.textContent.trim() : "", modal: !m.hidden ? document.querySelector("#dlg-title").textContent : "" };
            if (!m.hidden) m.hidden = true;
            return r;
        }, id));
    }
    // 导出页的每个导出按钮
    await page.click("#stabs >> text=导出");
    const n = await page.evaluate(() => { const b = document.querySelectorAll("#sp-export .live-main, #sp-export .exp-btns .btn"); b.forEach((x, i) => x.setAttribute("data-sx", i)); return b.length; });
    for (let i = 0; i < n; i++) {
        await page.click('[data-sx="' + i + '"]');
        await page.waitForTimeout(140);
        results.push(await page.evaluate((i) => {
            const fb = document.querySelector(".fb"), el = document.querySelector('[data-sx="' + i + '"]');
            return { id: "导出 · " + el.textContent.trim().slice(0, 10), bubble: fb && !fb.hidden ? fb.textContent.trim() : "", modal: "" };
        }, i));
    }
    const keys = await page.evaluate(() => window.__keys);
    await page.close();
    return { errors, requests, results, keys };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    const opts = { canWrite: process.env.MH_NO_WRITE ? false : true, backendDown: !!process.env.MH_BACKEND_DOWN, backendDead: !!process.env.MH_BACKEND_DEAD };
    // 预热一次：浏览器第一次打开本地页面要冷启动（AE 里的面板没有这一步），这次的启动时间单独记录、不算进断言
    const warm = await runPanel(browser, 1, Object.assign({ warmup: true }, opts));
    console.log("预热（浏览器冷启动）：main.js 在 " + (warm.mainStart === undefined ? "?" : warm.mainStart.toFixed(1)) + "ms 开始执行，外部请求 " + warm.requests.length + " 个");
    const panels = [];
    for (let n = 1; n <= 4; n++) panels.push(await runPanel(browser, n, opts));
    const studio = await runStudio(browser, opts);
    const regress = await runRegressions(browser);
    const needs = await runNeeds(browser);
    await browser.close();

    let fail = 0;
    const lines = [];
    panels.forEach(p => {
        const tools = p.results.filter(r => r.info && r.info.isTool);
        const dead = p.results.filter(r => r.info && !r.reacted);
        const toolsWithCall = tools.filter(r => r.calls && r.calls.length);
        const toolsWithBubble = tools.filter(r => r.bubble || r.modal || r.pop);
        lines.push("面板 " + p.panel + "：控件 " + p.total + " 个，工具按钮 " + tools.length + " 个（" + toolsWithCall.length + " 个调用了后台，" + toolsWithBubble.length + " 个出现了气泡 / 对话框 / 浮层）");
        lines.push("  main.js 开始执行：" + (p.mainStart === undefined ? "未记录" : p.mainStart.toFixed(1) + "ms") + " · 外部请求 " + p.requests.length + " 个 · JS 错误 " + p.errors.length + " 个 · 按键登记 " + (p.keys || "无"));
        if (p.banner) lines.push("  横幅：" + p.banner);
        if (p.evalFile) lines.push("  自动恢复：" + p.evalFile.slice(0, 120));
        if (dead.length) { fail++; lines.push("  ✗ 没有任何反应的控件：" + dead.map(r => r.info.widget + "/" + (r.info.text || r.info.cls)).join("，")); }
        if (p.errors.length) { fail++; lines.push("  ✗ JS 错误：" + p.errors.join(" | ")); }
        if (p.requests.length) { fail++; lines.push("  ✗ 外部请求：" + p.requests.join(", ")); }
        if (!(p.mainStart < 300)) { fail++; lines.push("  ✗ main.js 没有在 300ms 内开始执行"); }
        const toolDead = tools.filter(r => !(r.calls && r.calls.length) && !r.bubble && !r.modal && !r.pop);
        if (opts.backendDead && !/重新连接/.test(p.banner)) { fail++; lines.push("  ✗ 后台连不上时没有显示「重新连接」横幅"); }
        const noNeeds = p.results.filter(r => r.info && r.calls && r.calls.some(c => NEED_TOOLS.has(c)) && !r.info.needs);
        if (noNeeds.length) { fail++; lines.push("  ✗ 会调用选区类工具、却没有声明 needs 的控件：" + noNeeds.map(r => r.info.widget + "/" + (r.info.text || r.info.cls) + "→" + r.calls.join("+")).join("，")); }
        const withNeeds = p.results.filter(r => r.info && r.info.needs).length;
        lines.push("  声明了 needs 的控件 " + withNeeds + " 个");
        if (toolDead.length) { fail++; lines.push("  ✗ 工具按钮既没有调用后台也没有气泡：" + toolDead.map(r => r.info.widget + "/" + (r.info.text || r.info.cls)).join("，")); }
    });
    lines.push("Studio：按钮 " + studio.results.length + " 个 · 外部请求 " + studio.requests.length + " 个 · JS 错误 " + studio.errors.length + " 个 · 按键登记 " + studio.keys);
    studio.results.forEach(r => lines.push("  " + r.id + " → " + (r.bubble || r.modal || "（没有反馈）")));
    if (studio.errors.length || studio.requests.length || studio.results.some(r => !r.bubble && !r.modal)) { fail++; lines.push("  ✗ Studio 有按钮没有反馈，或者有错误 / 外部请求"); }
    lines.push("阶段 2 · 选区状态与自检：");
    needs.forEach(r => { lines.push("  " + (r.ok ? "✓ " : "✗ ") + r.name + (r.ok ? "" : "：" + r.detail)); if (!r.ok) fail++; });
    lines.push("回归场景：");
    regress.forEach(r => { lines.push("  " + (r.ok ? "✓ " : "✗ ") + r.name + (r.ok ? "" : "：" + r.detail)); if (!r.ok) fail++; });
    fs.writeFileSync(path.join(OUT, "clicktest.json"), JSON.stringify({ panels, studio, regress, needs }, null, 2));
    console.log(lines.join("\n"));
    console.log(fail ? "✗ 点击测试：" + fail + " 项没通过（详情见 tests/out/clicktest.json）" : "✓ 点击测试通过（详情见 tests/out/clicktest.json）");
    process.exit(fail ? 1 : 0);
})();
