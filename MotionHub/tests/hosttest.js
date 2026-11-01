// host.jsx 单元测试：在 Node 里模拟 ExtendScript 的 File / Folder / app，直接调用 MH.call
// 覆盖阶段 1 的后台改动：q() 转义、文件夹建不了时的行为、importSamples 计数、只读操作不开撤销组
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOST = path.join(__dirname, "../com.windwings.motionhub/jsx/host.jsx");
let failures = 0;
function check(name, cond, detail) {
    console.log((cond ? "✓ " : "✗ ") + name + (cond ? "" : "：" + (detail || "")));
    if (!cond) failures++;
}

// 每个场景一个干净的环境：root 是假的磁盘根目录；readonly 为 true 时所有 create / copy / 写入都失败
// 其他开关（测试中途改 opts 上的值也会生效）：
//   lockRemove：文件名匹配的删不掉（文件被占用）
//   failCopy：复制目标的路径匹配时只写一半就失败（磁盘满了、网络盘断开），返回 false
//   failClose：写完关闭时出错（缓存没能写进磁盘），文件只剩一半，close() 返回 false
//   bomAware：open("r") 读到 UTF-8 BOM 时自己把编码改成 UTF-8 并跳过 BOM（ExtendScript 文档里写的行为）
//   caseless：不分大小写、但保留大小写的磁盘（Windows / macOS 默认）
//   userData：Folder.userData 放在 root 下的哪里（默认 AppData）；os：$.os（默认 Mac）
function loadHost(opts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-host-"));
    const ro = !!opts.readonly;
    const undo = [], presets = [];
    // 「~」开头的路径落到假的 home 里，不会在当前目录建出一个叫 ~ 的文件夹
    // uriPaths：和 ExtendScript 一样，把路径里的 %XX 当成 URI 转义（"Fade%20In.jsx" 指的是 "Fade In.jsx"）
    const home = p => {
        if (typeof p === "string" && p.charAt(0) === "~") p = path.join(root, "home", p.slice(1));
        if (opts.uriPaths && typeof p === "string") { try { p = decodeURI(p); } catch (e) {} }
        return p;
    };
    // BINARY 编码按字节读写（每个字符 0–255），和 ExtendScript 一样
    const enc = f => (f.encoding === "BINARY" ? "latin1" : "utf8");
    // caseless：按路径找文件时每一段都不分大小写（先找完全同名的）。File 对象的 fsName 保持构造时的写法
    // （假定 ExtendScript 不会把它改成磁盘上的写法），getFiles 返回磁盘上的真实写法
    const real = p => {
        if (!opts.caseless || p.indexOf(root + path.sep) !== 0) return p;
        let cur = root;
        for (const part of p.slice(root.length + 1).split(path.sep)) {
            if (!part) continue;
            let names = [];
            try { names = fs.readdirSync(cur); } catch (e) {}
            cur = path.join(cur, names.indexOf(part) !== -1 ? part : (names.find(n => n.toLowerCase() === part.toLowerCase()) || part));
        }
        return cur;
    };
    const half = (from, to) => { const b = fs.readFileSync(from); fs.writeFileSync(to, b.subarray(0, b.length >> 1)); };
    function FileC(p) { if (!(this instanceof FileC)) return new FileC(p); p = home(p); this.fsName = p; this.name = encodeURI(path.basename(p)); this.encoding = "UTF-8"; this.error = ""; }
    Object.defineProperty(FileC.prototype, "exists", { get() { const p = real(this.fsName); return fs.existsSync(p) && fs.statSync(p).isFile(); } });
    Object.defineProperty(FileC.prototype, "parent", { get() { return new FolderC(path.dirname(this.fsName)); } });
    Object.defineProperty(FileC.prototype, "length", { get() { return this.exists ? fs.statSync(real(this.fsName)).size : -1; } });
    FileC.prototype.open = function (mode) {
        if (mode !== "r" && ro) return false;
        this._mode = mode; this._pos = 0;
        if (mode === "w") fs.writeFileSync(real(this.fsName), "");
        if (mode !== "r") return true;
        if (!this.exists) return false;
        if (opts.bomAware) {
            const b = fs.readFileSync(real(this.fsName));
            if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { this.encoding = "UTF-8"; this._pos = 3; }
        }
        return true;
    };
    FileC.prototype.seek = function (pos, mode) { if (mode) return false; this._pos = pos; return true; };
    FileC.prototype.read = function () { return fs.readFileSync(real(this.fsName)).subarray(this._pos || 0).toString(enc(this)); };
    FileC.prototype.write = function (t) { fs.appendFileSync(real(this.fsName), Buffer.from(String(t), enc(this))); return true; };
    FileC.prototype.close = function () {
        const mode = this._mode;
        this._mode = null;
        if (mode === "w" && opts.failClose && opts.failClose.test(this.fsName)) { half(real(this.fsName), real(this.fsName)); this.error = "I/O error"; return false; }
        return true;
    };
    FileC.prototype.copy = function (to) {
        if (ro) return false;
        const dst = real(typeof to === "string" ? home(to) : to.fsName);
        if (opts.failCopy && opts.failCopy.test(dst)) { half(real(this.fsName), dst); this.error = "I/O error"; return false; }
        fs.copyFileSync(real(this.fsName), dst);
        return true;
    };
    FileC.prototype.remove = function () {
        if (opts.lockRemove && opts.lockRemove.test(path.basename(this.fsName)) && this.fsName.indexOf("_已移除") === -1) { this.error = "File is locked"; return false; }
        fs.unlinkSync(real(this.fsName)); return true;
    };
    function FolderC(p) { if (!(this instanceof FolderC)) return new FolderC(p); p = home(p); this.fsName = p; this.name = encodeURI(path.basename(p)); }
    Object.defineProperty(FolderC.prototype, "exists", { get() { const p = real(this.fsName); return fs.existsSync(p) && fs.statSync(p).isDirectory(); } });
    Object.defineProperty(FolderC.prototype, "parent", { get() { const d = path.dirname(this.fsName); return d === this.fsName ? null : new FolderC(d); } });
    FolderC.prototype.create = function () { if (ro) return false; fs.mkdirSync(real(this.fsName), { recursive: true }); return true; };
    FolderC.prototype.getFiles = function (mask) {
        if (!this.exists) return null;   // 真实的 ExtendScript 在文件夹不存在时返回 null
        const re = mask && mask !== "*" ? new RegExp("^" + mask.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null;
        const dir = real(this.fsName);
        return fs.readdirSync(dir).filter(n => !re || re.test(n)).map(n => {
            const p = path.join(this.fsName, n);
            return fs.statSync(path.join(dir, n)).isDirectory() ? new FolderC(p) : new FileC(p);
        });
    };
    FileC.decode = s => decodeURI(s);
    FolderC.myDocuments = new FolderC(path.join(root, "Documents"));
    FolderC.userData = new FolderC(path.join(root, opts.userData || "AppData"));
    FolderC.temp = new FolderC(path.join(root, "tmp"));

    const g = {
        File: FileC, Folder: FolderC,
        CompItem: function () {}, FolderItem: function () {}, FootageItem: function () {}, AVLayer: function () {}, ShapeLayer: function () {}, TextLayer: function () {}, CameraLayer: function () {}, LightLayer: function () {},
        $: { os: opts.os || "Macintosh OS 14", fileName: path.join(root, "ext/jsx/host.jsx"), global: {} },
        app: {
            version: "24.3.0",
            settings: { haveSetting: () => false, getSetting: () => "", saveSetting: () => {} },
            preferences: { getPrefAsLong: () => (opts.canWrite === false ? 0 : 1) },
            beginUndoGroup: (n) => undo.push("begin:" + n), endUndoGroup: () => undo.push("end"),
            project: { activeItem: null, selection: [] }
        },
        PropertyType: { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 }
    };
    // 假合成：图层 / 属性 / 关键帧按 opts.comp 生成
    if (opts.comp) {
        const C = g.CompItem;
        const mk = (o) => Object.assign(Object.create(C.prototype), o);
        const comp = mk({ name: "主合成", selectedLayers: [], selectedProperties: [] });
        for (let i = 0; i < opts.comp.layers; i++) comp.selectedLayers.push({ index: i + 1, source: i < (opts.comp.precomps || 0) ? mk({ name: "pre" + i }) : { name: "footage" }, applyPreset: (f) => presets.push({ layer: i + 1, file: f.fsName }) });
        (opts.comp.props || []).forEach(p => comp.selectedProperties.push({ propertyType: p.group ? 6214 : 6212, canSetExpression: !p.group, selectedKeys: p.group ? undefined : new Array(p.keys || 0).fill(1) }));
        g.app.project.activeItem = comp;
        g.app.project.selection = [comp, mk({ name: "另一个" }), { name: "素材" }];
    }
    g.$.global = g;
    // 示例脚本：ext/library_seed/动画/a.jsx、工具/b.jsx
    const seed = path.join(root, "ext/library_seed");
    fs.mkdirSync(path.join(seed, "动画"), { recursive: true });
    fs.mkdirSync(path.join(seed, "工具"), { recursive: true });
    fs.writeFileSync(path.join(seed, "动画/a.jsx"), "// @name A\nalert(1);");
    fs.writeFileSync(path.join(seed, "工具/b.jsx"), "// @name B\nalert(2);");
    if (opts.preseed) for (const f of opts.preseed) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), "x"); }

    const src = fs.readFileSync(HOST, "utf8").replace(/^﻿/, "");
    const fn = new Function(...Object.keys(g), src + "\nreturn MH;");
    const MH = fn(...Object.values(g));
    return { MH, root, undo, presets, call: (name, args) => JSON.parse(MH.call(name, args || {})) };
}

