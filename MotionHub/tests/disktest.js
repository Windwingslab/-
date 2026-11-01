// 磁盘数据安全测试（3.7.1）：没开写入权限、老版本只存在本机缓存里的数据、4 个面板共用的文件、写盘失败
// 每个面板一个独立的浏览器上下文（CEP 里每个面板的本机缓存是分开的），磁盘是一份共享的内存表：
// 一个面板做完操作，把磁盘内容交给下一个面板（模拟同一块磁盘）。
// 文件系统模拟得比较严：目录要先建好才能写；写入先写 .tmp 再改名；可以让某个文件的改名失败（模拟 Windows 上文件被占用）
"use strict";
const path = require("path");
const { chromium } = require("playwright");

const EXT = process.env.MH_EXT || path.join(__dirname, "../com.windwings.motionhub");
const HOME = "/Users/test", CFG = HOME + "/Library/Application Support/MotionHub/", LIB = "/lib", SNIP = LIB + "/_snippets.json";

let failures = 0;
function check(name, cond, detail) {
    console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : "：" + (detail || "")));
    if (!cond) failures++;
}

// o: { panel, disk, local（null = 保留上下文里原来的本机缓存）, canWrite, node, failRename: {文件: 次数 | "always"}, down, importCopies }
async function openPanel(browser, o) {
    const ctx = o.ctx || await browser.newContext({ viewport: { width: 340, height: 1400 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript((o) => {
        if (o.local) { localStorage.clear(); for (const k in o.local) localStorage.setItem("mh." + k, JSON.stringify(o.local[k])); }
        const mem = window.__mem = Object.assign({}, o.disk);
        const dirs = window.__dirs = new Set(["/", "/Users", o.HOME, o.HOME + "/Library", o.HOME + "/Library/Application Support"].concat(o.dirs || []));
        Object.keys(mem).forEach(p => { let d = p; while ((d = d.replace(/\/[^\/]*$/, "")) && d !== "") dirs.add(d); });
        window.__ops = []; window.__calls = [];
        const fail = Object.assign({}, o.failRename || {});
        window.__setFail = (f) => { for (const k in fail) delete fail[k]; Object.assign(fail, f); };
        const err = (code) => { const e = new Error(code); e.code = code; return e; };
        const dirOf = p => p.replace(/\/[^\/]*$/, "") || "/";
        if (o.node) window.require = (m) => {
            if (m === "fs") return {
                mkdirSync(p, opt) {
                    window.__ops.push(["mkdir", p]);
                    if (!opt || !opt.recursive) { if (!dirs.has(dirOf(p))) throw err("ENOENT"); dirs.add(p); return; }
                    let d = p; const add = []; while (d && d !== "/" && !dirs.has(d)) { add.push(d); d = dirOf(d); } add.forEach(x => dirs.add(x));
                },
                existsSync: p => p in mem || dirs.has(p),
                unlinkSync: p => { window.__ops.push(["unlink", p]); if (!(p in mem)) throw err("ENOENT"); delete mem[p]; },
                writeFileSync: (p, t, opt) => {
                    window.__ops.push(["write", p]);
                    if (!dirs.has(dirOf(p))) throw err("ENOENT");
                    if (opt && opt.flag === "wx" && p in mem) throw err("EEXIST");
                    mem[p] = String(t);
                    if (opt && opt.flag === "wx") { window.__mtime = window.__mtime || {}; window.__mtime[p] = Date.now(); }
                },
                renameSync: (a, b) => {
                    window.__ops.push(["rename", a, b]);
                    if (!(a in mem)) throw err("ENOENT");
                    const name = b.split("/").pop();
                    if (fail[name] === "always" || fail[name] > 0) { if (fail[name] !== "always") fail[name]--; throw err("EPERM"); }
                    if ((o.failRenameRe || []).some(x => new RegExp(x).test(name))) throw err("EPERM");
                    mem[b] = mem[a]; delete mem[a];
                },
                readFileSync: p => {
                    const name = p.split("/").pop();
                    if (window.__failRead && window.__failRead[name] > 0) { window.__failRead[name]--; throw err("EBUSY"); }
                    if (!(p in mem)) throw err("ENOENT"); return mem[p];
                },
                // 跨面板锁：wx = 文件已存在就失败
                openSync: (p, flag) => { window.__ops.push(["open", p, flag]); if (!dirs.has(dirOf(p))) throw err("ENOENT"); if (flag === "wx" && p in mem) throw err("EEXIST"); mem[p] = ""; window.__mtime = window.__mtime || {}; window.__mtime[p] = Date.now(); return 3; },
                closeSync: () => {},
                statSync: p => {
                    if (dirs.has(p)) return { isDirectory: () => true, mtimeMs: 0, size: 0 };
                    if (!(p in mem)) throw err("ENOENT");
                    return { isDirectory: () => false, mtimeMs: (window.__mtime && window.__mtime[p]) || 0, size: String(mem[p]).length };
                }
            };
            if (m === "path") return { join: (...a) => a.join("/").replace(/\/+/g, "/"), dirname: dirOf, basename: p => p.replace(/^.*\//, "") };
            if (m === "os") return { homedir: () => o.HOME };
            throw err("MODULE_NOT_FOUND");
        };
        window.__alive = !o.down;
        window.__revive = () => { window.__alive = true; };
        window.__canWrite = !!o.canWrite;
        window.__lib = o.LIB;   // 后台现在的脚本库（测试里可以改，模拟别的面板换了脚本库）
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.panel" + o.panel, getSystemPath: () => "", registerKeyEventsInterest() {},
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb(window.__alive ? "object" : "undefined"), 2);
                if (code.indexOf("$.evalFile(") === 0) return setTimeout(() => cb(window.__alive ? "undefined" : "EvalScript error."), 2);
                if (!window.__alive) return setTimeout(() => cb("EvalScript error."), 2);
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code); const a = JSON.parse(m[2]);
                window.__calls.push(m[1]);
                const cw = window.__canWrite;
                let r = { ok: true, msg: "", data: {} };
                // 后台（ExtendScript）读得到 Node 写的同一个文件；没开写入权限时写不进去
                if (m[1] === "loadConfig") r.data = { text: (o.CFG + a.name + ".json") in mem ? mem[o.CFG + a.name + ".json"] : null };
                if (m[1] === "saveConfig") { if (cw) mem[o.CFG + a.name + ".json"] = a.text; else r = { ok: false, msg: "无法写入：" + a.name }; }
                const SN = window.__lib + "/_snippets.json";
                if (m[1] === "loadSnippets") r.data = { text: SN in mem ? mem[SN] : null, libPath: window.__lib };
                if (m[1] === "saveSnippets") { if (cw) mem[SN] = a.text; else r = { ok: false, msg: "无法写入：_snippets.json" }; }
                if (m[1] === "init") r.data = { version: "3.7.1", ae: "24.3.0", canWrite: cw, os: "mac", libPath: window.__lib, libReady: true };
                if (m[1] === "status") r.data = { canWrite: cw };
                if (m[1] === "scan") r.data = { items: [], categories: [], libPath: window.__lib };
                if (m[1] === "importSamples") r.data = o.importCopies ? { copied: o.importCopies, existing: 0 } : { copied: 0, existing: 0, skipped: true };
                if (m[1] === "ctx") r.data = { comp: "", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0, lib: window.__lib };
                setTimeout(() => cb(JSON.stringify(r)), 2);
            }
        };
    }, Object.assign({}, o, { ctx: undefined, HOME, CFG, LIB, SNIP }));
    await page.goto("file://" + EXT + "/index.html");
    await page.waitForTimeout(o.wait || 1600);   // 启动 + 共用列表写入后的核对（最多约 0.8 秒）
    return {
        ctx, page, errors,
        disk: () => page.evaluate(() => window.__mem),
        snippets: () => page.evaluate(() => window.MHDebug.snippets()),
        config: () => page.evaluate(() => window.MHDebug.config()),
        calls: () => page.evaluate(() => window.__calls.slice()),
        hint: () => page.evaluate(() => document.querySelector("#hint").textContent),
        bubble: () => page.evaluate(() => { const f = document.querySelector(".fb"); return f && !f.hidden ? f.className + " | " + f.textContent : ""; }),
        // 关面板前把本机缓存原样记下来，重开时用它（浏览器在关掉最后一个页面时偶尔会丢掉还没提交的 localStorage，这是测试环境的问题）
        local: () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.indexOf("mh.") === 0) o[k.slice(3)] = JSON.parse(localStorage.getItem(k)); } return o; }),
        close: () => page.close()
    };
}
const J = (disk, file) => (file in disk ? JSON.parse(disk[file]) : null);
// 启动后的异步步骤在忙的机器上可能晚一点完成：轮询到条件成立（最多 4 秒），不靠固定的等待时间
async function until(get, ok, ms) {
    const t0 = Date.now();
    let v = await get();
    while (!ok(v) && Date.now() - t0 < (ms || 4000)) { await new Promise(r => setTimeout(r, 100)); v = await get(); }
    return v;
}
const names = list => (list || []).map(s => s.name);

