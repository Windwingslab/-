// 共用磁盘模拟（来自 3.7.1 第二轮审查）：4 个面板（各自一个浏览器上下文 = 各自的本机缓存）同时启动，读写同一块磁盘。
// · 页面里的 Node fs = 同步 XHR 到这个服务器（和 tests/disktest.js 一样严：目录要先建好、wx 打开已存在的文件会失败）
// · evalScript = 异步请求到这个服务器；后台调用一个一个执行（AE 只有一个 ExtendScript 引擎），每次随机延迟
// · 场景：3.7.0 没开写入权限的老用户第一次启动 3.7.1，4 个面板各有自己的片段、曲线、隐藏设置、布局；可以随机让改名失败（文件被占用）
// 断言：第一次启动（含自动重试）后、以及关掉 AE 重开后，谁的东西都在，默认片段只有一份，面板上的片段按钮都指得到片段
// 用法：node sharedsim.js [次数] [canWrite 0|1] [改名失败概率] [随机种子]
"use strict";
const http = require("http"), fsr = require("fs"), path = require("path");
const { chromium } = require("playwright");
const EXT = process.env.MH_EXT || path.join(__dirname, "../com.windwings.motionhub");
const HOME = "/Users/test", CFG = HOME + "/Library/Application Support/MotionHub/", LIB = "/lib", SNIP = LIB + "/_snippets.json";

let seed = +(process.argv[5] || 1);
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function makeDisk(init) {
    const mem = Object.assign({}, init), dirs = new Set(["/", "/Users", HOME, HOME + "/Library", HOME + "/Library/Application Support"]);
    Object.keys(mem).forEach(p => { let d = p; while ((d = d.replace(/\/[^\/]*$/, "")) && d !== "") dirs.add(d); });
    return { mem, dirs, log: [] };
}
const dirOf = p => p.replace(/\/[^\/]*$/, "") || "/";

function startServer(state) {
    const hostQ = [];
    let busy = false;
    function pump() {
        if (busy || !hostQ.length) return;
        busy = true;
        const job = hostQ.shift();
        setTimeout(() => { job(); busy = false; pump(); }, 1 + Math.floor(rnd() * state.hostLatency));
    }
    const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            const u = req.url.split("?")[0];
            if (u === "/fs") {
                const { op, args } = JSON.parse(body), D = state.disk;
                let out;
                try {
                    const err = (c) => { const e = new Error(c); e.code = c; throw e; };
                    if (op === "mkdirSync") { let d = args[0]; const add = []; while (d && d !== "/" && !D.dirs.has(d)) { add.push(d); d = dirOf(d); } add.forEach(x => D.dirs.add(x)); out = { ok: true }; }
                    else if (op === "existsSync") out = { ok: true, v: args[0] in D.mem || D.dirs.has(args[0]) };
                    else if (op === "unlinkSync") { if (!(args[0] in D.mem)) err("ENOENT"); delete D.mem[args[0]]; out = { ok: true }; }
                    else if (op === "writeFileSync") { if (!D.dirs.has(dirOf(args[0]))) err("ENOENT"); D.mem[args[0]] = String(args[1]); out = { ok: true }; }
                    else if (op === "renameSync") {
                        if (!(args[0] in D.mem)) err("ENOENT");
                        if (state.renameFail && rnd() < state.renameFail) { D.log.push(["EPERM", args[1], args[2]]); err("EPERM"); }
                        D.mem[args[1]] = D.mem[args[0]]; delete D.mem[args[0]]; D.log.push(["rename", args[1], args[2]]); out = { ok: true };
                    }
                    else if (op === "readFileSync") { if (!(args[0] in D.mem)) err("ENOENT"); out = { ok: true, v: D.mem[args[0]] }; }
                    else if (op === "openSync") { if (!D.dirs.has(dirOf(args[0]))) err("ENOENT"); if (args[1] === "wx" && args[0] in D.mem) err("EEXIST"); D.mem[args[0]] = ""; D.mt = D.mt || {}; D.mt[args[0]] = Date.now(); out = { ok: true, v: 3 }; }
                    else if (op === "closeSync") out = { ok: true };
                    else if (op === "statSync") { if (!(args[0] in D.mem)) err("ENOENT"); out = { ok: true, v: { mtimeMs: (D.mt && D.mt[args[0]]) || Date.now() } }; }
                    else out = { ok: false, code: "EINVAL" };
                } catch (e) { out = { ok: false, code: e.code || String(e) }; }
                res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out)); return;
            }
            if (u === "/host") {
                const { panel, name, args } = JSON.parse(body), D = state.disk;
                hostQ.push(() => {
                    const cw = state.canWrite;
                    let r = { ok: true, msg: "", data: {} };
                    if (name === "loadConfig") r.data = { text: (CFG + args.name + ".json") in D.mem ? D.mem[CFG + args.name + ".json"] : null };
                    if (name === "saveConfig") { if (cw) { D.mem[CFG + args.name + ".json"] = args.text; D.log.push(["hostWrite", CFG + args.name + ".json", panel]); } else r = { ok: false, msg: "无法写入：" + args.name }; }
                    if (name === "loadSnippets") r.data = { text: SNIP in D.mem ? D.mem[SNIP] : null, libPath: LIB };
                    if (name === "saveSnippets") { if (cw) { D.mem[SNIP] = args.text; D.log.push(["hostWrite", SNIP, panel]); } else r = { ok: false, msg: "无法写入：_snippets.json" }; }
                    if (name === "init") r.data = { version: "3.7.1", ae: "24.3.0", canWrite: cw, os: "mac", libPath: LIB, libReady: true };
                    if (name === "status") r.data = { canWrite: cw };
                    if (name === "scan") r.data = { items: [], categories: [], libPath: LIB };
                    if (name === "importSamples") r.data = { copied: 0, existing: 0, skipped: true };
                    if (name === "ctx") r.data = { comp: "", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0 };
                    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
                });
                pump();
                return;
            }
            // static extension files
            const f = path.join(EXT, decodeURIComponent(u.replace(/^\/ext\//, "")));
            fsr.readFile(f, (e, b) => {
                if (e) { res.writeHead(404); res.end(); return; }
                const ext = path.extname(f);
                res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" })[ext] || "application/octet-stream" });
                res.end(b);
            });
        });
    });
    return new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv)));
}