// 1. q()：任意控制字符和 U+2028 / U+2029 都要能被 JSON.parse 读回原样
{
    const h = loadHost({});
    let all = "";
    for (let c = 0; c < 32; c++) all += String.fromCharCode(c);
    all += "\u2028\u2029\"\\/末尾";
    const raw = h.MH.call("saveConfig", { name: "esc", text: all });
    const back = h.call("loadConfig", { name: "esc" });
    check("q()：0x00–0x1F、U+2028/2029、引号、反斜杠都能被 JSON.parse 原样读回", back.ok && back.data.text === all, JSON.stringify(back).slice(0, 120));
    const out = h.MH.call("loadConfig", { name: "esc" });
    check("q()：返回的 JSON 里没有裸露的控制字符或 U+2028/2029", !/[\u0000-\u001f\u2028\u2029]/.test(out), JSON.stringify(out.match(/[\u0000-\u001f\u2028\u2029]/)));
    check("saveConfig 正常返回", JSON.parse(raw).ok);
}

// 2. 新装 + 没开写入权限：init 仍然成功并报告 canWrite=false（这样面板才能显示权限横幅）
{
    const h = loadHost({ readonly: true, canWrite: false });
    const r = h.call("init", {});
    check("只读磁盘：init 成功", r.ok, r.msg);
    check("只读磁盘：init 报告 canWrite=false、libReady=false", r.ok && r.data.canWrite === false && r.data.libReady === false, JSON.stringify(r.data));
    const c = h.call("loadConfig", { name: "panel1" });
    check("只读磁盘：读不存在的布局返回 text=null，而不是报错", c.ok && c.data.text === null, JSON.stringify(c));
    const sn = h.call("loadSnippets", {});
    check("只读磁盘：读不存在的片段返回 text=null，而不是报错", sn.ok && sn.data.text === null, JSON.stringify(sn));
    const sc = h.call("scan", {});
    check("只读磁盘：scan 失败时给出可读的提示（提到首选项）", !sc.ok && /首选项/.test(sc.msg) && !/出错了/.test(sc.msg), sc.msg);
    const im = h.call("importSamples", {});
    check("只读磁盘：importSamples 失败时给出可读的提示", !im.ok && /首选项|没法创建/.test(im.msg), im.msg);
    const sv = h.call("saveConfig", { name: "panel1", text: "{}" });
    check("只读磁盘：saveConfig 失败时说明原因", !sv.ok && /配置文件夹|无法写入/.test(sv.msg), sv.msg);
}

