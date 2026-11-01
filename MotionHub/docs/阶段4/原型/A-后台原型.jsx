    // =====================================================================
    // 阶段 4 · A（原型）：脚本平台
    // =====================================================================
    var API = null;   // 末尾赋值为 { call, version }：运行用户脚本后据此检查全局 MH 有没有被换掉
    if (!$.global.MH_SESSION) $.global.MH_SESSION = (new Date()).getTime();
    var SESSION = $.global.MH_SESSION;   // 每次启动 AE 不同：用来判断「装完之后重启过没有」

    // —— ES3 严格 JSON 解析（不用 eval）——
    function parseJSON(text) {
        var s = String(text), i = 0;
        function bad() { throw new Error("JSON 格式错误（第 " + i + " 个字符）"); }
        function ws() {
            var c;
            while (i < s.length) { c = s.charAt(i); if (c === " " || c === "\t" || c === "\n" || c === "\r") i++; else break; }
        }
        function str() {
            var out = "", c, h;
            i++;
            while (i < s.length) {
                c = s.charAt(i++);
                if (c === '"') return out;
                if (c !== "\\") { out += c; continue; }
                c = s.charAt(i++);
                if (c === "n") out += "\n"; else if (c === "r") out += "\r"; else if (c === "t") out += "\t";
                else if (c === "b") out += "\b"; else if (c === "f") out += "\f";
                else if (c === '"' || c === "\\" || c === "/") out += c;
                else if (c === "u") { h = s.substring(i, i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) bad(); out += String.fromCharCode(parseInt(h, 16)); i += 4; }
                else bad();
            }
            return bad();
        }
        function val() {
            ws();
            var c = s.charAt(i), o, a, k, m;
            if (c === "{") {
                o = {}; i++; ws();
                if (s.charAt(i) === "}") { i++; return o; }
                for (;;) {
                    ws();
                    if (s.charAt(i) !== '"') bad();
                    k = str(); ws();
                    if (s.charAt(i++) !== ":") bad();
                    o[k] = val(); ws();
                    c = s.charAt(i++);
                    if (c === "}") return o;
                    if (c !== ",") bad();
                }
            }
            if (c === "[") {
                a = []; i++; ws();
                if (s.charAt(i) === "]") { i++; return a; }
                for (;;) {
                    a.push(val()); ws();
                    c = s.charAt(i++);
                    if (c === "]") return a;
                    if (c !== ",") bad();
                }
            }
            if (c === '"') return str();
            if (s.substring(i, i + 4) === "true") { i += 4; return true; }
            if (s.substring(i, i + 5) === "false") { i += 5; return false; }
            if (s.substring(i, i + 4) === "null") { i += 4; return null; }
            m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+\-]?\d+)?/.exec(s.substring(i, i + 40));
            if (!m) bad();
            i += m[0].length;
            return parseFloat(m[0]);
        }
        var v = val();
        ws();
        if (i < s.length) bad();
        return v;
    }

    function stateFile(name) { return new File(configDir().fsName + "/" + name); }
    // 读状态文件：坏了就把原文件另存一份 .bad-时间.json 再用默认值，原数据不会被后面的写入覆盖掉
    function readState(f, def) {
        var t = readText(f);
        if (t === null || t === "") return def;
        try { return parseJSON(t); } catch (e) {
            try { f.copy(f.fsName.replace(/\.json$/i, "") + ".bad-" + (new Date()).getTime() + ".json"); } catch (e2) {}
            return def;
        }
    }
    function saveState(f, obj) { needFolder(f.parent, "配置文件夹"); writeText(f, stringify(obj)); }

    // —— 面板识别：读全文（大文件读头尾各 64K），按 修改时间 + 大小 缓存 ——
    var SNIFF = {};
    function sniff(file) {
        var r = { panel: null, palette: false }, mod = "", len = 0, text = "", c;
        try { mod = file.modified ? String(file.modified.getTime()) : ""; len = file.length; } catch (e0) {}
        c = SNIFF[file.fsName];
        if (c && c.mod === mod && c.len === len) return c.r;
        try {
            file.encoding = "UTF-8";
            if (!file.open("r")) return r;
            if (len <= 262144) text = file.read();
            else { text = file.read(65536); try { file.seek(65536, 2); text += "\n" + file.read(); } catch (e1) {} }
            file.close();
        } catch (e2) { return r; }
        r.panel = /instanceof\s+Panel\b/.test(text);
        r.palette = /["']palette["']/.test(text);
        SNIFF[file.fsName] = { mod: mod, len: len, r: r };
        return r;
    }

    // —— 脚本自己的报错：只取需要的字段（Error.source 是整份源码，不能带出去）——
    function throwInfo(e) {
        var d = { text: "", name: "", line: 0, file: "", number: 0 };
        if (e === null || e === undefined) { d.text = "脚本抛出了 " + String(e) + "，没有附带说明"; return d; }
        if (typeof e !== "object") { d.text = String(e); }
        else {
            try { d.text = e.message !== undefined ? String(e.message) : String(e); } catch (x1) { d.text = "读不到报错内容"; }
            try { if (e.name) d.name = String(e.name); } catch (x2) {}
            try { if (e.line) d.line = Number(e.line) || 0; } catch (x3) {}
            try { if (e.fileName) d.file = File.decode(new File(e.fileName).name); } catch (x4) {}
            try { if (e.number) d.number = Number(e.number) || 0; } catch (x5) {}
        }
        if (d.text.length > 2000) d.text = d.text.substring(0, 2000) + "…";
        return d;
    }
    function scriptFail(e, label, f, kind) {
        var d = throwInfo(e), shown, where, err;
        d.script = f ? File.decode(f.name) : "";
        d.bin = !!(f && /\.jsxbin$/i.test(f.name));
        d.other = !!(d.file && d.script && d.file !== d.script);
        shown = d.text || d.name || "没有说明";
        if (shown.length > 80) shown = shown.substring(0, 80) + "…";
        where = d.line ? "（第 " + d.line + " 行" + (d.other ? "，在「" + d.file + "」里" : "") + "）" : "";
        err = new Error(kind === "preset"
            ? "没能应用预设「" + label + "」：AE 报错「" + shown + "」。确认预设和当前 AE 版本兼容、用到的效果已安装，再试一次"
            : "运行" + (kind === "snippet" ? "片段" : "") + "「" + label + "」出错：脚本报错「" + shown + "」" + where + "。按脚本说明准备好合成或图层再试；还不行，点「查看报错」复制给脚本作者");
        err.isScript = true;
        err.detail = d;
        return err;
    }

    // —— 最近使用：本机、按脚本库分开（换了脚本库就从空开始），最多 20 条 ——
    var RECENT_MAX = 20, FAV_MAX = 200;
    function libKey(f) {
        var r = new Folder(libPath()).fsName, p = f.fsName;
        if (p.length > r.length && p.substring(0, r.length) === r) return p.substring(r.length).replace(/\\/g, "/");
        return "";
    }
    function recentList() {
        var st = readState(stateFile("recent.json"), null);
        return st && st.lib === libPath() && st.items instanceof Array ? st.items : [];
    }
    function touchRecent(key) {
        if (!key) return;
        var old = recentList(), list = [], n = 1, i;
        for (i = 0; i < old.length; i++) {
            if (old[i].k === key) n = (old[i].n || 0) + 1;
            else if (list.length < RECENT_MAX - 1) list.push(old[i]);
        }
        saveState(stateFile("recent.json"), { v: 1, lib: libPath(), items: [{ k: key, t: (new Date()).getTime(), n: n }].concat(list) });
    }
    // —— 收藏：存在脚本库根目录，跟着脚本库走（和 _snippets.json 一样）——
    function favFile() { return new File(libPath() + "/_favorites.json"); }
    function favList() { var st = readState(favFile(), null); return st && st.keys instanceof Array ? st.keys : []; }
    LIB.libState = function () { return { fav: favList(), recent: recentList() }; };
    LIB.favSet = function (a) {
        var label = a.name || a.key;
        if (!canWriteFiles()) fail("没法保存收藏：先在 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」");
        var keys = favList(), out = [], had = false, i;
        for (i = 0; i < keys.length; i++) { if (keys[i] === a.key) had = true; else out.push(keys[i]); }
        if (a.on && had) return { fav: keys, msg: "「" + label + "」已经在收藏里了" };   // 幂等：不改顺序、不写盘
        if (!a.on && !had) return { fav: keys, msg: "「" + label + "」本来就不在收藏里" };
        if (a.on) {
            if (out.length >= FAV_MAX) fail("收藏已满 " + FAV_MAX + " 个：先取消几个不常用的，再收藏「" + label + "」");
            out.unshift(a.key);
        }
        saveState(new File(libRoot().fsName + "/_favorites.json"), { v: 1, keys: out });
        return { fav: out, msg: a.on ? (had ? "「" + label + "」已经在收藏里了" : "已收藏「" + label + "」") : "已取消收藏「" + label + "」" };
    };
    // 文件在脚本库里换了位置：收藏按「唯一同名文件」跟过去，同名的不止一个就不动
    function followMoves(items) {
        var keys = favList(), have = {}, byFile = {}, moved = [], i, nm, k, j, dup;
        for (i = 0; i < items.length; i++) {
            have[items[i].key] = true;
            nm = "f:" + items[i].file.toLowerCase();
            byFile[nm] = byFile.hasOwnProperty(nm) ? -1 : i;
        }
        for (i = 0; i < keys.length; i++) {
            if (have[keys[i]]) continue;
            nm = "f:" + keys[i].replace(/^.*\//, "").toLowerCase();
            k = byFile.hasOwnProperty(nm) ? byFile[nm] : -1;
            if (k < 0) continue;
            dup = false;
            for (j = 0; j < keys.length; j++) if (keys[j] === items[k].key) dup = true;
            if (dup) continue;
            moved.push({ from: keys[i], to: items[k].key, name: items[k].name, cat: items[k].cat });
            keys[i] = items[k].key;
        }
        if (moved.length && canWriteFiles()) { try { saveState(new File(libRoot().fsName + "/_favorites.json"), { v: 1, keys: keys }); } catch (e) { moved = []; } }
        return moved;
    }

    // —— 安装为停靠面板 ——
    function aeXY() { var v = app.version.split("."); return v[0] + "." + parseInt(v[1], 10); }
    function prefsBase() {
        return IS_WIN ? Folder.userData.fsName + "/Adobe/After Effects" : Folder("~/Library/Preferences/Adobe/After Effects").fsName;
    }
    // 只认 AE 自己建好的「<主.次>」首选项文件夹，不替 AE 建版本文件夹（建错了 AE 根本不读）
    function dockTarget() {
        var xy = aeXY(), base = prefsBase(), ver = new Folder(base + "/" + xy), all, list = [], i, nm;
        if (!ver.exists) {
            all = listFiles(new Folder(base));
            for (i = 0; i < all.length; i++) {
                nm = File.decode(all[i].name);
                if (all[i] instanceof Folder && nm.substring(0, xy.length) === xy && !/^\d/.test(nm.substring(xy.length))) list.push(all[i]);
            }
            if (list.length !== 1) return { xy: xy, dir: null, tried: ver.fsName };
            ver = list[0];
        }
        return { xy: xy, dir: new Folder(ver.fsName + "/Scripts/ScriptUI Panels"), tried: ver.fsName };
    }
    function needDock() {
        var t = dockTarget();
        if (!t.dir) fail("没找到 AE " + t.xy + " 的首选项文件夹（" + t.tried + "）：改用 AE 菜单「文件 → 脚本 → 安装 ScriptUI 面板…」，选这个脚本即可");
        return t;
    }
    function dockManifest() {
        var st = readState(stateFile("panels_installed.json"), null);
        return st && st.items instanceof Array ? st : { v: 1, items: [] };
    }
    function dockIndex(st, file, xy) {
        for (var i = 0; i < st.items.length; i++) if (st.items[i].file === file && st.items[i].ae === xy) return i;
        return -1;
    }
    function sameBytes(a, b) {
        var x, y;
        try {
            if (!a.exists || !b.exists || a.length !== b.length) return false;
            a.encoding = "BINARY"; b.encoding = "BINARY";
            if (!a.open("r")) return false;
            x = a.read(); a.close();
            if (!b.open("r")) return false;
            y = b.read(); b.close();
            return x === y;
        } catch (e) { return false; }
    }
    function backupTo(xy, file, tag) {
        var dir = needFolder(new Folder(configDir().fsName + "/panel_backups/" + xy), "备份文件夹");
        return new File(dir.fsName + "/" + (new Date()).getTime() + "_" + tag + "_" + file);
    }
    LIB.dockInstall = function (a) {
        var f = new File(a.path), file = File.decode(f.name);
        if (!f.exists) fail("找不到「" + file + "」：文件被移动、改名或删除了。点脚本库的「刷新」再试");
        if (!/\.(jsx|jsxbin)$/i.test(file)) fail("只有 .jsx / .jsxbin 脚本能安装为停靠面板");
        if (!canWriteFiles()) fail("先在 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」，再安装为停靠面板");
        var t = needDock(), dest = new File(t.dir.fsName + "/" + file), st = dockManifest(), idx = dockIndex(st, file, t.xy);
        var rec = idx >= 0 ? st.items[idx] : null, original = rec ? rec.backup : "", b;
        if (dest.exists) {
            if (sameBytes(f, dest)) {
                if (!rec) { st.items.push({ file: file, key: a.key || "", ae: t.xy, at: (new Date()).getTime(), session: SESSION, backup: "", adopted: true }); saveState(stateFile("panels_installed.json"), st); }
                return { already: true, file: file, ae: t.xy, msg: "「" + file + "」已经装好了：在「窗口」菜单底部打开它（刚装的要先重启 AE）" };
            }
            if (!rec && !a.replace) return { conflict: { file: file, dir: t.dir.fsName }, msg: "" };
            b = backupTo(t.xy, file, rec ? "old" : "orig");
            if (!dest.copy(b.fsName)) fail("没能备份已有的「" + file + "」（" + (dest.error || "未知原因") + "）：没有替换。检查 " + b.parent.fsName + " 是否可写");
            if (!rec) original = b.fsName;
        }
        needFolder(t.dir, "ScriptUI Panels 文件夹");
        if (!f.copy(dest.fsName) || !dest.exists) fail("没能复制到 ScriptUI Panels（" + (f.error || "未知原因") + "）：检查 " + t.dir.fsName + " 是否可写；公司电脑可能锁定了这个文件夹，改用 AE 菜单「文件 → 脚本 → 安装 ScriptUI 面板…」");
        var nrec = { file: file, key: a.key || "", ae: t.xy, at: (new Date()).getTime(), session: SESSION, backup: original || "" };
        if (idx >= 0) st.items[idx] = nrec; else st.items.push(nrec);
        saveState(stateFile("panels_installed.json"), st);
        return { installed: true, updated: !!rec, file: file, ae: t.xy, dir: t.dir.fsName, canRestart: typeof app.restart === "function",
            msg: (rec ? "已更新停靠面板" : "已安装为停靠面板") + "：重启 AE 后，在「窗口」菜单底部打开「" + file + "」" };
    };
    LIB.dockRemove = function (a) {
        var t = needDock(), st = dockManifest(), idx = dockIndex(st, a.file, t.xy), rec, dest, keep, orig, restored = false;
        if (idx < 0) fail("「" + a.file + "」不是 MotionHub 安装的：要删掉它，在设置页点「打开 ScriptUI Panels 文件夹」手动删除");
        rec = st.items[idx];
        dest = new File(t.dir.fsName + "/" + a.file);
        if (dest.exists) {
            keep = backupTo(t.xy, a.file, "removed");
            if (!dest.copy(keep.fsName) || !dest.remove()) fail("没能卸载「" + a.file + "」（" + (dest.error || "未知原因") + "）：先关掉 AE 里打开的这个面板，再试一次");
        }
        if (rec.backup) { orig = new File(rec.backup); if (orig.exists && orig.copy(dest.fsName)) restored = true; }
        st.items.splice(idx, 1);
        saveState(stateFile("panels_installed.json"), st);
        return { removed: true, restored: restored, msg: "已卸载「" + a.file + "」：重启 AE 后它会从「窗口」菜单消失" + (restored ? "；原来的同名文件已放回" : "") };
    };
    function menuId(file) { try { return app.findMenuCommandId(file) || 0; } catch (e) { return 0; } }
    LIB.dockStatus = function () {
        var t = dockTarget(), st = dockManifest(), items = [], stale = [], cur = {}, i, r, here;
        for (i = 0; i < st.items.length; i++) if (st.items[i].ae === t.xy) cur["f:" + st.items[i].file] = true;
        for (i = 0; i < st.items.length; i++) {
            r = st.items[i];
            if (r.ae !== t.xy) { if (!cur["f:" + r.file]) stale.push({ key: r.key, file: r.file, ae: r.ae }); continue; }
            here = t.dir ? new File(t.dir.fsName + "/" + r.file).exists : false;
            items.push({ key: r.key, file: r.file, ae: r.ae, present: here, restarted: r.session !== SESSION, menu: here && r.session !== SESSION ? menuId(r.file) : 0 });
        }
        return { ae: t.xy, dir: t.dir ? t.dir.fsName : "", items: items, stale: stale };
    };

