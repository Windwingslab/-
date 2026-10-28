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
    const undo = [];
    function FileC(p) { if (!(this instanceof FileC)) return new FileC(p); this.fsName = p; this.name = encodeURI(path.basename(p)); this.encoding = "UTF-8"; }
    Object.defineProperty(FileC.prototype, "exists", { get() { return fs.existsSync(this.fsName) && fs.statSync(this.fsName).isFile(); } });
    Object.defineProperty(FileC.prototype, "parent", { get() { return new FolderC(path.dirname(this.fsName)); } });
    FileC.prototype.open = function (mode) { if (mode !== "r" && ro) return false; this._mode = mode; if (mode === "w") fs.writeFileSync(this.fsName, ""); return mode === "r" ? this.exists : true; };
    FileC.prototype.read = function () { return fs.readFileSync(this.fsName, "utf8"); };
    FileC.prototype.write = function (t) { fs.appendFileSync(this.fsName, t); return true; };
    FileC.prototype.close = function () { return true; };
    FileC.prototype.copy = function (to) { if (ro) return false; fs.copyFileSync(this.fsName, typeof to === "string" ? to : to.fsName); return true; };
    FileC.prototype.remove = function () { fs.unlinkSync(this.fsName); return true; };
    function FolderC(p) { if (!(this instanceof FolderC)) return new FolderC(p); this.fsName = p; this.name = encodeURI(path.basename(p)); }
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
            project: { activeItem: null }
        }
    };
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
    return { MH, root, undo, call: (name, args) => JSON.parse(MH.call(name, args || {})) };
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

console.log(failures ? "✗ host 测试：" + failures + " 项没通过" : "✓ host 测试全部通过");
process.exit(failures ? 1 : 0);