// 3. importSamples：返回实际复制的文件数；第二次全部已存在
{
    const h = loadHost({});
    const a = h.call("importSamples", {});
    check("importSamples 第一次：copied=2", a.ok && a.data.copied === 2 && a.data.existing === 0, JSON.stringify(a));
    const b = h.call("importSamples", {});
    check("importSamples 第二次：copied=0、existing=2", b.ok && b.data.copied === 0 && b.data.existing === 2, JSON.stringify(b));
    const s = h.call("scan", {});
    check("scan 读到 2 个示例脚本", s.ok && s.data.items.length === 2, JSON.stringify(s.data && s.data.items.map(i => i.name)));
}

// 4. 只读操作不开撤销组，改动工程的操作开撤销组
{
    const h = loadHost({});
    h.call("bezierRead", {}); h.call("copyKeys", {}); h.call("styleCopy", {});
    check("bezierRead / copyKeys / styleCopy 不开撤销组", h.undo.length === 0, h.undo.join(","));
    h.call("trim", {});
    check("trim（会改工程）开了撤销组并且关闭", h.undo[0] === "begin:MotionHub：剪切图层" && h.undo[1] === "end", h.undo.join(","));
}

// 5. 脚本库文件夹被删掉之后再 scan：getFiles 返回 null 不应该崩
{
    const h = loadHost({});
    h.call("init", {});
    fs.rmSync(path.join(h.root, "Documents"), { recursive: true, force: true });
    const s = h.call("scan", {});
    check("脚本库文件夹被删后 scan 会重新建好并返回空列表", s.ok && s.data.items.length === 0, JSON.stringify(s));
}

// 6. LIB.ctx：选区快照准确、只读、不开撤销组
{
    const h0 = loadHost({});
    const e = h0.call("ctx", {});
    check("ctx：没有合成时全为 0", e.ok && e.data.comp === "" && e.data.layers === 0 && e.data.keys === 0 && e.data.projComps === 0, JSON.stringify(e.data));
    const h = loadHost({ comp: { layers: 3, precomps: 1, props: [{ keys: 2 }, { keys: 3 }, { group: true }] } });
    const r = h.call("ctx", {});
    check("ctx：图层 3、预合成 1、关键帧 5、可加表达式属性 2、项目里选中合成 2", r.ok && r.data.comp === "主合成" && r.data.layers === 3 && r.data.precomps === 1 && r.data.keys === 5 && r.data.exprProps === 2 && r.data.projComps === 2, JSON.stringify(r.data));
    check("ctx：不开撤销组", h.undo.length === 0, h.undo.join(","));
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) h.MH.call("ctx", {});
    const per = (Date.now() - t0) / 200;
    check("ctx：单次调用很快（Node 模拟里 < 2ms，AE 里主要开销是 evalScript 往返）", per < 2, per.toFixed(3) + "ms");
}

// 7. LIB.selfCheck：版本、写入权限、脚本库文件夹可写；测试文件写完会删掉
{
    const h = loadHost({});
    h.call("init", {});
    const r = h.call("selfCheck", {});
    const lib = path.join(h.root, "Documents/MotionHub/Library");
    check("selfCheck：版本和 VERSION 一致、可写、文件夹存在且可写", r.ok && /^\d+\.\d+\.\d+$/.test(r.data.version) && r.data.canWrite && r.data.libExists && r.data.libWritable, JSON.stringify(r.data));
    check("selfCheck：没有留下测试文件", !fs.existsSync(path.join(lib, "_motionhub_write_test.tmp")));
    const ro = loadHost({ readonly: true, canWrite: false });
    const r2 = ro.call("selfCheck", {});
    check("selfCheck：只读环境如实报告（canWrite=false、文件夹不存在）", r2.ok && r2.data.canWrite === false && r2.data.libExists === false && r2.data.libWritable === false, JSON.stringify(r2.data));
}

// —— 3.7.1 ——
const LIB_DIR = h => path.join(h.root, "Documents/MotionHub/Library");
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const b64 = t => Buffer.from(t, typeof t === "string" ? "utf8" : undefined).toString("base64");
// 读文件 / 列目录：不存在时返回 null / []。检查不通过时打出 ✗，而不是整个测试崩掉、后面的检查都没跑
const text = p => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const ls = p => (fs.existsSync(p) ? fs.readdirSync(p) : []);

