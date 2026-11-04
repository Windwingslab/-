/* MotionHub 前端公用：和 AE 后台通信、按键注册、点击反馈
   主面板（main.js）和 Studio（studio.js）都先加载这个文件 */
(function () {
    "use strict";

    var CEP = window.__adobe_cep__;
    var IS_WIN = navigator.platform.indexOf("Win") === 0;

    // =====================================================================
    // 后台通信：MH.call(name, args) → JSON 字符串 {ok, msg, data}
    // =====================================================================

    // ExtendScript（ES3）把 U+2028 / U+2029 当成换行，出现在字符串字面量里会直接语法错误
    function toCode(name, args) {
        return ("MH.call(" + JSON.stringify(name) + "," + JSON.stringify(args || {}) + ")")
            .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }

    function evalRaw(code) {
        return new Promise(function (resolve) {
            try { CEP.evalScript(code, function (r) { resolve(r); }); } catch (e) { resolve("EvalScript error."); }
        });
    }

    // 插件目录：和 CSInterface.getSystemPath(SystemPath.EXTENSION) 一样的解码方式
    function extensionPath() {
        var p = "";
        try { p = decodeURI(CEP.getSystemPath("extension")); } catch (e) { return ""; }
        return IS_WIN ? p.replace("file:///", "") : p.replace("file://", "");
    }

    var backendDown = false, listeners = [];
    function setBackendDown(v) {
        if (backendDown === v) return;
        backendDown = v;
        listeners.forEach(function (fn) { try { fn(v); } catch (e) {} });
    }

    // 后台没加载（ScriptPath 失败、AE 重置了脚本引擎）时，用 $.evalFile 重新载入 host.jsx
    var reloading = null;
    function reloadHost() {
        if (reloading) return reloading;
        reloading = evalRaw("typeof MH").then(function (t) {
            if (t === "object") return true;
            var dir = extensionPath();
            if (!dir) return false;
            return evalRaw("$.evalFile(" + JSON.stringify(dir + "/jsx/host.jsx") + ")").then(function () {
                return evalRaw("typeof MH");
            }).then(function (t2) { return t2 === "object"; });
        }).then(function (ok) { reloading = null; return ok; }, function () { reloading = null; return false; });
        return reloading;
    }

    var NOT_LOADED = "后台没有连上 AE：点面板顶部的「重新连接」，还不行就关闭面板再打开";

    function parse(r, name) {
        try { return JSON.parse(r); } catch (e) {
            return { ok: false, msg: "后台返回的数据无法读取（" + name + "）：" + String(r).slice(0, 80) };
        }
    }

    function host(name, args) {
        if (!CEP) {
            var mock = window.MHMock ? window.MHMock(name, args) : JSON.stringify({ ok: false, msg: "预览模式：没有连接 After Effects" });
            return Promise.resolve(parse(mock, name));
        }
        var code = toCode(name, args);
        return evalRaw(code).then(function (r) {
            if (r !== "EvalScript error.") { setBackendDown(false); return parse(r, name); }
            // 先分清：是后台没加载，还是这一次调用本身出错
            return evalRaw("typeof MH").then(function (t) {
                if (t === "object") {
                    setBackendDown(false);
                    return { ok: false, msg: "这次操作在 AE 里出错了（" + name + "），后台本身正常：换个选区再试，或把这条提示发给开发者" };
                }
                return reloadHost().then(function (ok) {
                    if (!ok) { setBackendDown(true); return { ok: false, msg: NOT_LOADED, down: true }; }
                    setBackendDown(false);
                    return evalRaw(code).then(function (r2) {
                        if (r2 === "EvalScript error.") return { ok: false, msg: "已重新载入后台，但这次操作仍然出错（" + name + "）：换个选区再试" };
                        return parse(r2, name);
                    });
                });
            });
        });
    }

    function reconnect() {
        if (!CEP) return Promise.resolve(false);
        return reloadHost().then(function (ok) { setBackendDown(!ok); return ok; });
    }

    // =====================================================================
    // 按键：面板获得焦点时 AE 默认会吃掉快捷键，先登记要用的组合
    // macOS 用 Mac 虚拟键码，Windows 用 VK 键码
    // =====================================================================
    var KEYCODES = IS_WIN ? { k: 75, esc: 27, space: 32, up: 38, down: 40, del: 46, bksp: 8 } : { k: 40, esc: 53, space: 49, up: 126, down: 125, del: 117, bksp: 51 };
    function registerKeys(names) {
        if (!CEP || !CEP.registerKeyEventsInterest) return false;
        var list = [];
        names.forEach(function (n) {
            if (n === "cmdK") list.push(IS_WIN ? { keyCode: KEYCODES.k, ctrlKey: true } : { keyCode: KEYCODES.k, metaKey: true });
            else if (n === "altUp" || n === "altDown") list.push({ keyCode: KEYCODES[n === "altUp" ? "up" : "down"], altKey: true });
            else if (KEYCODES[n] !== undefined) list.push({ keyCode: KEYCODES[n] });
        });
        try { CEP.registerKeyEventsInterest(JSON.stringify(list)); return true; } catch (e) { return false; }
    }

    // =====================================================================
    // 点击反馈：被点的按钮旁边出气泡（进行中 / 成功 / 失败），按钮本身也变色
    // =====================================================================
    var bubble = null, bubbleTimer = null;
    function ensureBubble() {
        if (bubble) return bubble;
        bubble = document.createElement("div");
        bubble.className = "fb";
        bubble.setAttribute("role", "status");
        bubble.setAttribute("aria-live", "polite");
        bubble.hidden = true;
        document.body.appendChild(bubble);
        return bubble;
    }

    function place(anchor, saved) {
        var b = ensureBubble();
        var r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : (saved || null);
        var W = window.innerWidth, H = window.innerHeight;
        if (!r || (!r.width && !r.height)) r = { left: W / 2, right: W / 2, top: 40, bottom: 40, width: 0, height: 0 };
        // 先放回左上角再量：固定定位元素的宽度会受当前位置限制，停在旧位置量会偏窄
        b.style.left = "0px"; b.style.top = "0px";
        var bw = b.offsetWidth, bh = b.offsetHeight;
        var x = Math.min(W - bw - 12, Math.max(12, r.left + r.width / 2 - bw / 2));
        // 按钮在面板下面 40% 的地方：气泡放到按钮上面（不盖住下一行，也不压在提示栏上）
        var y = r.bottom > H * 0.6 ? r.top - bh - 6 : r.bottom + 6;
        if (y < 6) y = r.bottom + 6;
        if (y + bh > H - 6) y = Math.max(6, r.top - bh - 6);
        b.style.left = Math.round(x) + "px";
        b.style.top = Math.round(y) + "px";
    }

    function esc(s) {
        return String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }

    // state：busy / ok / err
    function show(anchor, state, msg, saved) {
        var b = ensureBubble();
        clearTimeout(bubbleTimer);
        b.className = "fb " + state;
        b.innerHTML = '<i class="fb-dot"></i><span>' + esc(msg) + "</span>";
        b.hidden = false;
        place(anchor, saved);
        // 同一句提示重复出现也要重播动画
        b.classList.remove("fb-in");
        void b.offsetWidth;
        b.classList.add("fb-in");
        if (state !== "busy") bubbleTimer = setTimeout(function () { b.hidden = true; }, state === "ok" ? 1800 : 4200);
    }
    function hideBubble() { if (bubble) { clearTimeout(bubbleTimer); bubble.hidden = true; } }

    function mark(btn, state) {
        if (!btn) return;
        btn.classList.remove("st-ok", "st-err");
        void btn.offsetWidth;
        btn.classList.add(state === "ok" ? "st-ok" : "st-err");
        clearTimeout(btn._stTimer);
        btn._stTimer = setTimeout(function () { btn.classList.remove("st-ok", "st-err"); }, 900);
    }

    // 统一执行一次点击：fn 可以返回 Promise<{ok,msg}>、{ok,msg}、null（自己处理了界面，比如打开了对话框）
    // opts.toast(r)：同时写进底部提示栏留记录
    var inflight = 0;   // 正在跑的操作数：后台同步引起的重绘会等它们结束（免得按钮被换掉、丢了「处理中」又能再点一次）
    function run(btn, fn, opts) {
        opts = opts || {};
        if (btn && btn._mhBusy) {
            show(btn, "busy", "正在处理，上一次还没完成");
            return Promise.resolve(null);
        }
        hideBubble();   // 新的一次点击，先收起上一个按钮的气泡，免得看起来像这个按钮的结果
        // 记下点击时按钮的位置：操作里重绘了列表、按钮被换掉时，结果仍显示在这里
        var rect = null;
        if (btn && btn.getBoundingClientRect) { var br = btn.getBoundingClientRect(); rect = { left: br.left, right: br.right, top: br.top, bottom: br.bottom, width: br.width, height: br.height }; }
        var p;
        try { p = fn(); } catch (err) {
            p = { ok: false, msg: "出错了：" + (err && err.message ? err.message : err) };
        }
        if (!p) return Promise.resolve(null);
        if (!p.then) p = Promise.resolve(p);
        inflight++;
        if (btn) { btn._mhBusy = true; btn.classList.add("pending"); }
        // 进行中：0.1 秒还没完成，按钮底部出现走动的细线；0.6 秒还没完成，再在旁边说「处理中…」（快的操作不闪气泡）
        var slow = 0, waited = 0;
        (function wait(delay) {
            slow = setTimeout(function () {
                waited += delay;
                var modal = document.getElementById("modal");
                if (modal && !modal.hidden) { waited = 0; return wait(100); }   // 对话框开着：是在等用户输入，不是在处理
                if (btn) btn.classList.add("busy");
                if (waited >= 600) show(btn, "busy", opts.busyText || "处理中…", rect);
                else wait(600 - waited);
            }, delay);
        })(100);
        return p.then(null, function (err) {
            return { ok: false, msg: "出错了：" + (err && err.message ? err.message : err) };
        }).then(function (r) {
            clearTimeout(slow);
            inflight--;
            if (btn) { btn._mhBusy = false; btn.classList.remove("busy", "pending"); }
            if (!r) { hideBubble(); return r; }
            var ok = r.ok !== false;
            // 成功但没有要说的：不弹气泡，只让按钮描一下边（不打扰）
            if (ok && !r.msg && !opts.doneText) hideBubble();
            else show(btn, ok ? "ok" : "err", r.msg || (ok ? opts.doneText : "没有完成"), rect);
            mark(btn, ok ? "ok" : "err");
            if (opts.toast) opts.toast(r);
            return r;
        });
    }

    // =====================================================================
    // 本机磁盘（Node）：存插件自己的数据文件（布局、片段、设置）
    // AE 没开「允许脚本写入文件」时 ExtendScript 写不了文件，但 CEP 面板自己可以写自己的数据。
    // 先写 .tmp 再改名：写到一半崩溃也不会留下半个文件
    // =====================================================================
    var disk = (function () {
        var fs = null, path = null, os = null, proc = null;
        try {
            // --mixed-context 下 require 是全局函数；没开 mixed-context 时在 window.cep_node 上
            var cn = window.cep_node;
            var req = typeof require === "function" ? require : (cn && typeof cn.require === "function" ? cn.require : null);
            proc = typeof process !== "undefined" ? process : (cn && cn.process) || null;
            if (req) { fs = req("fs"); path = req("path"); os = req("os"); }
        } catch (e) { fs = null; }
        function ok() { return !!(fs && path && os); }
        // 和 ExtendScript 的 Folder.userData 是同一个位置：Windows 是 %APPDATA%，Mac 是 ~/Library/Application Support
        function userDataDir() {
            if (!ok()) return "";
            if (IS_WIN) {
                var env = proc && proc.env ? proc.env.APPDATA : "";
                return env || path.join(os.homedir(), "AppData", "Roaming");
            }
            return path.join(os.homedir(), "Library", "Application Support");
        }
        // 和 host.jsx 的 configFile() 用同一个文件名规则
        function configPath(name) { return path.join(userDataDir(), "MotionHub", String(name).replace(/[^\w.\-]/g, "_") + ".json"); }
        function why(e) { return (e && (e.code || e.message)) || String(e); }
        function writeText(file, text) {
            if (!ok()) return { ok: false, msg: "这里没有 Node，没法直接写文件" };
            // 4 个面板会同时写同一个共享文件（state.json、_snippets.json）：临时文件名各不相同，互不踩踏
            var tmp = file + "." + ((proc && proc.pid) || 0) + "-" + Math.random().toString(36).slice(2, 8) + ".tmp";
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(tmp, text, "utf8");
                fs.renameSync(tmp, file);
                return { ok: true, path: file };
            } catch (e) {
                try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
                return { ok: false, path: file, code: why(e), msg: file + "，" + why(e) };
            }
        }
        // text = null 表示文件不存在。只有 ENOENT / ENOTDIR 才算「不存在」：网络盘超时、没权限等别的错误一律算读失败，
        // 绝不能当成「没有」再去覆盖它。开头的 BOM（记事本「带 BOM 的 UTF-8」）去掉
        function readText(file) {
            if (!ok()) return { ok: false, msg: "这里没有 Node，没法直接读文件" };
            try {
                var t = fs.readFileSync(file, "utf8");
                if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
                return { ok: true, text: t, path: file };
            } catch (e) {
                if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { ok: true, text: null, path: file };
                return { ok: false, path: file, code: why(e), msg: "读不了 " + file + "（" + why(e) + "）" };
            }
        }
        // 文件的指纹（修改时间 + 大小）：面板拿到焦点时文件没变，就不用重新读。"" = 不知道
        function stamp(file) {
            if (!ok()) return "";
            try { var st = fs.statSync(file); return st.mtimeMs + ":" + st.size; }
            catch (e) { return e && e.code === "ENOENT" ? "none" : ""; }
        }
        // 把文件挪到旁边（比如损坏的配置文件）：<文件>.bad-<时间>，返回新路径；挪不动返回 ""
        function moveAside(file, tag) {
            if (!ok()) return "";
            var to = file + "." + tag;
            try { fs.renameSync(file, to); return to; } catch (e) { return ""; }
        }
        // ---------------------------------------------------------------
        // 跨面板的文件锁：4 个面板各自跑在自己的进程里，改共用文件时先拿锁，锁里同步地读、改、写，只要几毫秒。
        // · 锁文件里写着「进程号-随机串」。别人拿着时：那个进程还在、而且不到 60 秒 → 忙（调用方过几十毫秒再试）；
        //   进程已经不在了，或者 60 秒还没放 → 当成上次异常退出留下的，接管它。
        // · 接管是原子的：先把旧锁改名成只有自己知道的名字，改名成功的那一个才能接管。
        // · fn 拿到 mine()：写完以后用它确认锁还在自己手里，不在就算这次没做成（操作留着下次再套，套两遍结果一样）。
        // · 打开锁文件遇到别的错误（Windows 上刚删的锁还没放手等）也算忙，绝不无锁去写。
        // · 锁文件放在本机的 userData/MotionHub/.locks（不会出现在同步盘上的脚本库里），建不了就用系统临时文件夹
        var lockSeed = ((proc && proc.pid) || 0) + "-" + Math.random().toString(36).slice(2, 10);
        function usableDir(d) {
            try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
            try { return typeof fs.statSync === "function" ? fs.statSync(d).isDirectory() : fs.existsSync(d); } catch (e2) { return false; }
        }
        function lockDir() {
            var d = path.join(userDataDir(), "MotionHub", ".locks");
            if (usableDir(d)) return d;
            if (typeof os.tmpdir === "function") { d = path.join(os.tmpdir(), "MotionHub-locks"); if (usableDir(d)) return d; }
            return "";
        }
        function alive(pid) {
            if (!pid || !proc || typeof proc.kill !== "function") return true;   // 不知道就当它还活着
            try { proc.kill(pid, 0); return true; } catch (e) { return !(e && e.code === "ESRCH"); }
        }
        function withLock(file, fn) {
            if (!ok()) return fn(function () { return true; });
            var s = String(file), h = 5381, i;
            for (i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
            var dir = lockDir();
            if (!dir) return { ok: false, msg: "建不了锁文件（" + path.join(userDataDir(), "MotionHub", ".locks") + "）：检查这个文件夹是否可写" };
            var lp = path.join(dir, s.replace(/^.*[\\\/]/, "").replace(/[^\w.\-]/g, "_") + "-" + h.toString(36) + ".lock");
            var token = lockSeed + "-" + Math.random().toString(36).slice(2, 8);
            var mine = function () { try { return fs.readFileSync(lp, "utf8") === token; } catch (e) { return false; } };
            var take = function () { fs.writeFileSync(lp, token, { flag: "wx" }); };
            try { take(); }
            catch (e) {
                if (!e || e.code !== "EEXIST") return { ok: false, busy: true };
                var held = "", age = 0;
                try { held = fs.readFileSync(lp, "utf8"); age = Date.now() - fs.statSync(lp).mtimeMs; } catch (e1) { return { ok: false, busy: true }; }
                var stale = age >= 60000 || (held && !alive(parseInt(held, 10)));
                if (!stale) return { ok: false, busy: true };
                var aside = lp + "." + token + ".stale";
                try { fs.renameSync(lp, aside); } catch (e2) { return { ok: false, busy: true }; }
                var was = null;
                try { was = fs.readFileSync(aside, "utf8"); } catch (e3) {}
                if (was !== held) {   // 改名改到的已经是别人刚拿的新锁：还回去，这次算忙
                    try { fs.renameSync(aside, lp); } catch (e4) {}
                    return { ok: false, busy: true };
                }
                try { fs.unlinkSync(aside); } catch (e5) {}
                try { take(); } catch (e6) { return { ok: false, busy: true }; }
            }
            try { return fn(mine); }
            finally { if (mine()) { try { fs.unlinkSync(lp); } catch (e7) {} } }
        }
        return {
            ok: ok, userDataDir: userDataDir, configPath: configPath, writeText: writeText, readText: readText, withLock: withLock,
            stamp: stamp, moveAside: moveAside,
            join: function () { return ok() ? path.join.apply(path, arguments) : ""; }
        };
    })();

    window.MHBridge = {
        version: "3.8.0",   // 前端版本：自检时和后台 host.jsx 的 VERSION 比对
        disk: disk,
        host: host,
        reconnect: reconnect,
        isBackendDown: function () { return backendDown; },
        onBackend: function (fn) { listeners.push(fn); },
        registerKeys: registerKeys,
        run: run,
        inflight: function () { return inflight; },
        show: show,
        hide: hideBubble,
        toCode: toCode,
        extensionPath: extensionPath
    };
})();
