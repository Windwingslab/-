/* MotionHub 面板：布局引擎 + 组件注册表 + 脚本库 */
(function () {
    "use strict";

    // =====================================================================
    // 基础
    // =====================================================================
    var $ = function (s, root) { return (root || document).querySelector(s); };
    var $$ = function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); };
    var svg = window.MHIcons.svg;
    var CEP = window.__adobe_cep__;
    var OS = navigator.platform.indexOf("Win") === 0 ? "win" : "mac";

    // 当前是第几个面板（manifest 里的 panel1–panel4）
    var PANEL = (function () {
        try {
            var id = CEP && CEP.getExtensionId ? CEP.getExtensionId() : "";
            var m = /panel(\d)/.exec(id || "") || /panel=(\d)/.exec(location.search);
            return m ? +m[1] : 1;
        } catch (e) { return 1; }
    })();

    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html !== undefined) n.innerHTML = html;
        return n;
    }

    function esc(s) {
        return String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }

    var local = {
        get: function (k, d) { try { var v = localStorage.getItem("mh." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem("mh." + k, JSON.stringify(v)); } catch (e) {} }
    };

    var B = window.MHBridge;
    // 后台工具的使用次数（只存在本机，不上传）：给下一轮删减功能提供依据
    var USAGE_LABEL = {
        anchor: "锚点九宫格", centerComp: "居中到合成", nullLayer: "空对象", addLayer: "新建图层", align: "对齐", distribute: "分布",
        sequence: "错开排列", trim: "剪到工作区", precompEach: "逐个预合成", reverse: "反转图层顺序", rename: "批量重命名",
        ease: "缓动", cloneKeys: "克隆关键帧", copyKeys: "复制关键帧", pasteKeys: "粘贴关键帧", keyTime: "关键帧均分 / 拉伸 / 微移 / 反转",
        bezier: "应用缓动曲线", bezierRead: "从关键帧读取曲线", quickAnim: "快速动画", splitLayer: "在播放头拆分", toPlayhead: "移到播放头",
        motionBlur: "运动模糊", beatMarkers: "节拍标记", clearMarkers: "清除标记", beatLayers: "吸附 / 按节拍排列", decompose: "解散预合成",
        dupPrecomp: "独立复制预合成", smartRename: "智能重命名", chain: "首尾相接", styleCopy: "复制样式", stylePaste: "粘贴样式",
        applyEffect: "效果收藏", wireframe: "线框叠加", wireClear: "清除线框", wireStyle: "线框颜色", applyExpr: "表达式片段", runCode: "脚本片段",
        wiggle: "抖动", loop: "循环", bounce: "弹性", clearExpr: "清除表达式", dupComp: "复制合成", collectColors: "收集颜色", run: "运行脚本库里的脚本"
    };
    // =====================================================================
    // 配置文件读写（布局、曲线、片段设置、使用统计都走这里）
    // 先交给后台；后台写不进去（AE 没开「允许脚本写入文件」）或连不上时，用 Node 直接读写同一个文件。
    // 这样没开写入权限的用户，布局也一直在磁盘上，不会因为重装插件、升级 AE、清理临时文件而丢
    // =====================================================================
    var canWrite = null;      // AE 的写入权限：null = 还不知道（init 之前）
    var libPathNow = "";      // 这次会话里后台告诉我们的脚本库位置
    function nodeConfigWrite(name, text, prev) {
        var w = B.disk.writeText(B.disk.configPath(name), text);
        return w.ok ? { ok: true, msg: "", via: "node" } : { ok: false, msg: w.msg };
    }
    // 有 Node 就一律用 Node 读写配置：先写临时文件再改名，不会留下写了一半的文件；也不用排在后台的队列里等
    function writeConfigText(name, text) {
        if (B.disk.ok()) return Promise.resolve(nodeConfigWrite(name, text));
        return B.host("saveConfig", { name: name, text: text });
    }
    function readConfigText(name) {
        if (B.disk.ok()) {
            var d = B.disk.readText(B.disk.configPath(name));
            return Promise.resolve(d.ok ? { ok: true, msg: "", data: { text: d.text }, via: "node" } : { ok: false, msg: d.msg });
        }
        return B.host("loadConfig", { name: name });
    }
    function snippetsPath() { return libPathNow ? B.disk.join(libPathNow, "_snippets.json") : ""; }
    function writeSnippetsText(text) {
        var viaNode = function (prev) {
            var p = snippetsPath();
            if (!p) return { ok: false, msg: prev || "还不知道脚本库在哪里，片段只存在本机缓存" };
            var w = B.disk.writeText(p, text);
            return w.ok ? { ok: true, msg: "", via: "node" } : { ok: false, msg: w.msg };
        };
        if (canWrite === false && B.disk.ok()) return Promise.resolve(viaNode());
        return B.host("saveSnippets", { text: text }).then(function (r) {
            if (r && r.ok) return r;
            return B.disk.ok() ? viaNode(r && r.msg) : r;
        });
    }
    function readSnippetsText() {
        return B.host("loadSnippets").then(function (r) {
            // 后台会说它读的是哪个脚本库：别的面板换过脚本库时，这个面板跟着换（片段写到新库里，脚本列表也刷新）
            if (r && r.ok && r.data && r.data.libPath) setLibPath(r.data.libPath);
            if (r && r.ok) return r;
            if (!B.disk.ok() || !snippetsPath()) return r;
            var d = B.disk.readText(snippetsPath());
            return d.ok ? { ok: true, msg: "", data: { text: d.text }, via: "node" } : r;
        });
    }

    // =====================================================================
    // 4 个面板共用的列表：代码片段（_snippets.json）、曲线预设（curves.json）、隐藏的内置片段（snippet_prefs.json）。
    // 4 个面板是 4 个独立的进程，各有各的本机缓存。做法：
    //  · 用户的每个改动记成一条操作（加 / 改 / 删，按 id），先存进本机缓存，再拿着跨面板的文件锁：
    //    读磁盘上现在的版本 → 把操作套上去 → 写回。锁里的读改写是同步的，只要几毫秒，
    //    所以别的面板刚写进去的不会被盖掉，「没读到」也不会被当成「被删了」。
    //  · 操作写进磁盘之前一直留在本机缓存里：写失败、关掉 AE、后台没连上，下次接着写，不丢。
    //  · 别的面板也改过同一条：两个版本都留下；别的面板改过、这边要删：不删。宁可多留，不丢。
    //  · 面板重新拿到焦点时再读一次磁盘，列表和别的面板保持一致。
    // =====================================================================
    // 写盘失败统一这么说：是什么、哪个文件和原因、接下来会怎样、要用户做什么
    var DISK_ADVICE = "改动先存在这台电脑的缓存里，会自动重试；一直不行就检查文件夹是否可写";
    function diskFail(what, why) { return { ok: false, disk: { what: what, why: why }, msg: what + "没写进磁盘（" + why + "）：" + DISK_ADVICE }; }
    function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    // 后台同步（拿到焦点、自动重试、别的面板的改动）引起的重绘：有操作正在跑、对话框开着时先等一等，
    // 免得被点的按钮被换掉、丢了「处理中」还能再点一次，或者对话框背后的列表变了
    var renderWanted = false, renderTimer = null;
    function renderSoon() {
        renderWanted = true;
        if (renderTimer) return;
        (function tryNow() {
            renderTimer = null;
            if (B.inflight() > 0 || !$("#modal").hidden) { renderTimer = setTimeout(tryNow, 250); return; }
            if (!renderWanted) return;
            renderWanted = false;
            renderSnippets();
            if (cfg) renderLayout();
        })();
    }
    function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
    function blank(t) { return t == null || !/\S/.test(t); }   // 不存在、0 字节（写到一半中断）、只有空白：都当成「还没有」

    // o.tag：本机缓存键名；o.what：提示里的名字；o.file()：磁盘上的完整路径（还不知道时返回 ""）
    // o.parse(text) → 数组；o.dump(list) → 文本；o.key(x)；o.get() / o.set(list)：面板里的列表
    // o.localGet() / o.localSet(list)：本机缓存；o.seed()：全新用户的默认内容（只在磁盘上还没有文件时写入）
    // o.body(x)：内容指纹，一次性合并时用来认出「内容完全一样」的重复项；o.onRemap(remap)：重复项换成磁盘上那份后改这个面板的引用
    // o.fork(x) / o.forkNote(x) / o.keptNote(x)：两个面板改了同一条时怎么留、怎么说；o.changed()：列表变了以后重绘
    // o.hostRead() / o.hostWrite(text)：没有 Node 时退回给后台读写
    function sharedList(o) {
        var S = { synced: false, bad: false, retry: 0, timer: null, q: Promise.resolve(), stamp: "", told: {}, ops: local.get(o.tag + "Ops", null) || [] };
        function queued(fn) { var run = function () { return fn(); }; S.q = S.q.then(run, run); return S.q; }
        function saveOps() { local.set(o.tag + "Ops", S.ops); }
        function badMsg(file) { return o.what + "文件损坏（" + file + "）：原文件没有动，改动先存在这台电脑的缓存里。先备份这个文件再修，修好后改动会自动写进去"; }
        function parseText(text) {
            if (blank(text)) return { missing: true, list: [] };
            try { var l = o.parse(text); return Array.isArray(l) ? { list: l } : null; } catch (e) { return null; }
        }
        function idxOf(list, k) { for (var i = 0; i < list.length; i++) if (o.key(list[i]) === k) return i; return -1; }
        // 把操作按顺序套到磁盘上现在的列表上。notes：[{ kind: "fork" | "kept", key, text }]
        function apply(disk, missing, ops) {
            var list = disk.slice(), remap = {}, notes = [];
            ops.forEach(function (op) {
                var i;
                if (op.op === "put") {
                    i = idxOf(list, o.key(op.item));
                    if (i === -1) { list.push(op.item); return; }
                    // 别的面板也改过这一条（磁盘上的既不是这边改之前的，也不是改之后的）：两个版本都留下。
                    // 副本的 id 记在操作里：重试时再套一遍不会多出第二份
                    if (op.prev && o.fork && !sameJSON(list[i], op.prev) && !sameJSON(list[i], op.item)) {
                        var copy = o.fork(op.item, op.forkId);
                        if (idxOf(list, o.key(copy)) === -1) list.push(copy);
                        notes.push({ kind: "fork", key: o.key(op.item), text: o.forkNote(op.item) });
                        return;
                    }
                    list[i] = op.item;
                } else if (op.op === "del") {
                    i = idxOf(list, op.key);
                    if (i === -1) return;
                    // 别的面板在这期间改过这一条：不删
                    if (op.prev && !sameJSON(list[i], op.prev)) { notes.push({ kind: "kept", key: op.key, text: o.keptNote ? o.keptNote(list[i]) : "" }); return; }
                    list.splice(i, 1);
                } else if (op.op === "init") {
                    // 启动时：磁盘上还没有（或是空文件）→ 用本机缓存，没有缓存就用默认内容；
                    // 老版本留下、只存在本机缓存里的列表 → 合并进磁盘（内容完全一样的不重复加，这个面板的引用改指过去）
                    var items = missing ? (op.items || (o.seed ? o.seed() : [])) : (op.absorb ? op.items || [] : []);
                    items.forEach(function (x) {
                        if (idxOf(list, o.key(x)) !== -1) return;
                        if (o.body) for (var j = 0; j < list.length; j++) if (o.body(list[j]) === o.body(x)) { remap[o.key(x)] = o.key(list[j]); return; }
                        list.push(x);
                    });
                }
            });
            return { list: list, remap: remap, notes: notes };
        }
        // Node：按目标文件分组，每个文件在锁里读、套操作、写回（同步，几毫秒）。
        // 每组各管各的：换之前的脚本库打不开，不耽误现在这个库；当前文件的结果决定面板里显示什么
        function syncNode() {
            var cur = o.file(), groups = [], byFile = {};
            S.ops.forEach(function (op, i) {
                var f = op.f || cur;
                if (!f) return;
                if (!byFile[f]) { byFile[f] = { f: f, ops: [], idx: [] }; groups.push(byFile[f]); }
                byFile[f].ops.push(op); byFile[f].idx.push(i);
            });
            if (cur && !byFile[cur]) { byFile[cur] = { f: cur, ops: [], idx: [] }; groups.push(byFile[cur]); }
            if (!cur && !groups.length) return { ok: false, later: true };
            // 共用文件被删掉了（同步盘出错、手动清理）：用面板里现在的列表写回去，不把大家的列表清空（init 只在文件不存在时起作用）
            if (cur && !byFile[cur].ops.some(function (op) { return op.op === "init"; })) byFile[cur].ops.push({ op: "init", items: o.get().length ? o.get() : null, absorb: false, f: cur });
            var done = {}, notes = [], remap = {}, view = null, curFail = null, other = null;
            groups.forEach(function (G) {
                var r = B.disk.withLock(G.f, function (mine) {
                    var d = B.disk.readText(G.f);
                    if (!d.ok) return { ok: false, msg: d.msg };
                    var p = parseText(d.text);
                    if (!p) return { ok: false, bad: true, msg: badMsg(G.f) };
                    var a = apply(p.list, p.missing, G.ops);
                    if (G.ops.length && (p.missing ? a.list.length > 0 : !sameJSON(a.list, p.list))) {
                        var w = B.disk.writeText(G.f, o.dump(a.list));
                        if (!w.ok) return { ok: false, msg: w.msg };
                        // 写的时候锁被别人接管了：这次不算做成，操作留着下次再套（套两遍结果一样）
                        if (!mine()) return { ok: false, busy: true };
                    }
                    return { ok: true, list: a.list, remap: a.remap, notes: a.notes };
                }) || { ok: false, msg: "没有返回" };
                if (r.ok) {
                    G.idx.forEach(function (i) { done[i] = true; });
                    notes = notes.concat(r.notes);
                    for (var k in r.remap) remap[k] = r.remap[k];
                    if (G.f === cur) view = r.list;
                } else if (G.f === cur) curFail = r;
                else if (!other) other = { f: G.f, r: r };
            });
            S.ops = S.ops.filter(function (op, i) { return !done[i]; });
            saveOps();
            var res = curFail || { ok: true, list: view, later: !cur };
            res.notes = notes; res.remap = remap; res.other = other;
            return res;
        }
        // 没有 Node（只在测试或装坏了的环境里）：交给后台读写，尽力而为
        function syncHost() {
            return o.hostRead().then(function (r) {
                if (!(r && r.ok && r.data)) return { ok: false, offline: true, msg: (r && r.msg) || "没有读到" };
                var p = parseText(r.data.text);
                if (!p) return { ok: false, bad: true, msg: badMsg(o.what + "文件") };
                var ops = S.ops.slice(), a = apply(p.list, p.missing, ops);
                var take = function () { S.ops = S.ops.slice(ops.length); saveOps(); return { ok: true, list: a.list, remap: a.remap, notes: a.notes }; };
                if (!ops.length || (!p.missing && sameJSON(a.list, p.list))) return take();
                if (canWrite === false) return { ok: false, msg: "AE 没允许脚本写入文件" };
                return o.hostWrite(o.dump(a.list)).then(function (w) { return w && w.ok ? take() : { ok: false, msg: (w && w.msg) || "没有返回" }; });
            });
        }
        function attempt(n) {
            return (B.disk.ok() ? Promise.resolve(syncNode()) : syncHost()).then(function (x) {
                // 别的面板正拿着锁：等几十毫秒再试（最多约 2 秒）
                if (x && x.busy && n < 80) return wait(10 + Math.floor(Math.random() * 30)).then(function () { return attempt(n + 1); });
                return x;
            });
        }
        // 写不进去：1、2、5、10 秒后重试，之后每 30 秒一次，直到写进去；面板拿到焦点时也会试
        function retryLater() {
            clearTimeout(S.timer);
            if (!S.ops.length) return;
            S.timer = setTimeout(function () { S.sync(true); }, [1000, 2000, 5000, 10000][S.retry] || 30000);
            S.retry++;
        }
        function finish(x) {
            x = x || { ok: false, msg: "没有返回" };
            var any = false, k;
            for (k in (x.remap || {})) { any = true; break; }
            if (any && o.onRemap) o.onRemap(x.remap);
            // 换之前的脚本库打不开：那边的改动留着重试，说一次
            if (x.other) {
                retryLater();
                if (o.otherNote && !S.told[x.other.f]) { S.told[x.other.f] = true; toast(o.otherNote(x.other.f, x.other.r)); }
            }
            if (x.ok && x.list) {
                S.synced = true; S.bad = false;
                if (!x.other) { S.retry = 0; clearTimeout(S.timer); }
                var changed = !sameJSON(x.list, o.get());
                o.set(x.list); o.localSet(x.list);
                S.stamp = B.disk.ok() && o.file() ? B.disk.stamp(o.file()) : "";
                if (changed && o.changed) o.changed();
                return { ok: true, notes: x.notes || [] };
            }
            if (x.ok) return { ok: true, later: true, notes: x.notes || [] };   // 别的文件写好了，当前这个还不知道在哪里
            S.bad = !!x.bad;
            // 没有 Node、后台又没连上：不在后台反复去敲，恢复连接时（重新连接 / 自动恢复）会整体同步一次，改动留在本机缓存里
            if (x.offline) return { ok: true, offline: true };
            retryLater();
            if (x.later) return { ok: false, later: true, msg: o.what + "还不知道存在哪里（后台还没连上）：改动先存在这台电脑的缓存里，连上后自动写进去" };
            if (x.busy) return { ok: false, busy: true, msg: o.what + "正被别的面板写入：改动先存在这台电脑的缓存里，稍后自动再试" };
            if (S.bad) return { ok: false, bad: true, msg: x.msg };
            return diskFail(o.what, x.msg || "没有返回");
        }
        // bg = 不是用户点出来的（自动重试、拿到焦点、启动）：别的面板的改动被保留 / 另存时，在提示栏说一声
        S.sync = function (bg) {
            return queued(function () { return attempt(0).then(finish); }).then(function (r) {
                if (bg && r && r.notes && r.notes.length) toast({ ok: true, msg: r.notes.map(function (n) { return n.text; }).filter(Boolean).join("；") });
                return r;
            });
        };
        S.pending = function () { return S.ops.length > 0; };
        // 面板拿到焦点：有没写进去的改动就写；文件没变（修改时间 + 大小一样）就不读
        S.refresh = function () {
            if (S.ops.length) return S.sync(true);
            if (!S.synced || !B.disk.ok()) return Promise.resolve({ ok: true });
            var f = o.file();
            if (f && S.stamp && B.disk.stamp(f) === S.stamp) return Promise.resolve({ ok: true });
            return S.sync(true);
        };
        // 启动 / 重新连上 / 换了脚本库：先用本机缓存显示，再和磁盘对上。每个文件只留一条 init，不越攒越多
        S.load = function () {
            return queued(function () {
                var cached = o.localGet(), f = o.file();
                if (!S.synced && cached) o.set(cached);
                // 开发版留下过「Dirty」标记（上次的改动没写进去）：同样合并一次
                var legacy = local.get(o.tag + "Dirty", null) === true;
                if (legacy) local.set(o.tag + "Dirty", null);
                var absorb = (!local.get(o.tag + "Merged", false) || legacy) && !!cached, init = null;
                S.ops.forEach(function (op) { if (op.op === "init" && (op.f || "") === (f || "")) init = op; });
                if (init) { init.items = cached; init.absorb = init.absorb || absorb; }
                else S.ops.push({ op: "init", items: cached, absorb: absorb, f: f });
                saveOps();
                local.set(o.tag + "Merged", true);   // 合并这一步已经记成操作了，写不进去也会一直留着重试
                return attempt(0).then(finish);
            }).then(function (r) {
                if (r && r.notes && r.notes.length) toast({ ok: true, msg: r.notes.map(function (n) { return n.text; }).filter(Boolean).join("；") });
                return r;
            });
        };
        // 换了脚本库：旧库上的 init 只是给不存在的文件写默认内容，丢掉；老版本本机列表的合并移到新库，别困在打不开的旧库上；
        // 旧库上的加 / 改 / 删留着，等旧库能打开时写回去
        S.retarget = function (from, to) {
            var n = S.ops.length;
            S.ops = S.ops.filter(function (op) {
                if (op.op !== "init" || op.f !== from) return true;
                if (op.absorb) { op.f = to; return true; }
                return false;
            });
            if (S.ops.length !== n || S.ops.some(function (op) { return op.f === to; })) saveOps();
        };
        // 用户的一次改动：面板里的列表已经改好了，这里记下操作并写进磁盘。返回的 mine = 这次改动自己的说明（被保留 / 另存了）
        S.change = function (op) {
            op.f = o.file();
            if (op.op === "put" && op.prev && !op.forkId) op.forkId = uid();
            S.ops.push(op); saveOps();
            o.localSet(o.get());
            S.retry = 0;
            var k = op.op === "del" ? op.key : o.key(op.item);
            return S.sync().then(function (r) {
                if (r && r.notes) r.mine = r.notes.filter(function (n) { return n.key === k; });
                return r;
            });
        };
        return S;
    }

    var usage = {}, usageTimer = null, usageLoaded = false;
    function bumpUsage(name) {
        usage[name] = (usage[name] || 0) + 1;
        if (!usageLoaded) return;                 // 磁盘上的历史还没读到：先只记内存，读到后合并再写，不覆盖历史
        local.set("usage" + PANEL, usage);        // 本机缓存立刻写，关面板也不丢
        clearTimeout(usageTimer);
        usageTimer = setTimeout(saveUsage, 2000);
    }
    function saveUsage() { writeConfigText("usage_panel" + PANEL, JSON.stringify(usage)); }
    function host(name, args) {
        if (USAGE_LABEL[name]) bumpUsage(name);
        return B.host(name, args);
    }

    // =====================================================================
    // 颜色
    // =====================================================================
    var INK = "#171819";
    var PALETTE = [
        ["#FF5900", "品牌橙"], ["#FF7A2F", "亮橙"], ["#FFD8BE", "桃"], ["#F4F4F2", "白"],
        ["#A8BBD6", "钢蓝"], ["#4A6285", "深钢蓝"], ["#8A8C8E", "灰"], ["#26110A", "深棕"]
    ];

    function rgb(hex) {
        var n = parseInt(hex.replace("#", ""), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function toHex(c) {
        return "#" + c.map(function (v) { var h = Math.round(Math.max(0, Math.min(255, v))).toString(16); return h.length < 2 ? "0" + h : h; }).join("").toUpperCase();
    }
    function mix(a, b, t) { // t = 0 → a，1 → b
        var x = rgb(a), y = rgb(b);
        return toHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; }));
    }
    function luminance(hex) {
        return rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
            .reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
    }
    function contrast(a, b) {
        var l1 = luminance(a), l2 = luminance(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    // 色块上的文字：近黑和白里对比度更高的那个（品牌橙上是近黑 5.66:1）
    function onColor(hex) { return contrast(hex, INK) >= contrast(hex, "#FFFFFF") ? INK : "#FFFFFF"; }

    // 偏灰的品牌色：把强调色按比例混进中性深灰。选中的胶囊、主按钮、上了色的方块都用它，不用亮色大块；
    // 主按钮的图标用强调色本身（小面积），太暗看不清时用正文色
    var HL_BASE = "#262728", HL_LINE_BASE = "#3A3B3C";
    function hlVars(hex) {
        var hl = mix(HL_BASE, hex, 0.10);
        return {
            "--hl": hl, "--hl-hover": mix(HL_BASE, hex, 0.15), "--hl-press": mix(HL_BASE, hex, 0.22),
            "--hl-line": mix(HL_LINE_BASE, hex, 0.20), "--hl-icon": contrast(hex, hl) >= 3 ? hex : "#F4F4F2"
        };
    }
    function setVars(style, vars) { for (var k in vars) style.setProperty(k, vars[k]); }

    function applyAccent(hex) {
        var r = document.documentElement.style;
        r.setProperty("--accent", hex);
        r.setProperty("--accent-hover", mix(hex, "#FFFFFF", 0.18));
        r.setProperty("--on-accent", onColor(hex));
        setVars(r, hlVars(hex));
    }

    // 给单个组件上的颜色：组件左边一条细色条、主按钮用这个颜色的偏灰版本，不再整块染色
    function paintCell(cell, hex) {
        if (!hex) return;
        cell.style.setProperty("--c", hex);
        cell.style.setProperty("--on-c", onColor(hex));
        setVars(cell.style, hlVars(hex));
        cell.classList.add("tinted");
    }

    // =====================================================================
    // 底部提示栏
    // =====================================================================
    var KEYS = OS === "mac"
        ? { click: "单击", alt: "⌥ 单击", shift: "⇧ 单击", ctrl: "⌘ 单击" }
        : { click: "单击", alt: "Alt+单击", shift: "Shift+单击", ctrl: "Ctrl+单击" };
    var IDLE = '<div class="muted">把鼠标移到按钮上，这里会显示它的用法。点右上角 ✎ 可以自定义布局。</div>';
    var hintEl = $("#hint"), hovered = null, toastTimer = null;

    function hintHTML(h) {
        if (!h) return IDLE;
        var html = '<div class="h-title">' + esc(h.title) + "</div>";
        ["click", "alt", "shift", "ctrl"].forEach(function (k) {
            if (h[k]) html += '<div><span class="k">' + KEYS[k] + "</span> — " + esc(h[k]) + "</div>";
        });
        if (h.note) html += '<div class="muted">' + esc(h.note) + "</div>";
        if (h.na) html += '<div class="na-line">现在不可用：' + esc(h.na) + "（仍然可以点，AE 会再检查一次）</div>";
        return html;
    }
    function showHint(h) {
        hovered = h;
        if (toastTimer) return;
        hintEl.className = "hint";
        hintEl.innerHTML = hintHTML(h);
    }
    var errParts = [], errAt = 0;
    // 几个错误前后脚出现（比如启动时两个文件夹都写不进去）：合成一句显示，不互相覆盖；几处写盘失败只说一次怎么办
    function errText(parts) {
        var disks = parts.filter(function (x) { return x.disk; }), texts = [], files = [], dones = [], byRest = {}, order = [];
        // 「连接后台失败：X」「读取脚本库失败：X」→「连接后台、读取脚本库失败：X」
        parts.forEach(function (x) {
            if (x.disk) return;
            var m = /^(.{1,12}?)失败：([\s\S]+)$/.exec(x.msg), rest = m ? m[2] : x.msg;
            if (!byRest[rest]) { byRest[rest] = []; order.push(rest); }
            if (m && byRest[rest].indexOf(m[1]) === -1) byRest[rest].push(m[1]);
            if (!m) byRest[rest].plain = true;
        });
        order.forEach(function (rest) { var who = byRest[rest]; texts.push(who.length && !who.plain ? who.join("、") + "失败：" + rest : rest); });
        if (disks.length === 1) texts.push(disks[0].msg);
        else if (disks.length > 1) {
            disks.forEach(function (x) {
                var f = x.disk.what + "（" + x.disk.why + "）";
                if (files.indexOf(f) === -1) files.push(f);
                if (x.done && dones.indexOf(x.done) === -1) dones.push(x.done);
            });
            texts.push((dones.length ? dones.join("、") + "，但" : "") + "这些没写进磁盘：" + files.join("；") + "。" + DISK_ADVICE);
        }
        return texts.slice(-3).join("；");
    }
    function toast(r) {
        if (!r || (!r.msg && r.ok)) return r;
        var msg = r.msg;
        if (!r.ok) {
            if (Date.now() - errAt > 4000) { errParts = []; errAt = Date.now(); }
            if (!errParts.some(function (x) { return x.msg === r.msg; })) errParts.push({ msg: r.msg, disk: r.disk, done: r.done });
            msg = errText(errParts);
        } else errParts = [];
        clearTimeout(toastTimer);
        hintEl.className = "hint " + (r.ok ? "ok" : "err");
        hintEl.innerHTML = '<div class="h-msg">' + esc(msg) + "</div>";
        toastTimer = setTimeout(function () { toastTimer = null; if (hoverNode) rehint(); else showHint(hovered); }, r.ok ? 2600 : 4200);
        return r;
    }
    function bindHint(node, h) {
        node.addEventListener("mouseenter", function () { hoverNode = node; hoverRaw = h; if (!editing) showHint(withNa(node, typeof h === "function" ? h() : h)); });
        node.addEventListener("mouseleave", function () { if (hoverNode === node) { hoverNode = null; hoverRaw = null; } showHint(null); });
    }
    // 鼠标停着的按钮和它原始的提示：选区变化后重新算「现在不可用」那一行
    var hoverNode = null, hoverRaw = null;
    function rehint() {
        if (!hoverNode || toastTimer || editing) return;
        if (!hoverNode.isConnected) { hoverNode = null; hoverRaw = null; return; }
        showHint(withNa(hoverNode, typeof hoverRaw === "function" ? hoverRaw() : hoverRaw));
    }
    function withNa(node, h) {
        if (!h || !node.dataset || !node.dataset.na) return h;
        var o = {};
        for (var k in h) o[k] = h[k];
        o.na = node.dataset.na;
        return o;
    }
    function mods(e) { return { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }; }

    // 图标方块
    function tile(o) {
        var b = el("button", "tile" + (o.cls ? " " + o.cls : "") + (o.filled ? " filled" : "") + (o.label && o.left !== false ? " left" : ""));
        b.innerHTML = (o.icon ? svg(o.icon) : "") + (o.label ? '<span class="lbl">' + esc(o.label) + "</span>" : "");
        if (o.tool) b.dataset.tool = o.tool;
        var needs = o.needs !== undefined ? o.needs : (o.run && o.run.needs) || "";
        if (needs) b.dataset.needs = needs;
        if (o.hint) bindHint(b, o.hint);
        b.addEventListener("click", function (e) {
            if (editing) return;
            b.classList.add("flash");
            setTimeout(function () { b.classList.remove("flash"); }, 140);
            var m = mods(e);
            act0(b, function () { return o.run(m); });
        });
        return b;
    }
    // 一次点击：按钮旁出气泡（进行中 / 成功 / 失败），结果同时记在底部提示栏；执行期间忽略重复点击
    function act0(btn, fn) {
        return B.run(btn, fn, { toast: toast }).then(function (r) { refreshCtx(true); return r; });
    }

    function numInput(value, onChange, cls) {
        var n = el("input", "num-in" + (cls ? " " + cls : ""));
        n.type = "text";
        n.value = value;
        n.addEventListener("change", function () { onChange(n); });
        n.addEventListener("keydown", function (e) { e.stopPropagation(); });
        return n;
    }

    // =====================================================================
    // 对话框 / 浮层
    // =====================================================================
    function dialog(title, bodyNodes, buttons) {
        return new Promise(function (resolve) {
            var m = $("#modal"), body = $("#dlg-body"), btns = $("#dlg-btns");
            $("#dlg-title").textContent = title;
            body.innerHTML = "";
            btns.innerHTML = "";
            bodyNodes.forEach(function (n) { body.appendChild(n); });
            function close(v) {
                m.hidden = true;
                document.removeEventListener("keydown", onKey, true);
                resolve(v);
            }
            function onKey(e) {
                if (e.key === "Escape") { e.stopPropagation(); close(null); }
                if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && buttons.length) close(buttons[buttons.length - 1].value());
            }
            buttons.forEach(function (b) {
                var x = el("button", "btn" + (b.accent ? " accent" : ""), esc(b.label));
                x.addEventListener("click", function () { close(b.value()); });
                btns.appendChild(x);
            });
            m.hidden = false;
            m.onclick = function (e) { if (e.target === m) close(null); };
            m.closeWith = close;
            document.addEventListener("keydown", onKey, true);
            var first = body.querySelector("input[type=text], textarea");
            if (first) { first.focus(); if (first.select) first.select(); }
        });
    }
    function ask(title, labelText, def) {
        var lab = el("label", "", esc(labelText));
        var inp = el("input");
        inp.type = "text";
        inp.value = def || "";
        lab.appendChild(inp);
        return dialog(title, [lab], [
            { label: "取消", value: function () { return null; } },
            { label: "确定", accent: true, value: function () { return inp.value.trim() || null; } }
        ]);
    }
    function confirmBox(title, text) {
        return dialog(title, [el("div", "", esc(text))], [
            { label: "取消", value: function () { return false; } },
            { label: "确定", accent: true, value: function () { return true; } }
        ]);
    }

    var pop = $("#pop");
    function showPop(anchor, nodes) {
        pop.innerHTML = "";
        nodes.forEach(function (n) { pop.appendChild(n); });
        pop.hidden = false;
        var r = anchor.getBoundingClientRect();
        var x = Math.min(window.innerWidth - pop.offsetWidth - 6, Math.max(6, r.left - 8));
        var y = r.bottom + 6;
        if (y + pop.offsetHeight > window.innerHeight - 6) y = Math.max(6, r.top - pop.offsetHeight - 6);
        pop.style.left = x + "px";
        pop.style.top = y + "px";
    }
    function hidePop() { pop.hidden = true; }
    document.addEventListener("mousedown", function (e) { if (!pop.hidden && !pop.contains(e.target)) hidePop(); });

    // 色板：返回节点；onPick(hex 或 null)
    function swatches(current, onPick, allowNone) {
        var box = el("div", "swatches");
        if (allowNone) {
            var none = el("button", "sw none" + (!current ? " on" : ""));
            none.title = "默认";
            none.addEventListener("click", function () { onPick(null); });
            box.appendChild(none);
        }
        PALETTE.forEach(function (p) {
            var s = el("button", "sw" + (current && current.toUpperCase() === p[0] ? " on" : ""));
            s.style.background = p[0];
            s.title = p[1] + " " + p[0];
            s.addEventListener("click", function () { onPick(p[0]); });
            box.appendChild(s);
        });
        var c = el("label", "sw custom");
        c.title = "自定义颜色";
        var inp = el("input");
        inp.type = "color";
        inp.value = current || "#FF5900";
        inp.addEventListener("change", function () { onPick(inp.value.toUpperCase()); });
        c.appendChild(inp);
        box.appendChild(c);
        return box;
    }

    // =====================================================================
    // 面板配置（布局 + 主题色），存在 AE 用户数据目录，4 个面板各一份
    // =====================================================================
    // cfgSynced：已经和磁盘上的 panelN.json 对上；cfgBad：磁盘文件损坏（只读不写，保留原文件）；cfgDirty：没对上期间改过
    var cfg = null, saveTimer = null, editing = false, cfgSynced = false, cfgBad = false, cfgDirty = false;

    function uid() { return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function H(en, zh) { return { type: "heading", en: en, zh: zh }; }
    function T(type, extra) { var o = { type: type }; for (var k in extra || {}) o[k] = extra[k]; return o; }

    function S(sid) { return { type: "snippet", sid: sid }; }
    var EXPR_SNIPPETS = [S("builtin:wiggle"), S("builtin:loop"), S("builtin:bounce"), S("builtin:clearExpr")];

    // 3.7：差异化的功能放前面；只是复刻 AE 原生快捷键的小工具不再默认放上来（组件库「更多」和 ⌘K 里都有）
    var PRESETS = {
        main: {
            name: "主面板", items: [
                H("PRECOMP · COMP", "预合成 · 合成"), T("decompose"), T("dupPrecomp"), T("dupComp"), T("colors"),
                H("STYLE · EFFECTS", "样式 · 效果"), T("style"), T("effects"),
                H("KEYFRAME", "曲线 · 关键帧"), T("graph"), T("keys"), T("ease"),
                H("ANIMATE", "快速动画 · 时间排列"), T("quick"), T("arrange"),
                H("BEAT", "音乐节拍"), T("beat"),
                H("WIREFRAME", "线框叠加"), T("wire"),
                H("CREATE", "新建图层"), T("create"), T("studio"),
                H("ANCHOR · ALIGN", "锚点 · 对齐"), T("anchor"), T("centerComp"), T("precomp"),
                T("alignLeft"), T("alignHCenter"), T("alignRight"), T("alignTop"), T("alignVCenter"), T("alignBottom"), T("distH"), T("distV"),
                H("LAYER", "图层"), T("smartRename"), T("reverseLayers"), T("rename"),
                H("EXPRESSION", "表达式 · 先选属性")
            ].concat(EXPR_SNIPPETS, [H("MY SCRIPTS", "我的脚本")])
        },
        animate: {
            name: "动画", items: [
                H("CURVE", "自定义缓动"), T("graph"), T("ease"),
                H("KEYS", "关键帧"), T("keys"),
                H("ANIMATE", "快速动画 · 时间排列"), T("quick"), T("arrange"),
                H("BEAT", "音乐节拍"), T("beat"),
                H("WIREFRAME", "线框叠加"), T("wire"),
                H("EXPRESSION", "表达式")
            ].concat(EXPR_SNIPPETS)
        },
        organize: {
            name: "整理", items: [
                H("PRECOMP · COMP", "预合成 · 合成"), T("decompose"), T("dupPrecomp"), T("dupComp"), T("colors"),
                H("STYLE · EFFECTS", "样式 · 效果"), T("style"), T("effects"),
                H("CREATE", "新建图层"), T("create"),
                H("ANCHOR", "锚点"), T("anchor"), T("centerComp"), T("precomp"),
                H("ALIGN", "对齐"), T("alignLeft"), T("alignHCenter"), T("alignRight"), T("alignTop"), T("alignVCenter"), T("alignBottom"), T("distH"), T("distV"),
                H("LAYER", "图层"), T("smartRename"), T("reverseLayers"), T("rename")
            ]
        },
        scripts: { name: "我的脚本", items: [H("MY SCRIPTS", "我的脚本"), H("SNIPPETS", "代码片段")] },
        blank: { name: "", items: [H("WORKSPACE", "我的面板")] }
    };

    // =====================================================================
    // 配置迁移：schema 1（3.6 及以前）→ 2（3.7）
    // 被合并的按钮换成对应的组件（面板里已经有就去重），表达式按钮换成内置片段；用户的颜色和参数一起带过去
    // =====================================================================
    var SCHEMA = 2;
    var MERGE_TO = {
        easeBoth: "ease", linear: "ease", hold: "ease", cloneKeys: "keys", reverseKeys: "keys",
        adjust: "create", solid: "create", camera: "create", textLayer: "create", shapeLayer: "create", light: "create", nullLayer: "create",
        seq: "arrange", chain: "arrange"
    };
    var TO_SNIPPET = { wiggle: "builtin:wiggle", loop: "builtin:loop", bounce: "builtin:bounce", clearExpr: "builtin:clearExpr" };
    var OLD_NAMES = {
        easeBoth: "缓入缓出", linear: "线性", hold: "定格", cloneKeys: "克隆关键帧", reverseKeys: "反转关键帧",
        adjust: "调整图层", solid: "纯色层", camera: "摄像机", textLayer: "文字图层", shapeLayer: "形状图层", light: "灯光", nullLayer: "空对象",
        seq: "依次排列", chain: "首尾相接", wiggle: "抖动", loop: "循环", bounce: "弹性", clearExpr: "清除表达式", beatSeq: "按节拍排列"
    };
    var NEW_PLACES = {
        ease: "「缓动」组件", keys: "「关键帧工具」组件", create: "「新建图层」组件（空对象的 ⌥ 设为父级也在这里）",
        arrange: "「时间排列」组件（错开 / 首尾相接 / 跟节拍）", snippet: "内置表达式片段（修饰键用法不变，脚本库 → 代码片段里可以隐藏）"
    };

    function migrateConfig(c) {
        var moves = [];
        if ((c.schema || 1) >= SCHEMA) return moves;
        var src = c.items, out = [], have = {}, sids = {}, i;
        // 面板里原本就有的组件 / 片段：被合并的按钮直接去重
        for (i = 0; i < src.length; i++) {
            if (!MERGE_TO[src[i].type]) have[src[i].type] = true;
            if (src[i].type === "snippet") sids[src[i].sid] = true;
        }
        // 被合并 / 被去重的按钮带着的参数：迁移完补到目标组件上（目标自己已有的参数不覆盖）
        var carry = {};
        function keep(k, v) { if (v !== undefined && carry[k] === undefined) carry[k] = v; }
        for (i = 0; i < src.length; i++) {
            if (src[i].type === "seq") { keep("num", src[i].num); keep("step", src[i].step); }
            if (src[i].type === "chain") keep("gap", src[i].gap);
            if (src[i].type === "beat") keep("every", src[i].every);
        }
        for (i = 0; i < src.length; i++) {
            var it = src[i], t = it.type, target = MERGE_TO[t], sid = TO_SNIPPET[t];
            if (target) {
                moves.push({ from: t, to: target });
                if (have[target]) continue;
                var n = { id: it.id, type: target };
                if (it.color) n.color = it.color;
                if (target === "arrange") {
                    n.mode = t === "chain" ? "chain" : "stagger";
                    if (it.num) n.num = it.num;
                    if (it.step !== undefined) n.step = it.step;
                }
                have[target] = true;
                out.push(n);
            } else if (sid) {
                moves.push({ from: t, to: "snippet" });
                if (sids[sid]) continue;
                var sn = { id: it.id, type: "snippet", sid: sid };
                if (it.color) sn.color = it.color;
                sids[sid] = true;
                out.push(sn);
            } else out.push(it);
        }
        // 节拍组件里的「按节拍排列」搬到了时间排列：有节拍组件却没有时间排列的面板，紧跟着补一个
        if (have.beat && !have.arrange) {
            for (i = 0; i < out.length; i++) if (out[i].type === "beat") {
                out.splice(i + 1, 0, { id: uid(), type: "arrange", mode: "beat", every: out[i].every || 1 });
                break;
            }
            moves.push({ from: "beatSeq", to: "arrange" });
        } else if (have.beat) moves.push({ from: "beatSeq", to: "arrange" });
        for (i = 0; i < out.length; i++) if (out[i].type === "arrange") {
            for (var ck in carry) if (out[i][ck] === undefined) out[i][ck] = carry[ck];
            break;
        }
        // 原来有内容、迁移后变空的分组标题一起去掉（用户自己建的空分组不动）
        var hadContent = {}, cur = null;
        for (i = 0; i < src.length; i++) {
            if (src[i].type === "heading") cur = src[i].id;
            else if (cur) hadContent[cur] = true;
        }
        var cleaned = [];
        for (i = 0; i < out.length; i++) {
            if (out[i].type === "heading" && hadContent[out[i].id]) {
                var j = i + 1;
                while (j < out.length && out[j].type !== "heading") j++;
                if (j === i + 1) continue;
            }
            cleaned.push(out[i]);
        }
        c.items = cleaned;
        c.schema = SCHEMA;
        return moves;
    }

    // 迁移后说明一次：哪些按钮搬到了哪里
    var migrationNotice = null;
    function showMigrationNotice() {
        if (!migrationNotice || !migrationNotice.length) return;
        var byTo = {}, order = [];
        migrationNotice.forEach(function (m) {
            if (!byTo[m.to]) { byTo[m.to] = []; order.push(m.to); }
            if (byTo[m.to].indexOf(OLD_NAMES[m.from]) === -1) byTo[m.to].push(OLD_NAMES[m.from]);
        });
        var ul = el("ul", "mig-list");
        order.forEach(function (to) {
            ul.appendChild(el("li", "", "<b>" + esc(byTo[to].join(" / ")) + "</b> → " + esc(NEW_PLACES[to])));
        });
        migrationNotice = null;
        local.set("migNotice" + PANEL, SCHEMA);
        dialog("(3.7) — 按钮搬家了", [
            el("p", "", "为了少一些重复的入口，下面这些按钮合并进了对应的组件。你的布局、颜色和设置都保留了，面板上没有出现空格子。"),
            ul,
            el("p", "muted", "「在播放头拆分」「剪到工作区」「移到播放头」「运动模糊」不再默认放在新面板上；已经放上去的保持不变，组件库「更多」和 ⌘K 里都能找到。")
        ], [{ label: "知道了", accent: true, value: function () { return true; } }]);
    }

    var PANEL_PRESET = { 1: "main", 2: "animate", 3: "organize", 4: "scripts" };

    function fromPreset(key) {
        var p = PRESETS[key];
        return {
            schema: SCHEMA,
            name: p.name || ("面板 " + PANEL),
            accent: "#FF5900",
            items: p.items.map(function (it) { var o = JSON.parse(JSON.stringify(it)); o.id = uid(); return o; })
        };
    }

    // 本机缓存里记一笔「最新的布局还没写进磁盘」：下次启动以本机缓存为准，再写回磁盘
    var cfgRetry = 0, cfgRetryTimer = null, cfgWarned = false;
    function cfgUnsaved(v) { local.set("cfgDirty" + PANEL, v); }
    function saveConfig() {
        // 本机缓存和「还没写进磁盘」的标记立刻写（同步）：改完马上关面板、退出 AE 也不丢；写磁盘才等 0.25 秒合并连续的改动
        local.set("panel" + PANEL, cfg);
        cfgUnsaved(true);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            saveTimer = null;
            var text = JSON.stringify(cfg);
            if (!cfgSynced) { cfgDirty = true; return; }   // 没连上磁盘时的改动，恢复连接后推到磁盘
            writeConfigText("panel" + PANEL, text).then(function (r) {
                if (r && r.ok) { cfgRetry = 0; cfgWarned = false; clearTimeout(cfgRetryTimer); cfgUnsaved(false); return; }
                cfgUnsaved(true);
                if (B.disk.ok()) {
                    // 有 Node 时还写不进去，多半是暂时的（文件正被别的程序占用、磁盘满了）：提示一次，过一会儿自动重试
                    if (!cfgWarned) { cfgWarned = true; toast(diskFail("面板布局", (r && r.msg) || "没有返回")); }
                    clearTimeout(cfgRetryTimer);
                    cfgRetryTimer = setTimeout(saveConfig, [1000, 2000, 5000, 10000][cfgRetry] || 30000);
                    cfgRetry++;
                    return;
                }
                cfgSynced = false; cfgDirty = true;   // 没有 Node：改成「离线改动」，权限打开或重新连上后再写
            });
        }, 250);
    }

    function loadConfig() {
        return readConfigText("panel" + PANEL).then(function (r) {
            var c = null, bad = false, fromLocal = false;
            try { if (r.ok && r.data && !blank(r.data.text)) c = JSON.parse(r.data.text); } catch (e) { bad = true; }
            // 布局文件坏了（写到一半断电等）：挪到旁边留着，用这台电脑缓存里的布局重新写好，并说一声
            if (bad && B.disk.ok()) {
                var moved = B.disk.moveAside(B.disk.configPath("panel" + PANEL), "bad-" + timeStamp());
                if (moved) { bad = false; c = null; toast({ ok: false, msg: "面板布局文件损坏：已改名为「" + moved.replace(/^.*[\\\/]/, "") + "」留在原处，现在用这台电脑缓存里的布局并重新写好" }); }
            }
            cfgSynced = r.ok && !bad;
            cfgBad = bad;
            var lc = local.get("panel" + PANEL, null), backup = null;
            // 上次的改动没写进磁盘：本机缓存比磁盘上的新，以它为准
            if (cfgSynced && lc && lc.items && local.get("cfgDirty" + PANEL, false)) c = lc;
            // 这个 AE 版本第一次用 3.7.1，本机缓存里的布局和磁盘上的不一样（多半是另一个 AE 版本改过同一个面板）：
            // 用磁盘上的，这里原来的另存一份备份，设置页「载入预设」里可以换回来
            else if (cfgSynced && c && c.items && lc && lc.items && !local.get("cfgOnDisk" + PANEL, false) && layoutKey(lc) !== layoutKey(c)) backup = lc;
            if (cfgSynced) local.set("cfgOnDisk" + PANEL, true);
            if (!c) c = lc;
            fromLocal = !!(c && c === lc && c.items);
            if (!c || !c.items) {
                c = fromPreset(PANEL_PRESET[PANEL] || "blank");
                // 旧版「我的脚本」里固定过的脚本，搬到第一个面板
                if (PANEL === 1) local.get("pins", []).forEach(function (k) { c.items.push({ id: uid(), type: "script", key: k }); });
            }
            c.items.forEach(function (it) { if (!it.id) it.id = uid(); });
            var moves = migrateConfig(c);
            cfg = c;
            if (moves.length && local.get("migNotice" + PANEL, 0) < SCHEMA) migrationNotice = moves;
            // 迁移改过布局，或者布局只存在本机缓存里（老版本没开写入权限时就是这样）：现在写进磁盘
            if (moves.length || (cfgSynced && fromLocal)) saveConfig();
            // 要备份的布局先单独存一份（以后的保存不会碰它），写进备份文件以后才删；写不进去下次打开面板、拿到焦点时再试
            if (backup) local.set("cfgPendingBackup" + PANEL, backup);
            flushPendingBackup();
        });
    }
    function timeStamp() {
        var d = new Date(), two = function (n) { return (n < 10 ? "0" : "") + n; };
        return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + "-" + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
    }
    var pendWarned = false;
    function flushPendingBackup() {
        var pend = local.get("cfgPendingBackup" + PANEL, null);
        if (!pend || !pend.items) return Promise.resolve();
        return backupLayout(pend).then(function (b) {
            if (!b.ok) {
                if (!pendWarned) { pendWarned = true; toast({ ok: false, msg: "这个 AE 版本里原来的面板布局还没备份上（" + b.msg + "）：先单独留在这台电脑的缓存里，下次打开面板会再试；检查 MotionHub 文件夹是否可写" }); }
                return;
            }
            local.set("cfgPendingBackup" + PANEL, null);
            local.set("cfgBackupNotice" + PANEL, b.name);
            showBackupNotice();
        });
    }
    // 面板关掉（或 AE 退出）时还有没写出去的布局：用 Node 同步写掉（Node 的写是同步的，来得及）
    window.addEventListener("beforeunload", function () {
        if (!saveTimer || !cfgSynced || !B.disk.ok()) return;
        clearTimeout(saveTimer); saveTimer = null;
        var w = B.disk.writeText(B.disk.configPath("panel" + PANEL), JSON.stringify(cfg));
        if (w.ok) cfgUnsaved(false);
    });
    function layoutKey(x) { return JSON.stringify({ name: x.name, accent: x.accent, items: x.items }); }
    // 把一份布局写成备份文件 panelN-backup-<时间>.json，记进「载入预设」的备份列表。返回 { ok, msg, name }
    var backupSeq = 0;
    function backupLayout(x) {
        var stamp = timeStamp(), name = "panel" + PANEL + "-backup-" + stamp + (backupSeq++ ? "-" + backupSeq : "");
        return writeConfigText(name, JSON.stringify(x)).then(function (r) {
            if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || "没有返回" };
            var list = local.get("cfgBackups" + PANEL, []) || [];
            list.unshift({ name: name, label: (x.name || "面板") + " · " + x.items.length + " 个组件 · " + stamp.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2}).*/, "$1-$2-$3 $4:$5") });
            local.set("cfgBackups" + PANEL, list.slice(0, 8));
            return { ok: true, name: name };
        }, function (e) { return { ok: false, msg: (e && e.message) || String(e) }; });
    }
    // 第一次启动时备份过这个 AE 版本原来的布局：启动完弹一次说明（提示栏里的一句话很容易错过）
    function showBackupNotice() {
        var name = local.get("cfgBackupNotice" + PANEL, null);
        if (!name) return;
        if (!$("#modal").hidden) { setTimeout(showBackupNotice, 600); return; }
        local.set("cfgBackupNotice" + PANEL, null);
        dialog("(3.7.1) — 布局有备份", [
            el("p", "", "这个 AE 版本里原来的面板布局，和磁盘上的不一样（多半是另一个 AE 版本改过这个面板）。现在用的是磁盘上的那份。"),
            el("p", "muted", "原来的已经备份。以后也可以在「设置 → 载入预设」里选「备份」换回去。")
        ], [
            { label: "保留现在的", value: function () { return false; } },
            { label: "换回原来的", accent: true, value: function () { return true; } }
        ]).then(function (back) { if (back) restoreBackup(name); });
    }
    // 别的面板合并片段时把重复的默认片段换成了磁盘上那份：备份里的布局也按同样的对应改，换回来时按钮不会变成「已删除」
    function applySnippetRemap(layout) {
        var map = local.get("snipRemap", {}) || {};
        layout.items.forEach(function (it) { if (it.type === "snippet" && Object.prototype.hasOwnProperty.call(map, it.sid)) it.sid = map[it.sid]; });
    }
    // 换成一份备份的布局：先把当前布局另存一份备份，备份写不进去就不换
    function restoreBackup(name) {
        return readConfigText(name).then(function (r) {
            var b = null;
            try { if (r && r.ok && r.data && r.data.text) b = JSON.parse(r.data.text); } catch (e) {}
            if (!b || !b.items) return { ok: false, msg: "没读到这份备份（" + ((r && r.msg) || "文件不在了或已损坏") + "）：换一份备份再试" };
            return backupLayout(cfg).then(function (bk) {
                if (!bk.ok) return { ok: false, msg: "没有换：当前布局的备份没写进去（" + bk.msg + "）。检查 MotionHub 文件夹是否可写后再试" };
                b.items.forEach(function (it) { if (!it.id) it.id = uid(); });
                applySnippetRemap(b);
                migrateConfig(b);
                cfg = b;
                applyAccent(cfg.accent || "#FF5900"); $("#panel-name").textContent = cfg.name;
                saveConfig(); renderLayout(); renderSettings(); selectTab("panel");
                return { ok: true, msg: "已换回备份的布局，刚才的布局也另存了一份备份" };
            });
        }).then(function (res) { B.show(null, res.ok ? "ok" : "err", res.msg); toast(res); return res; });
    }

    function findItem(id) { for (var i = 0; i < cfg.items.length; i++) if (cfg.items[i].id === id) return i; return -1; }

    function addItem(obj) {
        obj.id = uid();
        cfg.items.push(obj);
        saveConfig();
        renderLayout();
    }

    // =====================================================================
    // 组件注册表
    // =====================================================================
    var W = {};
    var CATS = ["智能组件", "新建", "锚点 · 对齐", "关键帧", "图层", "表达式", "合成 · 颜色", "结构"];

    function reg(type, def) { W[type] = def; }

    // 单个工具方块：size [宽, 高]，宽 > 1 时显示文字
    function toolType(type, o) {
        reg(type, {
            name: o.name, cat: o.cat, icon: o.icon, desc: o.hint.click, size: [o.w || 1, 1], run: o.run, hint: o.hint, more: !!o.more,
            render: function (cell, item) {
                cell.appendChild(tile({
                    icon: o.icon, label: (o.w || 1) > 1 ? o.name : "", filled: !!item.color,
                    hint: o.hint, run: o.run, tool: type, needs: o.needs
                }));
            }
        });
    }

    // 每个后台工具需要什么选区（和 host.jsx 里的检查一致）。修饰键会放宽条件的工具按最宽松的写，宁可少变暗也不误判
    var NEEDS = {
        anchor: "layer", centerComp: "layer", nullLayer: "comp", addLayer: "comp", align: "layer", distribute: "layers3",
        sequence: "layers2", trim: "layer", precompEach: "layer", reverse: "layers2", rename: "layer",
        ease: "keys", cloneKeys: "keys", copyKeys: "keys", pasteKeys: "layer", keyTime: "keys", bezier: "keys", bezierRead: "keys",
        quickAnim: "layer", splitLayer: "layer", toPlayhead: "layer", motionBlur: "layer",
        beatMarkers: "comp", clearMarkers: "comp", beatLayers: "layer", audioInfo: "layer",
        decompose: "precomp", dupPrecomp: "precomp", smartRename: "comp", chain: "layers2",
        styleCopy: "layer", stylePaste: "layer", applyEffect: "comp", wireframe: "comp", wireClear: "comp", wireStyle: "comp",
        applyExpr: "props", wiggle: "props", loop: "props", bounce: "props", clearExpr: "layer",
        dupComp: "compOrProj", collectColors: "layer"
    };
    var NEED_TEXT = {
        comp: "先打开一个合成", layer: "先选中图层", layers2: "先选中至少 2 个图层", layers3: "先选中至少 3 个图层",
        keys: "先选中关键帧", props: "先在时间轴选中属性（如位置、旋转）", precomp: "先选中预合成图层",
        compOrProj: "先打开合成，或在项目面板选中合成"
    };

    function need(n, fn) { fn.needs = n || ""; return fn; }
    function call(name, extra) {
        var fn = function (m) {
            var a = { mods: m };
            for (var k in extra || {}) a[k] = extra[k];
            return host(name, a);
        };
        fn.needs = NEEDS[name] || "";
        return fn;
    }

    // —— 结构：章节标题 ——
    reg("heading", {
        name: "章节标题", cat: "结构", icon: "heading", desc: "(01) — NAME 样式的分组标题，自动编号", size: "full", editable: true,
        render: function (cell, item) {
            cell.classList.add("heading");
            var n = ("0" + item._n).slice(-2);
            cell.innerHTML = '<span class="num">(' + n + ") — " + esc(item.en || "SECTION") + '</span><span class="zh">' + esc(item.zh || "") + "</span>";
        },
        edit: function (item) {
            var a = el("label", "", "英文标题（大写等宽）");
            var i1 = el("input"); i1.type = "text"; i1.value = item.en || ""; a.appendChild(i1);
            var b = el("label", "", "中文说明");
            var i2 = el("input"); i2.type = "text"; i2.value = item.zh || ""; b.appendChild(i2);
            return dialog("(✎) — HEADING", [a, b], [
                { label: "取消", value: function () { return null; } },
                { label: "确定", accent: true, value: function () { return { en: i1.value.trim().toUpperCase(), zh: i2.value.trim() }; } }
            ]).then(function (v) { if (v) { item.en = v.en; item.zh = v.zh; } return v; });
        }
    });

    // —— 锚点九宫格 ——
    reg("anchor", {
        name: "锚点九宫格", cat: "锚点 · 对齐", icon: "anchor11", desc: "一键把锚点放到图层的 9 个位置", size: [3, 3],
        render: function (cell) {
            var g = el("div", "anchor-grid");
            var pos = [["左上", "上中", "右上"], ["左中", "中心", "右中"], ["左下", "下中", "右下"]];
            for (var y = 0; y < 3; y++) {
                for (var x = 0; x < 3; x++) {
                    (function (fx, fy, name, ix, iy) {
                        g.appendChild(tile({
                            icon: "anchor" + ix + iy,
                            hint: { title: "锚点 · " + name, click: "锚点移到" + name + "，画面不动", alt: "再把图层贴到合成的" + name, note: "有遮罩按遮罩范围；选中遮罩只看选中的" },
                            run: call("anchor", { fx: fx, fy: fy })
                        }));
                    })(x / 2, y / 2, pos[y][x], x, y);
                }
            }
            cell.appendChild(g);
        }
    });

    toolType("centerComp", { name: "居中到合成", cat: "锚点 · 对齐", icon: "center", w: 3, hint: { title: "居中到合成", click: "锚点放到中心，再移到合成中心", alt: "不改锚点，按外框居中", note: "有遮罩按遮罩范围；带父级的也能居中" }, run: call("centerComp") });
    toolType("precomp", { name: "逐个预合成", cat: "图层", icon: "precomp", w: 3, hint: { title: "逐个预合成", click: "每个选中图层各自预合成，保留属性" }, run: call("precompEach") });

    [["alignLeft", "left", "左对齐"], ["alignHCenter", "hcenter", "水平居中"], ["alignRight", "right", "右对齐"],
     ["alignTop", "top", "顶部对齐"], ["alignVCenter", "vcenter", "垂直居中"], ["alignBottom", "bottom", "底部对齐"]].forEach(function (d) {
        toolType(d[0], { name: d[2], cat: "锚点 · 对齐", icon: d[0], hint: { title: d[2], click: d[2] + "到合成", alt: "到选区（整体外框）", shift: "到最上面的选中图层", note: "按看得见的部分：有遮罩按遮罩，带父级的也算" }, run: call("align", { mode: d[1] }) });
    });
    toolType("distH", { name: "水平分布", cat: "锚点 · 对齐", icon: "distH", hint: { title: "水平分布", click: "按中心等距，两头不动", alt: "按间距均分：空隙一样大", note: "至少 3 个图层；有遮罩按遮罩范围" }, run: call("distribute", { horizontal: true }) });
    toolType("distV", { name: "垂直分布", cat: "锚点 · 对齐", icon: "distV", hint: { title: "垂直分布", click: "按中心等距，两头不动", alt: "按间距均分：空隙一样大", note: "至少 3 个图层；有遮罩按遮罩范围" }, run: call("distribute", { horizontal: false }) });

    toolType("trim", { more: true, name: "剪到工作区", cat: "图层", icon: "trim", hint: { title: "剪到工作区", click: "把选中图层的入点和出点剪到工作区", alt: "只把入点剪到播放头" }, run: call("trim") });
    toolType("split", { more: true, name: "在播放头拆分", cat: "图层", icon: "split", hint: { title: "在播放头拆分", click: "把选中图层在播放头位置拆成两段" }, run: call("splitLayer") });
    toolType("toPlayhead", { more: true, name: "移到播放头", cat: "图层", icon: "toPlayhead", hint: { title: "移到播放头", click: "把选中图层的入点对齐到播放头", alt: "把出点对齐到播放头" }, run: call("toPlayhead") });
    toolType("reverseLayers", { name: "反转顺序", cat: "图层", icon: "reverse", hint: { title: "反转图层顺序", click: "反转选中图层的上下顺序" }, run: call("reverse") });
    toolType("motionBlur", { more: true, name: "运动模糊", cat: "图层", icon: "motionBlur", hint: { title: "运动模糊", click: "开 / 关选中图层的运动模糊（同时打开合成开关）" }, run: call("motionBlur") });
    toolType("rename", {
        name: "批量重命名", cat: "图层", icon: "rename", needs: "layer", hint: { title: "批量重命名", click: "输入名称后，按 名称_01、名称_02 … 重命名" },
        run: function () {
            return ask("(R) — RENAME", "新名称（会自动加编号）", "Layer").then(function (base) { return base ? host("rename", { base: base }) : null; });
        }
    });



    toolType("dupComp", { name: "复制合成", cat: "合成 · 颜色", icon: "dupComp", hint: { title: "复制合成并更新表达式", click: "复制选中合成，并把表达式里对原合成名的引用改成新名字", alt: "复制后直接打开新合成" }, run: call("dupComp") });
    // 新建图层（单个按钮版，也可以用整行的「新建图层」组件）
    var CREATE = [
        ["text", "textLayer", "文字"], ["shape", "shapeLayer", "形状"], ["solid", "solid", "纯色"], ["adjust", "adjust", "调整图层"],
        ["null", "nullLayer", "空对象"], ["camera", "camera", "摄像机"], ["light", "light", "灯光"]
    ];

    toolType("decompose", { name: "解散预合成", cat: "图层", icon: "decompose", hint: { title: "解散预合成", click: "把预合成里的图层放回当前合成，画面位置保持不变", alt: "同时删除项目里不再使用的原合成", note: "预合成图层自己有变换时，会用一个空对象接住它" }, run: call("decompose") });
    toolType("dupPrecomp", { name: "复制预合成（独立）", cat: "图层", icon: "dupPrecomp", hint: { title: "复制预合成（独立副本）", click: "复制图层，并换成一份独立的合成副本，改副本不会影响原来的", alt: "连里面嵌套的预合成也一起独立复制", shift: "不新建图层，直接把当前图层换成独立副本" }, run: call("dupPrecomp") });
    toolType("smartRename", { name: "智能重命名", cat: "图层", icon: "smartRename", hint: { title: "智能重命名", click: "按图层内容自动起名：文字用文字内容，素材用文件名，调整层用第一个效果名", alt: "重命名合成里的全部图层", shift: "名字前加上类型，例如 [文字] 标题" }, run: call("smartRename") });

    toolType("studio", {
        name: "打开 Studio", cat: "新建", icon: "widgets", w: 3,
        hint: { title: "MotionHub Studio · 剪辑排版", click: "打开剪辑排版窗口：多视频拼图、社交媒体尺寸、调色、导出 GIF / MP4" },
        run: function () {
            if (CEP && CEP.requestOpenExtension) {
                CEP.requestOpenExtension("com.windwings.motionhub.studio", "");
                return { ok: true, msg: "已打开 Studio：在单独的窗口里，没看到就从「窗口 → 扩展 → MotionHub Studio」切过去" };
            }
            return { ok: false, msg: "打不开 Studio：从「窗口 → 扩展 → MotionHub Studio · 剪辑排版」打开" };
        }
    });

    toolType("colors", { name: "收集颜色", cat: "合成 · 颜色", icon: "colors", hint: { title: "收集颜色", click: "收集选中图层（含图层样式）里不重复的颜色，放进「颜色控制器」并自动关联", alt: "只收集，不关联" }, run: call("collectColors") });

    // —— 智能组件：缓动 ——
    function widgetBox(cell, head, right) {
        var w = el("div", "widget");
        w.appendChild(el("div", "w-head", esc(head) + (right !== undefined ? '<span class="r">' + esc(right) + "</span>" : "")));
        cell.appendChild(w);
        return w;
    }
    function row(parent) { var r = el("div", "w-row"); parent.appendChild(r); return r; }

    // onCommit：松开滑块或改完数字时调用（拿到这一行做气泡的位置）
    function sliderRow(parent, label, item, key, def, hint, onCommit) {
        var r = row(parent);
        r.appendChild(el("span", "k", label));
        var range = el("input");
        range.type = "range"; range.min = 1; range.max = 100;
        range.value = item[key] || def;
        var num = numInput(range.value, function (n) {
            var v = Math.max(1, Math.min(100, parseFloat(n.value) || def));
            n.value = v; range.value = v; item[key] = v; saveConfig();
            if (onCommit) onCommit(r);
        });
        range.addEventListener("input", function () { num.value = range.value; item[key] = +range.value; });
        range.addEventListener("change", function () { saveConfig(); if (onCommit) onCommit(r); });
        r.appendChild(range);
        r.appendChild(num);
        bindHint(r, hint);
    }

    reg("ease", {
        name: "缓动", cat: "智能组件", icon: "easeBoth", desc: "IN / OUT 影响滑块 + 缓动、线性、定格", size: "full",
        render: function (cell, item) {
            var w = widgetBox(cell, "EASE · 缓动", "影响 %");
            var args = function (mode, m) { return { mode: mode, inInfl: item.inInfl || 33, outInfl: item.outInfl || 33, mods: m }; };
            // 拖动滑块松手（或改完数字）就直接应用到选中的关键帧，一次松手一步撤销；没选关键帧时只记下数值，不打扰。
            // 连续拖的时候上一次还没做完：做完后按最新的数值再应用一次
            var running = false, again = false;
            var live = function (anchor) {
                if (running) { again = true; return; }
                running = true;
                B.run(anchor, function () {
                    return host("easeIfKeys", args("both", {})).then(function (r) {
                        if (r && r.ok && r.data && !r.data.applied) return null;
                        if (r && r.ok) bumpUsage("ease");
                        return r;
                    });
                }, { toast: toast }).then(function () {
                    running = false;
                    if (again) { again = false; live(anchor); }
                });
            };
            var h = { title: "缓动影响 %", click: "拖动后松手，直接应用到选中的关键帧（没选关键帧时只记下数值）", note: "IN 控制进入关键帧，OUT 控制离开关键帧；数值越大曲线越陡，AE 默认 33" };
            sliderRow(w, "IN", item, "inInfl", 33, h, live);
            sliderRow(w, "OUT", item, "outInfl", 33, h, live);
            var r = row(w);
            r.appendChild(tile({ icon: "easeBoth", label: "缓入缓出", left: false, cls: "grow", filled: true, hint: { title: "缓入缓出", click: "按上面的影响值应用到选中的关键帧（相当于 F9）", alt: "只缓入", shift: "只缓出", note: "调滑块时松手就会直接应用，这个按钮用来给新选中的关键帧套用同样的数值" }, needs: NEEDS.ease, run: function (m) { return host("ease", args("both", m)); } }));
            r.appendChild(tile({ icon: "linear", hint: { title: "线性", click: "把选中关键帧设为线性" }, needs: NEEDS.ease, run: function (m) { return host("ease", args("linear", m)); } }));
            r.appendChild(tile({ icon: "hold", hint: { title: "定格", click: "把选中关键帧设为定格" }, needs: NEEDS.ease, run: function (m) { return host("ease", args("hold", m)); } }));
        }
    });

    // —— 智能组件：自定义缓动曲线 ——
    // 用户自己保存的曲线，存在共享配置 curves.json 里
    var userCurves = [];
    var curveStore = sharedList({
        tag: "curves", what: "曲线预设",
        file: function () { return B.disk.ok() ? B.disk.configPath("curves") : ""; },
        hostRead: function () { return readConfigText("curves"); },
        hostWrite: function (t) { return writeConfigText("curves", t); },
        parse: function (t) { return JSON.parse(t); }, dump: function (l) { return JSON.stringify(l); },
        key: function (c) { return JSON.stringify(c); },   // 名字 + 数值：同名不同曲线两个都留
        get: function () { return userCurves; }, set: function (l) { userCurves = l; },
        localGet: function () { return local.get("curves", null); }, localSet: function (l) { local.set("curves", l); },
        changed: renderSoon
    });
    function loadCurves() { return curveStore.load(); }

    var BEZ_PRESETS = [
        ["平滑", [0.45, 0, 0.55, 1]], ["三次", [0.65, 0, 0.35, 1]], ["五次", [0.83, 0, 0.17, 1]], ["指数", [0.87, 0, 0.13, 1]],
        ["缓出", [0.22, 1, 0.36, 1]], ["缓入", [0.64, 0, 0.78, 0]], ["回弹", [0.34, 1.56, 0.64, 1]], ["预备", [0.36, 0, 0.66, -0.56]]
    ];

    reg("graph", {
        name: "缓动曲线", cat: "智能组件", icon: "graph", desc: "拖动手柄编辑贝塞尔曲线，一键应用到关键帧", size: "full",
        render: function (cell, item) {
            var b = item.bz || [0.65, 0, 0.35, 1];
            var w = widgetBox(cell, "CURVE · 缓动曲线", "");
            var wrap = el("div", "graph-wrap");
            var NS = "http://www.w3.org/2000/svg";
            var g = document.createElementNS(NS, "svg");
            g.setAttribute("viewBox", "0 0 116 116");
            g.setAttribute("class", "graph");
            var P = 18, S = 80;
            var X = function (v) { return P + v * S; }, Y = function (v) { return P + S - v * S; };
            function line(cls, x1, y1, x2, y2) {
                var l = document.createElementNS(NS, "line");
                l.setAttribute("class", cls);
                l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
                g.appendChild(l);
                return l;
            }
            for (var i = 0; i <= 4; i++) { line("g-line", X(i / 4), Y(0), X(i / 4), Y(1)); line("g-line", X(0), Y(i / 4), X(1), Y(i / 4)); }
            var arm1 = line("g-arm", 0, 0, 0, 0), arm2 = line("g-arm", 0, 0, 0, 0);
            var curve = document.createElementNS(NS, "path");
            curve.setAttribute("class", "g-curve");
            g.appendChild(curve);
            function handle() { var c = document.createElementNS(NS, "circle"); c.setAttribute("class", "g-h"); c.setAttribute("r", 5); g.appendChild(c); return c; }
            var h1 = handle(), h2 = handle();
            var val = w.querySelector(".w-head .r") || el("span");
            val.classList.add("bz-val");
            var presetBox = el("div", "presets");

            function draw() {
                curve.setAttribute("d", "M" + X(0) + " " + Y(0) + " C" + X(b[0]) + " " + Y(b[1]) + " " + X(b[2]) + " " + Y(b[3]) + " " + X(1) + " " + Y(1));
                h1.setAttribute("cx", X(b[0])); h1.setAttribute("cy", Y(b[1]));
                h2.setAttribute("cx", X(b[2])); h2.setAttribute("cy", Y(b[3]));
                arm1.setAttribute("x1", X(0)); arm1.setAttribute("y1", Y(0)); arm1.setAttribute("x2", X(b[0])); arm1.setAttribute("y2", Y(b[1]));
                arm2.setAttribute("x1", X(1)); arm2.setAttribute("y1", Y(1)); arm2.setAttribute("x2", X(b[2])); arm2.setAttribute("y2", Y(b[3]));
                val.textContent = "(" + b.map(function (v) { return Math.round(v * 100) / 100; }).join(", ") + ")";
                $$(".preset", presetBox).forEach(function (p) { p.classList.toggle("on", p.dataset.bz === b.join()); });
            }
            function drag(idx) {
                return function (e) {
                    if (editing) return;
                    e.preventDefault();
                    var rect = g.getBoundingClientRect(), k = 116 / rect.width;
                    function move(ev) {
                        var x = ((ev.clientX - rect.left) * k - P) / S, y = (P + S - (ev.clientY - rect.top) * k) / S;
                        b[idx] = Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
                        b[idx + 1] = Math.round(Math.max(-0.2, Math.min(1.2, y)) * 100) / 100;
                        draw();
                    }
                    function up() {
                        window.removeEventListener("mousemove", move, true);
                        window.removeEventListener("mouseup", up, true);
                        item.bz = b.slice(); saveConfig();
                    }
                    window.addEventListener("mousemove", move, true);
                    window.addEventListener("mouseup", up, true);
                };
            }
            h1.addEventListener("mousedown", drag(0));
            h2.addEventListener("mousedown", drag(2));
            BEZ_PRESETS.concat(userCurves).forEach(function (p, i) {
                var mine = i >= BEZ_PRESETS.length;
                var btn = el("button", "preset" + (mine ? " mine" : ""), esc(p[0]));
                btn.dataset.bz = p[1].join();
                bindHint(btn, { title: (mine ? "我的预设 · " : "预设 · ") + p[0], click: "cubic-bezier(" + p[1].join(", ") + ")", alt: mine ? "删除这个预设" : "" });
                btn.addEventListener("click", function (e) {
                    if (editing) return;
                    if (mine && e.altKey) {
                        var k = JSON.stringify(p), at = -1;
                        userCurves.forEach(function (c, j) { if (at === -1 && JSON.stringify(c) === k) at = j; });
                        if (at !== -1) userCurves.splice(at, 1);
                        renderLayout();
                        curveStore.change({ op: "del", key: k, prev: p }).then(function (w) {
                            toast(w && w.ok === false ? { ok: false, msg: "已删除预设「" + p[0] + "」，但" + w.msg } : { ok: true, msg: "已删除预设「" + p[0] + "」" });
                        });
                        return;
                    }
                    b = p[1].slice(); item.bz = b.slice(); draw(); saveConfig();
                });
                presetBox.appendChild(btn);
            });
            wrap.appendChild(g);
            wrap.appendChild(presetBox);
            w.appendChild(wrap);
            var r = row(w);
            r.appendChild(tile({
                icon: "read", needs: "keys", hint: { title: "从关键帧读取", click: "选中两个关键帧，把它们之间的速度曲线读成 cubic-bezier" },
                run: function () {
                    return host("bezierRead").then(function (x) {
                        if (x.ok) { b = x.data.bezier; item.bz = b.slice(); draw(); saveConfig(); }
                        return x;
                    });
                }
            }));
            r.appendChild(tile({
                icon: "save", hint: { title: "保存为预设", click: "把当前曲线存成自己的预设（所有面板共用）", note: "⌥ 单击自己的预设可以删除它" },
                run: function () {
                    return ask("(+) — SAVE CURVE", "预设名称", "我的曲线 " + (userCurves.length + 1)).then(function (name) {
                        if (!name) return null;
                        var entry = [name, b.slice()];
                        userCurves.push(entry);
                        renderLayout();
                        return curveStore.change({ op: "put", item: entry }).then(function (w) {
                            return w && w.ok === false ? { ok: false, msg: "已保存预设「" + name + "」，但" + w.msg } : { ok: true, msg: "已保存预设「" + name + "」" };
                        });
                    });
                }
            }));
            r.appendChild(tile({
                icon: "play", label: "应用", left: false, cls: "grow", filled: true,
                hint: { title: "应用曲线", click: "把曲线应用到选中的关键帧（每两个相邻关键帧之间算一段）", alt: "镜像应用（进出对调）", note: "只选一个关键帧时，应用到它和下一个关键帧之间" },
                needs: NEEDS.bezier, run: function (m) { return host("bezier", { bezier: b, mods: m }); }
            }));
            bindHint(g, { title: "缓动曲线", click: "拖动两个手柄调整曲线，横轴是时间，纵轴是数值", note: "纵向可以拖出 0–1 以外，做回弹和预备动作" });
            draw();
        }
    });

    // —— 智能组件：关键帧 ——
    var clipCount = local.get("clipCount", 0);

    reg("keys", {
        name: "关键帧工具", cat: "智能组件", icon: "copyKeys", desc: "复制粘贴、克隆、反转、均分、拉伸、微移", size: "full",
        render: function (cell, item) {
            var w = widgetBox(cell, "KEYS · 关键帧");
            var r1 = row(w);
            var counter = el("div", "counter", "<b>" + clipCount + "</b>个已复制");
            counter.style.flex = "1";
            r1.appendChild(counter);
            r1.appendChild(tile({
                icon: "copyKeys", needs: "keys", hint: { title: "复制关键帧", click: "复制选中的关键帧（可以跨多个属性）" },
                run: function (m) {
                    return host("copyKeys", { mods: m }).then(function (r) {
                        if (r.ok && r.data) { clipCount = r.data.count; local.set("clipCount", clipCount); counter.innerHTML = "<b>" + clipCount + "</b>个已复制"; }
                        return r;
                    });
                }
            }));
            r1.appendChild(tile({ icon: "pasteKeys", filled: true, hint: { title: "粘贴关键帧", click: "粘贴到播放头位置：选了属性就粘到属性上，只选图层就粘到同名属性", alt: "反向粘贴", shift: "粘贴后选中新关键帧" }, run: call("pasteKeys") }));
            r1.appendChild(tile({ icon: "cloneKeys", hint: { title: "克隆关键帧", click: "从播放头克隆选中关键帧", alt: "克隆后选中新关键帧", shift: "反向克隆" }, run: call("cloneKeys") }));

            var r2 = row(w);
            r2.appendChild(tile({ icon: "reverseKeys", hint: { title: "反转关键帧", click: "把选中关键帧的时间顺序倒过来" }, run: call("keyTime", { op: "reverse" }) }));
            r2.appendChild(tile({ icon: "distributeKeys", hint: { title: "均分关键帧", click: "让选中关键帧在首尾之间等间距分布（至少 3 个）" }, run: call("keyTime", { op: "distribute" }) }));
            r2.appendChild(el("span", "sp"));
            var factor = numInput(item.factor || 1.5, function (n) { item.factor = Math.max(0.05, parseFloat(n.value) || 1.5); n.value = item.factor; saveConfig(); });
            bindHint(factor, { title: "拉伸倍数", click: "拉伸 / 压缩关键帧时用的倍数" });
            r2.appendChild(el("span", "unit", "×"));
            r2.appendChild(factor);
            r2.appendChild(tile({ icon: "stretchKeys", hint: { title: "拉伸关键帧", click: "以第一个选中关键帧为起点，按倍数拉长间隔", alt: "按倍数压缩" }, needs: NEEDS.keyTime, run: function (m) { return host("keyTime", { op: "stretch", factor: item.factor || 1.5, mods: m }); } }));

            var r3 = row(w);
            var frames = numInput(item.frames || 1, function (n) { item.frames = Math.max(1, parseInt(n.value, 10) || 1); n.value = item.frames; saveConfig(); });
            var nudge = function (dir) { return need(NEEDS.keyTime, function (m) { return host("keyTime", { op: "nudge", dir: dir, frames: item.frames || 1, mods: m }); }); };
            r3.appendChild(tile({ icon: "nudgeLeft", hint: { title: "左移关键帧", click: "选中关键帧向前移动 N 帧", shift: "移动 10 倍" }, run: nudge(-1) }));
            r3.appendChild(frames);
            r3.appendChild(el("span", "unit", "帧"));
            r3.appendChild(tile({ icon: "nudgeRight", hint: { title: "右移关键帧", click: "选中关键帧向后移动 N 帧", shift: "移动 10 倍" }, run: nudge(1) }));
            bindHint(frames, { title: "微移帧数", click: "左移 / 右移关键帧时每次移动的帧数" });
        }
    });

    // —— 智能组件：快速动画 ——
    var QUICK = [["fade", "透明度", "fade"], ["scale", "缩放", "scaleIn"], ["slide", "滑动", "slide"], ["rotate", "旋转", "rotateIn"], ["blur", "模糊", "blurIn"]];
    var DIRS = [["left", "arrowLeft", "从左"], ["up", "arrowUp", "从上"], ["down", "arrowDown", "从下"], ["right", "arrowRight", "从右"]];

    reg("quick", {
        name: "快速动画", cat: "智能组件", icon: "scaleIn", desc: "淡入、缩放弹出、滑入、旋转、模糊的入场 / 出场", size: "full",
        render: function (cell, item) {
            var kind = item.kind || "fade", dir = item.dir || "left";
            var w = widgetBox(cell, "ANIMATE · 快速动画", "自动加缓动");
            var chips = el("div", "chips");
            QUICK.forEach(function (q) {
                var c = el("button", "chip" + (q[0] === kind ? " on" : ""), svg(q[2]) + esc(q[1]));
                c.addEventListener("click", function () {
                    if (editing) return;
                    item.kind = q[0]; saveConfig();
                    $$(".chip", chips).forEach(function (x) { x.classList.remove("on"); });
                    c.classList.add("on");
                    dirRow.style.display = q[0] === "slide" ? "" : "none";
                });
                chips.appendChild(c);
            });
            w.appendChild(chips);
            var dirRow = row(w);
            dirRow.appendChild(el("span", "k", "方向"));
            DIRS.forEach(function (d) {
                var t = tile({
                    icon: d[1], filled: d[0] === dir, hint: { title: "滑动方向 · " + d[2], click: "入场时" + d[2] + "滑入，出场时向这个方向滑出" },
                    run: function () {
                        item.dir = d[0]; saveConfig();
                        $$(".tile", dirRow).forEach(function (x) { x.classList.remove("filled"); });
                        t.classList.add("filled");
                        return null;
                    }
                });
                dirRow.appendChild(t);
            });
            dirRow.style.display = kind === "slide" ? "" : "none";
            var r = row(w);
            var frames = numInput(item.frames || 12, function (n) { item.frames = Math.max(1, parseInt(n.value, 10) || 12); n.value = item.frames; saveConfig(); });
            bindHint(frames, { title: "动画时长", click: "入场 / 出场动画的帧数" });
            r.appendChild(frames);
            r.appendChild(el("span", "unit", "帧"));
            var run = function (out) {
                return need(NEEDS.quickAnim, function () { return host("quickAnim", { kind: item.kind || "fade", dir: item.dir || "left", frames: item.frames || 12, mods: { alt: out } }); });
            };
            r.appendChild(tile({ icon: "arrowRight", label: "入场", left: false, cls: "grow", filled: true, hint: { title: "入场动画", click: "从播放头开始，给选中图层做入场动画" }, run: run(false) }));
            r.appendChild(tile({ icon: "arrowLeft", label: "出场", left: false, cls: "grow", hint: { title: "出场动画", click: "在播放头结束，给选中图层做出场动画" }, run: run(true) }));
        }
    });

    // —— 智能组件：依次排列 Num / Step ——
    // —— 智能组件：时间排列（错开 / 首尾相接 / 跟节拍）——
    var ARRANGE_MODES = [["stagger", "错开"], ["chain", "首尾相接"], ["beat", "跟节拍"]];
    reg("arrange", {
        name: "时间排列", cat: "智能组件", icon: "seqForward", desc: "错开（Num / Step、四种顺序）、首尾相接、跟着音乐节拍排列图层", size: "full",
        render: function (cell, item) {
            var mode = item.mode || "stagger";
            var w = widgetBox(cell, "ARRANGE · 时间排列");
            var chips = el("div", "chips");
            ARRANGE_MODES.forEach(function (md) {
                var c = el("button", "chip" + (md[0] === mode ? " on" : ""), esc(md[1]));
                c.addEventListener("click", function () { if (editing) return; item.mode = md[0]; saveConfig(); renderLayout(); });
                bindHint(c, { title: "排列方式 · " + md[1], click: md[0] === "stagger" ? "每组 Num 个图层，组与组之间错开 Step 帧" : md[0] === "chain" ? "一个接一个排开，前一个的出点就是后一个的入点" : "用「音乐节拍」组件分析出的节拍，每隔 N 拍放一个图层" });
                chips.appendChild(c);
            });
            w.appendChild(chips);
            if (mode === "stagger") {
                var r1 = row(w);
                r1.appendChild(el("span", "unit", "NUM"));
                var num = numInput(item.num || 1, function (n) { item.num = Math.max(1, parseInt(n.value, 10) || 1); n.value = item.num; saveConfig(); });
                r1.appendChild(num);
                r1.appendChild(el("span", "unit", "STEP"));
                var step = numInput(item.step === undefined ? 2 : item.step, function (n) { item.step = Math.max(0, parseInt(n.value, 10) || 0); n.value = item.step; saveConfig(); });
                r1.appendChild(step);
                r1.appendChild(el("span", "unit", "帧"));
                bindHint(num, { title: "Num", click: "每组几个图层同时出现" });
                bindHint(step, { title: "Step", click: "组与组之间错开的帧数" });
                var r2 = row(w);
                [["forward", "seqForward", "正序"], ["reverse", "seqReverse", "倒序"], ["center", "seqCenter", "从中间向两边"], ["random", "seqRandom", "随机"], ["position", "seqPosition", "画面位置"]].forEach(function (o, i) {
                    var t = tile({
                        icon: o[1], filled: i === 0, tool: "sequence",
                        hint: o[0] === "position"
                            ? { title: "错开 · 按画面位置", click: "铺得宽从左到右，铺得高从上到下", alt: "反过来", note: "按看得见的部分的中心，和选择顺序无关" }
                            : { title: "错开 · " + o[2], click: "按" + o[2] + "错开选中图层", note: "顺序以你选择图层的先后为准" },
                        needs: NEEDS.sequence, run: function (m) { return host("sequence", { order: o[0], num: item.num || 1, step: item.step === undefined ? 2 : item.step, mods: m }); }
                    });
                    t.classList.add("grow");
                    r2.appendChild(t);
                });
            } else if (mode === "chain") {
                var rc = row(w);
                rc.appendChild(el("span", "unit", "间隔"));
                var gap = numInput(item.gap || 0, function (n) { item.gap = Math.max(0, parseInt(n.value, 10) || 0); n.value = item.gap; saveConfig(); });
                bindHint(gap, { title: "间隔", click: "相邻两个图层之间空出几帧，0 表示紧挨着" });
                rc.appendChild(gap);
                rc.appendChild(el("span", "unit", "帧"));
                rc.appendChild(tile({
                    icon: "chain", label: "首尾相接", left: false, cls: "grow", filled: true, tool: "chain",
                    hint: { title: "首尾相接", click: "按选择顺序把图层一个接一个排开", alt: "从播放头开始排", shift: "倒序" },
                    needs: NEEDS.chain, run: function (m) { return host("chain", { gap: item.gap || 0, mods: m }); }
                }));
            } else {
                var rb = row(w);
                if (!beat.info) {
                    rb.appendChild(tile({
                        icon: "beat", label: "先在「音乐节拍」里载入音频", left: false, cls: "grow", tool: "beatArrangeHint",
                        hint: { title: "跟节拍", click: "这个模式用「音乐节拍」组件分析出的节拍。先在那里选中音频图层并载入", note: "面板里没有「音乐节拍」组件时，从组件库添加" },
                        run: function () {
                            var beatCell = null;
                            $$(".cell", layoutEl).forEach(function (c) { if (!beatCell && /BEAT · 音乐节拍/.test(c.textContent)) beatCell = c; });
                            if (beatCell) { beatCell.scrollIntoView({ block: "center" }); beatCell.classList.add("flash-cell"); setTimeout(function () { beatCell.classList.remove("flash-cell"); }, 900); }
                            return { ok: false, msg: beatCell ? "先在「音乐节拍」组件里选中音频图层，点「载入」" : "先从组件库添加「音乐节拍」组件并载入音频，再回来按节拍排列" };
                        }
                    }));
                } else {
                    rb.appendChild(el("span", "unit", "每"));
                    var every = numInput(item.every || 1, function (n) { item.every = Math.max(1, parseInt(n.value, 10) || 1); n.value = item.every; saveConfig(); });
                    bindHint(every, { title: "每几拍", click: "每个图层占几拍" });
                    rb.appendChild(every);
                    rb.appendChild(el("span", "unit", "拍"));
                    rb.appendChild(tile({
                        icon: "seqForward", label: "按节拍排列", left: false, cls: "grow", filled: true, tool: "beatLayers",
                        hint: { title: "按节拍排列 · " + beat.info.name, click: "按选择顺序，从播放头后的第一拍开始，每隔 N 拍放一个图层", alt: "同时把每个图层的出点剪到下一个位置（卡点剪辑）" },
                        needs: NEEDS.beatLayers, run: function (m) { return host("beatLayers", { index: beat.info.index, times: beat.times.map(fileToComp), mode: "sequence", every: item.every || 1, mods: m }); }
                    }));
                }
            }
        }
    });

    // —— 智能组件：新建图层 ——
    reg("create", {
        name: "新建图层", cat: "新建", icon: "textLayer", desc: "文字、形状、纯色、调整、空对象、摄像机、灯光一键新建", size: "full",
        render: function (cell) {
            var r = el("div", "w-row create-row");
            CREATE.forEach(function (c) {
                var t = c[0] === "null"
                    ? tile({ icon: c[1], tool: "nullLayer", hint: { title: "新建空对象", click: "在选中图层上方新建", alt: "放到选中图层中心并设为父级", note: "原来有同一个父级时，空对象接在它下面" }, run: call("nullLayer") })
                    : tile({ icon: c[1], tool: "addLayer:" + c[0], hint: { title: "新建" + c[2], click: "在选中图层上方新建" + c[2] }, run: call("addLayer", { kind: c[0] }) });
                t.classList.add("grow");
                r.appendChild(t);
            });
            cell.appendChild(r);
        }
    });

    // —— 智能组件：音乐节拍 ——
    // 读取音频 → 低通滤波后算能量包络 → 能量上升的峰值 = 节拍；只分析图层在时间轴上可见的那一段
    var beat = { info: null, wave: null, onset: null, rate: 0, buffer: null, times: [], bpm: 0, player: null };

    function readAudio(path) {
        if (typeof require === "function") {
            var b = require("fs").readFileSync(path);
            return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        }
        return fetch("file://" + path).then(function (r) { return r.arrayBuffer(); });
    }

    function decode(buf) {
        var ac = new (window.AudioContext || window.webkitAudioContext)();
        return ac.decodeAudioData(buf).then(function (b) { if (ac.close) ac.close(); return b; });
    }

    function analyze(buffer) {
        var sr = buffer.sampleRate, oc = new OfflineAudioContext(1, buffer.length, sr);
        var src = oc.createBufferSource(), lp = oc.createBiquadFilter();
        src.buffer = buffer;
        lp.type = "lowpass";
        lp.frequency.value = 160;
        src.connect(lp);
        lp.connect(oc.destination);
        src.start();
        return oc.startRendering().then(function (low) {
            var d = low.getChannelData(0), hop = Math.round(sr / 100), n = Math.floor(d.length / hop);
            var energy = new Float32Array(n), onset = new Float32Array(n), i, j;
            for (i = 0; i < n; i++) {
                var sum = 0;
                for (j = i * hop; j < Math.min(d.length, (i + 2) * hop); j++) sum += d[j] * d[j];
                energy[i] = Math.sqrt(sum / (2 * hop));
            }
            for (i = 1; i < n; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
            // 画波形用：原始声音的峰值
            var raw = buffer.getChannelData(0), buckets = 800, step = Math.max(1, Math.floor(raw.length / buckets)), wave = new Float32Array(buckets);
            for (i = 0; i < buckets; i++) {
                var m = 0;
                for (j = i * step; j < Math.min(raw.length, (i + 1) * step); j += 4) m = Math.max(m, Math.abs(raw[j]));
                wave[i] = m;
            }
            return { onset: onset, rate: sr / hop, wave: wave, duration: buffer.duration };
        });
    }

    // 自适应阈值：局部均值 + 灵敏度 × 局部标准差，再加最小间隔
    function pickBeats(onset, rate, sens, minGap, t0, t1) {
        var out = [], half = Math.round(rate * 0.4), last = -1e9, n = onset.length;
        var a0 = Math.max(2, Math.floor(t0 * rate)), a1 = Math.min(n - 3, Math.ceil(t1 * rate));
        for (var f = a0; f <= a1; f++) {
            var v = onset[f];
            if (!(v > onset[f - 1] && v >= onset[f + 1] && v >= onset[f - 2] && v >= onset[f + 2])) continue;
            var lo = Math.max(0, f - half), hi = Math.min(n, f + half), m = 0, m2 = 0;
            for (var i = lo; i < hi; i++) { m += onset[i]; m2 += onset[i] * onset[i]; }
            m /= (hi - lo);
            var sd = Math.sqrt(Math.max(0, m2 / (hi - lo) - m * m));
            var t = f / rate;
            if (v > m + sens * sd && v > 0.002 && t - last >= minGap) { out.push(t); last = t; }
        }
        return out;
    }

    function bpmOf(times) {
        if (times.length < 3) return 0;
        var iv = [];
        for (var i = 1; i < times.length; i++) iv.push(times[i] - times[i - 1]);
        iv.sort(function (x, y) { return x - y; });
        var bpm = 60 / iv[Math.floor(iv.length / 2)];
        while (bpm < 70) bpm *= 2;
        while (bpm > 180) bpm /= 2;
        return Math.round(bpm);
    }

    // 素材时间 ↔ 合成时间
    function fileToComp(t) { return beat.info.startTime + t * beat.info.stretch / 100; }
    function visibleRange() {
        var k = beat.info.stretch / 100 || 1;
        return [Math.max(0, (beat.info.inPoint - beat.info.startTime) / k), Math.min(beat.buffer.duration, (beat.info.outPoint - beat.info.startTime) / k)];
    }

    reg("beat", {
        name: "音乐节拍", cat: "智能组件", icon: "beat", desc: "分析音频节拍：加标记、把图层吸附到节拍（按节拍排列在「时间排列」组件里）", size: "full",
        render: function (cell, item) {
            var w = widgetBox(cell, "BEAT · 音乐节拍", beat.times.length ? beat.times.length + " 拍" + (beat.bpm ? " · " + beat.bpm + " BPM" : "") : "");
            if (!beat.info) {
                var r0 = row(w);
                var load = tile({
                    icon: "beat", label: "载入选中的音频图层", left: false, cls: "grow", filled: true, needs: "layer",
                    hint: { title: "载入音频", click: "先在时间轴选中一个音频（或带声音的视频）图层，再点这里", note: "视频里的声音会先由 AE 渲染成临时 WAV，第一次会慢一点" },
                    run: function () { return loadBeat(item); }
                });
                r0.appendChild(load);
                return;
            }
            var cv = el("canvas", "wave");
            w.appendChild(cv);
            requestAnimationFrame(function () { drawWave(cv); });
            cv.addEventListener("click", function (e) {
                if (editing) return;
                var r = cv.getBoundingClientRect(), vr = visibleRange();
                playFrom(vr[0] + (e.clientX - r.left) / r.width * (vr[1] - vr[0]), cv);
            });
            bindHint(cv, { title: beat.info.name, click: "点波形从这个位置试听，再点一次停止", note: "橙色竖线是检测到的节拍，只分析图层可见的那一段" });

            var r1 = row(w);
            r1.appendChild(el("span", "k", "灵敏"));
            var sens = el("input");
            sens.type = "range"; sens.min = 0.3; sens.max = 3; sens.step = 0.1; sens.value = item.sens || 1.4;
            sens.title = "越往左节拍越多";
            r1.appendChild(sens);
            r1.appendChild(el("span", "unit", "间隔"));
            var gap = numInput(item.gap || 6, function (n) { item.gap = Math.max(1, parseInt(n.value, 10) || 6); n.value = item.gap; saveConfig(); redetect(item); renderLayout(); });
            r1.appendChild(gap);
            r1.appendChild(el("span", "unit", "帧"));
            sens.addEventListener("change", function () { item.sens = +sens.value; saveConfig(); redetect(item); renderLayout(); });
            bindHint(r1, { title: "检测设置", click: "灵敏度越低（往左）节拍越多；间隔是两个节拍之间最少隔几帧" });

            var r2 = row(w);
            var times = function () { return beat.times.map(fileToComp); };
            r2.appendChild(tile({ icon: "marker", filled: true, hint: { title: "节拍标记", click: "在音频图层上加节拍标记", alt: "加到合成标记上", shift: "标记带编号" }, needs: NEEDS.beatMarkers, run: function (m) { return host("beatMarkers", { index: beat.info.index, times: times(), target: m.alt ? "comp" : "layer", numbered: m.shift }); } }));
            r2.appendChild(tile({ icon: "trash", hint: { title: "清除标记", click: "清除音频图层上的全部标记", alt: "清除合成上的全部标记" }, needs: NEEDS.clearMarkers, run: function (m) { return host("clearMarkers", { index: beat.info.index, target: m.alt ? "comp" : "layer" }); } }));
            r2.appendChild(tile({ icon: "snap", hint: { title: "吸附到节拍", click: "把选中图层的入点吸附到最近的节拍" }, needs: NEEDS.beatLayers, run: function (m) { return host("beatLayers", { index: beat.info.index, times: times(), mode: "snap", mods: m }); } }));
            r2.appendChild(el("span", "sp"));
            r2.appendChild(tile({ icon: "close", hint: { title: "卸载音频", click: "换用另一个音频图层" }, run: function () { stopPlay(); beat.info = null; beat.times = []; renderLayout(); return null; } }));
        }
    });

    function redetect(item) {
        if (!beat.onset) return;
        var vr = visibleRange(), fps = beat.info.fps || 25;
        beat.times = pickBeats(beat.onset, beat.rate, item.sens || 1.4, (item.gap || 6) / fps, vr[0], vr[1]);
        beat.bpm = bpmOf(beat.times);
    }

    function loadBeat(item) {
        return host("audioInfo").then(function (r) {
            if (!r.ok) return r;
            var info = r.data;
            toast({ ok: true, msg: "正在分析「" + info.name + "」…" });
            var get = function (path) { return readAudio(path).then(decode); };
            var p = info.isVideo
                ? host("extractAudio", { index: info.index }).then(function (x) { if (!x.ok) throw new Error(x.msg); return get(x.data.path); })
                : get(info.path).catch(function () {
                    return host("extractAudio", { index: info.index }).then(function (x) { if (!x.ok) throw new Error(x.msg); return get(x.data.path); });
                });
            return p.then(function (buffer) {
                beat.buffer = buffer;
                beat.info = info;
                return analyze(buffer);
            }).then(function (a) {
                beat.onset = a.onset; beat.rate = a.rate; beat.wave = a.wave;
                redetect(item);
                renderLayout();
                return { ok: true, msg: "检测到 " + beat.times.length + " 个节拍" + (beat.bpm ? "，约 " + beat.bpm + " BPM" : "") + (info.timeRemap ? "（图层开了时间重映射，节拍位置可能不准）" : "") };
            }).catch(function (e) {
                return { ok: false, msg: "读取音频失败：" + (e && e.message ? e.message : e) };
            });
        });
    }

    function drawWave(cv) {
        var dpr = window.devicePixelRatio || 1, W2 = cv.clientWidth, H2 = cv.clientHeight;
        if (!W2) return;
        cv.width = W2 * dpr; cv.height = H2 * dpr;
        var g = cv.getContext("2d");
        g.scale(dpr, dpr);
        var css = getComputedStyle(cv);
        var accent = css.getPropertyValue("--c").trim() || "#FF5900";
        var vr = visibleRange(), dur = beat.buffer.duration, wave = beat.wave, mid = H2 / 2;
        g.fillStyle = "rgba(244,244,242,.32)";
        for (var x = 0; x < W2; x++) {
            var t = vr[0] + x / W2 * (vr[1] - vr[0]);
            var a = wave[Math.min(wave.length - 1, Math.floor(t / dur * wave.length))] || 0;
            var h = Math.max(1, a * (H2 - 6));
            g.fillRect(x, mid - h / 2, 1, h);
        }
        g.fillStyle = accent;
        beat.times.forEach(function (t) { g.fillRect(Math.round((t - vr[0]) / (vr[1] - vr[0]) * W2), 0, 1.5, H2); });
        if (beat.player && beat.player.cv === cv) {
            var pt = beat.player.from + (beat.player.ac.currentTime - beat.player.at);
            g.fillStyle = "#F4F4F2";
            g.fillRect(Math.round((pt - vr[0]) / (vr[1] - vr[0]) * W2), 0, 1, H2);
        }
    }

    function stopPlay() {
        if (beat.player) { try { beat.player.src.stop(); beat.player.ac.close(); } catch (e) {} beat.player = null; }
    }

    function playFrom(t, cv) {
        if (beat.player) { stopPlay(); drawWave(cv); return; }
        var ac = new (window.AudioContext || window.webkitAudioContext)(), src = ac.createBufferSource();
        src.buffer = beat.buffer;
        src.connect(ac.destination);
        var end = visibleRange()[1];
        src.start(0, t, Math.max(0.05, end - t));
        beat.player = { ac: ac, src: src, at: ac.currentTime, from: t, cv: cv };
        src.onended = function () { if (beat.player && beat.player.src === src) { stopPlay(); drawWave(cv); } };
        (function tick() { if (beat.player && beat.player.cv === cv) { drawWave(cv); requestAnimationFrame(tick); } })();
    }

    // —— 智能组件：样式复制 / 粘贴 ——
    var styleInfo = local.get("styleInfo", null);

    function toggleChip(parent, label, item, key, def, hint) {
        var on = item[key] === undefined ? def : item[key];
        var c = el("button", "chip" + (on ? " on" : ""), esc(label));
        c.addEventListener("click", function () {
            if (editing) return;
            item[key] = !(item[key] === undefined ? def : item[key]);
            c.classList.toggle("on", item[key]);
            saveConfig();
        });
        if (hint) bindHint(c, hint);
        parent.appendChild(c);
        return c;
    }

    reg("style", {
        name: "样式复制", cat: "智能组件", icon: "styleCopy", desc: "复制一个图层的效果、关键帧、变换，粘贴到其他图层", size: "full",
        render: function (cell, item) {
            var w = widgetBox(cell, "STYLE · 样式", styleInfo ? "已复制：" + styleInfo.layer : "未复制");
            var chips = el("div", "chips");
            toggleChip(chips, "效果", item, "fx", true, { title: "粘贴效果", click: "把效果连同参数一起粘贴" });
            toggleChip(chips, "关键帧", item, "keys", true, { title: "粘贴关键帧", click: "效果上的关键帧和速度曲线一起带过去" });
            toggleChip(chips, "适配长度", item, "fit", true, { title: "适配长度", click: "开：关键帧按每个图层的长短等比例拉伸；关：保持原来的时间" });
            toggleChip(chips, "变换", item, "tr", false, { title: "粘贴变换", click: "缩放和旋转" });
            toggleChip(chips, "混合", item, "blend", false, { title: "粘贴混合", click: "混合模式、不透明度、运动模糊" });
            toggleChip(chips, "替换效果", item, "replace", false, { title: "替换已有效果", click: "粘贴前先删掉目标图层原有的效果" });
            w.appendChild(chips);
            var r = row(w);
            r.appendChild(tile({
                icon: "styleCopy", label: "复制", left: false, cls: "grow", needs: "layer",
                hint: { title: "复制样式", click: "复制选中图层（第一个）的效果、关键帧、变换和混合模式" },
                run: function () {
                    return host("styleCopy").then(function (x) {
                        if (x.ok) { styleInfo = { layer: x.data.layer, effects: x.data.effects, keys: x.data.keys }; local.set("styleInfo", styleInfo); renderLayout(); }
                        return x;
                    });
                }
            }));
            r.appendChild(tile({
                icon: "stylePaste", label: "粘贴到选中图层", left: false, cls: "grow", filled: true, needs: "layer",
                hint: { title: "粘贴样式", click: "按上面勾选的内容粘贴到所有选中图层" },
                run: function () {
                    var on = function (k, d) { return item[k] === undefined ? d : item[k]; };
                    return host("stylePaste", { effects: on("fx", true), keys: on("keys", true), fit: on("fit", true), transform: on("tr", false), blend: on("blend", false), replace: on("replace", false) });
                }
            }));
        }
    });

    // —— 智能组件：线框叠加（图层边界、锚点、运动轨迹、摄像机信息，渲染出来也看得到）——
    var WIRE_OPTS = [
        ["bounds", "边界框", true, "每个图层的外框，3D 图层会跟着摄像机透视"],
        ["anchor", "锚点", true, "锚点位置的十字"],
        ["path", "运动轨迹", true, "锚点在整个时间里走过的路线（虚线）"],
        ["grow", "轨迹随时间生长", false, "轨迹只画到当前时间，像拖尾一样边走边画"],
        ["labels", "图层名", true, "在边界框左上角标出图层名"],
        ["grid", "3D 地面网格", true, "合成里有 3D 图层或摄像机时，加一张跟着摄像机透视的地面网格，摄像机一动就看得出来"],
        ["hud", "摄像机信息", false, "左上角显示时间码、摄像机位置和缩放"],
        ["safe", "安全框", false, "动作安全框、字幕安全框和中心十字"]
    ];

    reg("wire", {
        name: "线框叠加", cat: "智能组件", icon: "widgets", desc: "把图层边界、锚点、运动轨迹、摄像机信息做成真实图层，渲染出来也看得到", size: "full",
        render: function (cell, item) {
            var w = widgetBox(cell, "WIREFRAME · 线框叠加", "渲染可见");
            var chips = el("div", "chips");
            WIRE_OPTS.forEach(function (o) { toggleChip(chips, o[1], item, "w_" + o[0], o[2], { title: o[1], click: o[3] }); });
            w.appendChild(chips);
            var r = row(w);
            var opts = function () {
                var out = {};
                WIRE_OPTS.forEach(function (o) { out[o[0]] = item["w_" + o[0]] === undefined ? o[2] : item["w_" + o[0]]; });
                return out;
            };
            r.appendChild(tile({
                icon: "widgets", label: "生成线框", left: false, cls: "grow", filled: true,
                hint: { title: "生成线框", click: "给选中图层生成线框图层", alt: "给合成里所有显示中的图层生成", note: "颜色、线宽、不透明度在「MH 线框控制」空对象的效果控件里调，所有线框一起变" },
                needs: NEEDS.wireframe, run: function (m) { return host("wireframe", { opts: opts(), mods: m }); }
            }));
            r.appendChild(tile({
                icon: "colors", needs: "comp", hint: { title: "线框颜色", click: "换成品牌色板里的颜色" },
                run: function () {
                    var anchor = cell.querySelector(".w-row:last-child .tile:nth-child(2)");
                    showPop(anchor || cell, [el("div", "p-title", "线框颜色"), swatches(null, function (hex) {
                        hidePop();
                        var c = rgb(hex).map(function (v) { return v / 255; });
                        act0(anchor || cell, function () { return host("wireStyle", { color: [c[0], c[1], c[2], 1] }); });
                    }, false)]);
                    return null;
                }
            }));
            r.appendChild(tile({ icon: "trash", hint: { title: "清除线框", click: "删除这个合成里所有 MotionHub 生成的线框图层" }, run: call("wireClear") }));
        }
    });

    // —— 智能组件：效果收藏 ——
    var DEFAULT_FAVS = [
        ["ADBE Gaussian Blur 2", "高斯模糊"], ["ADBE Glo2", "发光"], ["ADBE Drop Shadow", "投影"], ["ADBE Fill", "填充"],
        ["ADBE CurvesCustom", "曲线"], ["ADBE HUE SATURATION", "色相/饱和度"], ["ADBE Turbulent Displace", "湍流置换"], ["ADBE Motion Blur", "定向模糊"]
    ];
    var allEffects = null;

    reg("effects", {
        name: "效果收藏", cat: "智能组件", icon: "fx", desc: "常用效果一键添加，Alt 加在新的调整图层上", size: "full",
        render: function (cell, item) {
            var favs = item.favs || DEFAULT_FAVS;
            var w = widgetBox(cell, "EFFECTS · 效果收藏", "⌥ 加到调整层");
            var chips = el("div", "chips");
            favs.forEach(function (f) {
                var c = el("button", "chip", svg("fx") + esc(f[1]));
                c.dataset.needs = NEEDS.applyEffect;
                bindHint(c, { title: f[1], click: "添加到选中图层", alt: "新建调整图层并添加" });
                c.addEventListener("click", function (e) { if (editing) return; var m = mods(e); act0(c, function () { return host("applyEffect", { match: f[0], name: f[1], mods: m }); }); });
                chips.appendChild(c);
            });
            var add = el("button", "chip", svg("pencil") + "管理");
            bindHint(add, { title: "管理收藏", click: "从已安装的全部效果里挑选收藏" });
            add.addEventListener("click", function () { if (!editing) act0(add, function () { return manageFavs(item); }); });
            chips.appendChild(add);
            w.appendChild(chips);
        }
    });

    function manageFavs(item) {
        var favs = (item.favs || DEFAULT_FAVS).slice();
        var loadErr = null;
        var load = allEffects ? Promise.resolve(allEffects) : host("listEffects").then(function (r) {
            if (!r.ok) { loadErr = r.msg; return []; }
            allEffects = r.data.effects;
            return allEffects;
        });
        return load.then(function (list) {
            var q = el("input");
            q.type = "text";
            q.placeholder = "搜索效果名称…";
            q.addEventListener("keydown", function (e) { e.stopPropagation(); });
            var box = el("div", "cat-list fav-list");
            function isFav(m) { return favs.some(function (f) { return f[0] === m; }); }
            function draw() {
                box.innerHTML = "";
                var key = q.value.trim().toLowerCase();
                var shown = (list.length ? list : DEFAULT_FAVS.map(function (f) { return { match: f[0], name: f[1], cat: "" }; })).filter(function (e) {
                    return !key || (e.name + " " + e.cat + " " + e.match).toLowerCase().indexOf(key) !== -1;
                }).slice(0, 80);
                shown.forEach(function (e) {
                    var b = el("button", "cat-item" + (isFav(e.match) ? " on" : ""),
                        '<span class="ci">' + svg(isFav(e.match) ? "star" : "fx") + '</span><span><div class="cn">' + esc(e.name) + '</div><div class="cd">' + esc(e.cat) + "</div></span><span></span>");
                    b.addEventListener("click", function () {
                        if (isFav(e.match)) favs = favs.filter(function (f) { return f[0] !== e.match; });
                        else favs.push([e.match, e.name]);
                        draw();
                    });
                    box.appendChild(b);
                });
            }
            q.addEventListener("input", draw);
            draw();
            var nodes = [q, box];
            if (loadErr) nodes.unshift(el("div", "status bad", esc("读不到已安装的效果（" + loadErr + "），下面先列出默认收藏")));
            return dialog("(★) — FAVORITE EFFECTS", nodes, [
                { label: "取消", value: function () { return null; } },
                { label: "保存", accent: true, value: function () { return favs; } }
            ]).then(function (v) {
                if (!v) return null;
                item.favs = v;
                saveConfig(); renderLayout();
                return { ok: true, msg: "已保存效果收藏（" + v.length + " 个）" };
            });
        });
    }

    // —— 我的脚本 / 代码片段 ——
    reg("script", {
        name: "脚本", cat: null, icon: "script", size: [3, 1],
        render: function (cell, item) {
            var it = lib.byKey[item.key];
            var name = it ? it.name : (item.key || "").split("/").pop().replace(/\.\w+$/, "") + "（缺失）";
            cell.appendChild(tile({
                icon: it && it.ext === "ffx" ? "preset" : "script", label: name, cls: "script", filled: !!item.color,
                hint: function () {
                    if (!it) return { title: name, note: "脚本库里找不到这个文件了，可以在编辑模式里删掉它" };
                    return { title: it.name + " · " + it.type, click: it.ext === "ffx" ? "应用到选中图层" : "运行", shift: "在文件夹中显示", note: it.desc || it.file };
                },
                run: function (m) {
                    if (!it) return Promise.resolve({ ok: false, msg: "找不到这个脚本，请刷新脚本库" });
                    if (m.shift) return host("reveal", { path: it.path });
                    return host("run", { path: it.path });
                }
            }));
        }
    });

    reg("snippet", {
        name: "代码片段", cat: null, icon: "codeSnippet", size: [3, 1],
        render: function (cell, item) {
            var s = snippetById(item.sid);
            var name = s ? s.name : snippetsOnce ? "（已删除的片段）" : "读取中…";
            cell.appendChild(tile({
                icon: s && s.kind === "expr" ? "exprSnippet" : "codeSnippet", label: name, cls: "script", filled: !!item.color,
                needs: snippetNeeds(s), tool: s && s.builtin ? s.id : undefined,
                hint: function () {
                    if (!s) return { title: name };
                    if (s.builtin) return { title: name + " · 内置" + (s.kind === "expr" ? "表达式" : "脚本"), click: s.hint.click, alt: s.hint.alt, shift: s.hint.shift, ctrl: s.hint.ctrl, note: "内置片段：可以在「脚本库 → 代码片段」里隐藏" };
                    return s.kind === "expr"
                        ? { title: name + " · 表达式", click: "应用到选中属性", alt: "追加到已有表达式后面", note: s.code.split("\n")[0] }
                        : { title: name + " · 脚本", click: "执行", note: s.code.split("\n")[0] };
                },
                run: function (m) { return s ? runSnippet(s, m) : Promise.resolve({ ok: false, msg: snippetsOnce ? "这个片段已经被删除" : "片段还在读取：稍等一下再点" }); }
            }));
        }
    });

    // =====================================================================
    // 布局渲染 + 编辑模式
    // =====================================================================
    var layoutEl = $("#layout"), dragId = null;

    function renderLayout() {
        layoutEl.innerHTML = "";
        var hn = 0;
        cfg.items.forEach(function (item) {
            var def = W[item.type];
            if (!def) return;
            if (item.type === "heading") item._n = ++hn;
            var cell = el("div", "cell");
            cell.dataset.id = item.id;
            if (def.size === "full") cell.classList.add("full");
            else {
                cell.style.gridColumn = "span " + def.size[0];
                if (def.size[1] > 1) cell.style.gridRow = "span " + def.size[1];
            }
            paintCell(cell, item.color);
            try { def.render(cell, item); } catch (err) {
                cell.innerHTML = "";
                cell.classList.add("broken");
                cell.appendChild(el("div", "broken-msg", "这个组件加载失败：" + esc((def.name || item.type) + " · " + (err && err.message ? err.message : err))));
                if (window.console) console.error("MotionHub 组件加载失败", item.type, err);
            }
            if (editing) decorateEditable(cell, item, def);
            layoutEl.appendChild(cell);
        });
        if (!editing) {
            var add = el("div", "cell");
            add.appendChild(tile({ icon: "plus", cls: "add", hint: { title: "添加", click: "往这个面板添加组件、工具、脚本或代码片段" }, run: function () { openCatalog(); return null; } }));
            layoutEl.appendChild(add);
        }
        applyNeeds();
    }

    function decorateEditable(cell, item, def) {
        cell.draggable = true;
        var ctl = el("div", "cell-ctl");
        if (def.editable) {
            var ed = el("button", "", svg("pencil"));
            ed.title = "编辑";
            ed.addEventListener("click", function (e) { e.stopPropagation(); def.edit(item).then(function (v) { if (v) { saveConfig(); renderLayout(); } }); });
            ctl.appendChild(ed);
        }
        var dot = el("button", "dot");
        dot.title = "换颜色";
        dot.addEventListener("click", function (e) {
            e.stopPropagation();
            showPop(dot, [el("div", "p-title", "组件颜色"), swatches(item.color, function (hex) {
                if (hex) item.color = hex; else delete item.color;
                hidePop(); saveConfig(); renderLayout();
            }, true)]);
        });
        ctl.appendChild(dot);
        var x = el("button", "", svg("close"));
        x.title = "从面板删除";
        x.addEventListener("click", function (e) {
            e.stopPropagation();
            cfg.items.splice(findItem(item.id), 1);
            saveConfig(); renderLayout();
        });
        ctl.appendChild(x);
        cell.appendChild(ctl);

        cell.addEventListener("dragstart", function (e) {
            dragId = item.id;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", item.id);
            setTimeout(function () { cell.classList.add("dragging"); }, 0);
        });
        cell.addEventListener("dragend", function () {
            dragId = null;
            $$(".cell", layoutEl).forEach(function (c) { c.classList.remove("dragging", "drop-before", "drop-after"); });
        });
        cell.addEventListener("dragover", function (e) {
            if (!dragId || dragId === item.id) return;
            e.preventDefault();
            var r = cell.getBoundingClientRect();
            var after = cell.classList.contains("full") ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
            cell.classList.toggle("drop-after", after);
            cell.classList.toggle("drop-before", !after);
        });
        cell.addEventListener("dragleave", function () { cell.classList.remove("drop-before", "drop-after"); });
        cell.addEventListener("drop", function (e) {
            if (!dragId) return;
            e.preventDefault();
            var after = cell.classList.contains("drop-after");
            var from = findItem(dragId);
            var moved = cfg.items.splice(from, 1)[0];
            var to = findItem(item.id);
            cfg.items.splice(after ? to + 1 : to, 0, moved);
            dragId = null;
            saveConfig(); renderLayout();
        });
    }

    function setEditing(on) {
        editing = on;
        document.body.classList.toggle("editing", on);
        $("#btn-edit").classList.toggle("on", on);
        if (on) selectTab("panel");
        hidePop();
        showHint(null);
        renderLayout();
        if (on) toast({ ok: true, msg: "编辑布局：拖动组件排序，点 ● 换颜色，点 × 删除" });
    }

    $("#btn-edit").addEventListener("click", function () { setEditing(!editing); });
    bindHint($("#btn-edit"), { title: "编辑布局", click: "进入 / 退出编辑模式：拖动排序、换颜色、删除、添加组件" });
    $("#eb-done").addEventListener("click", function () { setEditing(false); });
    $("#eb-add").addEventListener("click", function () { openCatalog(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && editing && $("#modal").hidden) setEditing(false); });

    // —— 组件库 ——
    function openCatalog() {
        var nodes = [];
        function item(icon, name, desc, size, onAdd) {
            var b = el("button", "cat-item",
                '<span class="ci">' + svg(icon) + '</span><span><div class="cn">' + esc(name) + '</div><div class="cd">' + esc(desc || "") + '</div></span><span class="cs">' + esc(size) + "</span>");
            b.addEventListener("click", function () {
                onAdd();
                $("#modal").closeWith(null);
                toast({ ok: true, msg: "已添加「" + name + "」到面板末尾" + (editing ? "" : "，点 ✎ 可以调整位置") });
            });
            return b;
        }
        function sizeLabel(s) { return s === "full" ? "整行" : s[0] + "×" + s[1]; }
        CATS.forEach(function (cat) {
            var list = el("div", "cat-list");
            Object.keys(W).forEach(function (type) {
                var d = W[type];
                if (d.cat !== cat || d.more) return;
                list.appendChild(item(d.icon, d.name, d.desc, sizeLabel(d.size), function () {
                    addItem(type === "heading" ? { type: type, en: "SECTION", zh: "新分组" } : { type: type });
                }));
            });
            if (list.children.length) nodes.push(el("div", "cat-title", esc(cat)), list);
        });
        var sl = el("div", "cat-list");
        lib.items.forEach(function (it) {
            sl.appendChild(item(it.ext === "ffx" ? "preset" : "script", it.name, it.cat + " · " + it.type, "3×1", function () { addItem({ type: "script", key: it.key }); }));
        });
        if (!lib.items.length) sl.appendChild(el("div", "muted", "脚本库是空的，可以在「脚本库」页添加"));
        nodes.push(el("div", "cat-title", "我的脚本"), sl);
        var cl = el("div", "cat-list");
        visibleSnippets().forEach(function (s) {
            cl.appendChild(item(s.kind === "expr" ? "exprSnippet" : "codeSnippet", s.name, (s.builtin ? "内置 · " : "") + (s.kind === "expr" ? "表达式" : "脚本"), "3×1", function () { addItem({ type: "snippet", sid: s.id }); }));
        });
        nodes.push(el("div", "cat-title", "代码片段"), cl);
        // 更多：复刻 AE 原生快捷键的小工具，默认不放在面板上
        var more = el("details", "cat-more"), ml = el("div", "cat-list");
        more.appendChild(el("summary", "cat-title", "更多（AE 自带快捷键能做的小工具）"));
        Object.keys(W).forEach(function (type) {
            var d = W[type];
            if (!d.more) return;
            ml.appendChild(item(d.icon, d.name, d.desc, sizeLabel(d.size), function () { addItem({ type: type }); }));
        });
        more.appendChild(ml);
        nodes.push(more);
        dialog("(+) — ADD TO PANEL " + PANEL, nodes, [{ label: "关闭", value: function () { return null; } }]);
    }

    // =====================================================================
    // 脚本库
    // =====================================================================
    var lib = { items: [], categories: [], byKey: {}, libPath: "" };

    // 脚本库位置只在这里改：别的面板换了脚本库（后台的 init / scan / ctx / loadSnippets 会报告现在的位置），
    // 这个面板的脚本列表和代码片段都跟着换，并说一声；换之前没写进去的片段改动，仍然写回原来那个库
    var ownLibSwitch = null;   // 这个面板自己正在换到的位置
    // 同一个文件夹的不同写法（末尾的斜杠、\ 和 /、大小写——Mac 和 Windows 的磁盘默认不分大小写）不算换了脚本库
    function samePath(a, b) { var n = function (x) { return String(x || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }; return n(a) === n(b); }
    function setLibPath(p) {
        if (!p || p === libPathNow) return;
        if (libPathNow && samePath(p, libPathNow)) return;
        var was = libPathNow, mine = !!ownLibSwitch && samePath(p, ownLibSwitch);
        libPathNow = p;
        ownLibSwitch = null;
        if (!was) return;
        if (B.disk.ok()) snippetStore.retarget(B.disk.join(was, "_snippets.json"), B.disk.join(p, "_snippets.json"));
        loadSnippets().then(function (r) {
            var who = mine ? "脚本库已换成「" + p + "」" : "脚本库已在别的面板换成「" + p + "」";
            if (r && r.ok === false && !r.later) toast({ ok: false, msg: who + "，但新库里的代码片段读不到（" + ((r.disk && r.disk.why) || r.msg) + "）：这里暂时显示的是换之前的片段，会自动重试" });
            else if (!mine) toast({ ok: true, msg: who + "：这里的脚本和代码片段也换成了新库里的" });
        });
        if (!mine) refreshLibrary().then(null, function () {});
    }
    function refreshLibrary() {
        return host("scan").then(function (r) {
            if (!r.ok) throw new Error(r.msg);
            lib.items = r.data.items;
            lib.categories = r.data.categories;
            lib.libPath = r.data.libPath;
            if (lib.libPath) setLibPath(lib.libPath);
            lib.byKey = {};
            lib.items.forEach(function (it) { lib.byKey[it.key] = it; });
            renderCats();
            renderLibrary();
            if (cfg) renderLayout();
            $("#set-path").textContent = lib.libPath;
        });
    }

    function onPanel(type, field, value) {
        return cfg.items.some(function (it) { return it.type === type && it[field] === value; });
    }
    function togglePanel(type, field, value) {
        var i = -1;
        cfg.items.forEach(function (it, k) { if (it.type === type && it[field] === value) i = k; });
        if (i >= 0) { cfg.items.splice(i, 1); saveConfig(); renderLayout(); return false; }
        var o = { type: type }; o[field] = value;
        addItem(o);
        return true;
    }

    function categoryDialog(title, filesHTML) {
        var list = el("div", "files", filesHTML);
        var lab = el("label", "", "分类");
        var sel = el("select");
        ["未分类"].concat(lib.categories).forEach(function (c) { sel.appendChild(new Option(c, c)); });
        sel.appendChild(new Option("＋ 新建分类…", "__new__"));
        lab.appendChild(sel);
        var labNew = el("label", "", "新分类名称");
        var inp = el("input");
        inp.type = "text";
        labNew.appendChild(inp);
        labNew.style.display = "none";
        sel.addEventListener("change", function () { labNew.style.display = sel.value === "__new__" ? "" : "none"; if (sel.value === "__new__") inp.focus(); });
        var pin = el("label", "check", '<input type="checkbox" checked> 添加到当前面板（' + esc(cfg.name) + "）");
        var pnl = el("label", "check", '<input type="checkbox"> 同时安装到 AE 的 ScriptUI Panels');
        return dialog(title, [list, lab, labNew, pin, pnl], [
            { label: "取消", value: function () { return null; } },
            {
                label: "添加", accent: true, value: function () {
                    return { cat: sel.value === "__new__" ? inp.value.trim() : sel.value, pin: pin.querySelector("input").checked, toPanels: pnl.querySelector("input").checked };
                }
            }
        ]);
    }

    function afterInstall(keys, v) {
        if (v.pin) keys.forEach(function (k) { if (!onPanel("script", "key", k)) cfg.items.push({ id: uid(), type: "script", key: k }); });
        saveConfig();
        return refreshLibrary();
    }

    function addScripts() {
        return host("pickFiles").then(function (r) {
            if (!r.ok) return r;
            var files = r.data.files;
            if (!files.length) return null;
            return categoryDialog("(+) — ADD SCRIPTS", files.map(function (f) { return esc(f.name); }).join("<br>")).then(function (v) {
                if (!v) return null;
                return host("install", { paths: files.map(function (f) { return f.path; }), cat: v.cat, toPanels: v.toPanels }).then(function (res) {
                    if (!res.ok) return res;
                    return afterInstall(res.data.keys, v).then(function () { return res; });
                });
            });
        });
    }

    // 拖入结果说明：和 host 的「添加」用同一套话（同名同内容 = 已经在库里；同名不同内容 = 另存一份）
    function droppedMsg(rs) {
        var added = 0, existing = 0, renamed = [];
        rs.forEach(function (r) {
            var d = r.data;
            if (d.state === "exists") { existing++; return; }
            added++;
            if (d.state === "renamed") renamed.push("「" + d.name + "」库里已经有一个内容不同的，新的存为「" + d.savedAs + "」");
        });
        var msg = added ? "已添加 " + added + " 个文件" : "";
        if (renamed.length) msg += "。" + renamed.join("；") + "，两个都保留了";
        if (existing) msg += (msg ? "。" : "") + existing + " 个已经在库里（内容完全一样），没有重复添加";
        return msg;
    }

    // 把文件拖进面板
    var dropDepth = 0, overlay = $("#drop-overlay");
    function isFileDrag(e) { return !dragId && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1; }
    document.addEventListener("dragenter", function (e) { if (isFileDrag(e)) { dropDepth++; overlay.hidden = false; } });
    document.addEventListener("dragleave", function (e) { if (isFileDrag(e) && --dropDepth <= 0) { dropDepth = 0; overlay.hidden = true; } });
    document.addEventListener("dragover", function (e) { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    document.addEventListener("drop", function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dropDepth = 0; overlay.hidden = true;
        var all = e.dataTransfer.files;
        var files = Array.prototype.filter.call(all, function (f) { return /\.(jsx|jsxbin|ffx)$/i.test(f.name); });
        var skipped = all.length - files.length;
        if (!files.length) { toast({ ok: false, msg: "只支持 .jsx / .jsxbin / .ffx 文件" }); return; }
        categoryDialog("(+) — DROP FILES", files.map(function (f) { return esc(f.name); }).join("<br>")).then(function (v) {
            if (!v) return;
            Promise.all(files.map(function (f) {
                return new Promise(function (res) {
                    var fr = new FileReader();
                    fr.onload = function () { res(host("writeDropped", { name: f.name, cat: v.cat, b64: String(fr.result).split(",")[1] || "" })); };
                    fr.onerror = function () { res({ ok: false, msg: "读取失败：" + f.name }); };
                    fr.readAsDataURL(f);
                });
            })).then(function (rs) {
                var bad = rs.filter(function (r) { return !r || !r.ok; });
                var good = rs.filter(function (r) { return r && r.ok && r.data; });
                if (!good.length) { var b0 = bad[0] || { ok: false, msg: "没有加进任何文件" }; B.show(null, "err", b0.msg); toast(b0); return; }
                afterInstall(good.map(function (r) { return r.data.key; }), v).then(function () {
                    var msg = droppedMsg(good) + (v.pin ? "。已放到当前面板" : "");
                    if (bad.length) msg += "。另有 " + bad.length + " 个没加进去：" + bad[0].msg;
                    if (skipped) msg += "。" + skipped + " 个不是 .jsx / .jsxbin / .ffx 文件，跳过了";
                    var r = { ok: !bad.length, msg: msg };
                    B.show(null, r.ok ? "ok" : "err", r.msg); toast(r);
                }, function (e) {
                    var r = { ok: false, msg: "文件已经加进脚本库，但刷新列表失败：" + (e && e.message ? e.message : e) + "。点脚本库页的「刷新」再试" };
                    B.show(null, "err", r.msg); toast(r);
                });
            });
        });
    });

    var catSel = $("#lib-cat"), qInput = $("#lib-q"), listEl = $("#lib-list");

    function renderCats() {
        var keep = catSel.value || "全部";
        catSel.innerHTML = "";
        var cats = ["全部"].concat(lib.categories);
        if (lib.items.some(function (it) { return it.cat === "未分类"; })) cats.push("未分类");
        cats.forEach(function (c) { catSel.appendChild(new Option(c, c)); });
        catSel.value = cats.indexOf(keep) !== -1 ? keep : "全部";
    }

    // 行内按钮可能在点击后立刻重绘列表，双击的第二下会落到新的行上：记下时间，行的双击据此忽略
    var lastActClick = 0;
    function rowDblclick(e) { return !(e.target.closest && e.target.closest(".acts")) && Date.now() - lastActClick > 600; }
    function act(parent, icon, cls, h, fn) {
        var b = el("button", "act " + (cls || ""), svg(icon));
        bindHint(b, h);
        b.addEventListener("click", function (e) { e.stopPropagation(); lastActClick = Date.now(); var m = mods(e); act0(b, function () { return fn(m); }); });
        // 双击按钮时，不能顺带触发整行的「双击运行」
        b.addEventListener("dblclick", function (e) { e.stopPropagation(); });
        parent.appendChild(b);
        return b;
    }

    function renderLibrary() {
        var cat = catSel.value || "全部", q = qInput.value.trim().toLowerCase();
        var items = lib.items.filter(function (it) {
            if (cat !== "全部" && it.cat !== cat) return false;
            return !q || (it.name + " " + it.desc + " " + it.cat + " " + it.file).toLowerCase().indexOf(q) !== -1;
        });
        listEl.innerHTML = "";
        if (!items.length) {
            listEl.appendChild(el("li", "lib-empty", lib.items.length ? "没有匹配的脚本" : "脚本库是空的，点下面的「添加脚本」或直接把文件拖进来"));
            return;
        }
        var lastCat = null;
        items.forEach(function (it) {
            if (cat === "全部" && it.cat !== lastCat) { lastCat = it.cat; listEl.appendChild(el("li", "lib-group", esc(it.cat.toUpperCase()))); }
            var li = el("li", "lib-item");
            li.innerHTML = '<div style="min-width:0"><div class="nm">' + esc(it.name) + '</div><div class="ds">' + esc(it.desc || it.file) + '</div></div><span class="tag">' + esc(it.type) + "</span>";
            var acts = el("div", "acts");
            var here = onPanel("script", "key", it.key);
            act(acts, here ? "close" : "pin", "", { title: here ? "从当前面板移除" : "放到当前面板", click: "在「面板」页显示为按钮" }, function () {
                var added = togglePanel("script", "key", it.key);
                renderLibrary();
                return Promise.resolve({ ok: true, msg: added ? "已放到当前面板" : "已从当前面板移除" });
            });
            act(acts, "folder", "", { title: "在文件夹中显示" }, function () { return host("reveal", { path: it.path }); });
            act(acts, "trash", "", { title: "移除", click: "移到脚本库的 _已移除 文件夹（可手动恢复）" }, function () {
                return confirmBox("(−) — REMOVE", "从脚本库移除「" + it.name + "」？文件会移到 _已移除 文件夹。").then(function (ok) {
                    if (!ok) return null;
                    return host("remove", { path: it.path }).then(function (r) { return refreshLibrary().then(function () { return r; }); });
                });
            });
            act(acts, "play", "run", { title: "运行 " + it.name, click: it.ext === "ffx" ? "应用到选中图层" : "运行脚本" }, function () { return host("run", { path: it.path }); });
            li.appendChild(acts);
            bindHint(li, { title: it.name + " · " + it.cat + " · " + it.type, click: "双击运行", note: it.desc || it.file });
            li.addEventListener("dblclick", function (e) { if (rowDblclick(e)) act0(li, function () { return host("run", { path: it.path }); }); });
            listEl.appendChild(li);
        });
    }

    catSel.addEventListener("change", renderLibrary);
    qInput.addEventListener("input", renderLibrary);
    $("#lib-add").addEventListener("click", function () { act0(this, addScripts); });
    $("#lib-refresh").addEventListener("click", function () { act0(this, function () { return refreshLibrary().then(function () { return { ok: true, msg: "已刷新：" + lib.items.length + " 个脚本" }; }); }); });
    $("#lib-open").addEventListener("click", function () { act0(this, function () { return host("reveal", {}); }); });
    bindHint($("#lib-add"), { title: "添加脚本", click: "选择文件加入脚本库，可以同时放到当前面板" });
    bindHint($("#lib-refresh"), { title: "刷新", click: "重新扫描脚本库文件夹" });
    bindHint($("#lib-open"), { title: "打开脚本库文件夹", click: "每个子文件夹就是一个分类" });

    $$("#lib-seg button").forEach(function (b) {
        b.addEventListener("click", function () {
            $$("#lib-seg button").forEach(function (x) { x.classList.toggle("on", x === b); });
            $("#lib-files").hidden = b.dataset.seg !== "files";
            $("#lib-snippets").hidden = b.dataset.seg !== "snippets";
        });
    });

    // =====================================================================
    // 代码片段：「添加表达式」和「执行脚本」，存在脚本库的 _snippets.json
    // =====================================================================
    var snippets = [];
    var DEFAULT_SNIPPETS = [
        { id: "def:loopWiggle", kind: "expr", name: "循环抖动", code: "freq = 2; amp = 40; loopTime = 3;\nt = time % loopTime;\nw1 = wiggle(freq, amp, 1, 0.5, t);\nw2 = wiggle(freq, amp, 1, 0.5, t - loopTime);\nlinear(t, 0, loopTime, w1, w2)" },
        { id: "def:spin", kind: "expr", name: "匀速旋转", code: "value + time * 90" },
        { id: "def:blink", kind: "expr", name: "闪烁", code: "Math.sin(time * 20) > 0 ? 100 : 0" },
        { id: "def:followParent", kind: "expr", name: "跟随父级延迟", code: "delay = 0.1;\nthisLayer.parent ? parent.transform.position.valueAtTime(time - delay) : value" },
        { id: "def:randomLabel", kind: "script", name: "随机颜色标签", code: "var c = app.project.activeItem;\nif (c instanceof CompItem) {\n    var l = c.selectedLayers;\n    for (var i = 0; i < l.length; i++) l[i].label = 1 + Math.floor(Math.random() * 16);\n}" },
        { id: "def:toggle3d", kind: "script", name: "切换 3D 图层", code: "var c = app.project.activeItem;\nif (c instanceof CompItem) {\n    var l = c.selectedLayers;\n    for (var i = 0; i < l.length; i++) l[i].threeDLayer = !l[i].threeDLayer;\n}" }
    ];

    // 内置片段：原来的抖动 / 循环 / 弹性 / 清除表达式按钮。直接调用后台工具，修饰键行为和以前完全一样；可以隐藏，不能删除
    var BUILTIN_SNIPPETS = [
        { id: "builtin:wiggle", kind: "expr", name: "抖动 wiggle", tool: "wiggle", code: "wiggle(3, 30);",
            hint: { click: "给选中属性加 wiggle(3, 30)", alt: "同时在图层上加「抖动频率 / 抖动幅度」滑块并关联" } },
        { id: "builtin:loop", kind: "expr", name: "循环 loopOut", tool: "loop", code: "loopOut(\"cycle\");",
            hint: { click: "Cycle：从头循环", alt: "Ping-Pong：来回往返", shift: "Continue：按最后速度延续", ctrl: "Offset：每次循环累加" } },
        { id: "builtin:bounce", kind: "expr", name: "弹性回弹", tool: "bounce", code: "// 在最后一个关键帧之后产生惯性回弹",
            hint: { click: "在关键帧后产生惯性回弹", alt: "更强的回弹" } },
        { id: "builtin:clearExpr", kind: "expr", name: "清除表达式", tool: "clearExpr", code: "// 清除选中属性上的表达式",
            hint: { click: "清除选中属性上的表达式", alt: "清除选中图层上的全部表达式" } },
        { id: "builtin:wiggleSliders", kind: "script", name: "抖动 + 滑块控制", tool: "wiggle", mods: { alt: true }, code: "// 给选中属性加 wiggle，并在图层上加「抖动频率 / 抖动幅度」滑块关联",
            hint: { click: "给选中属性加 wiggle，并在图层上加两个滑块控制频率和幅度" } }
    ];
    var snipPrefs = { hidden: [] };
    function isHiddenBuiltin(s) { return !!s.builtin && snipPrefs.hidden.indexOf(s.id) !== -1; }
    BUILTIN_SNIPPETS.forEach(function (b) { b.builtin = true; });
    // 搜索、组件库里能看到的片段：没隐藏的内置片段 + 自己的片段
    function visibleSnippets() { return BUILTIN_SNIPPETS.filter(function (b) { return !isHiddenBuiltin(b); }).concat(snippets); }
    var prefStore = sharedList({
        tag: "snipHidden", what: "内置片段的显示设置",
        file: function () { return B.disk.ok() ? B.disk.configPath("snippet_prefs") : ""; },
        hostRead: function () { return readConfigText("snippet_prefs"); },
        hostWrite: function (t) { return writeConfigText("snippet_prefs", t); },
        parse: function (t) { var x = JSON.parse(t); return x && typeof x === "object" && !Array.isArray(x) ? (Array.isArray(x.hidden) ? x.hidden : []) : null; },
        dump: function (l) { return JSON.stringify({ hidden: l }); },
        key: function (id) { return String(id); },
        get: function () { return snipPrefs.hidden; }, set: function (l) { snipPrefs.hidden = l; },
        localGet: function () { var x = local.get("snipPrefs", null); return x && Array.isArray(x.hidden) ? x.hidden : null; },
        localSet: function (l) { local.set("snipPrefs", { hidden: l }); },
        changed: renderSoon
    });
    function loadSnipPrefs() { return prefStore.load(); }
    function snippetNeeds(s) { return !s ? "" : s.tool ? (NEEDS[s.tool] || "") : s.kind === "expr" ? NEEDS.applyExpr : ""; }

    function snippetById(id) {
        for (var b = 0; b < BUILTIN_SNIPPETS.length; b++) if (BUILTIN_SNIPPETS[b].id === id) return BUILTIN_SNIPPETS[b];
        for (var i = 0; i < snippets.length; i++) if (snippets[i].id === id) return snippets[i];
        return null;
    }
    // 没从磁盘读到片段时（后台没连上 / 文件损坏）只存本机缓存，不覆盖磁盘上的文件
    function snippetBody(s) { return JSON.stringify([s.kind, s.name, s.code]); }
    var snippetStore = sharedList({
        tag: "snippets", what: "代码片段",
        file: snippetsPath,
        hostRead: readSnippetsText, hostWrite: writeSnippetsText,
        parse: function (t) { return JSON.parse(t); }, dump: function (l) { return JSON.stringify(l, null, 2); },
        key: function (x) { return x.id; },
        get: function () { return snippets; }, set: function (l) { snippets = l; },
        localGet: function () { return local.get("snippets", null); }, localSet: function (l) { local.set("snippets", l); },
        seed: function () { return DEFAULT_SNIPPETS.map(function (d) { return { id: d.id, kind: d.kind, name: d.name, code: d.code }; }); },
        // 老版本每个面板各自生成过一份默认片段（id 不同、内容一样），自己也可能在几个面板里建过同样的片段：
        // 合并时内容完全一样的只留磁盘上那条，这个面板里的按钮改指过去
        body: snippetBody,
        fork: function (x, id) { return { id: id || uid(), kind: x.kind, name: x.name + "（另存）", code: x.code }; },
        otherNote: function (f, r) { return { ok: false, msg: "换之前的脚本库「" + f.replace(/[\\\/]_snippets\.json$/, "") + "」现在打不开（" + ((r && r.msg) || "没有返回") + "）：那边的改动先留在这台电脑的缓存里，能打开时自动写回" }; },
        forkNote: function (x) { return "「" + x.name + "」在别的面板也改过：两份都留下了，这边改的存为「" + x.name + "（另存）」"; },
        keptNote: function (x) { return "「" + x.name + "」刚在别的面板改过，没有删除；确实要删的话再删一次"; },
        onRemap: function (remap) {
            var n = 0, all = local.get("snipRemap", {}) || {};
            for (var k in remap) all[k] = remap[k];
            local.set("snipRemap", all);
            if (!cfg) return;
            cfg.items.forEach(function (it) { if (it.type === "snippet" && Object.prototype.hasOwnProperty.call(remap, it.sid)) { it.sid = remap[it.sid]; n++; } });
            if (n) { saveConfig(); renderSoon(); }
        },
        changed: renderSoon
    });
    function loadSnippets() {
        return snippetStore.load().then(function (r) {
            // 片段到了以后重绘面板：面板上的片段按钮是按 id 找片段的，片段没到时会显示「读取中」
            renderSoon();
            return r;
        });
    }
    function snippetIndex(id) { for (var i = 0; i < snippets.length; i++) if (snippets[i].id === id) return i; return -1; }
    // 共用列表的保存结果 → 按钮旁边的气泡
    function storeResult(w, done) {
        if (w && w.ok === false) return { ok: false, msg: done + "，但" + w.msg, disk: w.disk, done: done };
        var mine = (w && w.mine) || [], kept = mine.filter(function (n) { return n.kind === "kept"; })[0];
        if (kept) return { ok: false, msg: kept.text };
        var notes = mine.map(function (n) { return n.text; }).filter(Boolean);
        return { ok: true, msg: notes.length ? done + "。" + notes.join("；") : done };
    }
    function runSnippet(s, m) {
        if (s.tool) {
            var mm = {}, k;
            for (k in m || {}) mm[k] = m[k];
            for (k in s.mods || {}) mm[k] = s.mods[k];
            return host(s.tool, { mods: mm });
        }
        return s.kind === "expr" ? host("applyExpr", { code: s.code, name: s.name, mods: m }) : host("runCode", { code: s.code, name: s.name, mods: m });
    }

    function editSnippet(s, kind) {
        var isNew = !s;
        s = s || { id: uid(), kind: kind, name: "", code: "" };
        var seen = isNew ? null : JSON.parse(JSON.stringify(s));   // 打开对话框时看到的版本：别的面板在这期间改过，就两份都留
        var a = el("label", "", "名称");
        var name = el("input"); name.type = "text"; name.value = s.name; a.appendChild(name);
        var b = el("label", "", "类型");
        var sel = el("select");
        sel.appendChild(new Option("表达式（应用到选中属性）", "expr"));
        sel.appendChild(new Option("脚本（ExtendScript，直接执行）", "script"));
        sel.value = s.kind; b.appendChild(sel);
        var c = el("label", "", "代码");
        var code = el("textarea"); code.value = s.code; code.spellcheck = false;
        code.addEventListener("keydown", function (e) {
            e.stopPropagation();
            if (e.key === "Tab") { e.preventDefault(); var p = code.selectionStart; code.value = code.value.slice(0, p) + "    " + code.value.slice(code.selectionEnd); code.selectionStart = code.selectionEnd = p + 4; }
        });
        c.appendChild(code);
        return dialog(isNew ? "(+) — NEW SNIPPET" : "(✎) — EDIT SNIPPET", [a, b, c], [
            { label: "取消", value: function () { return null; } },
            { label: "保存", accent: true, value: function () { return { name: name.value.trim(), kind: sel.value, code: code.value }; } }
        ]).then(function (v) {
            if (!v) return null;
            if (!v.name || !v.code.trim()) return { ok: false, msg: "名称和代码都不能为空" };
            var item = { id: s.id, kind: v.kind, name: v.name, code: v.code };
            // 按 id 找现在列表里的那一条（列表可能刚被别的面板的改动更新过）；在别的面板删掉了，这边的修改作为一条留下
            var at = snippetIndex(item.id);
            if (at === -1) snippets.push(item); else snippets[at] = item;
            renderSnippets(); renderLayout();
            return snippetStore.change({ op: "put", item: item, prev: seen }).then(function (w) {
                return storeResult(w, (isNew ? "已新建" : "已保存") + "「" + item.name + "」");
            });
        });
    }

    function renderSnippets() {
        var box = $("#lib-snippets");
        box.innerHTML = "";
        [["expr", "ADD EXPRESSION · 添加表达式"], ["script", "EXECUTE SCRIPT · 执行脚本"]].forEach(function (g) {
            var head = el("div", "lib-group", "<span>" + esc(g[1]) + "</span>");
            act(head, "plus", "", { title: "新建" + (g[0] === "expr" ? "表达式" : "脚本") + "片段", click: "粘贴或手写代码，保存后可以一键使用" }, function () { return editSnippet(null, g[0]); });
            box.appendChild(head);
            var ul = el("ul", "lib-list");
            ul.style.borderTop = "0";
            var mine = snippets.filter(function (s) { return s.kind === g[0]; });
            var list = BUILTIN_SNIPPETS.filter(function (s) { return s.kind === g[0]; }).concat(mine);
            list.forEach(function (s) {
                var hidden = isHiddenBuiltin(s);
                var li = el("li", "lib-item" + (hidden ? " is-hidden" : ""));
                li.innerHTML = '<div style="min-width:0"><div class="nm">' + esc(s.name) + '</div><div class="ds mono">' + esc(s.code.split("\n")[0]) + "</div></div>" +
                    (s.builtin ? '<span class="tag">' + (hidden ? "已隐藏" : "内置") + "</span>" : "");
                var acts = el("div", "acts");
                if (s.builtin) {
                    act(acts, hidden ? "refresh" : "close", "", { title: hidden ? "恢复显示" : "隐藏这个内置片段", click: hidden ? "重新出现在命令搜索和组件库里" : "不再出现在命令搜索和组件库里（已经放在面板上的不受影响）" }, function () {
                        var i = snipPrefs.hidden.indexOf(s.id);
                        if (i === -1) snipPrefs.hidden.push(s.id); else snipPrefs.hidden.splice(i, 1);
                        renderSnippets();
                        return prefStore.change(i === -1 ? { op: "put", item: s.id } : { op: "del", key: s.id }).then(function (w) {
                            return storeResult(w, (i === -1 ? "已隐藏「" : "已恢复「") + s.name + "」");
                        });
                    });
                    var hereB = onPanel("snippet", "sid", s.id);
                    act(acts, hereB ? "close" : "pin", "", { title: hereB ? "从当前面板移除" : "放到当前面板" }, function () {
                        var added = togglePanel("snippet", "sid", s.id);
                        renderSnippets();
                        return { ok: true, msg: added ? "已放到当前面板" : "已从当前面板移除" };
                    });
                    act(acts, "play", "run", { title: s.name, click: s.hint.click, alt: s.hint.alt, shift: s.hint.shift, ctrl: s.hint.ctrl }, function (m) { return runSnippet(s, m); });
                    li.appendChild(acts);
                    li.addEventListener("dblclick", function (e) { if (rowDblclick(e)) act0(li, function () { return runSnippet(s, {}); }); });
                    ul.appendChild(li);
                    return;
                }
                var here = onPanel("snippet", "sid", s.id);
                act(acts, here ? "close" : "pin", "", { title: here ? "从当前面板移除" : "放到当前面板" }, function () {
                    var added = togglePanel("snippet", "sid", s.id);
                    renderSnippets();
                    return Promise.resolve({ ok: true, msg: added ? "已放到当前面板" : "已从当前面板移除" });
                });
                act(acts, "pencil", "", { title: "编辑" }, function () { return editSnippet(s); });
                act(acts, "trash", "", { title: "删除" }, function () {
                    var seen = JSON.parse(JSON.stringify(s));
                    return confirmBox("(−) — DELETE", "删除片段「" + s.name + "」？").then(function (ok) {
                        if (!ok) return null;
                        // 按 id 删：列表在对话框开着时可能被别的面板的改动更新过
                        var at = snippetIndex(seen.id);
                        if (at !== -1) snippets.splice(at, 1);
                        renderSnippets(); renderLayout();
                        return snippetStore.change({ op: "del", key: seen.id, prev: seen }).then(function (w) { return storeResult(w, "已删除「" + seen.name + "」"); });
                    });
                });
                act(acts, "play", "run", s.kind === "expr" ? { title: "应用表达式", click: "应用到选中属性", alt: "追加到已有表达式后面" } : { title: "执行脚本" }, function (m) { return runSnippet(s, m); });
                li.appendChild(acts);
                li.addEventListener("dblclick", function (e) { if (rowDblclick(e)) act0(li, function () { return runSnippet(s, {}); }); });
                ul.appendChild(li);
            });
            if (!mine.length) ul.appendChild(el("li", "lib-empty", "还没有自己的片段，点右边的 ＋ 新建"));
            box.appendChild(ul);
        });
    }

    // =====================================================================
    // 设置页
    // =====================================================================
    function renderSettings() {
        $("#set-name").value = cfg.name;
        var box = $("#set-accent");
        box.innerHTML = "";
        box.appendChild(swatches(cfg.accent, function (hex) {
            cfg.accent = hex || "#FF5900";
            applyAccent(cfg.accent);
            saveConfig(); renderSettings();
        }, false));
    }
    $("#set-name").addEventListener("change", function () {
        cfg.name = $("#set-name").value.trim() || ("面板 " + PANEL);
        $("#panel-name").textContent = cfg.name;
        saveConfig();
    });
    $("#set-name").addEventListener("keydown", function (e) { e.stopPropagation(); });
    $("#set-preset").addEventListener("click", function () {
        var lab = el("label", "", "选择预设（会替换当前面板的布局）");
        var sel = el("select");
        (local.get("cfgBackups" + PANEL, []) || []).forEach(function (b) { sel.appendChild(new Option("备份：" + b.label, "backup:" + b.name)); });
        [["main", "主面板：全部工具"], ["animate", "动画：曲线 · 关键帧 · 快速动画"], ["organize", "整理：锚点 · 对齐 · 图层"], ["scripts", "我的脚本"], ["blank", "空白"]].forEach(function (p) { sel.appendChild(new Option(p[1], p[0])); });
        lab.appendChild(sel);
        dialog("(◇) — PRESET LAYOUT", [lab], [
            { label: "取消", value: function () { return null; } },
            { label: "载入", accent: true, value: function () { return sel.value; } }
        ]).then(function (key) {
            if (!key) return;
            if (key.indexOf("backup:") === 0) return restoreBackup(key.slice(7));
            // 载入预设会替换整个布局：先把当前布局另存一份备份（选错了还能从这里换回去），备份写不进去就不换
            return backupLayout(cfg).then(function (bk) {
                if (!bk.ok) { var no = { ok: false, msg: "没有载入：当前布局的备份没写进去（" + bk.msg + "）。检查 MotionHub 文件夹是否可写后再试" }; B.show(null, "err", no.msg); toast(no); return; }
                var keepName = cfg.name, keepAccent = cfg.accent;
                cfg = fromPreset(key);
                cfg.name = keepName; cfg.accent = keepAccent;
                saveConfig(); renderLayout(); selectTab("panel");
                B.show(null, "ok", "已载入预设布局");
                toast({ ok: true, msg: "已载入预设布局，原来的布局另存了一份备份（设置 → 载入预设 里可以换回去）" });
            });
        });
    });

    function updatePerm(cw) {
        canWrite = !!cw;
        var p = $("#set-perm");
        p.className = "status" + (canWrite ? "" : " bad");
        p.textContent = canWrite ? "已允许脚本写入文件，可以正常添加脚本。"
            : "打开 AE「首选项 → 脚本和表达式」，勾选「允许脚本写入文件和访问网络」：添加脚本、导入示例要用到它。" +
              (B.disk.ok() ? "面板布局和设置不受影响，照常保存在磁盘上。" : "打开之前，面板布局只保存在这台电脑的缓存里。");
    }
    $("#set-change").addEventListener("click", function () {
        act0(this, function () {
            return host("chooseLibrary").then(function (r) {
                if (!r.ok || !r.data || !r.data.libPath) return r.ok ? null : r;
                if (samePath(r.data.libPath, libPathNow)) return { ok: true, msg: "还是原来的脚本库，没有更换" };
                ownLibSwitch = r.data.libPath;
                return refreshLibrary().then(function () { return { ok: true, msg: "已切换脚本库（所有面板共用）" }; }, function (e) { ownLibSwitch = null; throw e; });
            });
        });
    });
    $("#set-open").addEventListener("click", function () { act0(this, function () { return host("reveal", {}); }); });
    $("#set-samples").addEventListener("click", function () {
        act0(this, function () { return host("importSamples").then(function (r) { return refreshLibrary().then(function () { return r; }); }); });
    });
    $("#set-recheck").addEventListener("click", function () { act0(this, selfCheck); });
    bindHint($("#set-recheck"), { title: "自检", click: "逐项检查：后台连接、前后端版本、AE 版本、写入权限、脚本库文件夹、Node、本地字体" });

    // 使用统计：4 个面板各存一份，这里汇总
    function loadUsage() {
        return readConfigText("usage_panel" + PANEL).then(function (r) {
            var u = null;
            try { if (r.ok && r.data && r.data.text) u = JSON.parse(r.data.text); } catch (e) {}
            var mine = u || local.get("usage" + PANEL, {}) || {};
            for (var k in mine) usage[k] = (usage[k] || 0) + mine[k];   // 读到之前已经点过的也算上
            usageLoaded = true;
            local.set("usage" + PANEL, usage);
            saveUsage();
            if ($("#page-settings").classList.contains("on")) renderUsage();
        });
    }
    function renderUsage() {
        var box = $("#set-usage");
        return Promise.all([1, 2, 3, 4].map(function (n) {
            if (n === PANEL) return Promise.resolve(usage);
            return readConfigText("usage_panel" + n).then(function (r) {
                try { return r.ok && r.data && r.data.text ? JSON.parse(r.data.text) : {}; } catch (e) { return {}; }
            });
        })).then(function (all) {
            var total = {}, sum = 0;
            all.forEach(function (u) { for (var k in u) if (USAGE_LABEL[k]) { total[k] = (total[k] || 0) + u[k]; sum += u[k]; } });
            var used = Object.keys(total).sort(function (a, b) { return total[b] - total[a]; });
            var never = Object.keys(USAGE_LABEL).filter(function (k) { return !total[k]; });
            box.innerHTML = "";
            if (!sum) { box.appendChild(el("p", "muted", "还没有记录。用一阵子再来看：最常用的工具会排在前面，从没用过的会列在下面。")); return; }
            box.appendChild(el("div", "usage-h", "最常用 · 4 个面板合计 " + sum + " 次"));
            var ol = el("ol", "usage-top");
            used.slice(0, 8).forEach(function (k) {
                ol.appendChild(el("li", "", '<span class="nm">' + esc(USAGE_LABEL[k]) + '</span><span class="bar"><i style="width:' + Math.round(total[k] / total[used[0]] * 100) + '%"></i></span><span class="n mono">' + total[k] + "</span>"));
            });
            box.appendChild(ol);
            box.appendChild(el("div", "usage-h", "从没用过 · " + never.length + " 个"));
            box.appendChild(el("p", "usage-never", never.map(function (k) { return esc(USAGE_LABEL[k]); }).join("、") || "全部都用过"));
        });
    }
    $("#set-usage-reset").addEventListener("click", function () {
        act0(this, function () {
            return confirmBox("(−) — RESET USAGE", "清空这个面板的使用统计？其他面板的不受影响。").then(function (ok) {
                if (!ok) return null;
                usage = {};
                usageLoaded = true;
                local.set("usage" + PANEL, usage);
                return writeConfigText("usage_panel" + PANEL, "{}").then(renderUsage).then(function () { return { ok: true, msg: "已清空这个面板的使用统计" }; });
            });
        });
    });
    bindHint($("#set-usage-reset"), { title: "清空统计", click: "只清空当前面板的计数" });

    // 自检：每一项独立判断，失败的写明怎么解决
    function fontLoaded(spec) {
        if (!document.fonts || !document.fonts.load) return Promise.resolve(false);
        return document.fonts.load(spec).then(function (list) { return list.length > 0; }, function () { return false; });
    }
    function selfCheck() {
        var rows = [];
        function add(ok, name, detail, fix) { rows.push({ ok: ok, name: name, detail: detail, fix: ok ? "" : fix }); }
        return Promise.all([
            host("selfCheck"),
            Promise.all(['400 12px "Geist"', '500 12px "Geist"', '400 12px "Geist Mono"', '500 12px "Geist Mono"'].map(fontLoaded))
        ]).then(function (res) {
            var r = res[0], fonts = res[1];
            add(r.ok, "后台连接", r.ok ? "已连上 AE" : r.msg, "点面板顶部的「重新连接」；还不行就关闭面板再打开");
            if (!r.ok) {
                ["前后端版本", "AE 版本", "写入权限", "脚本库文件夹"].forEach(function (n) {
                    add(false, n, "后台没连上，无法检查", "先点面板顶部的「重新连接」，再点一次自检");
                });
            } else {
                var d = r.data, major = parseInt(d.ae, 10);
                add(d.version === B.version, "前后端版本", "面板 " + B.version + " · 后台 " + d.version, "重新运行安装脚本，完全退出 AE 后再打开");
                add(major >= 22, "AE 版本", d.ae, "需要 After Effects 2022（22.0）及以上");
                add(d.canWrite, "写入权限", d.canWrite ? "已允许脚本写入文件" : "还没允许脚本写入文件", "打开「首选项 → 脚本和表达式」，勾选「允许脚本写入文件和访问网络」");
                add(d.libExists && d.libWritable, "脚本库文件夹",
                    d.libPath + (d.libExists ? (d.libWritable ? "（存在，可写）" : "（存在，但写不进去" + (d.libError ? "：" + d.libError : "") + "）") : "（不存在）"),
                    d.canWrite ? "在上面「(02) 脚本库文件夹」点「更换」换一个可写的位置" : "先打开写入权限，再点一次自检");
                updatePerm(d.canWrite);
                bannerState.perm = !d.canWrite;
                renderBanner();
            }
            var nodeOk = false;
            try { nodeOk = typeof require === "function" && typeof require("fs").existsSync === "function"; } catch (e) {}
            add(nodeOk, "Node.js", nodeOk ? "可用（节拍分析、拖入文件会用到）" : "不可用", "重新运行安装脚本（manifest 需要 --enable-nodejs）");
            var fontsOk = fonts.every(Boolean);
            add(fontsOk, "本地字体", fontsOk ? "Geist / Geist Mono 已加载" : "有 " + fonts.filter(function (x) { return !x; }).length + " 个字重没加载上，暂时用系统字体代替", "检查插件目录下的 fonts/ 是否完整，重新运行安装脚本");

            var ul = $("#set-check");
            ul.innerHTML = "";
            rows.forEach(function (x) {
                var li = el("li", x.ok ? "ok" : "bad",
                    '<span class="mk">' + (x.ok ? "✓" : "!") + '</span><span class="nm">' + esc(x.name) + '</span><span class="dt">' + esc(x.detail) + "</span>" +
                    (x.fix ? '<span class="fx">' + esc(x.fix) + "</span>" : ""));
                ul.appendChild(li);
            });
            var bad = rows.filter(function (x) { return !x.ok; });
            return bad.length
                ? { ok: false, msg: "自检发现 " + bad.length + " 项问题：" + bad.map(function (x) { return x.name; }).join("、") + "，解决办法写在设置页 (03)" }
                : { ok: true, msg: "自检通过：" + rows.length + " 项都正常" };
        });
    }
    $("#set-panels").addEventListener("click", function () { act0(this, function () { return host("openPanelsFolder"); }); });

    // =====================================================================
    // 命令搜索：Cmd / Ctrl + K，搜索全部工具、脚本和代码片段
    // =====================================================================
    function allCommands() {
        var list = [];
        Object.keys(W).forEach(function (type) {
            var d = W[type];
            if (d.run) list.push({ icon: d.icon, name: d.name, sub: d.cat, run: d.run });
        });
        CREATE.forEach(function (c) { if (c[0] !== "null") list.push({ icon: c[1], name: "新建" + c[2], sub: "新建", run: call("addLayer", { kind: c[0] }) }); });
        [["easeBoth", "缓入缓出", function (m) { return host("ease", { mode: "both", inInfl: 33, outInfl: 33, mods: m }); }],
         ["linear", "线性关键帧", function (m) { return host("ease", { mode: "linear", mods: m }); }],
         ["hold", "定格关键帧", function (m) { return host("ease", { mode: "hold", mods: m }); }],
         ["cloneKeys", "克隆关键帧", call("cloneKeys")], ["reverseKeys", "反转关键帧", call("keyTime", { op: "reverse" })],
         ["chain", "首尾相接", call("chain", { gap: 0 })], ["seqForward", "错开排列（正序）", call("sequence", { order: "forward", num: 1, step: 2 })],
         ["nullLayer", "新建空对象", call("nullLayer")]].forEach(function (x) {
            list.push({ icon: x[0], name: x[1], sub: "关键帧 · 排列", run: x[2] });
        });
        list.push({ icon: "copyKeys", name: "复制关键帧", sub: "关键帧", run: call("copyKeys") });
        list.push({ icon: "pasteKeys", name: "粘贴关键帧", sub: "关键帧", run: call("pasteKeys") });
        list.push({ icon: "styleCopy", name: "复制样式", sub: "样式", run: call("styleCopy") });
        lib.items.forEach(function (it) { list.push({ icon: it.ext === "ffx" ? "preset" : "script", name: it.name, sub: "脚本 · " + it.cat, run: function () { return host("run", { path: it.path }); } }); });
        visibleSnippets().forEach(function (s) { list.push({ icon: s.kind === "expr" ? "exprSnippet" : "codeSnippet", name: s.name, sub: (s.builtin ? "内置" : "") + (s.kind === "expr" ? "表达式片段" : "脚本片段"), run: function (m) { return runSnippet(s, m); } }); });
        list.push({ icon: "pencil", name: "编辑布局", sub: "面板", run: function () { setEditing(true); return null; } });
        list.push({ icon: "plus", name: "添加组件", sub: "面板", run: function () { openCatalog(); return null; } });
        return list;
    }

    function openPalette() {
        if (!$("#modal").hidden) return;
        var cmds = allCommands(), shown = [], sel = 0;
        var q = el("input", "pal-input");
        q.type = "text";
        q.placeholder = "搜索工具、脚本、代码片段…";
        var box = el("div", "cat-list pal-list");
        function draw() {
            var key = q.value.trim().toLowerCase();
            shown = cmds.filter(function (c) { return !key || (c.name + " " + c.sub).toLowerCase().indexOf(key) !== -1; }).slice(0, 40);
            sel = Math.min(sel, Math.max(0, shown.length - 1));
            box.innerHTML = "";
            shown.forEach(function (c, i) {
                var b = el("button", "cat-item" + (i === sel ? " sel" : ""),
                    '<span class="ci">' + svg(c.icon) + '</span><span><div class="cn">' + esc(c.name) + '</div><div class="cd">' + esc(c.sub || "") + "</div></span><span></span>");
                b.addEventListener("click", function (e) { go(c, mods(e)); });
                box.appendChild(b);
            });
            if (!shown.length) box.appendChild(el("div", "muted", "没有找到"));
        }
        function go(c, m) {
            $("#modal").closeWith(null);
            // 面板已经关掉，气泡出现在面板顶部
            act0(null, function () { return c.run(m || {}); });
        }
        q.addEventListener("input", function () { sel = 0; draw(); });
        q.addEventListener("keydown", function (e) {
            e.stopPropagation();
            if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); draw(); }
            if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
            if (e.key === "Enter" && shown[sel]) { e.preventDefault(); go(shown[sel], mods(e)); }
            if (e.key === "Escape") $("#modal").closeWith(null);
        });
        draw();
        dialog("(⌘K) — SEARCH", [q, box], []);
    }

    document.addEventListener("keydown", function (e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openPalette(); }
    });

    // =====================================================================
    // 标签页 + 启动
    // =====================================================================
    function selectTab(name) {
        $$(".tab").forEach(function (t) { t.classList.toggle("on", t.dataset.tab === name); });
        $$(".page").forEach(function (p) { p.classList.toggle("on", p.id === "page-" + name); });
        local.set("tab" + PANEL, name);
        if (name === "settings" && typeof renderUsage === "function") renderUsage();
        if (name !== "panel" && editing) setEditing(false);
    }
    $$(".tab").forEach(function (t) { t.addEventListener("click", function () { selectTab(t.dataset.tab); }); });
    $$("[data-icon]").forEach(function (n) { n.innerHTML = svg(n.dataset.icon); });

    hintEl.innerHTML = IDLE;
    selectTab(local.get("tab" + PANEL, "panel"));

    // =====================================================================
    // 选区状态：条件不满足的按钮变暗（仍可点），悬停写明缺什么
    // 只在三种时机查询：鼠标在面板里移动（节流 0.15 秒，最后一次移动也会补查）、面板获得焦点、每次操作完成后
    // =====================================================================
    var ctx = null, ctxBusy = false, ctxAt = 0, ctxPending = false, ctxTrail = 0;
    function missing(needs, c) {
        if (!needs || !c) return "";
        if (needs === "compOrProj") return c.comp || c.projComps > 0 ? "" : NEED_TEXT.compOrProj;
        if (!c.comp) return NEED_TEXT.comp;
        if (needs === "layer" && c.layers < 1) return NEED_TEXT.layer;
        if (needs === "layers2" && c.layers < 2) return NEED_TEXT.layers2;
        if (needs === "layers3" && c.layers < 3) return NEED_TEXT.layers3;
        if (needs === "keys" && c.keys < 1) return NEED_TEXT.keys;
        if (needs === "props" && c.exprProps < 1) return NEED_TEXT.props;
        if (needs === "precomp" && c.precomps < 1) return NEED_TEXT.precomp;
        return "";
    }
    function applyNeeds() {
        $$("[data-needs]").forEach(function (n) {
            var m = missing(n.dataset.needs, ctx);
            n.classList.toggle("na", !!m);
            if (m) { n.dataset.na = m; n.setAttribute("aria-description", m); }
            else { delete n.dataset.na; n.removeAttribute("aria-description"); }
        });
        rehint();
    }
    function refreshCtx(force) {
        if (B.isBackendDown()) return;
        if (ctxBusy) { ctxPending = true; return; }          // 上一次还没回来：回来后再查一次
        var now = Date.now();
        if (!force && now - ctxAt < 150) {                     // 节流窗口内（0.15 秒）：窗口结束时补一次，不丢掉最后一次移动
            if (!ctxTrail) ctxTrail = setTimeout(function () { ctxTrail = 0; refreshCtx(true); }, 150 - (now - ctxAt));
            return;
        }
        clearTimeout(ctxTrail); ctxTrail = 0;
        ctxBusy = true; ctxAt = now;
        host("ctx").then(function (r) {
            ctxBusy = false;
            if (r && r.ok) { ctx = r.data; applyNeeds(); if (r.data && r.data.lib) setLibPath(r.data.lib); }
            if (ctxPending) { ctxPending = false; refreshCtx(false); }
        }, function () { ctxBusy = false; });
    }
    // mousemove 只在鼠标位于面板里时才会触发，所以鼠标在面板外时不会查询
    document.addEventListener("mousemove", function () { refreshCtx(false); });
    window.addEventListener("focus", function () { refreshCtx(true); refreshShared(); });
    // 面板重新拿到焦点：共用列表和磁盘再对一次（别的面板的改动在这里同步过来），上次没写进去的改动再写一次
    var sharedTimer = null;
    function refreshShared() {
        if (!B.disk.ok()) return;   // 没有 Node 时不在焦点上读盘：每次都要去后台排队
        // 先让这次点击画出来（0.12 秒后再读盘）；文件没变就不读
        clearTimeout(sharedTimer);
        sharedTimer = setTimeout(function () {
            [snippetStore, curveStore, prefStore].forEach(function (st) { st.refresh(); });
            if (cfgSynced && local.get("cfgDirty" + PANEL, false)) saveConfig();
            flushPendingBackup();
        }, 120);
    }

    // =====================================================================
    // 顶部横幅：后台没连上 / 没有写入权限，第一屏就告诉用户怎么解决
    // =====================================================================
    var bannerState = { down: false, perm: false };
    function renderBanner() {
        var bn = $("#banner");
        if (bannerState.down) {
            bn.hidden = false;
            $("#banner-msg").textContent = "后台没有连上 AE，面板里的工具暂时用不了。";
            $("#banner-btn").textContent = "重新连接";
            $("#banner-btn").dataset.act = "reconnect";
        } else if (bannerState.perm) {
            bn.hidden = false;
            $("#banner-msg").textContent = "AE 还没允许脚本写入文件：打开「首选项 → 脚本和表达式」，勾选「允许脚本写入文件和访问网络」。";
            $("#banner-btn").textContent = "重新检查";
            $("#banner-btn").dataset.act = "recheck";
        } else bn.hidden = true;
    }
    var resyncing = null;
    // 共用列表读完后，写磁盘失败要报出来（读不到时已经退回本机缓存，不算失败）
    // 共用列表的一步：写盘失败原样带出去（toast 会把几处合成一句）；「还不知道存在哪里」不算失败，连上后会自动写
    function storeStep(name, fn) {
        return step(name, fn).then(function (r) { return r && r.ok === false && r.later ? { ok: true } : r; });
    }
    function resync() {
        if (resyncing) return resyncing;
        // 先连上后台，拿到写入权限和脚本库位置，再同步：片段要知道脚本库在哪里，没权限时才能用 Node 写
        var info = step("连接后台", initInfo), jobs = [info];
        var after = function (name, fn) { jobs.push(info.then(function () { return step(name, fn); })); };
        var afterStore = function (name, fn) { jobs.push(info.then(function () { return storeStep(name, fn); })); };
        if (!cfgSynced && !cfgBad) {
            after("同步面板布局", function () {
                if (cfgDirty) {
                    return writeConfigText("panel" + PANEL, JSON.stringify(cfg)).then(function (r) {
                        if (!r.ok) throw new Error(r.msg);
                        cfgSynced = true; cfgDirty = false; cfgUnsaved(false);
                    });
                }
                return loadConfig().then(function () { applyAccent(cfg.accent || "#FF5900"); $("#panel-name").textContent = cfg.name; renderLayout(); renderSettings(); showMigrationNotice(); });
            });
        }
        // 共用列表：重新和磁盘对上，离线期间记下的改动在这一步写进去
        afterStore("同步内置片段的显示设置", function () { return loadSnipPrefs().then(function (r) { renderSnippets(); return r; }); });
        afterStore("同步代码片段", loadSnippets);
        after("读取脚本库", refreshLibrary);
        afterStore("同步曲线预设", function () { return loadCurves().then(function (r) { renderLayout(); return r; }); });
        resyncing = Promise.all(jobs).then(function (rs) {
            resyncing = null;
            var bad = rs.filter(function (r) { return r && r.ok === false; });
            bad.forEach(function (r) { toast(r); });
            return bad;
        });
        return resyncing;
    }
    B.onBackend(function (down) {
        bannerState.down = down;
        renderBanner();
        if (!down) resync();   // 自动恢复或点「重新连接」后，把离线期间的改动同步到磁盘
    });
    $("#banner-btn").addEventListener("click", function () {
        var btn = this;
        if (btn.dataset.act === "reconnect") {
            act0(btn, function () {
                return B.reconnect().then(function (ok) {
                    if (!ok) return { ok: false, msg: "还是没有连上：关闭这个面板再从「窗口 → 扩展」打开；仍不行就重启 AE" };
                    return (resyncing || resync()).then(function (bad) {
                        return bad.length ? { ok: false, msg: "已重新连接，但" + bad.map(function (r) { return r.msg; }).join("；") } : { ok: true, msg: "已重新连接，离线时的改动已同步" };
                    });
                });
            });
        } else act0(btn, recheck);
    });
    function recheck() {
        return host("status").then(function (r) {
            if (!r.ok) return r;
            updatePerm(r.data.canWrite);
            var was = bannerState.perm;
            bannerState.perm = !r.data.canWrite;
            renderBanner();
            if (r.data.canWrite && was) return resync().then(function () { return { ok: true, msg: "已允许脚本写入文件，脚本库和设置已重新读取" }; });
            return r.data.canWrite ? { ok: true, msg: "已允许脚本写入文件" } : { ok: false, msg: "仍未允许：在「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」，然后再点一次" };
        });
    }

    // =====================================================================
    // 启动：每一步互相独立，任何一步失败都不影响其他步骤
    // =====================================================================
    function initInfo() {
        return host("init", {}).then(function (r) {
            if (!r || !r.ok) throw new Error(r ? r.msg : "没有返回");
            var d = r.data;
            OS = d.os || OS;
            canWrite = !!d.canWrite;
            if (d.libPath) setLibPath(d.libPath);
            $("#set-about").textContent = "MOTIONHUB v" + d.version + " · 面板 " + PANEL + " · AE " + d.ae;
            updatePerm(d.canWrite);
            bannerState.perm = !d.canWrite;
            renderBanner();
            if (d.libReady === false) toast({ ok: false, msg: "没法创建脚本库文件夹：" + d.libPath + (d.canWrite ? "。在设置页「更换文件夹」换一个位置" : "。先允许脚本写入文件") });
            return d;
        });
    }

    function step(name, fn) {
        var p;
        try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
        return p.then(null, function (e) {
            var msg = name + "失败：" + (e && e.message ? e.message : e);
            if (window.console) console.warn("MotionHub 启动 · " + msg);
            return { ok: false, msg: msg, step: name };
        });
    }

    // 「示例已导入」的标记存在磁盘上（userData/MotionHub/state.json）：重装、清缓存都不会丢，
    // 用户删掉的示例不会被导回来。老版本把标记放在本机缓存里，第一次启动时搬到磁盘
    function loadState() {
        return readConfigText("state").then(function (r) {
            var st = null;
            if (r && r.ok && r.data && r.data.text) { try { st = JSON.parse(r.data.text); } catch (e) { st = null; } }
            return st && typeof st === "object" && !Array.isArray(st) ? st : {};
        }, function () { return {}; });
    }
    function seedSamples() {
        return loadState().then(function (st) {
            if (st.seeded) return;
            var mark = function () { st.seeded = true; local.set("seeded", true); return writeConfigText("state", JSON.stringify(st)); };
            if (local.get("seeded", false)) return mark();
            // auto：脚本库里已经有脚本就不导（host 返回 skipped）
            return host("importSamples", { auto: true }).then(function (r) {
                if (!r.ok) throw new Error(r.msg);
                var d = r.data || {};
                // 真正复制了文件、或者库里本来就有，才记下「已导入」；什么都没做成的话下次再试
                if (d.copied > 0 || d.existing > 0 || d.skipped) return mark();
            });
        });
    }

    var snippetsOnce = false;   // 代码片段至少读过一次（之前找不到的片段按钮显示「读取中」，不说「已删除」）
    function boot() {
        // 片段、曲线、隐藏设置先用本机缓存画第一屏，磁盘上的稍后对上
        snippets = local.get("snippets", null) || [];
        userCurves = local.get("curves", null) || [];
        var sp = local.get("snipPrefs", null);
        if (sp && Array.isArray(sp.hidden)) snipPrefs.hidden = sp.hidden;
        var early = null;
        return step("读取面板布局", loadConfig).then(function () {
            if (!cfg) cfg = local.get("panel" + PANEL, null) || fromPreset(PANEL_PRESET[PANEL] || "blank");
            applyAccent(cfg.accent || "#FF5900");
            $("#panel-name").textContent = cfg.name;
            renderLayout();
            renderSettings();
            // 第一屏画完再读写共用文件。曲线和隐藏设置存在 userData 里，位置不依赖后台：和连接后台同时开始
            if (B.disk.ok()) early = [
                storeStep("同步内置片段的显示设置", loadSnipPrefs),
                storeStep("同步曲线预设", loadCurves)
            ];
            return step("连接后台", initInfo);
        }).then(function (initRes) {
            var failed = initRes && initRes.ok === false;
            var seed = failed ? Promise.resolve() : step("导入示例脚本", seedSamples);
            return Promise.all([
                seed.then(function () { return step("读取脚本库", refreshLibrary); }),
                storeStep("同步代码片段", function () { return loadSnippets().then(function (r) { snippetsOnce = true; renderLayout(); return r; }); }),
                step("读取使用统计", loadUsage)
            ].concat(early || [
                storeStep("同步内置片段的显示设置", loadSnipPrefs),
                storeStep("同步曲线预设", loadCurves)
            ])).then(function (rs) {
                snippetsOnce = true;
                refreshCtx(true);
                showMigrationNotice();
                showBackupNotice();
                var bad = [initRes].concat(rs).filter(function (r) { return r && r.ok === false; });
                bad.forEach(function (r) { toast(r); });
                return bad;
            });
        });
    }

    // 只读的调试接口（测试用）：拿到的都是副本，改了不影响面板
    var copy = function (x) { return JSON.parse(JSON.stringify(x)); };
    window.MHDebug = {
        config: function () { return copy(cfg); }, types: function () { return Object.keys(W); },
        migrate: function (c) { var x = copy(c); var m = migrateConfig(x); return { cfg: x, moves: m }; },
        snippets: function () { return copy(snippets); }, curves: function () { return copy(userCurves); }, hidden: function () { return copy(snipPrefs.hidden); },
        // 测试用：换主题色看效果（和设置页点色块一样，但不保存）
        accent: function (hex) { cfg.accent = hex; applyAccent(hex); renderLayout(); }
    };

    B.registerKeys(["cmdK", "esc"]);
    boot();
})();