// 8. H3 添加：同名同内容 → 已经在库里；同名不同内容 → 另存为「弹跳 (2).jsx」，旧的不动
{
    const h = loadHost({});
    h.call("init", {});
    const src = path.join(h.root, "Downloads/弹跳.jsx");
    put(src, "// v1");
    const a = h.call("install", { paths: [src], cat: "动画" });
    const lib = path.join(LIB_DIR(h), "动画");
    check("添加：新文件照常复制，key 指向 /动画/弹跳.jsx", a.ok && a.data.keys[0] === "/动画/弹跳.jsx" && fs.readFileSync(path.join(lib, "弹跳.jsx"), "utf8") === "// v1", JSON.stringify(a));
    const b = h.call("install", { paths: [src], cat: "动画" });
    check("添加：同名同内容不重复复制，说明「已经在库里」", b.ok && b.data.existing === 1 && fs.readdirSync(lib).length === 1 && /已经在库里/.test(b.msg) && !/已添加 1/.test(b.msg), b.msg);
    put(src, "// v2 内容不同");
    const c = h.call("install", { paths: [src], cat: "动画" });
    check("添加：同名不同内容 → 新的存为「弹跳 (2).jsx」，旧的原样保留", c.ok && c.data.keys[0] === "/动画/弹跳 (2).jsx" && fs.readFileSync(path.join(lib, "弹跳.jsx"), "utf8") === "// v1" && fs.readFileSync(path.join(lib, "弹跳 (2).jsx"), "utf8") === "// v2 内容不同", JSON.stringify(c.data));
    check("添加：气泡里说明改了名、两个都保留", /存为「弹跳 \(2\)\.jsx」/.test(c.msg) && /两个都保留/.test(c.msg), c.msg);
    // 同一个 v2 再添加一次（比如想放到另一个面板）：库里以前另存的「弹跳 (2).jsx」内容一样 → 算已经在库里，不再多存一份 (3)
    const n2 = ls(lib).length;
    const c2 = h.call("install", { paths: [src], cat: "动画" });
    check("添加：和以前另存的「弹跳 (2).jsx」内容一样 → 已经在库里，key 指向它，没有多出文件", c2.ok && c2.data.existing === 1 && c2.data.keys[0] === "/动画/弹跳 (2).jsx" && ls(lib).length === n2 && /已经在库里/.test(c2.msg) && !/已添加/.test(c2.msg), JSON.stringify(c2.data) + " " + ls(lib).join(","));
    put(src, "// v3");
    const d = h.call("install", { paths: [src], cat: "动画" });
    check("添加：再来一个不同的 → 「弹跳 (3).jsx」", d.ok && d.data.keys[0] === "/动画/弹跳 (3).jsx", JSON.stringify(d.data));
    // ScriptUI Panels 里已经有一个内容不同的同名面板：不覆盖
    const panels = path.join(h.root, "home/Library/Preferences/Adobe/After Effects/24.3/Scripts/ScriptUI Panels");
    put(path.join(panels, "弹跳.jsx"), "// 用户自己的面板");
    const n3 = ls(lib).length;
    const e = h.call("install", { paths: [src], cat: "动画", toPanels: true });
    check("装到 ScriptUI Panels：已有内容不同的同名文件时不覆盖，并说明怎么换成新版", e.ok && text(path.join(panels, "弹跳.jsx")) === "// 用户自己的面板" && /没有覆盖/.test(e.msg) && /点设置页的「ScriptUI Panels」打开文件夹，删掉旧文件后再添加一次/.test(e.msg), e.msg);
    check("装到 ScriptUI Panels：一个都没装上时不说「0 个已装到」", !/个已装到/.test(e.msg), e.msg);
    check("添加：v3 已经存成「弹跳 (3).jsx」→ 算已经在库里，脚本库文件夹里没有多出文件", e.ok && e.data.existing === 1 && e.data.keys[0] === "/动画/弹跳 (3).jsx" && ls(lib).length === n3, JSON.stringify(e.data) + " " + ls(lib).join(","));
    const n0 = fs.readdirSync(panels).length;
    const src2 = path.join(h.root, "Downloads/新面板.jsx");
    put(src2, "// panel");
    const f = h.call("install", { paths: [src2], cat: "", toPanels: true });
    check("装到 ScriptUI Panels：没有同名文件时照常复制", f.ok && fs.readdirSync(panels).length === n0 + 1 && /1 个已装到 ScriptUI Panels/.test(f.msg), f.msg);
}

// 9. H3 拖入：同样不覆盖；二进制内容按字节原样写入
{
    const h = loadHost({});
    h.call("init", {});
    const lib = path.join(LIB_DIR(h), "工具");
    const a = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64("// one") });
    check("拖入：新文件 state=new", a.ok && a.data.state === "new" && a.data.key === "/工具/对齐.jsx" && a.data.savedAs === "对齐.jsx", JSON.stringify(a));
    const b = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64("// one") });
    check("拖入：同名同内容 → state=exists，没有多出文件", b.ok && b.data.state === "exists" && b.data.savedAs === "对齐.jsx" && fs.readdirSync(lib).length === 1, JSON.stringify(b));
    const c = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64("// two") });
    check("拖入：同名不同内容 → state=renamed、savedAs=「对齐 (2).jsx」，旧文件不变", c.ok && c.data.state === "renamed" && c.data.savedAs === "对齐 (2).jsx" && fs.readFileSync(path.join(lib, "对齐.jsx"), "utf8") === "// one" && fs.readFileSync(path.join(lib, "对齐 (2).jsx"), "utf8") === "// two", JSON.stringify(c.data));
    const c2 = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64("// two") });
    check("拖入：和以前另存的「对齐 (2).jsx」字节一样 → state=exists、savedAs=「对齐 (2).jsx」，没有多出文件", c2.ok && c2.data.state === "exists" && c2.data.savedAs === "对齐 (2).jsx" && c2.data.key === "/工具/对齐 (2).jsx" && ls(lib).length === 2, JSON.stringify(c2.data) + " " + ls(lib).join(","));
    const bytes = Buffer.alloc(256); for (let i = 0; i < 256; i++) bytes[i] = i;
    const d = h.call("writeDropped", { name: "预设.ffx", cat: "工具", b64: bytes.toString("base64") });
    check("拖入：二进制 .ffx 按字节原样写入（0–255 全部字节）", d.ok && Buffer.compare(fs.readFileSync(path.join(lib, "预设.ffx")), bytes) === 0, JSON.stringify(d));
    const e = h.call("writeDropped", { name: "预设.ffx", cat: "工具", b64: bytes.toString("base64") });
    check("拖入：二进制同内容再拖一次 → exists", e.ok && e.data.state === "exists", JSON.stringify(e.data));
}

// 9b. 拖入带 BOM 的 UTF-8 脚本（老记事本、很多中文编辑器这样存）：按文档 open() 读到 BOM 会改编码并跳过它，
// readBinary 打开后要再设 BINARY、回到开头，比较的才是原始字节
{
    const h = loadHost({ bomAware: true });
    h.call("init", {});
    const lib = path.join(LIB_DIR(h), "工具");
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("// 中文注释\nalert(1);", "utf8")]);
    const a = h.call("writeDropped", { name: "带BOM.jsx", cat: "工具", b64: bom.toString("base64") });
    const b = h.call("writeDropped", { name: "带BOM.jsx", cat: "工具", b64: bom.toString("base64") });
    check("拖入：带 BOM 的脚本按原始字节写入，再拖一次 → exists，没有多出「带BOM (2).jsx」", a.ok && a.data.state === "new" && fs.existsSync(path.join(lib, "带BOM.jsx")) && Buffer.compare(fs.readFileSync(path.join(lib, "带BOM.jsx")), bom) === 0 && b.ok && b.data.state === "exists" && ls(lib).length === 1, JSON.stringify([a.data, b.data]) + " " + ls(lib).join(","));
}

