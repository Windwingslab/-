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
function loadHost(opts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-host-"));
    const ro = !!opts.readonly;
    const undo = [], presets = [];
    // 「~」开头的路径落到假的 home 里，不会在当前目录建出一个叫 ~ 的文件夹
    const home = p => (typeof p === "string" && p.charAt(0) === "~" ? path.join(root, "home", p.slice(1)) : p);
    // BINARY 编码按字节读写（每个字符 0–255），和 ExtendScript 一样
    const enc = f => (f.encoding === "BINARY" ? "latin1" : "utf8");
    function FileC(p) { if (!(this instanceof FileC)) return new FileC(p); p = home(p); this.fsName = p; this.name = encodeURI(path.basename(p)); this.encoding = "UTF-8"; this.error = ""; }
    Object.defineProperty(FileC.prototype, "exists", { get() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isFile(); } });
    Object.defineProperty(FileC.prototype, "parent", { get() { return new FolderC(path.dirname(this.fsName)); } });
    Object.defineProperty(FileC.prototype, "length", { get() { return this.exists ? fs.statSync(this.fsName).size : -1; } });
    FileC.prototype.open = function (mode) { if (mode !== "r" && ro) return false; this._mode = mode; if (mode === "w") fs.writeFileSync(this.fsName, ""); return mode === "r" ? this.exists : true; };
    FileC.prototype.read = function () { return fs.readFileSync(this.fsName, enc(this)); };
    FileC.prototype.write = function (t) { fs.appendFileSync(this.fsName, Buffer.from(String(t), enc(this))); return true; };
    FileC.prototype.close = function () { return true; };
    FileC.prototype.copy = function (to) { if (ro) return false; fs.copyFileSync(this.fsName, typeof to === "string" ? home(to) : to.fsName); return true; };
    FileC.prototype.remove = function () {
        if (opts.lockRemove && opts.lockRemove.test(path.basename(this.fsName)) && this.fsName.indexOf("_已移除") === -1) { this.error = "File is locked"; return false; }
        fs.unlinkSync(this.fsName); return true;
    };
    function FolderC(p) { if (!(this instanceof FolderC)) return new FolderC(p); p = home(p); this.fsName = p; this.name = encodeURI(path.basename(p)); }
    Object.defineProperty(FolderC.prototype, "exists", { get() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isDirectory(); } });
    Object.defineProperty(FolderC.prototype, "parent", { get() { const d = path.dirname(this.fsName); return d === this.fsName ? null : new FolderC(d); } });
    FolderC.prototype.create = function () { if (ro) return false; fs.mkdirSync(this.fsName, { recursive: true }); return true; };
    FolderC.prototype.getFiles = function (mask) {
        if (!this.exists) return null;   // 真实的 ExtendScript 在文件夹不存在时返回 null
        const re = mask && mask !== "*" ? new RegExp("^" + mask.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null;
        return fs.readdirSync(this.fsName).filter(n => !re || re.test(n)).map(n => {
            const p = path.join(this.fsName, n);
            return fs.statSync(p).isDirectory() ? new FolderC(p) : new FileC(p);
        });
    };
    FileC.decode = s => decodeURI(s);
    FolderC.myDocuments = new FolderC(path.join(root, "Documents"));
    FolderC.userData = new FolderC(path.join(root, "AppData"));
    FolderC.temp = new FolderC(path.join(root, "tmp"));

    const g = {
        File: FileC, Folder: FolderC,
        CompItem: function () {}, FolderItem: function () {}, FootageItem: function () {}, AVLayer: function () {}, ShapeLayer: function () {}, TextLayer: function () {}, CameraLayer: function () {}, LightLayer: function () {},
        $: { os: "Macintosh OS 14", fileName: path.join(root, "ext/jsx/host.jsx"), global: {} },
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
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const b64 = t => Buffer.from(t, typeof t === "string" ? "utf8" : undefined).toString("base64");

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
    put(src, "// v3");
    const d = h.call("install", { paths: [src], cat: "动画" });
    check("添加：再来一个不同的 → 「弹跳 (3).jsx」", d.ok && d.data.keys[0] === "/动画/弹跳 (3).jsx", JSON.stringify(d.data));
    // ScriptUI Panels 里已经有一个内容不同的同名面板：不覆盖
    const panels = path.join(h.root, "home/Library/Preferences/Adobe/After Effects/24.3/Scripts/ScriptUI Panels");
    put(path.join(panels, "弹跳.jsx"), "// 用户自己的面板");
    const e = h.call("install", { paths: [src], cat: "动画", toPanels: true });
    check("装到 ScriptUI Panels：已有内容不同的同名文件时不覆盖，并说明", e.ok && fs.readFileSync(path.join(panels, "弹跳.jsx"), "utf8") === "// 用户自己的面板" && /没有覆盖/.test(e.msg), e.msg);
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
    check("拖入：新文件 state=new", a.ok && a.data.state === "new" && a.data.key === "/工具/对齐.jsx", JSON.stringify(a));
    const b = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64("// one") });
    check("拖入：同名同内容 → state=exists，没有多出文件", b.ok && b.data.state === "exists" && fs.readdirSync(lib).length === 1, JSON.stringify(b));
    const c = h.call("writeDropped", { name: "对齐.jsx", cat: "工具", b64: b64("// two") });
    check("拖入：同名不同内容 → state=renamed、savedAs=「对齐 (2).jsx」，旧文件不变", c.ok && c.data.state === "renamed" && c.data.savedAs === "对齐 (2).jsx" && fs.readFileSync(path.join(lib, "对齐.jsx"), "utf8") === "// one" && fs.readFileSync(path.join(lib, "对齐 (2).jsx"), "utf8") === "// two", JSON.stringify(c.data));
    const bytes = Buffer.alloc(256); for (let i = 0; i < 256; i++) bytes[i] = i;
    const d = h.call("writeDropped", { name: "预设.ffx", cat: "工具", b64: bytes.toString("base64") });
    check("拖入：二进制 .ffx 按字节原样写入（0–255 全部字节）", d.ok && Buffer.compare(fs.readFileSync(path.join(lib, "预设.ffx")), bytes) === 0, JSON.stringify(d));
    const e = h.call("writeDropped", { name: "预设.ffx", cat: "工具", b64: bytes.toString("base64") });
    check("拖入：二进制同内容再拖一次 → exists", e.ok && e.data.state === "exists", JSON.stringify(e.data));
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
    const r0 = h0.call("run", { path: ffx.replace(h.root, h0.root) });
    check("预设：没选图层时不应用", !r0.ok && h0.presets.length === 0, r0.msg);
}

console.log(failures ? "✗ host 测试：" + failures + " 项没通过" : "✓ host 测试全部通过");
process.exit(failures ? 1 : 0);
