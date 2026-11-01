// Builds a prototype host.jsx for requirement A from the repo's host.jsx (repo is only read)
"use strict";
const fs = require("fs"), path = require("path");
const SRC = "/home/user/-/MotionHub/com.windwings.motionhub/jsx/host.jsx";
const OUT = path.join(__dirname, "host-a.jsx");
let s = fs.readFileSync(SRC, "utf8");
const patch = fs.readFileSync(path.join(__dirname, "patch-lib.jsx"), "utf8");
function rep(oldStr, newStr) {
    const n = s.split(oldStr).length - 1;
    if (n !== 1) throw new Error("anchor found " + n + " times: " + oldStr.slice(0, 60));
    s = s.replace(oldStr, newStr);
}

// 1. readMeta：机器可读的面板标记
rep(`                    if (/instanceof\\s+Panel/.test(head)) it.type = "面板";
                }
            } catch (e) {}
        }
        return it;`,
`                }
            } catch (e) {}
            var sn = sniff(file);
            it.panel = sn.panel; it.palette = sn.palette;
            if (sn.panel) it.type = "面板";
        } else it.panel = ext === "jsxbin" ? null : false;
        return it;`);

// 2. scan：收藏跟随 + 状态一起返回
rep(`        return { items: out, categories: categories(), libPath: root.fsName };`,
`        var moved = [];
        try { moved = followMoves(out); } catch (eM) {}
        return { items: out, categories: categories(), libPath: root.fsName, state: LIB.libState(), moved: moved };`);

// 3. LIB.run：撤销组、脚本报错原文、最近使用、MH 被覆盖时恢复、预设只调一次
rep(`    LIB.run = function (a) {
        var f = new File(a.path);
        if (!f.exists) fail("文件不存在，请刷新脚本库");
        if (/\\.ffx$/i.test(f.name)) {
            var comp = activeComp(), layers = needLayers(comp, 1);
            app.beginUndoGroup("MotionHub：应用预设");
            try {
                for (var i = 0; i < layers.length; i++) layers[i].applyPreset(f);
            } finally {
                app.endUndoGroup();
            }
            return "已对 " + layers.length + " 个图层应用预设";
        }
        $.evalFile(f);
        return "已运行：" + File.decode(f.name);
    };`,
`    LIB.run = function (a) {
        var f = new File(a.path), label = a.name || File.decode(f.name).replace(/\\.[^.]+$/, "");
        if (!f.exists) fail("找不到「" + label + "」：文件被移动、改名或删除了。点脚本库的「刷新」，再从列表里运行");
        var key = libKey(f), info, group, clobbered = false;
        if (/\\.ffx$/i.test(f.name)) {
            var comp = activeComp(), layers = needLayers(comp, 1);
            try { touchRecent(key); } catch (eR0) {}
            app.beginUndoGroup("MotionHub：应用预设");
            try { layers[0].applyPreset(f); }   // 一次调用就作用于全部选中图层
            catch (eP) { throw scriptFail(eP, label, f, "preset"); }
            finally { app.endUndoGroup(); }
            return { msg: "已对 " + layers.length + " 个选中图层应用预设「" + label + "」", kind: "preset", recent: recentList() };
        }
        info = /\\.jsx$/i.test(f.name) ? sniff(f) : { panel: null, palette: false };
        group = info.panel !== true;
        try { touchRecent(key); } catch (eR) {}
        if (group) app.beginUndoGroup("运行「" + label + "」");
        try { $.evalFile(f); }
        catch (e) { throw scriptFail(e, label, f, "script"); }
        finally {
            if (group) app.endUndoGroup();
            if (API && $.global.MH !== API) { $.global.MH = API; clobbered = true; }
        }
        var res = { kind: info.panel === true ? "panel" : "script", panel: info.panel, recent: recentList() };
        if (info.panel === true) {
            res.msg = "已打开「" + label + "」的浮动窗口";
            res.note = info.palette ? "要停靠进工作区：在脚本库点 ⋯ →「安装为可停靠面板」" : "没看到窗口？这个脚本可能只能停靠使用：在脚本库点 ⋯ →「安装为可停靠面板」";
        } else res.msg = "已运行「" + label + "」";
        if (clobbered) res.note = "脚本把全局变量 MH 换掉了，MotionHub 已恢复自己的后台；如果这个脚本有功能失灵，把这条提示发给脚本作者";
        return res;
    };`);

// 4. 片段：同样带出原文
rep(`    T.runCode = function (a) {
        (new Function(a.code))();
        return "已执行「" + (a.name || "脚本") + "」";
    };`,
`    T.runCode = function (a) {
        try { (new Function(a.code))(); }
        catch (e) { throw scriptFail(e, a.name || "脚本", null, "snippet"); }
        return "已执行「" + (a.name || "脚本") + "」";
    };`);

// 5. 插入 A 的新函数
rep(`    LIB.reveal = function (a) {`, patch + `    LIB.reveal = function (a) {`);

// 6. call()：脚本报错单独标记；throw null 等不再让 call() 自己崩掉
rep(`        } catch (e) {
            return stringify({ ok: false, msg: e.isUser ? e.message : "出错了：" + e.toString() + (e.line ? "（第 " + e.line + " 行）" : "") });
        }`,
`        } catch (e) {
            var user = false, script = false, t;
            try { script = !!(e && e.isScript); user = !!(e && e.isUser); } catch (x) {}
            if (script) return stringify({ ok: false, origin: "script", msg: e.message, data: { detail: e.detail } });
            if (user) return stringify({ ok: false, msg: e.message });
            t = throwInfo(e);
            return stringify({ ok: false, msg: "没能完成「" + (UNDO_NAMES[name] || name) + "」：MotionHub 内部出错（" + (t.name ? t.name + ": " : "") + t.text + (t.line ? "，host.jsx 第 " + t.line + " 行" : "") + "）。再试一次；还不行，把这条提示发给开发者" });
        }`);

// 7. 记下自己的 API 对象
rep(`    return { call: call, version: VERSION };
})();`, `    API = { call: call, version: VERSION };
    return API;
})();`);

fs.writeFileSync(OUT, s);
console.log("wrote " + OUT + " (" + s.split("\n").length + " lines)");
