// 迁移测试：把 v3.4.4 的 4 个默认预设（加上 blank 和一个用户自定义布局）当成磁盘上的 panelN.json 载入
// 断言：没有空格子或「（缺失）」；每个旧按钮都能在新布局里找到位置；颜色和参数保留；只说明一次；第二次载入不再变化
"use strict";
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const EXT = path.join(__dirname, "../com.windwings.motionhub");
const OLD = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/layouts-3.4.4.json"), "utf8"));
// 和 main.js 里的迁移表一致：旧类型 → 新位置
const MERGE_TO = {
    easeBoth: "ease", linear: "ease", hold: "ease", cloneKeys: "keys", reverseKeys: "keys",
    adjust: "create", solid: "create", camera: "create", textLayer: "create", shapeLayer: "create", light: "create", nullLayer: "create",
    seq: "arrange", chain: "arrange"
};
const TO_SNIPPET = { wiggle: "builtin:wiggle", loop: "builtin:loop", bounce: "builtin:bounce", clearExpr: "builtin:clearExpr" };
const SINGLE = ["ease", "keys", "create", "arrange"];

let failures = 0;
function check(name, cond, detail) {
    console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : "：" + (detail || "")));
    if (!cond) failures++;
}

async function load(browser, text) {
    const page = await browser.newPage({ viewport: { width: 320, height: 2400 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const saved = {};
    await page.exposeFunction("__save", (name, t) => { saved[name] = t; });
    await page.addInitScript((text) => {
        try { localStorage.clear(); } catch (e) {}
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.panel1",
            getSystemPath: () => "file:///ext",
            registerKeyEventsInterest() {},
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb("object"), 2);
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                const name = m[1], a = JSON.parse(m[2]);
                let r = { ok: true, msg: "", data: {} };
                if (name === "init") r.data = { version: "3.7.2", ae: "24.3.0", canWrite: true, os: "mac", libPath: "/lib" };
                if (name === "loadConfig") r.data = { text: a.name === "panel1" ? text : null };
                if (name === "saveConfig") window.__save(a.name, a.text);
                if (name === "loadSnippets") r.data = { text: null };
                if (name === "scan") r.data = { items: [], categories: [], libPath: "/lib" };
                if (name === "importSamples") r.data = { copied: 0, existing: 2 };
                if (name === "ctx") r.data = { comp: "", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0 };
                setTimeout(() => cb(JSON.stringify(r)), 2);
            }
        };
    }, text);
    await page.goto("file://" + EXT + "/index.html");
    await page.waitForTimeout(900);
    const res = await page.evaluate(() => {
        const modal = document.querySelector("#modal");
        const dialog = !modal.hidden ? { title: document.querySelector("#dlg-title").textContent, body: document.querySelector("#dlg-body").textContent } : null;
        const cells = Array.from(document.querySelectorAll("#layout .cell"));
        return {
            dialog,
            cfg: window.MHDebug.config(),
            types: window.MHDebug.types(),
            broken: cells.filter(c => c.classList.contains("broken")).length,
            empty: cells.filter(c => !c.classList.contains("heading") && (!c.children.length || c.offsetHeight < 8)).length,
            missingText: /（缺失）|（已删除的片段）/.test(document.querySelector("#layout").textContent),
            cellCount: cells.length
        };
    });
    await page.waitForTimeout(400);   // 等防抖保存
    await page.close();
    return Object.assign(res, { errors, saved });
}