async function gotoSnippets(p) {
    await p.page.click(".tab[data-tab=library]");
    await p.page.click("#lib-seg button[data-seg=snippets]");
    await p.page.waitForTimeout(100);
}
async function addSnippet(p, name, code) {
    await gotoSnippets(p);
    await p.page.locator("#lib-snippets .lib-group").nth(0).locator(".act").click();
    await p.page.fill("#dlg-body input[type=text]", name);
    await p.page.fill("#dlg-body textarea", code);
    await p.page.click("#dlg-btns .btn.accent");
    await p.page.waitForTimeout(400);
}
async function deleteSnippet(p, name) {
    await gotoSnippets(p);
    const row = p.page.locator("#lib-snippets .lib-item", { has: p.page.locator(".nm", { hasText: name }) }).first();
    await row.hover();
    await row.locator(".acts .act").nth(2).click();   // 放到面板、编辑、删除、运行
    await p.page.click("#dlg-btns .btn.accent");
    await p.page.waitForTimeout(400);
}
async function renamePanel(p, name) {
    await p.page.evaluate((n) => { const el = document.querySelector("#set-name"); el.value = n; el.dispatchEvent(new Event("change")); }, name);
}

// 3.7.0 时代、没开写入权限的用户：每个面板的东西只在自己的本机缓存里
const DEF = [
    ["expr", "循环抖动", "freq = 2; amp = 40; loopTime = 3;\nt = time % loopTime;\nw1 = wiggle(freq, amp, 1, 0.5, t);\nw2 = wiggle(freq, amp, 1, 0.5, t - loopTime);\nlinear(t, 0, loopTime, w1, w2)"],
    ["expr", "匀速旋转", "value + time * 90"]
];
const oldSnippets = (tag, own) => DEF.map((d, i) => ({ id: "old-" + tag + "-" + i, kind: d[0], name: d[1], code: d[2] })).concat([{ id: "own-" + tag, kind: "expr", name: own, code: "value // " + own }]);
const oldLayout = (tag, name) => ({ schema: 2, name: name, accent: "#FF5900", items: [{ id: "t1", type: "anchor" }, { id: "t2", type: "snippet", sid: "old-" + tag + "-1" }, { id: "t3", type: "snippet", sid: "own-" + tag }] });

