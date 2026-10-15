/* MotionHub 面板逻辑 */
(function () {
    "use strict";

    var $ = function (s, el) { return (el || document).querySelector(s); };
    var svg = window.MHIcons.svg;
    var IS_CEP = !!window.__adobe_cep__;
    var OS = navigator.platform.indexOf("Win") === 0 ? "win" : "mac";

    // ---------------------------------------------------------------------
    // 本地设置
    // ---------------------------------------------------------------------
    var store = {
        get: function (k, d) {
            try { var v = localStorage.getItem("mh." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
        },
        set: function (k, v) {
            try { localStorage.setItem("mh." + k, JSON.stringify(v)); } catch (e) {}
        }
    };

    // ---------------------------------------------------------------------
    // 调用 AE 后台（jsx/host.jsx 里的 MH.call）
    // ---------------------------------------------------------------------
    function host(name, args) {
        return new Promise(function (resolve) {
            var code = "MH.call(" + JSON.stringify(name) + "," + JSON.stringify(args || {}) + ")";
            var done = function (r) {
                var o;
                try { o = JSON.parse(r); } catch (e) {
                    o = { ok: false, msg: r === "EvalScript error." ? "后台脚本没有加载，请关闭面板后重新打开" : "返回数据异常：" + String(r).slice(0, 80) };
                }
                resolve(o);
            };
            if (IS_CEP) window.__adobe_cep__.evalScript(code, done);
            else done(window.MHMock ? window.MHMock(name, args) : JSON.stringify({ ok: true, msg: "（预览）" + name }));
        });
    }

    // ---------------------------------------------------------------------
    // 底部提示栏
    // ---------------------------------------------------------------------
    var KEYS = OS === "mac"
        ? { click: "单击", alt: "⌥ 单击", shift: "⇧ 单击", ctrl: "⌘ 单击" }
        : { click: "单击", alt: "Alt+单击", shift: "Shift+单击", ctrl: "Ctrl+单击" };
    var IDLE = '<div class="muted">把鼠标移到按钮上，这里会显示它的用法。</div>';

    var hintEl = $("#hint"), hovered = null, toastTimer = null;

    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
    }

    function hintHTML(h) {
        if (!h) return IDLE;
        var html = '<div class="h-title">' + esc(h.title) + "</div>";
        ["click", "alt", "shift", "ctrl"].forEach(function (k) {
            if (h[k]) html += '<div><span class="k">' + KEYS[k] + "</span> — " + esc(h[k]) + "</div>";
        });
        if (h.note) html += '<div class="muted">' + esc(h.note) + "</div>";
        return html;
    }

    function showHint(h) {
        hovered = h;
        if (toastTimer) return;
        hintEl.className = "hint";
        hintEl.innerHTML = hintHTML(h);
    }

    function toast(r) {
        if (!r || (!r.msg && r.ok)) return;
        clearTimeout(toastTimer);
        hintEl.className = "hint " + (r.ok ? "ok" : "err");
        hintEl.innerHTML = '<div class="h-msg">' + esc(r.msg) + "</div>";
        toastTimer = setTimeout(function () {
            toastTimer = null;
            showHint(hovered);
        }, r.ok ? 2600 : 4200);
    }

    function bindHint(el, h) {
        el.addEventListener("mouseenter", function () { showHint(typeof h === "function" ? h() : h); });
        el.addEventListener("mouseleave", function () { showHint(null); });
    }

    // ---------------------------------------------------------------------
    // 组件
    // ---------------------------------------------------------------------
    function mods(e) {
        return { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    }

    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html !== undefined) n.innerHTML = html;
        return n;
    }

    // 图标方块：hover 显示提示；点击时带上修饰键
    function tile(o) {
        var b = el("button", "tile" + (o.cls ? " " + o.cls : ""));
        b.innerHTML = (o.icon ? svg(o.icon) : "") + (o.label ? '<span class="lbl">' + esc(o.label) + "</span>" : "");
        bindHint(b, o.hint);
        b.addEventListener("click", function (e) {
            b.classList.add("flash");
            setTimeout(function () { b.classList.remove("flash"); }, 140);
            var p = o.run(mods(e));
            if (p && p.then) p.then(toast);
        });
        return b;
    }

    function section(parent, num, en, zh) {
        var h = el("div", "sec-head", '<span class="num">(' + num + ") — " + en + '</span><span class="zh">' + zh + "</span>");
        parent.appendChild(h);
        return h;
    }

    function grid(parent) {
        var g = el("div", "grid");
        parent.appendChild(g);
        return g;
    }

    // ---------------------------------------------------------------------
    // 对话框
    // ---------------------------------------------------------------------
    function dialog(title, bodyNodes, buttons) {
        return new Promise(function (resolve) {
            var m = $("#modal"), body = $("#dlg-body"), btns = $("#dlg-btns");
            $("#dlg-title").textContent = title;
            body.innerHTML = "";
            btns.innerHTML = "";
            bodyNodes.forEach(function (n) { body.appendChild(n); });
            function close(v) {
                m.hidden = true;
                document.removeEventListener("keydown", onKey);
                resolve(v);
            }
            function onKey(e) {
                if (e.key === "Escape") close(null);
                if (e.key === "Enter") close(buttons[buttons.length - 1].value());
            }
            buttons.forEach(function (b) {
                var x = el("button", "btn" + (b.accent ? " accent" : ""), esc(b.label));
                x.addEventListener("click", function () { close(b.value()); });
                btns.appendChild(x);
            });
            m.hidden = false;
            document.addEventListener("keydown", onKey);
            var first = body.querySelector("input[type=text]");
            if (first) { first.focus(); first.select(); }
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

    // ---------------------------------------------------------------------
    // 脚本库数据
    // ---------------------------------------------------------------------
    var lib = { items: [], categories: [], byKey: {}, libPath: "" };
    var pins = store.get("pins", []);

    function savePins() { store.set("pins", pins); }
    function isPinned(key) { return pins.indexOf(key) !== -1; }

    function togglePin(key, on) {
        var i = pins.indexOf(key);
        if (on === undefined) on = i === -1;
        if (on && i === -1) pins.push(key);
        if (!on && i !== -1) pins.splice(i, 1);
        savePins();
        renderMyScripts();
        renderLibrary();
    }

    function refreshLibrary() {
        return host("scan").then(function (r) {
            if (!r.ok) { toast(r); return; }
            lib.items = r.data.items;
            lib.categories = r.data.categories;
            lib.libPath = r.data.libPath;
            lib.byKey = {};
            lib.items.forEach(function (it) { lib.byKey[it.key] = it; });
            renderCats();
            renderLibrary();
            renderMyScripts();
            $("#set-path").textContent = lib.libPath;
        });
    }

    function runItem(it) {
        return host("run", { path: it.path });
    }

    function addScripts() {
        return host("pickFiles").then(function (r) {
            if (!r.ok) return r;
            var files = r.data.files;
            if (!files.length) return null;

            var list = el("div", "files", files.map(function (f) { return esc(f.name); }).join("<br>"));
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
            sel.addEventListener("change", function () {
                labNew.style.display = sel.value === "__new__" ? "" : "none";
                if (sel.value === "__new__") inp.focus();
            });
            var pin = el("label", "check", '<input type="checkbox" checked> 显示在「工具」页的 MY SCRIPTS 里');
            var pnl = el("label", "check", '<input type="checkbox"> 同时安装到 AE 的 ScriptUI Panels');

            return dialog("(+) — ADD SCRIPTS", [list, lab, labNew, pin, pnl], [
                { label: "取消", value: function () { return null; } },
                {
                    label: "添加", accent: true, value: function () {
                        return {
                            cat: sel.value === "__new__" ? inp.value.trim() : sel.value,
                            pin: pin.querySelector("input").checked,
                            toPanels: pnl.querySelector("input").checked
                        };
                    }
                }
            ]).then(function (v) {
                if (!v) return null;
                return host("install", {
                    paths: files.map(function (f) { return f.path; }),
                    cat: v.cat, toPanels: v.toPanels
                }).then(function (res) {
                    if (res.ok && v.pin) {
                        res.data.keys.forEach(function (k) { if (!isPinned(k)) pins.push(k); });
                        savePins();
                    }
                    return refreshLibrary().then(function () { return res; });
                });
            });
        });
    }

    // ---------------------------------------------------------------------
    // 工具页
    // ---------------------------------------------------------------------
    var myScriptsGrid = null;

    function buildTools() {
        var page = $("#page-tools");
        page.innerHTML = "";

        // (01) 锚点
        section(page, "01", "ANCHOR", "锚点");
        var wrap = el("div", "anchor-wrap");
        var ag = el("div", "anchor-grid");
        var pos = [["左上", "上中", "右上"], ["左中", "中心", "右中"], ["左下", "下中", "右下"]];
        for (var y = 0; y < 3; y++) {
            for (var x = 0; x < 3; x++) {
                (function (fx, fy, name) {
                    ag.appendChild(tile({
                        icon: "anchor" + (fx * 2) + (fy * 2), cls: "accent",
                        hint: { title: "锚点 · " + name, click: "把锚点移到图层的" + name + "，图层位置不变", alt: "同时把图层贴到合成的" + name },
                        run: function (m) { return host("anchor", { fx: fx, fy: fy, mods: m }); }
                    }));
                })(x / 2, y / 2, pos[y][x]);
            }
        }
        var side = el("div", "anchor-side");
        side.appendChild(tile({
            icon: "center", label: "居中到合成",
            hint: { title: "居中到合成", click: "锚点居中，并把图层移到合成中心", alt: "不改锚点，按图层外框居中" },
            run: function (m) { return host("centerComp", { mods: m }); }
        }));
        side.appendChild(tile({
            icon: "nullLayer", label: "空对象",
            hint: { title: "空对象", click: "在选中图层上方新建空对象", alt: "放到选中图层中心，并设为它们的父级" },
            run: function (m) { return host("nullLayer", { mods: m }); }
        }));
        side.appendChild(tile({
            icon: "precomp", label: "逐个预合成",
            hint: { title: "逐个预合成", click: "每个选中图层各自预合成，保留属性" },
            run: function (m) { return host("precompEach", { mods: m }); }
        }));
        wrap.appendChild(ag);
        wrap.appendChild(side);
        page.appendChild(wrap);

        // (02) 关键帧
        section(page, "02", "KEYFRAME", "缓动 · 关键帧");
        var sl = el("div", "sliders");
        function sliderRow(label, keyName, def) {
            var r = el("div", "srow", '<span class="k">' + label + "</span>");
            var range = el("input");
            range.type = "range"; range.min = 1; range.max = 100; range.value = store.get(keyName, def);
            var num = el("input", "num-in");
            num.type = "text"; num.value = range.value;
            range.addEventListener("input", function () { num.value = range.value; store.set(keyName, +range.value); });
            num.addEventListener("change", function () {
                var v = Math.max(1, Math.min(100, parseFloat(num.value) || def));
                num.value = v; range.value = v; store.set(keyName, v);
            });
            bindHint(r, { title: "缓动影响 %", click: "数值越大，曲线越陡（AE 默认 33）", note: "IN 控制进入关键帧，OUT 控制离开关键帧" });
            r.appendChild(range);
            r.appendChild(num);
            sl.appendChild(r);
            return range;
        }
        var rIn = sliderRow("IN", "inInfl", 33);
        var rOut = sliderRow("OUT", "outInfl", 33);
        page.appendChild(sl);
        var infl = function () { return { inInfl: +rIn.value, outInfl: +rOut.value }; };
        var g2 = grid(page);
        function easeArgs(mode, m) { var a = infl(); a.mode = mode; a.mods = m; return a; }
        g2.appendChild(tile({
            icon: "easeBoth",
            hint: { title: "缓动", click: "缓入缓出（等同 F9，影响值用上面的滑块）", alt: "只缓入", shift: "只缓出" },
            run: function (m) { return host("ease", easeArgs("both", m)); }
        }));
        g2.appendChild(tile({
            icon: "linear", hint: { title: "线性", click: "把选中关键帧设为线性" },
            run: function (m) { return host("ease", easeArgs("linear", m)); }
        }));
        g2.appendChild(tile({
            icon: "hold", hint: { title: "定格", click: "把选中关键帧设为定格" },
            run: function (m) { return host("ease", easeArgs("hold", m)); }
        }));
        g2.appendChild(tile({
            icon: "cloneKeys",
            hint: { title: "克隆关键帧", click: "把选中关键帧从播放头位置克隆一份", alt: "克隆后自动选中新关键帧", shift: "反向克隆（时间倒放）" },
            run: function (m) { return host("cloneKeys", { mods: m }); }
        }));

        // (03) 对齐
        section(page, "03", "ALIGN", "对齐 · 分布");
        var g3 = grid(page);
        [["alignLeft", "left", "左对齐"], ["alignHCenter", "hcenter", "水平居中"], ["alignRight", "right", "右对齐"],
         ["alignTop", "top", "顶部对齐"], ["alignVCenter", "vcenter", "垂直居中"], ["alignBottom", "bottom", "底部对齐"]].forEach(function (d) {
            g3.appendChild(tile({
                icon: d[0], hint: { title: d[2], click: d[2] + "到合成", alt: d[2] + "到选区（所有选中图层的整体外框）" },
                run: function (m) { return host("align", { mode: d[1], mods: m }); }
            }));
        });
        g3.appendChild(tile({
            icon: "distH", hint: { title: "水平分布", click: "按中心点水平均匀分布（至少 3 个图层）" },
            run: function (m) { return host("distribute", { horizontal: true, mods: m }); }
        }));
        g3.appendChild(tile({
            icon: "distV", hint: { title: "垂直分布", click: "按中心点垂直均匀分布（至少 3 个图层）" },
            run: function (m) { return host("distribute", { horizontal: false, mods: m }); }
        }));

        // (04) 图层
        section(page, "04", "LAYER", "图层");
        var g4 = grid(page);
        g4.appendChild(tile({ icon: "adjust", hint: { title: "调整图层", click: "在选中图层上方新建调整图层" }, run: function (m) { return host("addLayer", { kind: "adjust", mods: m }); } }));
        g4.appendChild(tile({ icon: "solid", hint: { title: "纯色层", click: "新建合成大小的纯色层" }, run: function (m) { return host("addLayer", { kind: "solid", mods: m }); } }));
        g4.appendChild(tile({ icon: "camera", hint: { title: "摄像机", click: "新建摄像机" }, run: function (m) { return host("addLayer", { kind: "camera", mods: m }); } }));
        g4.appendChild(tile({ icon: "trim", hint: { title: "剪到工作区", click: "把选中图层的入点和出点剪到工作区" }, run: function (m) { return host("trim", { mods: m }); } }));
        g4.appendChild(tile({ icon: "reverse", hint: { title: "反转顺序", click: "反转选中图层的上下顺序" }, run: function (m) { return host("reverse", { mods: m }); } }));
        g4.appendChild(tile({
            icon: "rename", hint: { title: "批量重命名", click: "输入名称后，按 名称_01、名称_02 … 重命名" },
            run: function () {
                return ask("(R) — RENAME", "新名称（会自动加编号）", "Layer").then(function (base) {
                    return base ? host("rename", { base: base }) : null;
                });
            }
        }));
        var line = el("div", "inline");
        var frames = el("input", "num-in");
        frames.type = "text";
        frames.value = store.get("frames", 2);
        frames.addEventListener("change", function () {
            var v = Math.max(0, parseInt(frames.value, 10) || 0);
            frames.value = v; store.set("frames", v);
        });
        bindHint(frames, { title: "错开帧数", click: "依次排列时，每个图层之间间隔的帧数" });
        line.appendChild(frames);
        line.appendChild(el("span", "unit", "帧"));
        line.appendChild(tile({
            icon: "sequence", label: "依次排列", cls: "text",
            hint: { title: "依次排列", click: "按选择顺序，把图层依次错开", alt: "倒序排列", shift: "随机顺序" },
            run: function (m) { return host("sequence", { frames: parseInt(frames.value, 10) || 0, mods: m }); }
        }));
        page.appendChild(line);

        // (05) 表达式
        section(page, "05", "EXPRESSION", "表达式 · 先选属性");
        var g5 = grid(page);
        g5.appendChild(tile({
            icon: "wiggle", hint: { title: "抖动 wiggle", click: "添加 wiggle(3, 30)", alt: "同时在图层上加「抖动频率 / 抖动幅度」滑块并关联" },
            run: function (m) { return host("wiggle", { mods: m }); }
        }));
        g5.appendChild(tile({
            icon: "loop", hint: { title: "循环 loopOut", click: "Cycle：从头循环", alt: "Ping-Pong：来回往返", shift: "Continue：按最后速度延续", ctrl: "Offset：每次循环累加" },
            run: function (m) { return host("loop", { mods: m }); }
        }));
        g5.appendChild(tile({
            icon: "bounce", hint: { title: "弹性", click: "在关键帧后产生惯性回弹", alt: "更强的回弹" },
            run: function (m) { return host("bounce", { mods: m }); }
        }));
        g5.appendChild(tile({
            icon: "clear", hint: { title: "清除表达式", click: "清除选中属性上的表达式", alt: "清除选中图层上的全部表达式" },
            run: function (m) { return host("clearExpr", { mods: m }); }
        }));

        // (06) 合成与颜色
        section(page, "06", "COMP · COLOR", "合成 · 颜色");
        var g6 = grid(page);
        g6.appendChild(tile({
            icon: "dupComp", hint: { title: "复制合成并更新表达式", click: "复制选中的合成，把表达式里对原合成名的引用改成新合成名", alt: "复制后直接打开新合成" },
            run: function (m) { return host("dupComp", { mods: m }); }
        }));
        g6.appendChild(tile({
            icon: "colors", hint: { title: "收集颜色", click: "收集选中图层（含图层样式）里所有不重复的颜色，放进新的「颜色控制器」并自动关联", alt: "只收集颜色，不关联" },
            run: function (m) { return host("collectColors", { mods: m }); }
        }));

        // (07) 我的脚本
        var h7 = section(page, "07", "MY SCRIPTS", "我的脚本");
        h7.querySelector(".zh").id = "my-count";
        myScriptsGrid = grid(page);
        myScriptsGrid.classList.add("scripts");
        renderMyScripts();
    }

    function renderMyScripts() {
        if (!myScriptsGrid) return;
        myScriptsGrid.innerHTML = "";
        var shown = 0;
        pins.forEach(function (key) {
            var it = lib.byKey[key];
            if (!it) return;
            shown++;
            myScriptsGrid.appendChild(tile({
                icon: it.ext === "ffx" ? "preset" : "script", label: it.name, cls: "script",
                hint: function () {
                    return {
                        title: it.name + " · " + it.type,
                        click: it.ext === "ffx" ? "应用到选中图层" : "运行",
                        alt: "从工具页移除（文件保留在脚本库）",
                        shift: "在文件夹中显示",
                        note: it.desc || it.file
                    };
                },
                run: function (m) {
                    if (m.alt) { togglePin(key, false); showHint(null); return null; }
                    if (m.shift) return host("reveal", { path: it.path });
                    return runItem(it);
                }
            }));
        });
        myScriptsGrid.appendChild(tile({
            icon: "plus", cls: "add",
            hint: { title: "添加脚本", click: "选择 .jsx / .jsxbin / .ffx 文件，加入脚本库并显示在这里", note: "脚本库里已有的脚本，可以在「脚本库」页点图钉固定到这里" },
            run: function () { return addScripts(); }
        }));
        var c = $("#my-count");
        if (c) c.textContent = shown ? "我的脚本 · " + shown : "我的脚本";
    }

    // ---------------------------------------------------------------------
    // 脚本库页
    // ---------------------------------------------------------------------
    var catSel = $("#lib-cat"), qInput = $("#lib-q"), listEl = $("#lib-list");

    function renderCats() {
        var keep = catSel.value || "全部";
        catSel.innerHTML = "";
        var cats = ["全部", "已固定"].concat(lib.categories);
        if (lib.items.some(function (it) { return it.cat === "未分类"; })) cats.push("未分类");
        cats.forEach(function (c) { catSel.appendChild(new Option(c, c)); });
        catSel.value = cats.indexOf(keep) !== -1 ? keep : "全部";
    }

    function renderLibrary() {
        var cat = catSel.value || "全部", q = qInput.value.trim().toLowerCase();
        var items = lib.items.filter(function (it) {
            if (cat === "已固定" && !isPinned(it.key)) return false;
            if (cat !== "全部" && cat !== "已固定" && it.cat !== cat) return false;
            if (q && (it.name + " " + it.desc + " " + it.cat + " " + it.file).toLowerCase().indexOf(q) === -1) return false;
            return true;
        });
        listEl.innerHTML = "";
        if (!items.length) {
            listEl.appendChild(el("li", "lib-empty", lib.items.length ? "没有匹配的脚本" : "脚本库是空的，点下面的「添加脚本」开始吧"));
            return;
        }
        var lastCat = null;
        items.forEach(function (it) {
            if (cat === "全部" && it.cat !== lastCat) {
                lastCat = it.cat;
                listEl.appendChild(el("li", "lib-group", esc(it.cat.toUpperCase())));
            }
            var li = el("li", "lib-item");
            li.innerHTML =
                '<div style="min-width:0"><div class="nm">' + (isPinned(it.key) ? '<span class="pin-dot">●</span>' : "") + esc(it.name) + "</div>" +
                '<div class="ds">' + esc(it.desc || it.file) + "</div></div>" +
                '<span class="tag">' + esc(it.type) + "</span>";
            var acts = el("div", "acts");
            function act(icon, cls, h, fn) {
                var b = el("button", "act " + (cls || ""), svg(icon));
                bindHint(b, h);
                b.addEventListener("click", function (e) { e.stopPropagation(); var p = fn(mods(e)); if (p && p.then) p.then(toast); });
                acts.appendChild(b);
            }
            act("pin", isPinned(it.key) ? "on" : "", { title: isPinned(it.key) ? "从工具页取消固定" : "固定到工具页", click: "在「工具」页的 MY SCRIPTS 里显示为按钮" },
                function () { togglePin(it.key); });
            act("folder", "", { title: "在文件夹中显示" }, function () { return host("reveal", { path: it.path }); });
            act("trash", "", { title: "移除", click: "移到脚本库的 _已移除 文件夹（可手动恢复）" }, function () {
                return confirmBox("(−) — REMOVE", "从脚本库移除「" + it.name + "」？\n文件会移到 _已移除 文件夹。").then(function (ok) {
                    if (!ok) return null;
                    return host("remove", { path: it.path }).then(function (r) {
                        if (r.ok) togglePin(it.key, false);
                        return refreshLibrary().then(function () { return r; });
                    });
                });
            });
            act("play", "run", { title: "运行 " + it.name, click: it.ext === "ffx" ? "应用到选中图层" : "运行脚本" }, function () { return runItem(it); });
            li.appendChild(acts);
            bindHint(li, { title: it.name + " · " + it.cat + " · " + it.type, click: "双击运行", note: it.desc || it.file });
            li.addEventListener("dblclick", function () { runItem(it).then(toast); });
            listEl.appendChild(li);
        });
    }

    catSel.addEventListener("change", renderLibrary);
    qInput.addEventListener("input", renderLibrary);
    $("#lib-add").addEventListener("click", function () { addScripts().then(toast); });
    $("#lib-refresh").addEventListener("click", function () { refreshLibrary().then(function () { toast({ ok: true, msg: "已刷新：" + lib.items.length + " 个脚本" }); }); });
    $("#lib-open").addEventListener("click", function () { host("reveal", {}).then(toast); });
    bindHint($("#lib-add"), { title: "添加脚本", click: "选择文件加入脚本库，可同时固定到工具页" });
    bindHint($("#lib-refresh"), { title: "刷新", click: "重新扫描脚本库文件夹（直接往文件夹里放文件后点这里）" });
    bindHint($("#lib-open"), { title: "打开脚本库文件夹", click: "每个子文件夹就是一个分类" });

    // ---------------------------------------------------------------------
    // 设置页
    // ---------------------------------------------------------------------
    function updatePerm(canWrite) {
        var p = $("#set-perm");
        p.className = "status" + (canWrite ? "" : " bad");
        p.textContent = canWrite
            ? "已允许脚本写入文件，可以正常添加脚本。"
            : "未允许脚本写入文件：请到 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」。";
    }

    $("#set-change").addEventListener("click", function () {
        host("chooseLibrary").then(function (r) {
            if (!r.ok || !r.data.libPath) return toast(r);
            store.set("libPath", r.data.libPath);
            refreshLibrary().then(function () { toast({ ok: true, msg: "已切换脚本库" }); });
        });
    });
    $("#set-open").addEventListener("click", function () { host("reveal", {}).then(toast); });
    $("#set-samples").addEventListener("click", function () {
        host("importSamples").then(function (r) { toast(r); refreshLibrary(); });
    });
    $("#set-recheck").addEventListener("click", function () {
        host("status").then(function (r) { if (r.ok) updatePerm(r.data.canWrite); toast({ ok: true, msg: "已重新检查" }); });
    });
    $("#set-panels").addEventListener("click", function () { host("openPanelsFolder").then(toast); });
    bindHint($("#set-change"), { title: "更换脚本库文件夹", click: "可以选网盘同步文件夹，多台电脑共用一套脚本" });
    bindHint($("#set-samples"), { title: "导入示例", click: "把插件自带的 5 个示例脚本复制到脚本库" });
    bindHint($("#set-panels"), { title: "ScriptUI Panels", click: "打开当前 AE 版本的用户面板文件夹" });

    // ---------------------------------------------------------------------
    // 标签页
    // ---------------------------------------------------------------------
    function selectTab(name) {
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.classList.toggle("on", t.dataset.tab === name); });
        Array.prototype.forEach.call(document.querySelectorAll(".page"), function (p) { p.classList.toggle("on", p.id === "page-" + name); });
        store.set("tab", name);
    }
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
        t.addEventListener("click", function () { selectTab(t.dataset.tab); });
    });

    // 静态按钮里的图标
    Array.prototype.forEach.call(document.querySelectorAll("[data-icon]"), function (n) { n.innerHTML = svg(n.dataset.icon); });

    // ---------------------------------------------------------------------
    // 启动
    // ---------------------------------------------------------------------
    hintEl.innerHTML = IDLE;
    selectTab(store.get("tab", "tools"));
    buildTools();

    host("init", { libPath: store.get("libPath", null) }).then(function (r) {
        if (!r.ok) { toast(r); return; }
        var d = r.data;
        OS = d.os || OS;
        $("#ver").textContent = "WINDWINGS · V" + d.version;
        $("#set-about").textContent = "MOTIONHUB v" + d.version + " · AE " + d.ae;
        updatePerm(d.canWrite);
        var seed = store.get("seeded", false) ? Promise.resolve() : host("importSamples").then(function () { store.set("seeded", true); });
        return seed.then(refreshLibrary);
    });
})();
