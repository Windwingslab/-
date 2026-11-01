// Harness for the requirement-A prototype host (host-a.jsx). Mocks ExtendScript File/Folder closely enough
// for: read(n) + seek, length, modified, copy-overwrites, read-only folders, $.evalFile running fixture code.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const HOST = path.join(__dirname, "host-a.jsx");
let failures = 0, passes = 0;
function check(name, cond, detail) {
    if (cond) passes++; else failures++;
    console.log((cond ? "✓ " : "✗ ") + name + (cond ? "" : "：" + (detail || "")));
}

function loadHost(opts) {
    opts = opts || {};
    const root = opts.root || fs.mkdtempSync(path.join(os.tmpdir(), "mh-a-"));
    const home = path.join(root, "home");
    const undo = [], presetCalls = [];
    const ro = (p) => (opts.roDirs || []).some(d => p === d || p.startsWith(d + "/"));
    const real = (p) => p.replace(/^~(?=\/|$)/, home);
    function FileC(p) { if (!(this instanceof FileC)) return new FileC(p); this.fsName = real(String(p)); this.name = encodeURI(path.basename(this.fsName)); this.encoding = "UTF-8"; this.error = ""; }
    Object.defineProperty(FileC.prototype, "exists", { get() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isFile(); } });
    Object.defineProperty(FileC.prototype, "parent", { get() { return new FolderC(path.dirname(this.fsName)); } });
    Object.defineProperty(FileC.prototype, "length", { get() { return this.exists ? fs.statSync(this.fsName).size : 0; } });
    Object.defineProperty(FileC.prototype, "modified", { get() { return this.exists ? new Date(fs.statSync(this.fsName).mtimeMs) : null; } });
    FileC.prototype.open = function (mode) {
        if (mode !== "r" && ro(path.dirname(this.fsName))) { this.error = "Permission denied"; return false; }
        this._pos = 0;
        if (mode === "w") fs.writeFileSync(this.fsName, "");
        return mode === "r" ? this.exists : true;
    };
    FileC.prototype.read = function (n) {
        const buf = fs.readFileSync(this.fsName);
        const t = this.encoding === "BINARY" ? buf.toString("latin1") : buf.toString("utf8");
        const start = this._pos || 0, out = n === undefined ? t.substr(start) : t.substr(start, n);
        this._pos = start + out.length;
        return out;
    };
    FileC.prototype.seek = function (pos, mode) { const len = this.length; this._pos = mode === 2 ? Math.max(0, len - pos) : mode === 1 ? this._pos + pos : pos; return true; };
    FileC.prototype.write = function (t) { fs.appendFileSync(this.fsName, t, this.encoding === "BINARY" ? "latin1" : "utf8"); return true; };
    FileC.prototype.close = function () { return true; };
    FileC.prototype.copy = function (to) {
        const dst = real(typeof to === "string" ? to : to.fsName);
        if (ro(path.dirname(dst)) || !fs.existsSync(path.dirname(dst))) { this.error = "Permission denied"; return false; }
        fs.copyFileSync(this.fsName, dst); return true;   // 和 ExtendScript 一样：目标已存在就覆盖
    };
    FileC.prototype.remove = function () { if (ro(path.dirname(this.fsName))) { this.error = "Permission denied"; return false; } fs.unlinkSync(this.fsName); return true; };
    FileC.prototype.toString = function () { return this.fsName; };
    function FolderC(p) { if (!(this instanceof FolderC)) return new FolderC(p); this.fsName = real(String(p)).replace(/\/$/, ""); this.name = encodeURI(path.basename(this.fsName)); }
    Object.defineProperty(FolderC.prototype, "exists", { get() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isDirectory(); } });
    Object.defineProperty(FolderC.prototype, "parent", { get() { const d = path.dirname(this.fsName); return d === this.fsName ? null : new FolderC(d); } });
    FolderC.prototype.create = function () { if (ro(this.fsName) || ro(path.dirname(this.fsName))) return false; fs.mkdirSync(this.fsName, { recursive: true }); return true; };
    FolderC.prototype.execute = function () { return true; };
    FolderC.prototype.getFiles = function () {
        if (!this.exists) return null;
        return fs.readdirSync(this.fsName).map(n => { const p = path.join(this.fsName, n); return fs.statSync(p).isDirectory() ? new FolderC(p) : new FileC(p); });
    };
    FileC.decode = s => decodeURI(s);
    FolderC.myDocuments = new FolderC(path.join(root, "Documents"));
    FolderC.userData = new FolderC(path.join(root, opts.win ? "AppData/Roaming" : "home/Library/Application Support"));
    FolderC.temp = new FolderC(path.join(root, "tmp"));
    function CompItem() {}
    function Panel() {}
    const g = {
        File: FileC, Folder: FolderC, CompItem, Panel,
        FolderItem: function () {}, FootageItem: function () {}, AVLayer: function () {}, ShapeLayer: function () {}, TextLayer: function () {}, CameraLayer: function () {}, LightLayer: function () {},
        Window: function (kind) { this.kind = kind; this.show = function () {}; },
        alert: function () {},
        $: { os: opts.win ? "Windows/64 10.0" : "Macintosh OS 14.5", fileName: path.join(root, "ext/jsx/host.jsx"), global: null },
        app: {
            version: opts.version || "24.3.0x45",
            settings: { haveSetting: () => false, getSetting: () => "", saveSetting: () => {} },
            preferences: { getPrefAsLong: () => (opts.canWrite === false ? 0 : 1) },
            beginUndoGroup: (n) => undo.push("begin:" + n), endUndoGroup: () => undo.push("end"),
            findMenuCommandId: (n) => ((opts.menus || []).indexOf(n) !== -1 ? 4000 + (opts.menus || []).indexOf(n) : 0),
            project: { activeItem: null, selection: [] }
        },
        PropertyType: { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 }
    };
    g.$.global = opts.global || g;
    if (opts.global) Object.assign(opts.global, { MH_SESSION: opts.global.MH_SESSION });
    g.$.evalFile = function (f) {
        const code = fs.readFileSync(String(f), "utf8");
        return new Function(...Object.keys(g), code).apply(g.$.global, Object.values(g));
    };
    if (opts.comp) {
        const comp = Object.assign(Object.create(CompItem.prototype), { name: "主合成", selectedProperties: [] });
        comp.selectedLayers = [];
        for (let i = 0; i < opts.comp; i++) comp.selectedLayers.push({ index: i + 1, applyPreset: (f) => { presetCalls.push(i); if (opts.presetThrows) throw new Error(opts.presetThrows); } });
        g.app.project.activeItem = comp;
    }
    const src = fs.readFileSync(HOST, "utf8").replace(/^﻿/, "");
    const MH = new Function(...Object.keys(g), src + "\nreturn MH;")(...Object.values(g));
    g.$.global.MH = MH;          // 真 AE 里顶层 var MH 就是 $.global.MH
    const lib = path.join(root, "Documents/MotionHub/Library");
    const raw = (n, a) => MH.call(n, a || {});
    return { MH, g, root, home, lib, undo, presetCalls, raw, call: (n, a) => JSON.parse(raw(n, a)) };
}
function put(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }
const PANEL_HEAD = 'var w = (this instanceof Panel) ? this : new Window("palette", "T");\nw.show && w.show();\n';

