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
const OUT = path.join(__dirname, "out");

// 后台假数据
function fakeHost(name, args, state) {
    const ok = (data, msg) => ({ ok: true, msg: msg || "", data: data || {} });
    switch (name) {
        case "init": return ok({ libPath: "/Users/test/Documents/MotionHub/Library", version: "3.5.1", ae: "24.3.0", canWrite: state.canWrite, os: "mac" });
        case "status": return ok({ canWrite: state.canWrite });
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
                isTool: el.classList.contains("tile") && !el.classList.contains("add")
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
        if (toolDead.length) { fail++; lines.push("  ✗ 工具按钮既没有调用后台也没有气泡：" + toolDead.map(r => r.info.widget + "/" + (r.info.text || r.info.cls)).join("，")); }
    });
    lines.push("Studio：按钮 " + studio.results.length + " 个 · 外部请求 " + studio.requests.length + " 个 · JS 错误 " + studio.errors.length + " 个 · 按键登记 " + studio.keys);
    studio.results.forEach(r => lines.push("  " + r.id + " → " + (r.bubble || r.modal || "（没有反馈）")));
    if (studio.errors.length || studio.requests.length || studio.results.some(r => !r.bubble && !r.modal)) { fail++; lines.push("  ✗ Studio 有按钮没有反馈，或者有错误 / 外部请求"); }
    fs.writeFileSync(path.join(OUT, "clicktest.json"), JSON.stringify({ panels, studio }, null, 2));
    console.log(lines.join("\n"));
    console.log(fail ? "✗ 点击测试：" + fail + " 项没通过（详情见 tests/out/clicktest.json）" : "✓ 点击测试通过（详情见 tests/out/clicktest.json）");
    process.exit(fail ? 1 : 0);
})();