// 10. H4 移除：放进 _已移除/<原分类>/，重名自动编号；移除失败不留副本
{
    const h = loadHost({ lockRemove: /^锁住/ });
    h.call("init", {});
    const lib = LIB_DIR(h);
    put(path.join(lib, "动画/弹跳.jsx"), "// 第一个");
    const a = h.call("remove", { path: path.join(lib, "动画/弹跳.jsx") });
    check("移除：移到 _已移除/动画/，原文件不在了", a.ok && fs.existsSync(path.join(lib, "_已移除/动画/弹跳.jsx")) && !fs.existsSync(path.join(lib, "动画/弹跳.jsx")) && /_已移除\/动画/.test(a.msg), a.msg);
    put(path.join(lib, "动画/弹跳.jsx"), "// 第二个");
    const b = h.call("remove", { path: path.join(lib, "动画/弹跳.jsx") });
    check("移除：_已移除 里已有同名 → 存为「弹跳 (2).jsx」，第一个没被覆盖", b.ok && fs.readFileSync(path.join(lib, "_已移除/动画/弹跳.jsx"), "utf8") === "// 第一个" && fs.readFileSync(path.join(lib, "_已移除/动画/弹跳 (2).jsx"), "utf8") === "// 第二个" && /弹跳 \(2\)\.jsx/.test(b.msg), b.msg);
    put(path.join(lib, "根目录.jsx"), "// root");
    const c = h.call("remove", { path: path.join(lib, "根目录.jsx") });
    check("移除：未分类的文件放在 _已移除/ 根下", c.ok && fs.existsSync(path.join(lib, "_已移除/根目录.jsx")), c.msg);
    put(path.join(lib, "工具/锁住.jsx"), "// locked");
    const d = h.call("remove", { path: path.join(lib, "工具/锁住.jsx") });
    check("移除：原文件删不掉时报错，并且不在 _已移除 里留下副本", !d.ok && fs.existsSync(path.join(lib, "工具/锁住.jsx")) && !fs.existsSync(path.join(lib, "_已移除/工具/锁住.jsx")) && /占用/.test(d.msg), d.msg);
    const s = h.call("scan", {});
    check("移除：_已移除 里的文件不出现在脚本库列表里", s.ok && s.data.items.every(it => it.path.indexOf("_已移除") === -1), JSON.stringify(s.data.items.map(i => i.key)));
}

// 10b. H4 移除：列表是旧的（脚本库在别的面板换过），文件已经不在当前脚本库里 → 不动它，说明原因
{
    const h = loadHost({});
    h.call("init", {});
    const lib = LIB_DIR(h);
    // 和当前库在同一个上级文件夹、名字开头也一样（Library-旧）：只比较字符串前缀会误认成库里的
    const old = path.join(h.root, "Documents/MotionHub/Library-旧/动画/弹跳.jsx");
    put(old, "// 旧库里的");
    const a = h.call("remove", { path: old });
    check("移除：不在当前脚本库里的文件不动，提示里说明当前是哪个库、怎么办", !a.ok && /没能移除「弹跳\.jsx」：它不在当前脚本库「/.test(a.msg) && a.msg.indexOf("「" + lib + "」") !== -1 && /列表已经刷新，重新选择要移除的脚本/.test(a.msg), a.msg);
    check("移除：不在库里的文件原样留着，两个库里都没有建出 _已移除", text(old) === "// 旧库里的" && !fs.existsSync(path.join(lib, "_已移除")) && !fs.existsSync(path.join(h.root, "Documents/MotionHub/Library-旧/_已移除")), ls(lib).join(","));
    const far = path.join(h.root, "Desktop/别处.jsx");
    put(far, "// 别处");
    const b = h.call("remove", { path: far });
    check("移除：完全在别处的文件也不动", !b.ok && /不在当前脚本库/.test(b.msg) && text(far) === "// 别处", b.msg);
}

// 11. H5 自动导入示例：库里已经有脚本就不导，用户删掉的示例不会回来；手动导入照常补齐
{
    const h = loadHost({});
    h.call("init", {});
    const lib = LIB_DIR(h);
    const a = h.call("importSamples", { auto: true });
    check("自动导入：空库 → 导入 2 个示例", a.ok && a.data.copied === 2 && !a.data.skipped, JSON.stringify(a.data));
    fs.unlinkSync(path.join(lib, "动画/a.jsx"));
    const b = h.call("importSamples", { auto: true });
    check("自动导入：库里还有脚本 → skipped，删掉的示例没有被导回来", b.ok && b.data.skipped === true && b.data.copied === 0 && !fs.existsSync(path.join(lib, "动画/a.jsx")), JSON.stringify(b.data));
    const c = h.call("importSamples", {});
    check("手动导入：照常补齐缺的示例（copied=1、existing=1）", c.ok && c.data.copied === 1 && c.data.existing === 1, JSON.stringify(c.data));
    const h2 = loadHost({});
    h2.call("init", {});
    const lib2 = LIB_DIR(h2);
    put(path.join(lib2, "_snippets.json"), "{}");
    put(path.join(lib2, "_已移除/动画/a.jsx"), "// removed");
    const d = h2.call("importSamples", { auto: true });
    check("自动导入：只有 _snippets.json 和 _已移除 里的文件不算「有脚本」→ 照常导入", d.ok && d.data.copied === 2, JSON.stringify(d.data));
}