// ---------- A1：面板识别 ----------
{
    const h = loadHost({});
    put(path.join(h.lib, "工具/top.jsx"), "// @name 顶部面板\n" + PANEL_HEAD);
    put(path.join(h.lib, "工具/late.jsx"), "// @name 后面才判断\n" + "var pad = 1;\n".repeat(600) + PANEL_HEAD);
    put(path.join(h.lib, "工具/huge.jsx"), "// @name 超大\n" + "x = 1;\n".repeat(60000) + PANEL_HEAD);
    put(path.join(h.lib, "工具/dockonly.jsx"), "// @name 只能停靠\nif (!(this instanceof Panel)) {} else { this.add('button'); }\n");
    put(path.join(h.lib, "工具/plain.jsx"), "// @name 普通\napp.project;\n");
    put(path.join(h.lib, "工具/enc.jsxbin"), "@JSXBIN@ES@2.0@MyBbyBn0AEJAnA");
    put(path.join(h.lib, "动画/look.ffx"), "RIFX");
    const s = h.call("scan");
    const by = {}; (s.data.items || []).forEach(i => { by[i.file] = i; });
    check("A1 识别：文件开头的 instanceof Panel → panel=true、palette=true", by["top.jsx"].panel === true && by["top.jsx"].palette === true && by["top.jsx"].type === "面板", JSON.stringify(by["top.jsx"]));
    check("A1 识别：4.5KB 之后才出现（旧代码只读 4000 字会漏判）→ panel=true", by["late.jsx"].panel === true, JSON.stringify(by["late.jsx"]));
    check("A1 识别：360KB 的文件，判断写在末尾 → 读头尾也能认出", by["huge.jsx"].panel === true, JSON.stringify({ panel: by["huge.jsx"].panel, size: fs.statSync(path.join(h.lib, "工具/huge.jsx")).size }));
    check("A1 识别：只判断 Panel、没有 palette 分支 → panel=true、palette=false（运行后可能什么都不显示）", by["dockonly.jsx"].panel === true && by["dockonly.jsx"].palette === false);
    check("A1 识别：普通脚本 panel=false；jsxbin panel=null（看不出）；ffx panel=false", by["plain.jsx"].panel === false && by["enc.jsxbin"].panel === null && by["look.ffx"].panel === false, JSON.stringify([by["plain.jsx"].panel, by["enc.jsxbin"].panel, by["look.ffx"].panel]));
    // 缓存：第二次扫描不重新读文件
    let reads = 0; const orig = h.g.File.prototype.read; h.g.File.prototype.read = function (n) { reads++; return orig.call(this, n); };
    h.call("scan");
    h.g.File.prototype.read = orig;
    check("A1 识别：第二次扫描命中缓存（只读 @name 用的开头，不再读全文）", reads <= 5, "read 调用 " + reads + " 次");
}