(async () => {
    const browser = await chromium.launch();
    for (const key of Object.keys(OLD)) {
        const old = OLD[key];
        console.log("布局「" + key + "」：" + old.items.length + " 项");
        const r = await load(browser, JSON.stringify(old));
        const items = r.cfg.items;
        const types = new Set(items.map(i => i.type));
        const sids = new Set(items.filter(i => i.type === "snippet").map(i => i.sid));
        const oldTypes = old.items.map(i => i.type);
        const hadMerged = oldTypes.some(t => MERGE_TO[t] || TO_SNIPPET[t]) || oldTypes.indexOf("beat") !== -1;

        check("迁移后 schema = 2", r.cfg.schema === 2, r.cfg.schema);
        check("没有页面错误", r.errors.length === 0, r.errors.join(" | "));
        check("没有空格子、加载失败的组件、「（缺失）」或「（已删除的片段）」", !r.broken && !r.empty && !r.missingText, JSON.stringify({ broken: r.broken, empty: r.empty, missing: r.missingText }));
        const unknown = items.filter(i => r.types.indexOf(i.type) === -1).map(i => i.type);
        check("新布局里每个组件类型都已注册", unknown.length === 0, unknown.join(","));
        // 每个旧按钮都能找到新位置
        const lost = [];
        old.items.forEach(it => {
            const t = it.type;
            if (MERGE_TO[t]) { if (!types.has(MERGE_TO[t])) lost.push(t + "→" + MERGE_TO[t]); }
            else if (TO_SNIPPET[t]) { if (!sids.has(TO_SNIPPET[t])) lost.push(t + "→" + TO_SNIPPET[t]); }
            else if (t === "heading") { /* 迁移后变空的标题会去掉，单独检查 */ }
            else if (!items.some(n => n.id === it.id && n.type === t)) lost.push(t + "（id " + it.id + "）");
        });
        if (oldTypes.indexOf("beat") !== -1 && !types.has("arrange")) lost.push("beat 的「按节拍排列」→ arrange");
        check("每个旧按钮都能在新布局里找到（" + old.items.filter(i => i.type !== "heading").length + " 个）", lost.length === 0, lost.join("，"));
        // 合并后的组件不重复
        const dup = SINGLE.filter(t => items.filter(i => i.type === t).length > Math.max(1, old.items.filter(i => i.type === t).length));
        check("合并后的组件没有重复", dup.length === 0, dup.join(","));
        const dupS = Object.values(TO_SNIPPET).filter(s => items.filter(i => i.sid === s).length > 1);
        check("内置片段没有重复", dupS.length === 0, dupS.join(","));
        // 标题：不留没有内容的标题（除非用户原来就是空分组）
        const emptyHeads = items.filter((it, i) => it.type === "heading" && (i === items.length - 1 || items[i + 1].type === "heading"))
            .filter(h => { const oi = old.items.findIndex(o => o.id === h.id); return oi !== -1 && oi + 1 < old.items.length && old.items[oi + 1].type !== "heading"; });
        check("迁移没有留下空的分组标题", emptyHeads.length === 0, emptyHeads.map(h => h.en).join(","));
        // 迁移说明
        check(hadMerged ? "弹出了一次迁移说明" : "没有需要搬家的按钮，不弹说明", hadMerged ? !!(r.dialog && /按钮搬家/.test(r.dialog.title)) : !r.dialog, JSON.stringify(r.dialog));
        if (hadMerged) check("迁移结果写回了磁盘", !!r.saved.panel1 && JSON.parse(r.saved.panel1).schema === 2);
        // 第二次载入：不再迁移、不再说明、内容不变
        if (r.saved.panel1) {
            const r2 = await load(browser, r.saved.panel1);
            check("第二次载入不再弹说明", !r2.dialog, JSON.stringify(r2.dialog));
            check("第二次载入布局不变", JSON.stringify(r2.cfg.items) === JSON.stringify(JSON.parse(r.saved.panel1).items));
        }
        if (key === "custom") {
            const ease = items.find(i => i.type === "ease"), create = items.find(i => i.type === "create"), arr = items.find(i => i.type === "arrange");
            check("颜色带到了新组件（缓入缓出 → 缓动，空对象 → 新建图层）", ease && ease.color === "#A8BBD6" && create && create.color === "#FF5900", JSON.stringify({ ease, create }));
            check("依次排列的 Num / Step 带到了时间排列", arr && arr.mode === "stagger" && arr.num === 2 && arr.step === 4, JSON.stringify(arr));
            check("关键帧工具原来的参数保留（factor=2）", items.some(i => i.type === "keys" && i.factor === 2));
            check("剪到工作区 / 运动模糊（默认隐藏的工具）在用户布局里保留", types.has("trim") && types.has("motionBlur"));
            check("节拍组件的「每 N 拍」带到了时间排列（every=2）", arr && arr.every === 2, JSON.stringify(arr));
        }
    }
    // 审查回归：首尾相接排在依次排列前面时，Num / Step 不丢；已有时间排列时，节拍的 every 也补上
    {
        const page = await browser.newPage();
        await page.addInitScript(() => { window.__adobe_cep__ = { getExtensionId: () => "com.windwings.motionhub.panel1", getSystemPath: () => "", registerKeyEventsInterest() {}, evalScript(c, cb) { cb(c === "typeof MH" ? "object" : JSON.stringify({ ok: true, data: { text: null } })); } }; });
        await page.goto("file://" + EXT + "/index.html");
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => window.MHDebug.migrate({ items: [
            { id: "a", type: "chain", gap: 3 }, { id: "b", type: "seq", num: 3, step: 5 }, { id: "c", type: "beat", every: 4 }] }));
        const arr = r.cfg.items.filter(i => i.type === "arrange");
        console.log("参数合并：");
        check("只有一个时间排列，保留首尾相接模式，并补上 Num=3 / Step=5 / 间隔=3 / 每 4 拍", arr.length === 1 && arr[0].mode === "chain" && arr[0].num === 3 && arr[0].step === 5 && arr[0].gap === 3 && arr[0].every === 4, JSON.stringify(r.cfg.items));
        const r2 = await page.evaluate(() => window.MHDebug.migrate({ items: [{ id: "h", type: "heading", en: "EMPTY" }, { id: "h2", type: "heading", en: "X" }, { id: "w", type: "wiggle" }] }));
        check("用户自己建的空分组保留；迁移后仍有内容的分组保留", r2.cfg.items.length === 3 && r2.cfg.items[0].id === "h", JSON.stringify(r2.cfg.items));
        await page.close();
    }
    // 审查回归：迁移结果写不进磁盘（没开写入权限）时，说明只弹一次
    {
        const text = JSON.stringify(OLD.custom);
        const run = async (ls) => {
            const page = await browser.newPage();
            await page.addInitScript(([text, ls]) => {
                localStorage.clear();
                for (const k in ls) localStorage.setItem(k, ls[k]);
                window.__adobe_cep__ = { getExtensionId: () => "com.windwings.motionhub.panel1", getSystemPath: () => "", registerKeyEventsInterest() {},
                    evalScript(code, cb) {
                        if (code === "typeof MH") return cb("object");
                        const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code); const a = JSON.parse(m[2]);
                        let r = { ok: true, data: {} };
                        if (m[1] === "loadConfig") r.data = { text: a.name === "panel1" ? text : null };
                        if (m[1] === "saveConfig") r = { ok: false, msg: "无法写入" };
                        if (m[1] === "init") r.data = { version: "3.7.2", ae: "24", canWrite: false, os: "mac" };
                        if (m[1] === "scan") r.data = { items: [], categories: [], libPath: "/lib" };
                        setTimeout(() => cb(JSON.stringify(r)), 2);
                    } };
            }, [text, ls]);
            await page.goto("file://" + EXT + "/index.html");
            await page.waitForTimeout(900);
            const shown = await page.evaluate(() => !document.querySelector("#modal").hidden && /按钮搬家/.test(document.querySelector("#dlg-title").textContent));
            const store = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
            await page.close();
            return { shown, store };
        };
        const first = await run({});
        const second = await run(first.store);
        console.log("写盘失败：");
        check("第一次启动弹说明，磁盘写不进去时第二次启动不再弹", first.shown && !second.shown, JSON.stringify({ first: first.shown, second: second.shown }));
    }
    // 审查回归：使用统计——读到磁盘历史之前点了按钮，不能覆盖历史，也不能重复计数
    {
        const page = await browser.newPage({ viewport: { width: 320, height: 1600 } });
        const saves = [];
        await page.exposeFunction("__saveUsage", (t) => saves.push(t));
        await page.addInitScript(() => {
            localStorage.clear();
            window.__adobe_cep__ = { getExtensionId: () => "com.windwings.motionhub.panel3", getSystemPath: () => "", registerKeyEventsInterest() {},
                evalScript(code, cb) {
                    if (code === "typeof MH") return cb("object");
                    const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code); const a = JSON.parse(m[2]);
                    let r = { ok: true, msg: "完成", data: {} }, delay = 2;
                    if (m[1] === "loadConfig") { r.data = { text: a.name === "usage_panel3" ? JSON.stringify({ anchor: 5 }) : null }; if (a.name === "usage_panel3") delay = 600; }
                    if (m[1] === "saveConfig" && a.name === "usage_panel3") window.__saveUsage(a.text);
                    if (m[1] === "init") r.data = { version: "3.7.2", ae: "24", canWrite: true, os: "mac" };
                    if (m[1] === "scan") r.data = { items: [], categories: [], libPath: "/lib" };
                    if (m[1] === "ctx") r.data = { comp: "C", layers: 1, keys: 0, exprProps: 0, precomps: 0, projComps: 0 };
                    setTimeout(() => cb(JSON.stringify(r)), delay);
                } };
        });
        await page.goto("file://" + EXT + "/index.html");
        await page.waitForTimeout(150);
        await page.click('.anchor-grid .tile >> nth=0');   // 磁盘上的统计还没读到
        await page.waitForTimeout(3200);
        const last = saves.length ? JSON.parse(saves[saves.length - 1]) : null;
        console.log("使用统计：");
        check("读到历史之前点的一次，和磁盘上的 5 次合并成 6 次（不覆盖、不重复）", last && last.anchor === 6, JSON.stringify(saves));
        await page.close();
    }
    // 3.7.2 H1：没开写入权限 + 清空本机缓存后重新打开，布局还在（ExtendScript 写不进去时改用 Node 直接写盘）
    {
        const HOME = "/Users/test", CFG = HOME + "/Library/Application Support/MotionHub/";
        const run = async (disk, withNode) => {
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", e => errors.push(e.message));
            await page.addInitScript(([disk, withNode, CFG, HOME]) => {
                localStorage.clear();
                const mem = window.__mem = Object.assign({}, disk);
                const err = (code) => { const e = new Error(code); e.code = code; return e; };
                if (withNode) window.require = (m) => {
                    if (m === "fs") return {
                        mkdirSync() {}, existsSync: p => p in mem, unlinkSync: p => { delete mem[p]; },
                        writeFileSync: (p, t) => { mem[p] = String(t); },
                        renameSync: (a, b) => { if (!(a in mem)) throw err("ENOENT"); mem[b] = mem[a]; delete mem[a]; },
                        readFileSync: p => { if (!(p in mem)) throw err("ENOENT"); return mem[p]; }
                    };
                    if (m === "path") return { join: (...a) => a.join("/").replace(/\/+/g, "/"), dirname: p => p.replace(/\/[^\/]*$/, ""), basename: p => p.replace(/^.*\//, "") };
                    if (m === "os") return { homedir: () => HOME };
                    throw err("MODULE_NOT_FOUND");
                };
                window.__hostWrites = 0;
                window.__adobe_cep__ = { getExtensionId: () => "com.windwings.motionhub.panel1", getSystemPath: () => "", registerKeyEventsInterest() {},
                    evalScript(code, cb) {
                        if (code === "typeof MH") return cb("object");
                        const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code); const a = JSON.parse(m[2]);
                        let r = { ok: true, msg: "", data: {} };
                        // ExtendScript 读得到 Node 写的同一个文件；没开写入权限时写不进去
                        if (m[1] === "loadConfig") r.data = { text: (CFG + a.name + ".json") in mem ? mem[CFG + a.name + ".json"] : null };
                        if (m[1] === "saveConfig" || m[1] === "saveSnippets") { window.__hostWrites++; r = { ok: false, msg: "无法写入：" + a.name }; }
                        if (m[1] === "loadSnippets") r.data = { text: null };
                        if (m[1] === "init") r.data = { version: "3.7.2", ae: "24.3.0", canWrite: false, os: "mac", libPath: "/lib", libReady: true };
                        if (m[1] === "scan") r.data = { items: [], categories: [], libPath: "/lib" };
                        if (m[1] === "importSamples") r.data = { copied: 0, existing: 0, skipped: true };
                        if (m[1] === "ctx") r.data = { comp: "", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0 };
                        setTimeout(() => cb(JSON.stringify(r)), 2);
                    } };
            }, [disk, withNode, CFG, HOME]);
            await page.goto("file://" + EXT + "/index.html");
            await page.waitForTimeout(900);
            return { page, errors };
        };
        console.log("无写入权限（H1）：");
        // 第一次打开：改面板名字 → 等防抖保存
        const a = await run({}, true);
        const hostBefore = await a.page.evaluate(() => window.__hostWrites);
        await a.page.evaluate(() => { const el = document.querySelector("#set-name"); el.value = "我的剪辑面板"; el.dispatchEvent(new Event("change")); });
        await a.page.waitForTimeout(600);
        const hostAfter = await a.page.evaluate(() => window.__hostWrites);
        const disk = await a.page.evaluate(() => window.__mem);
        const bannerA = await a.page.evaluate(() => document.querySelector("#set-perm") ? document.querySelector("#set-perm").textContent : "");
        await a.page.close();
        const saved = disk[CFG + "panel1.json"] ? JSON.parse(disk[CFG + "panel1.json"]) : null;
        check("写入权限关着：布局用 Node 写进了 userData/MotionHub/panel1.json（先写 .tmp 再改名，没有留下 .tmp）", saved && saved.name === "我的剪辑面板" && !Object.keys(disk).some(k => /\.tmp$/.test(k)), JSON.stringify(Object.keys(disk)));
        check("「示例已导入」标记也写到了磁盘（state.json）", disk[CFG + "state.json"] && JSON.parse(disk[CFG + "state.json"]).seeded === true, JSON.stringify(disk[CFG + "state.json"]));
        check("没有页面报错", !a.errors.length, a.errors.join(" | "));
        // 第二次打开：本机缓存清空了，布局从磁盘读回来
        const b = await run(disk, true);
        const nameB = await b.page.evaluate(() => window.MHDebug.config().name);
        await b.page.close();
        check("清空本机缓存后重新打开，面板名字和布局还在", nameB === "我的剪辑面板", nameB);
        check("已知权限关着时，改动直接用 Node 写，不再先去试一次注定失败的 ExtendScript 写入", hostAfter === hostBefore, hostBefore + " → " + hostAfter);
        // 对照：没有 Node 时（旧行为）同样的操作会丢——说明这条测试确实测到了问题
        const c = await run({}, false);
        await c.page.evaluate(() => { const el = document.querySelector("#set-name"); el.value = "我的剪辑面板"; el.dispatchEvent(new Event("change")); });
        await c.page.waitForTimeout(600);
        const diskC = await c.page.evaluate(() => window.__mem);
        await c.page.close();
        const d = await run(diskC, false);
        const nameD = await d.page.evaluate(() => window.MHDebug.config().name);
        await d.page.close();
        check("对照组（没有 Node）：清空缓存后改动丢失——这正是 H1 要修的问题", nameD !== "我的剪辑面板", nameD);
        check("设置页的权限说明写明「面板布局和设置照常保存在磁盘上」", /照常保存在磁盘上/.test(bannerA), bannerA);
    }
    await browser.close();

    // 默认预设本身也要能通过：新建面板时没有任何需要迁移的东西
    console.log(failures ? "✗ 迁移测试：" + failures + " 项没通过" : "✓ 迁移测试全部通过");
    process.exit(failures ? 1 : 0);
})();