// 12. H6 预设：applyPreset 只调用一次（它本身作用于所有选中的图层），一个撤销组
{
    const h = loadHost({ comp: { layers: 3 } });
    h.call("init", {});
    const ffx = path.join(LIB_DIR(h), "预设/模糊.ffx");
    put(ffx, "ffx");
    const r = h.call("run", { path: ffx });
    check("预设：选中 3 个图层时 applyPreset 只调用 1 次", r.ok && h.presets.length === 1, JSON.stringify(h.presets));
    check("预设：提示里说明作用于 3 个图层", /3 个图层/.test(r.msg), r.msg);
    check("预设：一个撤销组（开、关各一次）", h.undo.filter(u => /^begin:/.test(u)).length === 1 && h.undo[h.undo.length - 1] === "end", h.undo.join(","));
    const h0 = loadHost({ comp: { layers: 0 } });
    // .ffx 要放在 h0 自己的根目录下：文件确实存在，这一项才真的检查到「没选图层」，而不是「文件不存在」
    const ffx0 = ffx.replace(h.root, h0.root);
    put(ffx0, "ffx");
    const r0 = h0.call("run", { path: ffx0 });
    check("预设：没选图层时不应用（提示先选图层，不开撤销组）", !r0.ok && /至少 1 个图层/.test(r0.msg) && h0.presets.length === 0 && h0.undo.length === 0, r0.msg);
}

// 13. 不分大小写的磁盘（Windows / macOS 默认）：只是大小写不同、内容一样 → 已经在库里，
// key 用磁盘上的写法（和 scan 报告的一致），否则放到面板上的按钮会显示「（缺失）」
{
    const h = loadHost({ caseless: true });
    h.call("init", {});
    const lib = path.join(LIB_DIR(h), "动画");
    put(path.join(lib, "bounce.jsx"), "// same");
    put(path.join(lib, "bounce (2).jsx"), "// v2");
    const scanKeys = () => { const r = h.call("scan", {}); return r.ok ? r.data.items.map(i => i.key) : [r.msg]; };
    const src = path.join(h.root, "Downloads/Bounce.JSX");
    put(src, "// same");
    const a = h.call("install", { paths: [src], cat: "动画" });
    check("不分大小写：添加「Bounce.JSX」（和 bounce.jsx 内容一样）→ 已经在库里，key 是 scan 里的 /动画/bounce.jsx", a.ok && a.data.existing === 1 && a.data.keys[0] === "/动画/bounce.jsx" && scanKeys().indexOf(a.data.keys[0]) !== -1 && ls(lib).length === 2, JSON.stringify(a.data) + " scan=" + JSON.stringify(scanKeys()));
    put(src, "// v2");
    const b = h.call("install", { paths: [src], cat: "动画" });
    check("不分大小写：和「bounce (2).jsx」内容一样 → key 是 /动画/bounce (2).jsx", b.ok && b.data.existing === 1 && b.data.keys[0] === "/动画/bounce (2).jsx" && ls(lib).length === 2, JSON.stringify(b.data));
    const c = h.call("writeDropped", { name: "BOUNCE.jsx", cat: "动画", b64: b64("// same") });
    check("不分大小写：拖入「BOUNCE.jsx」（内容一样）→ exists，key 和 savedAs 都用磁盘上的写法", c.ok && c.data.state === "exists" && c.data.key === "/动画/bounce.jsx" && c.data.savedAs === "bounce.jsx" && ls(lib).length === 2, JSON.stringify(c.data));
    const d = h.call("remove", { path: path.join(h.root, "DOCUMENTS/MotionHub/LIBRARY/动画/bounce.jsx") });
    check("不分大小写：移除时路径的大小写和脚本库不同，也认得是库里的文件", d.ok && fs.existsSync(path.join(LIB_DIR(h), "_已移除/动画/bounce.jsx")) && !fs.existsSync(path.join(lib, "bounce.jsx")), d.msg);
    // 分大小写的磁盘上 bounce.jsx 和 Bounce.jsx 是两个文件：key 要指向完全同名的那个
    const h2 = loadHost({});
    h2.call("init", {});
    const lib2 = path.join(LIB_DIR(h2), "动画");
    put(path.join(lib2, "bounce.jsx"), "// 小写的那个");
    put(path.join(lib2, "Bounce.jsx"), "// 大写的那个");
    put(path.join(lib2, "BOUNCE.jsx"), "// 全大写的那个");
    const src2 = path.join(h2.root, "Downloads/Bounce.jsx");
    put(src2, "// 大写的那个");
    const e = h2.call("install", { paths: [src2], cat: "动画" });
    const f = h2.call("writeDropped", { name: "Bounce.jsx", cat: "动画", b64: b64("// 大写的那个") });
    check("分大小写的磁盘：同名文件只差大小写时，exists 的 key 指向完全同名的 /动画/Bounce.jsx", e.ok && e.data.existing === 1 && e.data.keys[0] === "/动画/Bounce.jsx" && f.ok && f.data.state === "exists" && f.data.key === "/动画/Bounce.jsx" && f.data.savedAs === "Bounce.jsx" && ls(lib2).length === 3, JSON.stringify([e.data, f.data]));
}