// ---------- A4：脚本自己的报错 ----------
{
    const h = loadHost({});
    const f = (n, code) => put(path.join(h.lib, "测试/" + n), code);
    const ok = f("ok.jsx", "app.project.x = 1;");
    let r = h.call("run", { path: ok });
    check("A4 正常运行：ok=true、文案「已运行「ok」」、开了撤销组「运行「ok」」并关闭", r.ok && r.msg === "已运行「ok」" && h.undo.join(",") === "begin:运行「ok」,end", JSON.stringify(r) + " " + h.undo.join(","));
    h.undo.length = 0;
    const pnl = f("pnl.jsx", PANEL_HEAD);
    r = h.call("run", { path: pnl });
    check("A1 面板脚本：提示「已打开…的浮动窗口」+ 停靠说明；不开撤销组（避免空记录）", r.ok && /浮动窗口/.test(r.msg) && /安装为可停靠面板/.test(r.data.note) && h.undo.length === 0, JSON.stringify(r) + " " + h.undo.join(","));

    const e1 = f("e1.jsx", 'var e = new Error("自定义错误"); e.line = 12; e.fileName = "' + path.join(h.lib, "测试/e1.jsx") + '"; throw e;');
    h.undo.length = 0;
    r = h.call("run", { path: e1 });
    check("A4 Error：origin=script，msg 带原文和行号，detail 有 text/line/file", !r.ok && r.origin === "script" && /「自定义错误」（第 12 行）/.test(r.msg) && r.data.detail.text === "自定义错误" && r.data.detail.line === 12 && r.data.detail.file === "e1.jsx" && !r.data.detail.other, JSON.stringify(r));
    check("A4 出错时撤销组照样关闭（脚本改到一半的东西一步撤销）", h.undo.join(",") === "begin:运行「e1」,end", h.undo.join(","));
    const e2 = f("e2.jsx", 'var e = new Error("库里出错"); e.line = 3; e.fileName = "/x/lib/helpers.jsx"; throw e;');
    r = h.call("run", { path: e2 });
    check("A4 错在 #include 的文件：写明「在「helpers.jsx」里」", !r.ok && /在「helpers.jsx」里/.test(r.msg) && r.data.detail.other === true, r.msg);
    const cases = [["throw \"Something bad\";", /「Something bad」/], ["throw null;", /抛出了 null/], ["throw undefined;", /抛出了 undefined/], ["throw { message: \"对象\" };", /「对象」/], ["throw 42;", /「42」/], ["foo();", /foo is not defined/]];
    cases.forEach(([code, re], i) => {
        const p = f("t" + i + ".jsx", code);
        const out = h.raw("run", { path: p });
        let j = null; try { j = JSON.parse(out); } catch (e) {}
        check("A4 " + code + " → call() 返回可解析的 JSON（不再变成 EvalScript error），文案带原文", j && j.ok === false && j.origin === "script" && re.test(j.msg), out.slice(0, 160));
    });
    const nl = f("nl.jsx", 'throw new Error("第一行\\n第二行\\u2028第三行" + new Array(3000).join("x"));');
    const out = h.raw("run", { path: nl });
    check("A4 原文里有换行、U+2028、超长：返回值里没有裸控制字符，detail.text 截到 2000 字", !/[\u0000-\u001f\u2028\u2029]/.test(out) && JSON.parse(out).data.detail.text.length <= 2001, out.length + " chars");
    const sn = h.call("runCode", { code: "var e = new Error('片段坏了'); e.line = 2; throw e;", name: "测片段" });
    check("A4 脚本片段（runCode）同样带原文，标为 origin=script", !sn.ok && sn.origin === "script" && /运行片段「测片段」出错：脚本报错「片段坏了」（第 2 行）/.test(sn.msg), JSON.stringify(sn));
    const clob = f("clob.jsx", "$.global.MH = { call: function () { return 'hijacked'; } };");
    r = h.call("run", { path: clob });
    check("A4 脚本把全局 MH 换掉：运行后立刻恢复，并在提示里说明", r.ok && /全局变量 MH/.test(r.data.note) && h.g.MH === h.MH && JSON.parse(h.g.MH.call("libState", {})).ok, JSON.stringify(r));
    const gone = h.call("run", { path: path.join(h.lib, "测试/不存在.jsx") });
    check("A4 文件不存在：动词开头、说怎么修", !gone.ok && /^找不到「不存在」：.*点脚本库的「刷新」/.test(gone.msg) && !gone.origin, gone.msg);
}