(async () => {
    const browser = await chromium.launch();

    console.log("老版本没开写入权限的用户升级到 3.7.1（什么都不改）：");
    {
        const p1 = await openPanel(browser, { panel: 1, disk: {}, canWrite: false, node: true, local: {
            panel1: oldLayout("p1", "我的剪辑面板"), snippets: oldSnippets("p1", "面板1的片段"),
            curves: [["面板1的曲线", [0.1, 0, 0.2, 1]]], snipPrefs: { hidden: ["builtin:loop"] }, seeded: true } });
        let disk = await p1.disk();
        const p4 = await openPanel(browser, { panel: 4, disk, canWrite: false, node: true, local: {
            panel4: oldLayout("p4", "第四个面板"), snippets: oldSnippets("p4", "面板4的片段"),
            curves: [["面板4的曲线", [0.3, 0, 0.4, 1]]], seeded: true } });
        disk = await p4.disk();
        const errs = p1.errors.concat(p4.errors);
        const sn = J(disk, SNIP), c1 = J(disk, CFG + "panel1.json"), c4 = J(disk, CFG + "panel4.json");
        check("两个面板的布局都写进了磁盘（之前只在本机缓存里）", c1 && c1.name === "我的剪辑面板" && c4 && c4.name === "第四个面板", JSON.stringify([c1 && c1.name, c4 && c4.name]));
        check("两个面板各自的片段都合并进了共用的 _snippets.json", sn && names(sn).includes("面板1的片段") && names(sn).includes("面板4的片段"), JSON.stringify(names(sn)));
        check("两个面板各生成过一份的默认片段，合并后只剩一份", sn && names(sn).filter(n => n === "匀速旋转").length === 1 && names(sn).filter(n => n === "循环抖动").length === 1, JSON.stringify(names(sn)));
        const spinId = sn && (sn.find(s => s.name === "匀速旋转") || {}).id;
        const t2 = c4 && c4.items.find(i => i.id === "t2");
        check("第四个面板上指向它自己那份默认片段的按钮，改指到合并后留下的那份（不显示缺失）", t2 && t2.sid === spinId && !(await p4.page.evaluate(() => /（已删除的片段）|（缺失）/.test(document.querySelector("#layout").textContent))), JSON.stringify({ t2, spinId }));
        const cv = J(disk, CFG + "curves.json") || [], hd = J(disk, CFG + "snippet_prefs.json");
        check("两个面板的曲线预设都写进了 curves.json", cv.some(c => c[0] === "面板1的曲线") && cv.some(c => c[0] === "面板4的曲线"), JSON.stringify(cv));
        check("隐藏的内置片段写进了 snippet_prefs.json", hd && hd.hidden && hd.hidden.includes("builtin:loop"), JSON.stringify(hd));
        check("「示例已导入」的旧标记搬到了磁盘，没有重新导入示例", J(disk, CFG + "state.json") && J(disk, CFG + "state.json").seeded === true && !(await p1.calls()).includes("importSamples"), JSON.stringify(disk[CFG + "state.json"]));
        check("没有 JS 错误", !errs.length, errs.join(" | "));
        await p1.close(); await p4.close();
        // 本机缓存没了（升级 AE、清理临时文件）：从磁盘读回来
        const q1 = await openPanel(browser, { panel: 1, disk, canWrite: false, node: true, local: {} });
        const q4 = await openPanel(browser, { panel: 4, disk: await q1.disk(), canWrite: false, node: true, local: {} });
        const s4 = await until(q4.snippets, l => names(l).includes("面板1的片段") && names(l).includes("面板4的片段"));
        const k1 = await q1.config(), k4 = await q4.config();
        check("清空本机缓存后：两个面板的布局都还在", k1.name === "我的剪辑面板" && k4.name === "第四个面板" && k1.items.length === 3, JSON.stringify([k1.name, k4.name, k1.items.length]));
        check("清空本机缓存后：两个面板的片段都还在", names(s4).includes("面板1的片段") && names(s4).includes("面板4的片段"), JSON.stringify(names(s4)));
        check("清空本机缓存后：曲线预设和隐藏设置都还在", (await q4.page.evaluate(() => window.MHDebug.curves())).length === 2 && (await q1.page.evaluate(() => window.MHDebug.hidden())).includes("builtin:loop"));
        await q1.close(); await q4.close();
    }

    console.log("两个面板同时开着，各自改片段（不互相覆盖）：");
    {
        const base = { [SNIP]: JSON.stringify([{ id: "s0", kind: "expr", name: "原有片段", code: "value" }, { id: "s1", kind: "expr", name: "要删的片段", code: "value * 2" }]) };
        const a = await openPanel(browser, { panel: 1, disk: base, canWrite: true, node: true, local: {} });
        const b = await openPanel(browser, { panel: 4, disk: base, canWrite: true, node: true, local: {} });
        await addSnippet(a, "面板1新建", "value + 1");
        await deleteSnippet(a, "要删的片段");
        // 同一块磁盘：把面板 1 写过的内容交给面板 4（面板 4 手里还是旧列表）
        await b.page.evaluate((m) => { Object.assign(window.__mem, m); }, await a.disk());
        await addSnippet(b, "面板4新建", "value + 4");
        const d = await b.disk(), sn = names(J(d, SNIP));
        check("面板 4 用旧列表保存时，没有盖掉面板 1 刚加的片段", sn.includes("面板1新建") && sn.includes("面板4新建") && sn.includes("原有片段"), JSON.stringify(sn));
        check("面板 1 删掉的片段，不会被面板 4 的旧列表带回来", !sn.includes("要删的片段"), JSON.stringify(sn));
        check("面板 4 保存后，列表里也能看到面板 1 加的片段", names(await b.snippets()).includes("面板1新建"), JSON.stringify(names(await b.snippets())));
        await a.close(); await b.close();
    }

    console.log("写盘失败（文件正被别的程序占用）：");
    {
        // 片段：改名失败一次 → 气泡说明没写进去 → 自动重试后写进磁盘
        const p = await openPanel(browser, { panel: 1, disk: { [SNIP]: "[]" }, canWrite: false, node: true, local: {}, failRename: { "_snippets.json": 1 } });
        await addSnippet(p, "占用时新建", "value + 9");
        const bub = await p.bubble();
        check("片段没写进磁盘时，气泡报错而不是「已新建」", /err/.test(bub) && /没写进磁盘/.test(bub), bub);
        await p.page.waitForTimeout(2600);
        check("过一会儿自动重试，片段写进了磁盘", names(J(await p.disk(), SNIP)).includes("占用时新建"), (await p.disk())[SNIP]);
        await p.close();
        // 一直写不进去：关掉面板再打开（本机缓存还在）→ 先把本机改动合并回磁盘
        const ctx = await browser.newContext();
        const p2 = await openPanel(browser, { ctx, panel: 1, disk: { [SNIP]: JSON.stringify([{ id: "x", kind: "expr", name: "磁盘上的", code: "1" }]) }, canWrite: false, node: true, local: {}, failRename: { "_snippets.json": "always" } });
        await addSnippet(p2, "一直没写进去的", "value + 7");
        const disk2 = await p2.disk(), local2 = await p2.local();
        await p2.close();
        check("一直写不进去：磁盘上还是旧的", !names(J(disk2, SNIP)).includes("一直没写进去的"));
        const p3 = await openPanel(browser, { ctx, panel: 1, disk: disk2, canWrite: false, node: true, local: local2 });
        const d3 = await until(p3.disk, d => names(J(d, SNIP)).includes("一直没写进去的"));
        check("下次启动：本机缓存里没写进去的片段合并回磁盘，磁盘上原有的也在", names(J(d3, SNIP)).includes("一直没写进去的") && names(J(d3, SNIP)).includes("磁盘上的"), d3[SNIP]);
        await p3.close(); await ctx.close();

        // 布局：改名失败一次 → 提示一次 → 自动重试；之后的改动照常写进磁盘
        const ctxL = await browser.newContext();
        const L = await openPanel(browser, { ctx: ctxL, panel: 1, disk: {}, canWrite: false, node: true, local: {} });
        await renamePanel(L, "名字一"); await L.page.waitForTimeout(500);
        await L.page.evaluate(() => window.__setFail({ "panel1.json": 1 }));
        await renamePanel(L, "名字二"); await L.page.waitForTimeout(500);
        const hint = await L.hint();
        await renamePanel(L, "名字三"); await L.page.waitForTimeout(2600);
        const dl = await L.disk();
        check("布局写不进去时提示栏说明原因", /面板布局没写进磁盘/.test(hint), hint);
        check("一次失败之后，后面的改动仍然写进磁盘（不会整场只存本机缓存）", J(dl, CFG + "panel1.json").name === "名字三", dl[CFG + "panel1.json"]);
        await L.page.evaluate(() => window.__setFail({ "panel1.json": "always" }));
        await renamePanel(L, "名字四"); await L.page.waitForTimeout(500);
        const dl2 = await L.disk(), ll2 = await L.local();
        await L.close();
        const L2 = await openPanel(browser, { ctx: ctxL, panel: 1, disk: dl2, canWrite: false, node: true, local: ll2 });
        const dL2 = await until(L2.disk, d => (J(d, CFG + "panel1.json") || {}).name === "名字四");
        check("最后一次没写进去就关了 AE：下次启动以本机缓存为准，并写回磁盘", (await L2.config()).name === "名字四" && J(dL2, CFG + "panel1.json").name === "名字四", JSON.stringify([(await L2.config()).name, dL2[CFG + "panel1.json"]]));
        await L2.close(); await ctxL.close();
    }

    console.log("启动时后台没连上，离线时新建片段，之后重新连接：");
    {
        const p = await openPanel(browser, { panel: 1, disk: { [SNIP]: JSON.stringify([{ id: "x", kind: "expr", name: "已有片段", code: "1" }]) }, canWrite: false, node: true, local: {}, down: true });
        await p.page.evaluate(() => window.__revive());
        await p.page.click("#banner-btn");
        await p.page.waitForTimeout(1800);
        await addSnippet(p, "重连后新建", "value + 3");
        const d = await p.disk();
        check("重新连接后，新建的片段用 Node 写进了磁盘（先拿到脚本库位置再同步）", names(J(d, SNIP)).includes("重连后新建") && names(J(d, SNIP)).includes("已有片段"), d[SNIP]);
        await p.close();
        const ctx = await browser.newContext();
        const q = await openPanel(browser, { ctx, panel: 1, disk: { [SNIP]: JSON.stringify([{ id: "x", kind: "expr", name: "已有片段", code: "1" }]) }, canWrite: false, node: true, local: {}, down: true });
        await addSnippet(q, "离线时新建", "value + 5");
        await q.page.evaluate(() => window.__revive());
        await q.page.click("#banner-btn");
        await q.page.waitForTimeout(1800);
        const dq = await q.disk(), bq = await q.bubble() + " " + await q.hint();
        check("离线时新建的片段，重新连接后合并写进磁盘", names(J(dq, SNIP)).includes("离线时新建") && names(J(dq, SNIP)).includes("已有片段"), dq[SNIP]);
        check("重新连接的提示里没有「同步代码片段失败」", !/同步代码片段失败/.test(bq), bq);
        await q.close(); await ctx.close();
    }

    console.log("示例脚本只导入一次（标记在磁盘上）：");
    {
        const a = await openPanel(browser, { panel: 1, disk: { [CFG + "state.json"]: JSON.stringify({ seeded: true }) }, canWrite: true, node: true, local: {}, importCopies: 2 });
        check("磁盘上已经记了「已导入」：本机缓存清空了也不再导入", !(await a.calls()).includes("importSamples"), JSON.stringify(await a.calls()));
        await a.close();
        const b = await openPanel(browser, { panel: 1, disk: {}, canWrite: true, node: true, local: {}, importCopies: 2 });
        const db = await b.disk();
        check("全新用户：导入示例，并在磁盘上记下「已导入」", (await b.calls()).includes("importSamples") && J(db, CFG + "state.json") && J(db, CFG + "state.json").seeded === true, JSON.stringify(db[CFG + "state.json"]));
        await b.close();
    }

    console.log("写文件的方式（没开写入权限，Node 直接写）：");
    {
        const p = await openPanel(browser, { panel: 1, disk: {}, canWrite: false, node: true, local: {} });
        await renamePanel(p, "测试写法"); await p.page.waitForTimeout(500);
        const ops = await p.page.evaluate(() => window.__ops), target = CFG + "panel1.json";
        const iw = ops.findIndex(o => o[0] === "write" && o[1].indexOf(target + ".") === 0 && /\.tmp$/.test(o[1]));
        const ir = ops.findIndex(o => o[0] === "rename" && o[2] === target);
        check("先建好目录、写临时文件、再改名成正式文件名", ops.some(o => o[0] === "mkdir" && o[1] === CFG.replace(/\/$/, "")) && iw !== -1 && ir > iw, JSON.stringify(ops.slice(0, 12)));
        check("从不直接写正式文件（写到一半断电也不会留下半个文件）", !ops.some(o => o[0] === "write" && o[1] === target), JSON.stringify(ops.filter(o => o[0] === "write")));
        check("没有留下临时文件", !Object.keys(await p.disk()).some(k => /\.tmp$/.test(k)), JSON.stringify(Object.keys(await p.disk())));
        await p.close();
    }


    console.log("第二轮审查的场景：");
    {
        // A. 老用户第一次启动时已经开了写入权限：照样把本机缓存里的合并进磁盘（之前只在没权限时合并）
        const a1 = await openPanel(browser, { panel: 1, disk: {}, canWrite: true, node: true, local: { snippets: oldSnippets("p1", "面板1的片段"), curves: [["面板1的曲线", [0.1, 0, 0.2, 1]]], seeded: true } });
        const a4 = await openPanel(browser, { panel: 4, disk: await a1.disk(), canWrite: true, node: true, local: { snippets: oldSnippets("p4", "面板4的片段"), curves: [["面板4的曲线", [0.3, 0, 0.4, 1]]], seeded: true } });
        const da = await a4.disk();
        check("开着写入权限的老用户：两个面板的片段和曲线都合并进磁盘", names(J(da, SNIP)).includes("面板1的片段") && names(J(da, SNIP)).includes("面板4的片段") && (J(da, CFG + "curves.json") || []).length === 2, JSON.stringify([names(J(da, SNIP)), da[CFG + "curves.json"]]));
        await a1.close(); await a4.close();

        // B. 第一次启动时后台没连上（写入权限还不知道）：曲线照样合并，不被磁盘上的覆盖
        const disk0 = { [CFG + "curves.json"]: JSON.stringify([["别的面板的曲线", [0.5, 0, 0.5, 1]]]) };
        const b = await openPanel(browser, { panel: 4, disk: disk0, canWrite: false, node: true, down: true, local: { curves: [["面板4的曲线", [0.3, 0, 0.4, 1]]], seeded: true } });
        const cb = J(await b.disk(), CFG + "curves.json") || [];
        check("后台没连上的第一次启动：本机的曲线也合并进磁盘", cb.some(c => c[0] === "面板4的曲线") && cb.some(c => c[0] === "别的面板的曲线"), JSON.stringify(cb));
        await b.close();

        // C. 删除对话框开着时，列表被别的面板的改动更新：确认后删的是对的那一条
        const base = { [SNIP]: JSON.stringify([{ id: "a", kind: "expr", name: "片段甲", code: "1" }, { id: "b", kind: "expr", name: "片段乙", code: "2" }]) };
        const c = await openPanel(browser, { panel: 1, disk: base, canWrite: true, node: true, local: {} });
        await gotoSnippets(c);
        const row = c.page.locator("#lib-snippets .lib-item", { has: c.page.locator(".nm", { hasText: "片段甲" }) }).first();
        await row.hover(); await row.locator(".acts .act").nth(2).click();   // 打开删除确认
        await c.page.evaluate(() => {   // 别的面板加了一条；这个面板拿到焦点，列表跟着更新
            const p = "/lib/_snippets.json", l = JSON.parse(window.__mem[p]); l.push({ id: "z", kind: "expr", name: "别的面板加的", code: "9" }); window.__mem[p] = JSON.stringify(l);
            window.dispatchEvent(new Event("focus"));
        });
        await c.page.waitForTimeout(200);
        await c.page.click("#dlg-btns .btn.accent");
        await c.page.waitForTimeout(400);
        const dc = names(J(await c.disk(), SNIP));
        check("对话框开着时列表更新过：删掉的是「片段甲」，别的面板加的还在", !dc.includes("片段甲") && dc.includes("别的面板加的") && dc.includes("片段乙"), JSON.stringify(dc));
        await c.close();

        // D. 0 字节的共用文件（写到一半中断）：当成「还没有」，用本机缓存写回去，不报损坏
        const d = await openPanel(browser, { panel: 1, disk: { [SNIP]: "", [CFG + "curves.json"]: "" }, canWrite: true, node: true, local: { snippets: [{ id: "m", kind: "expr", name: "我的片段", code: "value" }], curves: [["我的曲线", [0.1, 0, 0.2, 1]]], snippetsMerged: true, curvesMerged: true, seeded: true } });
        const dd = await d.disk(), dh = await d.hint();
        check("0 字节文件：不报损坏，本机缓存里的片段和曲线写回了磁盘", !/损坏/.test(dh) && names(J(dd, SNIP)).includes("我的片段") && (J(dd, CFG + "curves.json") || []).length === 1, dh + " " + dd[SNIP]);
        await d.close();

        // E. 正常启动后，面板上的自建片段按钮显示片段名（之前会显示「已删除的片段」）
        const e = await openPanel(browser, { panel: 1, disk: { [SNIP]: JSON.stringify([{ id: "m", kind: "expr", name: "我的片段", code: "value" }]), [CFG + "panel1.json"]: JSON.stringify({ schema: 2, name: "面板", accent: "#FF5900", items: [{ id: "t", type: "snippet", sid: "m" }] }), [CFG + "state.json"]: JSON.stringify({ seeded: true }) }, canWrite: true, node: true, local: {} });
        const et = await e.page.evaluate(() => document.querySelector("#layout").textContent);
        check("启动后片段按钮显示「我的片段」，不显示「已删除的片段」", /我的片段/.test(et) && !/已删除的片段/.test(et), et.slice(0, 120));
        await e.close();

        // F. 两个面板改了同一条片段：两个版本都留下，并在气泡里说明
        const f0 = { [SNIP]: JSON.stringify([{ id: "a", kind: "expr", name: "片段甲", code: "value" }]) };
        const fa = await openPanel(browser, { panel: 1, disk: f0, canWrite: true, node: true, local: {} });
        const fb = await openPanel(browser, { panel: 4, disk: f0, canWrite: true, node: true, local: {} });
        await gotoSnippets(fa);
        const ra = fa.page.locator("#lib-snippets .lib-item", { has: fa.page.locator(".nm", { hasText: "片段甲" }) }).first();
        await ra.hover(); await ra.locator(".acts .act").nth(1).click();
        await fa.page.fill("#dlg-body textarea", "value + 100 // 面板1改的");
        await fa.page.click("#dlg-btns .btn.accent"); await fa.page.waitForTimeout(300);
        await fb.page.evaluate((m) => { Object.assign(window.__mem, m); }, await fa.disk());
        await gotoSnippets(fb);
        const rb = fb.page.locator("#lib-snippets .lib-item", { has: fb.page.locator(".nm", { hasText: "片段甲" }) }).first();
        await rb.hover(); await rb.locator(".acts .act").nth(1).click();
        await fb.page.fill("#dlg-body input[type=text]", "片段甲（面板4改名）");
        await fb.page.click("#dlg-btns .btn.accent"); await fb.page.waitForTimeout(400);
        const df = J(await fb.disk(), SNIP), bf = await fb.bubble();
        check("同一条片段两边都改了：面板 1 的代码修改还在，面板 4 的改名另存了一份", df.some(x => x.code === "value + 100 // 面板1改的") && df.some(x => /面板4改名/.test(x.name)), JSON.stringify(df));
        check("气泡说明两份都留下了", /两份都留下了/.test(bf), bf);
        await fa.close(); await fb.close();

        // G. 保存前读不到磁盘上现在的版本：不写，提示并稍后重试（不会盖掉别的面板加的）
        const g0 = { [SNIP]: JSON.stringify([{ id: "a", kind: "expr", name: "片段甲", code: "1" }, { id: "z", kind: "expr", name: "别的面板加的", code: "9" }]) };
        const g = await openPanel(browser, { panel: 1, disk: g0, canWrite: false, node: true, local: {} });
        await g.page.evaluate(() => { window.__failRead = { "_snippets.json": 1 }; });
        await addSnippet(g, "读不到时新建的", "value + 2");
        const gb = await g.bubble();
        await g.page.waitForTimeout(1500);
        const dg = names(J(await g.disk(), SNIP));
        check("保存前读不到磁盘：气泡报错，不覆盖文件", /err/.test(gb) && /没写进磁盘/.test(gb), gb);
        check("稍后自动重试：新建的写进去了，别的面板加的也还在", dg.includes("读不到时新建的") && dg.includes("别的面板加的") && dg.includes("片段甲"), JSON.stringify(dg));
        await g.close();

        // H. 别的面板换了脚本库：这个面板一刷新选区状态就知道，片段换成新库的，并说一声
        const h0 = { [SNIP]: JSON.stringify([{ id: "a", kind: "expr", name: "旧库的片段", code: "1" }]), "/lib2/_snippets.json": JSON.stringify([{ id: "n", kind: "expr", name: "新库的片段", code: "2" }]) };
        const h = await openPanel(browser, { panel: 4, disk: h0, canWrite: true, node: true, local: {} });
        await h.page.evaluate(() => { window.__lib = "/lib2"; window.dispatchEvent(new Event("focus")); });
        await h.page.waitForTimeout(500);
        const hn = names(await h.snippets()), hh = await h.hint();
        check("别的面板换了脚本库：片段列表换成了新库里的", hn.includes("新库的片段") && !hn.includes("旧库的片段"), JSON.stringify(hn));
        check("提示栏说明脚本库在别的面板换过", /脚本库已在别的面板换成「\/lib2」/.test(hh), hh);
        await h.close();

        // I. 启动时几处都写不进去：提示栏一句话说完，怎么办只说一次
        const fails = { "_snippets.json": "always", "curves.json": "always", "snippet_prefs.json": "always", "panel1.json": "always" };
        const i = await openPanel(browser, { panel: 1, disk: {}, canWrite: false, node: true, failRename: fails, local: { panel1: oldLayout("p1", "老布局"), snippets: oldSnippets("p1", "面板1的片段"), curves: [["曲线", [0.1, 0, 0.2, 1]]], seeded: true } });
        const ih = await i.hint();
        check("几处写不进去：合成一句「这些没写进磁盘：…」，并列出每个文件", /这些没写进磁盘：/.test(ih) && /代码片段（/.test(ih) && /曲线预设（/.test(ih) && /面板布局（/.test(ih), ih);
        check("「会自动重试；一直不行就检查文件夹是否可写」只出现一次", (ih.match(/一直不行就检查文件夹是否可写/g) || []).length === 1, ih);
        await i.close();

        // J. 全新用户：默认片段写一份；没有内容的曲线 / 隐藏设置不建空文件
        const j = await openPanel(browser, { panel: 1, disk: {}, canWrite: false, node: true, local: {} });
        const dj = await j.disk();
        check("全新用户：默认片段写进磁盘一份，曲线和隐藏设置没有建空文件", names(J(dj, SNIP)).filter(n => n === "匀速旋转").length === 1 && !((CFG + "curves.json") in dj) && !((CFG + "snippet_prefs.json") in dj), JSON.stringify(Object.keys(dj)));
        await j.close();
    }

    console.log("第三轮审查的场景：");
    {
        // 锁：上次异常退出留下的锁文件（很久以前的）→ 接管，照常写进去
        const lockName = (f) => { let h = 5381; for (let i = 0; i < f.length; i++) h = ((h * 33) ^ f.charCodeAt(i)) >>> 0; return CFG + ".locks/" + f.replace(/^.*\//, "").replace(/[^\w.\-]/g, "_") + "-" + h.toString(36) + ".lock"; };
        const lk = await openPanel(browser, { panel: 1, disk: { [SNIP]: "[]", [lockName(SNIP)]: "12345-dead-token" }, canWrite: false, node: true, local: {} });
        await addSnippet(lk, "锁残留时新建", "value + 1");
        const dlk = await lk.disk();
        check("上次异常退出留下的旧锁：接管它，改动照常写进磁盘，不留锁文件", names(J(dlk, SNIP)).includes("锁残留时新建") && !Object.keys(dlk).some(k => /\.lock$/.test(k) || /\.stale$/.test(k)), JSON.stringify(Object.keys(dlk)));
        await lk.close();

        // 换回备份前，当前布局的备份写不进去：不换，说明原因，当前布局还在
        const cur = { schema: 2, name: "我现在的布局", accent: "#FF5900", items: [{ id: "a", type: "anchor" }, { id: "b", type: "graph" }] };
        const old = { schema: 2, name: "备份里的布局", accent: "#FF5900", items: [{ id: "c", type: "keys" }] };
        const rb = await openPanel(browser, { panel: 1, disk: { [CFG + "panel1.json"]: JSON.stringify(cur), [CFG + "panel1-backup-1.json"]: JSON.stringify(old) }, canWrite: false, node: true, failRenameRe: ["^panel1-backup-\\d{8}"],
            local: { panel1: cur, cfgOnDisk1: true, cfgBackups1: [{ name: "panel1-backup-1", label: "备份里的布局" }], seeded: true } });
        await rb.page.click(".tab[data-tab=settings]");
        await rb.page.click("#set-preset");
        await rb.page.click("#dlg-btns .btn.accent");   // 备份排在最前面、默认选中
        await rb.page.waitForTimeout(400);
        const rbb = await rb.bubble(), rbc = await rb.config();
        check("当前布局的备份写不进去时不换回备份，并说明原因", rbc.name === "我现在的布局" && /没有换/.test(rbb), rbb + " | " + rbc.name);
        await rb.close();

        // 布局文件损坏：挪到旁边留着，用缓存里的布局重新写好，并说一声
        const tr = await openPanel(browser, { panel: 1, disk: { [CFG + "panel1.json"]: '{"schema":2,"name":"写了一半', [CFG + "state.json"]: '{"seeded":true}' }, canWrite: true, node: true, local: { panel1: cur } });
        const dtr = await until(tr.disk, d => /我现在的布局/.test(d[CFG + "panel1.json"] || ""));
        const trh = await tr.hint();
        check("布局文件损坏：原文件改名留着，布局用缓存重新写好，提示栏说明", /我现在的布局/.test(dtr[CFG + "panel1.json"]) && Object.keys(dtr).some(k => /panel1\.json\.bad-/.test(k)) && /面板布局文件损坏/.test(trh), trh + " " + JSON.stringify(Object.keys(dtr)));
        await tr.close();

        // 记事本存的「带 BOM 的 UTF-8」片段文件：照常读，不报损坏
        const bom = await openPanel(browser, { panel: 2, disk: { [SNIP]: "﻿" + JSON.stringify([{ id: "u", kind: "expr", name: "带BOM的片段", code: "1" }]), [CFG + "state.json"]: '{"seeded":true}' }, canWrite: true, node: true, local: {} });
        const bn = await until(bom.snippets, l => names(l).includes("带BOM的片段"));
        check("带 BOM 的片段文件照常读出来，不报损坏", names(bn).includes("带BOM的片段") && !/损坏/.test(await bom.hint()), JSON.stringify(names(bn)));
        await bom.close();

        // 共用片段文件被删掉了（同步盘出错、手动清理）：拿到焦点时用面板里的列表写回去，不把大家的列表清空
        const gone = await openPanel(browser, { panel: 1, disk: { [SNIP]: JSON.stringify([{ id: "u", kind: "expr", name: "还在的片段", code: "1" }]) }, canWrite: true, node: true, local: {} });
        await gone.page.evaluate(() => { delete window.__mem["/lib/_snippets.json"]; window.dispatchEvent(new Event("focus")); });
        const dg2 = await until(gone.disk, d => "/lib/_snippets.json" in d);
        check("片段文件被删掉后：用面板里的列表写回去，列表没被清空", names(J(dg2, SNIP)).includes("还在的片段") && names(await gone.snippets()).includes("还在的片段"), JSON.stringify(dg2[SNIP]));
        await gone.close();

        // 要删的片段刚在别的面板改过：不删，气泡说明（不说「已删除」）
        const kd = await openPanel(browser, { panel: 1, disk: { [SNIP]: JSON.stringify([{ id: "a", kind: "expr", name: "片段甲", code: "1" }]) }, canWrite: true, node: true, local: {} });
        await gotoSnippets(kd);
        const kr = kd.page.locator("#lib-snippets .lib-item", { has: kd.page.locator(".nm", { hasText: "片段甲" }) }).first();
        await kr.hover(); await kr.locator(".acts .act").nth(2).click();
        await kd.page.evaluate(() => { window.__mem["/lib/_snippets.json"] = JSON.stringify([{ id: "a", kind: "expr", name: "片段甲", code: "1 // 别的面板改过" }]); });
        await kd.page.click("#dlg-btns .btn.accent"); await kd.page.waitForTimeout(400);
        const kb = await kd.bubble(), kdd = J(await kd.disk(), SNIP);
        check("要删的片段刚在别的面板改过：没有删，气泡报「没有删除」而不是「已删除」", kdd.length === 1 && /没有删除/.test(kb) && !/已删除/.test(kb), kb + " " + JSON.stringify(kdd));
        await kd.close();
    }

    await browser.close();
    console.log(failures ? "✗ 磁盘数据安全测试：" + failures + " 项没通过" : "✓ 磁盘数据安全测试全部通过");
    process.exit(failures ? 1 : 0);
})();