// 14. 复制 / 写入到一半失败（磁盘满了、网络盘断开）：报错说明原因，不留下残缺文件；重试时用原来的名字
{
    const o = {};
    const h = loadHost(o);
    h.call("init", {});
    const lib = LIB_DIR(h);
    const full = "// 完整的脚本 v1，有好几行内容";
    const src = path.join(h.root, "Downloads/弹跳.jsx");
    put(src, full);
    o.failCopy = /Library\/动画\//;
    const a = h.call("install", { paths: [src], cat: "动画" });
    check("添加时复制失败：报错说明原因，不留下复制了一半的「弹跳.jsx」", !a.ok && /没能复制「弹跳\.jsx」（I\/O error）：检查脚本库文件夹是否可写/.test(a.msg) && ls(path.join(lib, "动画")).length === 0, a.msg + " / " + ls(path.join(lib, "动画")).join(","));
    o.failCopy = null;
    const b = h.call("install", { paths: [src], cat: "动画" });
    check("复制失败后重试：存成原来的名字「弹跳.jsx」（不是「弹跳 (2).jsx」），内容完整", b.ok && b.data.keys[0] === "/动画/弹跳.jsx" && b.data.renamed.length === 0 && text(path.join(lib, "动画/弹跳.jsx")) === full && ls(path.join(lib, "动画")).length === 1, JSON.stringify(b.data));

    o.failCopy = /_已移除/;
    const r1 = h.call("remove", { path: path.join(lib, "动画/弹跳.jsx") });
    check("移除时复制失败：报错，原文件还在，_已移除 里不留残缺副本", !r1.ok && /没能移除「弹跳\.jsx」（I\/O error）：检查脚本库文件夹是否可写/.test(r1.msg) && text(path.join(lib, "动画/弹跳.jsx")) === full && !fs.existsSync(path.join(lib, "_已移除/动画/弹跳.jsx")), r1.msg);
    o.failCopy = null;
    const r2 = h.call("remove", { path: path.join(lib, "动画/弹跳.jsx") });
    check("移除失败后重试：放进 _已移除/动画/，用原来的名字", r2.ok && text(path.join(lib, "_已移除/动画/弹跳.jsx")) === full && ls(path.join(lib, "_已移除/动画")).length === 1 && !/\(2\)/.test(r2.msg), r2.msg);

    const dropped = "// 拖进来的脚本，内容比较长一些";
    o.failClose = /对齐\.jsx$/;
    const d1 = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64(dropped) });
    check("拖入时 close() 报错（缓存没写进磁盘）：报错，不留下写坏的文件", !d1.ok && /没能写完「对齐\.jsx」（I\/O error）：检查磁盘空间和脚本库文件夹是否可写/.test(d1.msg) && !fs.existsSync(path.join(lib, "工具/对齐.jsx")), d1.msg);
    o.failClose = null;
    const d2 = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64(dropped) });
    check("拖入失败后重试：state=new、savedAs=「对齐.jsx」，内容完整", d2.ok && d2.data.state === "new" && d2.data.savedAs === "对齐.jsx" && text(path.join(lib, "工具/对齐.jsx")) === dropped && ls(path.join(lib, "工具")).length === 1, JSON.stringify(d2.data));

    const panels = path.join(h.root, "home/Library/Preferences/Adobe/After Effects/24.3/Scripts/ScriptUI Panels");
    const src2 = path.join(h.root, "Downloads/新面板.jsx");
    put(src2, "// 一个面板脚本");
    o.failCopy = /ScriptUI Panels/;
    const p1 = h.call("install", { paths: [src2], cat: "", toPanels: true });
    check("装到 ScriptUI Panels 时复制失败：脚本库照常添加，说明没装上、怎么办，不留下残缺文件", p1.ok && /已添加 1 个文件/.test(p1.msg) && /「新面板\.jsx」（I\/O error）没能装到 ScriptUI Panels：点设置页的「ScriptUI Panels」打开文件夹/.test(p1.msg) && !/个已装到/.test(p1.msg) && !fs.existsSync(path.join(panels, "新面板.jsx")), p1.msg);
    o.failCopy = null;
    const p2 = h.call("install", { paths: [src2], cat: "", toPanels: true });
    check("再添加一次：脚本库里已经有了，这次装进 ScriptUI Panels", p2.ok && p2.data.existing === 1 && /1 个已装到 ScriptUI Panels/.test(p2.msg) && text(path.join(panels, "新面板.jsx")) === "// 一个面板脚本", p2.msg);
}

// 15. loadSnippets 同时报告读的是哪个脚本库：面板拿它和自己记的比，就知道脚本库是不是在别的面板换过
{
    const h = loadHost({});
    const i = h.call("init", {}), s = h.call("loadSnippets", {});
    check("loadSnippets：返回的 libPath 和 init 的一样", i.ok && s.ok && s.data.text === null && typeof s.data.libPath === "string" && s.data.libPath === i.data.libPath, JSON.stringify([i.data, s.data]));
    const ro = loadHost({ readonly: true, canWrite: false });
    const i2 = ro.call("init", {}), s2 = ro.call("loadSnippets", {});
    check("loadSnippets：只读磁盘、脚本库文件夹还没建时，libPath 也和 init 的一样", i2.ok && s2.ok && s2.data.text === null && typeof s2.data.libPath === "string" && s2.data.libPath === i2.data.libPath, JSON.stringify([i2.data, s2.data]));
    const h3 = loadHost({});
    const other = path.join(h3.root, "Dropbox/AE 脚本");
    put(path.join(other, "_snippets.json"), "[\"另一个库的片段\"]");
    const i3 = h3.call("init", { libPath: other }), s3 = h3.call("loadSnippets", {});
    check("loadSnippets：读的是当前脚本库里的片段，libPath 指向它", i3.ok && i3.data.libPath === other && s3.ok && s3.data.text === "[\"另一个库的片段\"]" && s3.data.libPath === other, JSON.stringify([i3.data, s3.data]));
}