// ---------- .ffx：一次 applyPreset 就作用于全部选中图层 ----------
{
    const h = loadHost({ comp: 3 });
    const p = put(path.join(h.lib, "动画/look.ffx"), "RIFX");
    const r = h.call("run", { path: p });
    check("ffx：选中 3 个图层只调用 1 次 applyPreset（旧代码会调用 3 次 = 每层被应用 3 遍）", r.ok && h.presetCalls.length === 1 && /3 个选中图层/.test(r.msg), JSON.stringify({ calls: h.presetCalls, r }));
    const h2 = loadHost({ comp: 2, presetThrows: "Reading past end of file" });
    const p2 = put(path.join(h2.lib, "动画/bad.ffx"), "x");
    const r2 = h2.call("run", { path: p2 });
    check("ffx 出错：文案「没能应用预设…AE 报错「原文」…」，撤销组关闭", !r2.ok && /^没能应用预设「bad」：AE 报错「Reading past end of file」/.test(r2.msg) && h2.undo.join(",") === "begin:MotionHub：应用预设,end", r2.msg + " " + h2.undo.join(","));
}

// ---------- A3：最近使用 + 收藏 ----------
{
    const h = loadHost({});
    const ps = [];
    for (let i = 0; i < 25; i++) ps.push(put(path.join(h.lib, "批量/s" + i + ".jsx"), "1;"));
    h.call("run", { path: ps[0] }); h.call("run", { path: ps[1] }); h.call("run", { path: ps[0] });
    let st = h.call("libState").data;
    check("A3 最近：按时间倒序、同一个脚本去重并累计次数", st.recent[0].k === "/批量/s0.jsx" && st.recent[0].n === 2 && st.recent[1].k === "/批量/s1.jsx" && st.recent.length === 2, JSON.stringify(st.recent));
    ps.forEach(p => h.call("run", { path: p }));
    st = h.call("libState").data;
    check("A3 最近：最多 20 条", st.recent.length === 20 && st.recent[0].k === "/批量/s24.jsx", st.recent.length);
    check("A3 最近：存在用户数据目录（不在脚本库里，不跟网盘同步）", fs.existsSync(path.join(h.root, "home/Library/Application Support/MotionHub/recent.json")));
    let a = h.call("favSet", { key: "/批量/s3.jsx", name: "s3", on: true });
    let b = h.call("favSet", { key: "/批量/s4.jsx", name: "s4", on: true });
    let c = h.call("favSet", { key: "/批量/s3.jsx", name: "s3", on: true });
    check("A3 收藏：两次设置不丢（单次调用内读-改-写）；重复收藏是幂等的", a.ok && b.ok && c.ok && c.data.fav.join() === "/批量/s4.jsx,/批量/s3.jsx" && /已经在收藏里/.test(c.msg), JSON.stringify(c));
    check("A3 收藏：存在脚本库根目录 _favorites.json，scan 不会把它当脚本", fs.existsSync(path.join(h.lib, "_favorites.json")) && h.call("scan").data.items.every(i => !/_favorites/.test(i.file)));
    const d = h.call("favSet", { key: "/批量/s3.jsx", name: "s3", on: false });
    check("A3 取消收藏", d.ok && d.data.fav.join() === "/批量/s4.jsx" && d.msg === "已取消收藏「s3」", JSON.stringify(d));
    // 文件被挪到别的分类：唯一同名 → 跟过去
    fs.mkdirSync(path.join(h.lib, "工具"), { recursive: true });
    fs.renameSync(path.join(h.lib, "批量/s4.jsx"), path.join(h.lib, "工具/s4.jsx"));
    let s = h.call("scan");
    check("A3 收藏跟随：s4.jsx 挪到「工具」后，scan 报告 moved 并改写收藏", s.data.moved.length === 1 && s.data.moved[0].to === "/工具/s4.jsx" && s.data.state.fav.join() === "/工具/s4.jsx", JSON.stringify(s.data.moved) + JSON.stringify(s.data.state.fav));
    // 同名不止一个：不跟
    h.call("favSet", { key: "/批量/s5.jsx", name: "s5", on: true });
    fs.mkdirSync(path.join(h.lib, "备份"), { recursive: true });
    fs.copyFileSync(path.join(h.lib, "批量/s5.jsx"), path.join(h.lib, "备份/s5.jsx"));
    fs.renameSync(path.join(h.lib, "批量/s5.jsx"), path.join(h.lib, "工具/s5.jsx"));
    s = h.call("scan");
    check("A3 收藏跟随：同名文件有两个 → 不猜，收藏保留原 key（界面显示「缺失」）", s.data.moved.length === 0 && s.data.state.fav.indexOf("/批量/s5.jsx") !== -1, JSON.stringify(s.data.state.fav));
    // 收藏文件损坏：备份原文件、不覆盖
    fs.writeFileSync(path.join(h.lib, "_favorites.json"), "{ 坏了");
    const e = h.call("favSet", { key: "/批量/s6.jsx", name: "s6", on: true });
    const bad = fs.readdirSync(h.lib).filter(n => /^_favorites\.bad-\d+\.json$/.test(n));
    check("A3 收藏文件损坏：先另存 .bad-时间.json 再写新文件，原内容还在", e.ok && bad.length === 1 && fs.readFileSync(path.join(h.lib, bad[0]), "utf8") === "{ 坏了", JSON.stringify({ e, bad }));
    const h2 = loadHost({ canWrite: false });
    const f2 = h2.call("favSet", { key: "/a.jsx", name: "a", on: true });
    check("A3 没开写入权限：收藏失败并说明怎么开", !f2.ok && /首选项 → 脚本和表达式/.test(f2.msg), f2.msg);
    // JSON 解析：q() 写出的任意字符都能读回
    let all = ""; for (let i = 1; i < 32; i++) all += String.fromCharCode(i);
    all += "\u2028\u2029\"\\/末尾 😀";
    h.call("favSet", { key: all, name: "怪名字", on: true });
    const back = h.call("libState").data.fav;
    check("A3 ES3 JSON 解析：控制字符、U+2028、引号、反斜杠、emoji 都能原样读回", back[0] === all, JSON.stringify(back[0]));
}