const DEF = [
    ["expr", "循环抖动", "freq = 2; amp = 40; loopTime = 3;\nt = time % loopTime;\nw1 = wiggle(freq, amp, 1, 0.5, t);\nw2 = wiggle(freq, amp, 1, 0.5, t - loopTime);\nlinear(t, 0, loopTime, w1, w2)"],
    ["expr", "匀速旋转", "value + time * 90"]
];
const oldSnippets = (tag, own) => DEF.map((d, i) => ({ id: "old-" + tag + "-" + i, kind: d[0], name: d[1], code: d[2] })).concat([{ id: "own-" + tag, kind: "expr", name: own, code: "value // " + own }]);
const oldLayout = (tag, name) => ({ schema: 2, name: name, accent: "#FF5900", items: [{ id: "t1", type: "anchor" }, { id: "t2", type: "snippet", sid: "old-" + tag + "-1" }, { id: "t3", type: "snippet", sid: "own-" + tag }] });

async function openPanel(browser, port, n, local, ctxIn) {
    const ctx = ctxIn || await browser.newContext({ viewport: { width: 340, height: 1000 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(({ n, local, HOME }) => {
        if (local) { localStorage.clear(); for (const k in local) localStorage.setItem("mh." + k, JSON.stringify(local[k])); }
        const call = (op, args) => {
            const x = new XMLHttpRequest(); x.open("POST", "/fs", false); x.send(JSON.stringify({ op, args }));
            const r = JSON.parse(x.responseText);
            if (!r.ok) { const e = new Error(r.code); e.code = r.code; throw e; }
            return r.v;
        };
        window.require = (m) => {
            if (m === "fs") return {
                mkdirSync: (p, o) => call("mkdirSync", [p, o]), existsSync: p => call("existsSync", [p]), unlinkSync: p => call("unlinkSync", [p]),
                writeFileSync: (p, t) => call("writeFileSync", [p, t]), renameSync: (a, b) => call("renameSync", [a, b, n]), readFileSync: p => call("readFileSync", [p]),
                openSync: (p, f) => call("openSync", [p, f]), closeSync: (fd) => call("closeSync", [fd]), statSync: p => call("statSync", [p])
            };
            if (m === "path") return { join: (...a) => a.join("/").replace(/\/+/g, "/"), dirname: p => p.replace(/\/[^\/]*$/, "") || "/", basename: p => p.replace(/^.*\//, "") };
            if (m === "os") return { homedir: () => HOME };
            throw new Error("MODULE_NOT_FOUND");
        };
        window.__adobe_cep__ = {
            getExtensionId: () => "com.windwings.motionhub.panel" + n, getSystemPath: () => "", registerKeyEventsInterest() {},
            evalScript(code, cb) {
                if (code === "typeof MH") return setTimeout(() => cb("object"), 1);
                const m = /^MH\.call\("([^"]+)",([\s\S]*)\)$/.exec(code);
                if (!m) return setTimeout(() => cb("undefined"), 1);
                fetch("/host", { method: "POST", body: JSON.stringify({ panel: n, name: m[1], args: JSON.parse(m[2]) }) }).then(r => r.text()).then(cb, () => cb("EvalScript error."));
            }
        };
    }, { n, local, HOME });
    return { ctx, page, errors, go: () => page.goto("http://127.0.0.1:" + port + "/ext/index.html") };
}

(async () => {
    const runs = +(process.argv[2] || 5), canWrite = process.argv[3] === "1", renameFail = +(process.argv[4] || 0);
    const browser = await chromium.launch();
    let bad = 0, dup = 0;
    const HID = ["wiggle", "loop", "bounce", "clearExpr"];
    function inspect(D) {
        const sn = SNIP in D ? JSON.parse(D[SNIP]) : [], cv = (CFG + "curves.json") in D ? JSON.parse(D[CFG + "curves.json"]) : [], hd = (CFG + "snippet_prefs.json") in D ? JSON.parse(D[CFG + "snippet_prefs.json"]).hidden : [];
        const ids = new Set(sn.map(s => s.id)), loss = [], dups = [];
        for (let i = 0; i < 4; i++) {
            if (!sn.some(s => s.name === "面板" + (i + 1) + "的片段")) loss.push("snippet p" + (i + 1));
            if (!cv.some(c => c[0] === "面板" + (i + 1) + "的曲线")) loss.push("curve p" + (i + 1));
            if (!hd.includes("builtin:" + HID[i])) loss.push("hidden p" + (i + 1));
            const t = D[CFG + "panel" + (i + 1) + ".json"], c = t ? JSON.parse(t) : null;
            if (!c) loss.push("layout p" + (i + 1));
            else c.items.filter(it => it.type === "snippet").forEach(it => { if (!ids.has(it.sid)) loss.push("tile p" + (i + 1) + ":" + it.sid); });
        }
        ["循环抖动", "匀速旋转"].forEach(nm => { const k = sn.filter(s => s.name === nm).length; if (k !== 1) dups.push(nm + " x" + k); });
        return { loss, dups, sn };
    }
    for (let run = 0; run < runs; run++) {
        const state = { disk: makeDisk({}), canWrite, renameFail, hostLatency: 25 };
        const srv = await startServer(state);
        const port = srv.address().port;
        const tags = ["p1", "p2", "p3", "p4"];
        let panels = [];
        for (let i = 0; i < 4; i++) {
            const t = tags[i];
            panels.push(await openPanel(browser, port, i + 1, {
                ["panel" + (i + 1)]: oldLayout(t, "面板" + (i + 1)), snippets: oldSnippets(t, "面板" + (i + 1) + "的片段"),
                curves: [["面板" + (i + 1) + "的曲线", [0.1 * (i + 1), 0, 0.5, 1]]], snipPrefs: { hidden: ["builtin:" + HID[i]] }, seeded: true
            }));
        }
        await Promise.all(panels.map(p => p.go()));
        await panels[0].page.waitForTimeout(9000);   // boot + verify rounds + automatic retries (2+4+6 s)
        const s1 = inspect(state.disk.mem);
        const fails = state.disk.log.filter(l => l[0] === "EPERM").length;
        const errs = [].concat(...panels.map(p => p.errors));
        // AE restarted: same localStorage, no more failures
        for (const p of panels) await p.page.close();
        state.renameFail = 0;
        const again = [];
        for (let i = 0; i < 4; i++) again.push(await openPanel(browser, port, i + 1, null, panels[i].ctx));
        await Promise.all(again.map(p => p.go()));
        await again[0].page.waitForTimeout(5000);
        const s2 = inspect(state.disk.mem);
        console.log("run " + run + " (EPERM " + fails + "): session1 loss=" + JSON.stringify(s1.loss) + " dups=" + JSON.stringify(s1.dups) + " | after restart loss=" + JSON.stringify(s2.loss) + " dups=" + JSON.stringify(s2.dups) + (errs.length ? " ERR " + errs.join("|") : ""));
        if (s2.loss.length) bad++;
        if (s2.dups.length) dup++;
        for (const p of panels) await p.ctx.close();
        srv.close();
    }
    await browser.close();
    console.log((bad || dup ? "✗ " : "✓ ") + "共用磁盘模拟（canWrite=" + (canWrite ? 1 : 0) + "，改名失败概率 " + renameFail + "）：" + runs + " 次里永久丢失 " + bad + " 次，默认片段重复 " + dup + " 次");
    process.exit(bad || dup ? 1 : 0);
})();