// 16. H1：没开写入权限时布局和片段由面板用 Node 写，host.jsx 读的必须是同一个文件。
// 在 Node 里载入真正的 js/bridge.js（假的 window / navigator，磁盘读写用真的 Node fs），再用真正的 host.jsx 读回来。
// bridge.js 按 navigator.platform 以 "Win" 开头判断 Windows：Windows 用 %APPDATA%（没有时用 <home>/AppData/Roaming），
// Mac 用 <home>/Library/Application Support，都要和 ExtendScript 的 Folder.userData 是同一个文件夹
{
    const vm = require("vm");
    const BRIDGE = path.join(__dirname, "../com.windwings.motionhub/js/bridge.js");
    // mixed = true：--mixed-context，require / process 是全局的；false：从 window.cep_node 上拿
    function loadBridge(platform, env, homedir, mixed) {
        // 测试跑在 Linux 上：Windows 那一轮也用 POSIX 的 path，检查的是 bridge.js 选的文件夹和文件名规则
        const nodeOs = Object.assign({}, os, { homedir: () => homedir });
        const req = m => (m === "os" ? nodeOs : m === "path" ? path.posix : require(m));
        const proc = { pid: 4242, env };
        const win = {};
        const ctx = { window: win, navigator: { platform }, document: {}, console, setTimeout, clearTimeout, Promise };
        if (mixed) { ctx.require = req; ctx.process = proc; } else win.cep_node = { require: req, process: proc };
        vm.createContext(ctx);
        vm.runInContext(fs.readFileSync(BRIDGE, "utf8"), ctx, { filename: BRIDGE });
        return win.MHBridge;
    }
    const runs = [
        { label: "Windows", platform: "Win32", os: "Windows 10", userData: "AppData", env: ud => ({ APPDATA: ud }), mixed: true },
        { label: "Windows（Node 里没有 APPDATA）", platform: "Win32", os: "Windows 10", userData: "home/AppData/Roaming", env: () => ({}), mixed: false },
        { label: "Mac", platform: "MacIntel", os: "Macintosh OS 14", userData: "home/Library/Application Support", env: () => ({}), mixed: false }
    ];
    const tmpLeft = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /\.tmp$/.test(n)) : []);
    for (const R of runs) {
        // 没开写入权限：ExtendScript 写不了文件，只能读
        const h = loadHost({ readonly: true, canWrite: false, os: R.os, userData: R.userData });
        const userData = path.join(h.root, R.userData);
        let B = null, err = "";
        try { B = loadBridge(R.platform, R.env(userData), path.join(h.root, "home"), R.mixed); } catch (e) { err = String(e && e.stack || e); }
        check(R.label + "：真正的 bridge.js 能在 Node 里载入、能用 Node 读写", !!(B && B.disk && B.disk.ok()), err);
        if (!(B && B.disk && B.disk.ok())) continue;
        const bad = [];
        for (const name of ["panel1", "usage_panel3", "curves", "snippet_prefs", "state", "a b/c"]) {
            const body = JSON.stringify({ name: name, note: "布局「" + name + "」" });
            const w = B.disk.writeText(B.disk.configPath(name), body);
            const r = h.call("loadConfig", { name: name });
            if (!(w.ok && r.ok && r.data.text === body)) bad.push(name + "：" + JSON.stringify({ w: w, r: r }));
        }
        check(R.label + "：Node 写的配置（panel1、usage_panel3、curves、snippet_prefs、state、名字带空格和斜杠的）host 的 loadConfig 都读得到原文", bad.length === 0, bad.join("；"));
        const cfgDir = path.join(userData, "MotionHub");
        check(R.label + "：配置文件夹里没有留下 .tmp", fs.existsSync(cfgDir) && tmpLeft(cfgDir).length === 0, tmpLeft(cfgDir).join(","));
        const init = h.call("init", {});
        const libDir = init.ok ? init.data.libPath : "";
        const st = JSON.stringify([{ id: "u1", kind: "expr", name: "我的片段", code: "wiggle(2, 20)" }]);
        const ws = libDir ? B.disk.writeText(B.disk.join(libDir, "_snippets.json"), st) : { ok: false, msg: init.msg };
        const rs = h.call("loadSnippets", {});
        check(R.label + "：Node 写进脚本库的 _snippets.json（库文件夹原来不存在），host 的 loadSnippets 读得到", init.ok && init.data.libReady === false && ws.ok && rs.ok && rs.data.text === st && rs.data.libPath === init.data.libPath, JSON.stringify({ init: init.data, ws: ws, rs: rs }));
        check(R.label + "：脚本库文件夹里没有留下 .tmp", !!libDir && tmpLeft(libDir).length === 0, tmpLeft(libDir).join(","));
    }
}

// 3.7.1 第二轮审查：编号有空缺时也不重复保存；名字里本来就有 %20 的文件不算改名
{
    const h = loadHost({});
    h.call("init", {});
    const lib = path.join(LIB_DIR(h), "动画");
    const src = path.join(h.root, "Downloads/弹跳.jsx");
    put(src, "// v1"); h.call("install", { paths: [src], cat: "动画" });
    put(src, "// v2"); h.call("install", { paths: [src], cat: "动画" });
    put(src, "// v3"); h.call("install", { paths: [src], cat: "动画" });
    fs.unlinkSync(path.join(lib, "弹跳.jsx"));             // 用户整理时删掉了最早的那份
    put(src, "// v2");
    const a = h.call("install", { paths: [src], cat: "动画" });
    check("编号开头有空缺：再加一次 v2 → 认出「弹跳 (2).jsx」已经有了，不另存", a.ok && a.data.existing === 1 && a.data.keys[0] === "/动画/弹跳 (2).jsx" && !fs.existsSync(path.join(lib, "弹跳.jsx")), JSON.stringify(a.data) + " " + fs.readdirSync(lib).join(","));
    fs.unlinkSync(path.join(lib, "弹跳 (2).jsx"));          // 中间也空出来
    put(src, "// v3");
    const b = h.call("install", { paths: [src], cat: "动画" });
    check("编号中间有空缺：再加一次 v3 → 认出「弹跳 (3).jsx」，不在空位上再存一份", b.ok && b.data.existing === 1 && b.data.keys[0] === "/动画/弹跳 (3).jsx" && fs.readdirSync(lib).length === 1, JSON.stringify(b.data) + " " + fs.readdirSync(lib).join(","));
    const d = h.call("writeDropped", { name: "弹跳.jsx", cat: "动画", b64: Buffer.from("// v3").toString("base64") });
    check("拖入同样内容（编号有空缺）→ exists，指向「弹跳 (3).jsx」", d.ok && d.data.state === "exists" && d.data.savedAs === "弹跳 (3).jsx", JSON.stringify(d.data));
    const e = h.call("install", { paths: [src.replace("弹跳.jsx", "弹跳.jsx")], cat: "动画" });
    check("编号副本的识别不会误把别的文件当成同一系列（只认「名字 (数字).扩展名」）", e.ok && e.data.existing === 1, JSON.stringify(e.data));
}
{
    const h = loadHost({ uriPaths: true });
    h.call("init", {});
    const r = h.call("writeDropped", { name: "Fade%20In.jsx", cat: "", b64: Buffer.from("// fade").toString("base64") });
    check("名字里本来就有 %20 的文件拖进空库：算新加的（state=new），不说成「库里已经有一个」", r.ok && r.data.state === "new", JSON.stringify(r.data));
}

console.log(failures ? "✗ host 测试：" + failures + " 项没通过" : "✓ host 测试全部通过");
process.exit(failures ? 1 : 0);