// ---------- A2：安装为可停靠面板 ----------
{
    const h = loadHost({});
    const src = put(path.join(h.lib, "工具/工具箱.jsx"), PANEL_HEAD);
    const prefs = path.join(h.home, "Library/Preferences/Adobe/After Effects");
    let r = h.call("dockInstall", { path: src, key: "/工具/工具箱.jsx" });
    check("A2 没有 AE 24.3 首选项文件夹：报错并给出 AE 菜单的替代办法，不替 AE 建文件夹", !r.ok && /安装 ScriptUI 面板/.test(r.msg) && !fs.existsSync(path.join(prefs, "24.3")), r.msg);
    fs.mkdirSync(path.join(prefs, "24.3"), { recursive: true });
    r = h.call("dockInstall", { path: src, key: "/工具/工具箱.jsx" });
    const dest = path.join(prefs, "24.3/Scripts/ScriptUI Panels/工具箱.jsx");
    check("A2 安装：建好 Scripts/ScriptUI Panels、复制文件、提示重启和「窗口」菜单", r.ok && r.data.installed && fs.existsSync(dest) && /重启 AE 后，在「窗口」菜单底部打开「工具箱.jsx」/.test(r.msg), JSON.stringify(r));
    const man = JSON.parse(fs.readFileSync(path.join(h.root, "home/Library/Application Support/MotionHub/panels_installed.json"), "utf8"));
    check("A2 安装清单：记下文件、来源 key、AE 版本", man.items.length === 1 && man.items[0].key === "/工具/工具箱.jsx" && man.items[0].ae === "24.3");
    r = h.call("dockInstall", { path: src, key: "/工具/工具箱.jsx" });
    check("A2 再装一次（内容相同）：already，不重复复制", r.ok && r.data.already, JSON.stringify(r));
    // 别人的同名文件
    const other = put(path.join(h.lib, "动画/计时器.jsx"), PANEL_HEAD + "// 我的版本\n");
    const theirs = path.join(prefs, "24.3/Scripts/ScriptUI Panels/计时器.jsx");
    put(theirs, "// 用户自己装的另一个版本\n");
    r = h.call("dockInstall", { path: other, key: "/动画/计时器.jsx" });
    check("A2 冲突：已有不是 MotionHub 装的同名文件 → 返回 conflict，不写任何东西", r.ok && r.data.conflict && fs.readFileSync(theirs, "utf8") === "// 用户自己装的另一个版本\n", JSON.stringify(r));
    r = h.call("dockInstall", { path: other, key: "/动画/计时器.jsx", replace: true });
    const bdir = path.join(h.root, "home/Library/Application Support/MotionHub/panel_backups/24.3");
    const backups = fs.readdirSync(bdir);
    check("A2 确认替换：原文件先备份再替换", r.ok && r.data.installed && backups.some(n => /_orig_计时器\.jsx$/.test(n)) && /我的版本/.test(fs.readFileSync(theirs, "utf8")), JSON.stringify(backups));
    r = h.call("dockRemove", { file: "计时器.jsx" });
    check("A2 卸载（撤销安装）：放回用户原来的同名文件，自己的那份留在备份里", r.ok && r.data.restored && fs.readFileSync(theirs, "utf8") === "// 用户自己装的另一个版本\n" && fs.readdirSync(bdir).some(n => /_removed_计时器\.jsx$/.test(n)), JSON.stringify(r));
    r = h.call("dockRemove", { file: "别人的.jsx" });
    check("A2 卸载不是 MotionHub 装的文件：拒绝，并说明去哪手动删", !r.ok && /不是 MotionHub 安装的/.test(r.msg), r.msg);
    const notjsx = put(path.join(h.lib, "动画/x.ffx"), "RIFX");
    r = h.call("dockInstall", { path: notjsx });
    check("A2 .ffx 不能装：说明只有 .jsx / .jsxbin 可以", !r.ok && /只有 \.jsx \/ \.jsxbin/.test(r.msg), r.msg);
    // 状态：同一次 AE 会话里 → 还没重启
    let s = h.call("dockStatus").data;
    check("A2 状态：刚装完（同一次 AE 会话）→ restarted=false，menu 不查", s.items.length === 1 && s.items[0].present && s.items[0].restarted === false && s.items[0].menu === 0, JSON.stringify(s));
    // 模拟重启 AE：新会话 + 菜单里有它
    const h2 = loadHost({ root: h.root, menus: ["工具箱.jsx"] });
    s = h2.call("dockStatus").data;
    check("A2 状态：重启后 → restarted=true，在「窗口」菜单里找得到（findMenuCommandId≠0）", s.items[0].restarted === true && s.items[0].menu > 0, JSON.stringify(s));
    // 升级到 24.4：之前装的提示要重装
    fs.mkdirSync(path.join(prefs, "24.4"), { recursive: true });
    const h3 = loadHost({ root: h.root, version: "24.4.0x12" });
    s = h3.call("dockStatus").data;
    check("A2 AE 升级到 24.4：dockStatus 报告 stale（需要重新安装）", s.ae === "24.4" && s.items.length === 0 && s.stale.length === 1 && s.stale[0].file === "工具箱.jsx", JSON.stringify(s));
    const re = h3.call("dockInstall", { path: src, key: "/工具/工具箱.jsx" });
    s = h3.call("dockStatus").data;
    check("A2 在 24.4 重新安装后不再报告 stale", re.ok && s.stale.length === 0 && s.items.length === 1, JSON.stringify(s));
    // ScriptUI Panels 写不进去
    const roDir = path.join(prefs, "24.4/Scripts/ScriptUI Panels");
    const h4 = loadHost({ root: h.root, version: "24.4.0x12", roDirs: [roDir] });
    const src2 = put(path.join(h.lib, "工具/新面板.jsx"), PANEL_HEAD);
    r = h4.call("dockInstall", { path: src2, key: "/工具/新面板.jsx" });
    check("A2 ScriptUI Panels 不可写：说明原因和替代办法", !r.ok && /Permission denied/.test(r.msg) && /安装 ScriptUI 面板/.test(r.msg), r.msg);
}
// Windows 路径：25.0x18 → %APPDATA%/Adobe/After Effects/25.0
{
    const h = loadHost({ win: true, version: "25.0x18" });
    const prefs = path.join(h.root, "AppData/Roaming/Adobe/After Effects/25.0");
    fs.mkdirSync(prefs, { recursive: true });
    const src = put(path.join(h.lib, "工具/w.jsx"), PANEL_HEAD);
    const r = h.call("dockInstall", { path: src, key: "/工具/w.jsx" });
    check("A2 Windows：25.0x18 装到 %APPDATA%\\Adobe\\After Effects\\25.0\\Scripts\\ScriptUI Panels", r.ok && fs.existsSync(path.join(prefs, "Scripts/ScriptUI Panels/w.jsx")), JSON.stringify(r));
}
// 测试 harness 自检：原版 host.jsx 的 throw null 确实会让 call() 自己崩（对照组）
{
    const orig = fs.readFileSync("/home/user/-/MotionHub/com.windwings.motionhub/jsx/host.jsx", "utf8");
    let threw = false;
    try {
        const g = { $: { os: "Mac", fileName: "/x/jsx/host.jsx", global: {}, evalFile: () => { throw null; } }, app: { version: "24.3", settings: { haveSetting: () => false }, preferences: { getPrefAsLong: () => 1 } }, File: function (p) { this.fsName = p; this.name = "x.jsx"; this.exists = true; this.parent = { parent: {} }; }, Folder: function (p) { this.fsName = p; } };
        g.Folder.myDocuments = { fsName: "/d" };
        const MH0 = new Function(...Object.keys(g), orig.replace(/^﻿/, "") + "\nreturn MH;")(...Object.values(g));
        MH0.call("run", { path: "/x.jsx" });
    } catch (e) { threw = true; }
    check("对照：原版 host.jsx 遇到 throw null 时 call() 自己抛异常（AE 里表现为 EvalScript error.）", threw);
}

console.log((failures ? "✗ " : "✓ ") + "A 原型：" + passes + " 项通过，" + failures + " 项没通过");
process.exit(failures ? 1 : 0);
