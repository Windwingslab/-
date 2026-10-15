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
            if (CEP) CEP.evalScript(code, done);
            else done(window.MHMock ? window.MHMock(name, args) : JSON.stringify({ ok: true, msg: "（预览）" + name }));
        });
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

    function applyAccent(hex) {
        var r = document.documentElement.style;
        r.setProperty("--accent", hex);
        r.setProperty("--accent-hover", mix(hex, "#FFFFFF", 0.18));
        r.setProperty("--on-accent", onColor(hex));
    }

    function paintCell(cell, hex) {
        if (!hex) return;
        cell.style.setProperty("--c", hex);
        cell.style.setProperty("--on-c", onColor(hex));
        cell.style.setProperty("--tint-bg", mix(hex, INK, 0.86));
        cell.style.setProperty("--tint-line", mix(hex, INK, 0.55));
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
        return html;
    }
    function showHint(h) {
        hovered = h;
        if (toastTimer) return;
        hintEl.className = "hint";
        hintEl.innerHTML = hintHTML(h);
    }
    function toast(r) {
        if (!r || (!r.msg && r.ok)) return r;
        clearTimeout(toastTimer);
        hintEl.className = "hint " + (r.ok ? "ok" : "err");
        hintEl.innerHTML = '<div class="h-msg">' + esc(r.msg) + "</div>";
        toastTimer = setTimeout(function () { toastTimer = null; showHint(hovered); }, r.ok ? 2600 : 4200);
        return r;
    }
    function bindHint(node, h) {
        node.addEventListener("mouseenter", function () { if (!editing) showHint(typeof h === "function" ? h() : h); });
        node.addEventListener("mouseleave", function () { showHint(null); });
    }
    function mods(e) { return { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }; }

    // 图标方块
    function tile(o) {
        var b = el("button", "tile" + (o.cls ? " " + o.cls : "") + (o.filled ? " filled" : "") + (o.label && o.left !== false ? " left" : ""));
        b.innerHTML = (o.icon ? svg(o.icon) : "") + (o.label ? '<span class="lbl">' + esc(o.label) + "</span>" : "");
        if (o.hint) bindHint(b, o.hint);
        b.addEventListener("click", function (e) {
            if (editing) return;
            b.classList.add("flash");
            setTimeout(function () { b.classList.remove("flash"); }, 140);
            var p = o.run(mods(e));
            if (p && p.then) p.then(toast);
        });
        return b;
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
    var cfg = null, saveTimer = null, editing = false;

    function uid() { return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function H(en, zh) { return { type: "heading", en: en, zh: zh }; }
    function T(type, extra) { var o = { type: type }; for (var k in extra || {}) o[k] = extra[k]; return o; }

    var PRESETS = {
        main: {
            name: "主面板", items: [
                H("ANCHOR", "锚点"), T("anchor"), T("centerComp"), T("nullLayer"), T("precomp"),
                H("KEYFRAME", "缓动 · 关键帧"), T("ease"), T("keys"), T("graph"),
                H("ANIMATE", "快速动画 · 依次排列"), T("quick"), T("seq"),
                H("ALIGN", "对齐 · 分布"), T("alignLeft"), T("alignHCenter"), T("alignRight"), T("alignTop"), T("alignVCenter"), T("alignBottom"), T("distH"), T("distV"),
                H("LAYER", "图层"), T("adjust"), T("solid"), T("camera"), T("trim"), T("split"), T("toPlayhead"), T("reverseLayers"), T("motionBlur"), T("rename"),
                H("EXPRESSION", "表达式 · 先选属性"), T("wiggle"), T("loop"), T("bounce"), T("clearExpr"),
                H("COMP · COLOR", "合成 · 颜色"), T("dupComp"), T("colors"),
                H("MY SCRIPTS", "我的脚本")
            ]
        },
        animate: {
            name: "动画", items: [
                H("CURVE", "自定义缓动"), T("graph"), T("ease"),
                H("KEYS", "关键帧"), T("keys"),
                H("ANIMATE", "快速动画"), T("quick"), T("seq"),
                H("EXPRESSION", "表达式"), T("wiggle"), T("loop"), T("bounce"), T("clearExpr")
            ]
        },
        organize: {
            name: "整理", items: [
                H("ANCHOR", "锚点"), T("anchor"), T("centerComp"), T("nullLayer"), T("precomp"),
                H("ALIGN", "对齐"), T("alignLeft"), T("alignHCenter"), T("alignRight"), T("alignTop"), T("alignVCenter"), T("alignBottom"), T("distH"), T("distV"),
                H("LAYER", "图层"), T("adjust"), T("solid"), T("camera"), T("trim"), T("split"), T("toPlayhead"), T("reverseLayers"), T("rename"),
                H("COMP · COLOR", "合成 · 颜色"), T("dupComp"), T("colors")
            ]
        },
        scripts: { name: "我的脚本", items: [H("MY SCRIPTS", "我的脚本"), H("SNIPPETS", "代码片段")] },
        blank: { name: "", items: [H("WORKSPACE", "我的面板")] }
    };
    var PANEL_PRESET = { 1: "main", 2: "animate", 3: "organize", 4: "scripts" };

    function fromPreset(key) {
        var p = PRESETS[key];
        return {
            name: p.name || ("面板 " + PANEL),
            accent: "#FF5900",
            items: p.items.map(function (it) { var o = JSON.parse(JSON.stringify(it)); o.id = uid(); return o; })
        };
    }

    function saveConfig() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            var text = JSON.stringify(cfg);
            local.set("panel" + PANEL, cfg);
            host("saveConfig", { name: "panel" + PANEL, text: text });
        }, 250);
    }

    function loadConfig() {
        return host("loadConfig", { name: "panel" + PANEL }).then(function (r) {
            var c = null;
            try { if (r.ok && r.data && r.data.text) c = JSON.parse(r.data.text); } catch (e) {}
            if (!c) c = local.get("panel" + PANEL, null);
            if (!c || !c.items) {
                c = fromPreset(PANEL_PRESET[PANEL] || "blank");
                // 旧版「我的脚本」里固定过的脚本，搬到第一个面板
                if (PANEL === 1) local.get("pins", []).forEach(function (k) { c.items.push({ id: uid(), type: "script", key: k }); });
            }
            c.items.forEach(function (it) { if (!it.id) it.id = uid(); });
            cfg = c;
        });
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
    var CATS = ["智能组件", "锚点 · 对齐", "关键帧", "图层", "表达式", "合成 · 颜色", "结构"];

    function reg(type, def) { W[type] = def; }

    // 单个工具方块：size [宽, 高]，宽 > 1 时显示文字
    function toolType(type, o) {
        reg(type, {
            name: o.name, cat: o.cat, icon: o.icon, desc: o.hint.click, size: [o.w || 1, 1],
            render: function (cell, item) {
                cell.appendChild(tile({
                    icon: o.icon, label: (o.w || 1) > 1 ? o.name : "", filled: !!item.color,
                    hint: o.hint, run: o.run
                }));
            }
        });
    }

    function call(name, extra) {
        return function (m) {
            var a = { mods: m };
            for (var k in extra || {}) a[k] = extra[k];
            return host(name, a);
        };
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
                            icon: "anchor" + ix + iy, filled: true,
                            hint: { title: "锚点 · " + name, click: "把锚点移到图层的" + name + "，图层位置不变", alt: "同时把图层贴到合成的" + name },
                            run: call("anchor", { fx: fx, fy: fy })
                        }));
                    })(x / 2, y / 2, pos[y][x], x, y);
                }
            }
            cell.appendChild(g);
        }
    });

    toolType("centerComp", { name: "居中到合成", cat: "锚点 · 对齐", icon: "center", w: 3, hint: { title: "居中到合成", click: "锚点居中，并把图层移到合成中心", alt: "不改锚点，按外框居中" }, run: call("centerComp") });
    toolType("nullLayer", { name: "空对象", cat: "图层", icon: "nullLayer", w: 3, hint: { title: "空对象", click: "在选中图层上方新建空对象", alt: "放到选中图层中心，并设为它们的父级" }, run: call("nullLayer") });
    toolType("precomp", { name: "逐个预合成", cat: "图层", icon: "precomp", w: 3, hint: { title: "逐个预合成", click: "每个选中图层各自预合成，保留属性" }, run: call("precompEach") });

    [["alignLeft", "left", "左对齐"], ["alignHCenter", "hcenter", "水平居中"], ["alignRight", "right", "右对齐"],
     ["alignTop", "top", "顶部对齐"], ["alignVCenter", "vcenter", "垂直居中"], ["alignBottom", "bottom", "底部对齐"]].forEach(function (d) {
        toolType(d[0], { name: d[2], cat: "锚点 · 对齐", icon: d[0], hint: { title: d[2], click: d[2] + "到合成", alt: d[2] + "到选区（选中图层的整体外框）" }, run: call("align", { mode: d[1] }) });
    });
    toolType("distH", { name: "水平分布", cat: "锚点 · 对齐", icon: "distH", hint: { title: "水平分布", click: "按中心点水平均匀分布（至少 3 个图层）" }, run: call("distribute", { horizontal: true }) });
    toolType("distV", { name: "垂直分布", cat: "锚点 · 对齐", icon: "distV", hint: { title: "垂直分布", click: "按中心点垂直均匀分布（至少 3 个图层）" }, run: call("distribute", { horizontal: false }) });

    toolType("adjust", { name: "调整图层", cat: "图层", icon: "adjust", hint: { title: "调整图层", click: "在选中图层上方新建调整图层" }, run: call("addLayer", { kind: "adjust" }) });
    toolType("solid", { name: "纯色层", cat: "图层", icon: "solid", hint: { title: "纯色层", click: "新建合成大小的纯色层" }, run: call("addLayer", { kind: "solid" }) });
    toolType("camera", { name: "摄像机", cat: "图层", icon: "camera", hint: { title: "摄像机", click: "新建摄像机" }, run: call("addLayer", { kind: "camera" }) });
    toolType("trim", { name: "剪到工作区", cat: "图层", icon: "trim", hint: { title: "剪到工作区", click: "把选中图层的入点和出点剪到工作区" }, run: call("trim") });
    toolType("split", { name: "在播放头拆分", cat: "图层", icon: "split", hint: { title: "在播放头拆分", click: "把选中图层在播放头位置拆成两段" }, run: call("splitLayer") });
    toolType("toPlayhead", { name: "移到播放头", cat: "图层", icon: "toPlayhead", hint: { title: "移到播放头", click: "把选中图层的入点对齐到播放头", alt: "把出点对齐到播放头" }, run: call("toPlayhead") });
    toolType("reverseLayers", { name: "反转顺序", cat: "图层", icon: "reverse", hint: { title: "反转图层顺序", click: "反转选中图层的上下顺序" }, run: call("reverse") });
    toolType("motionBlur", { name: "运动模糊", cat: "图层", icon: "motionBlur", hint: { title: "运动模糊", click: "开 / 关选中图层的运动模糊（同时打开合成开关）" }, run: call("motionBlur") });
    toolType("rename", {
        name: "批量重命名", cat: "图层", icon: "rename", hint: { title: "批量重命名", click: "输入名称后，按 名称_01、名称_02 … 重命名" },
        run: function () {
            return ask("(R) — RENAME", "新名称（会自动加编号）", "Layer").then(function (base) { return base ? host("rename", { base: base }) : null; });
        }
    });

    toolType("easeBoth", { name: "缓入缓出", cat: "关键帧", icon: "easeBoth", hint: { title: "缓入缓出", click: "等同 F9（影响 33%）", alt: "只缓入", shift: "只缓出" }, run: function (m) { return host("ease", { mode: "both", inInfl: 33, outInfl: 33, mods: m }); } });
    toolType("linear", { name: "线性", cat: "关键帧", icon: "linear", hint: { title: "线性", click: "把选中关键帧设为线性" }, run: function (m) { return host("ease", { mode: "linear", mods: m }); } });
    toolType("hold", { name: "定格", cat: "关键帧", icon: "hold", hint: { title: "定格", click: "把选中关键帧设为定格" }, run: function (m) { return host("ease", { mode: "hold", mods: m }); } });
    toolType("cloneKeys", { name: "克隆关键帧", cat: "关键帧", icon: "cloneKeys", hint: { title: "克隆关键帧", click: "从播放头克隆选中关键帧", alt: "克隆后选中新关键帧", shift: "反向克隆" }, run: call("cloneKeys") });
    toolType("reverseKeys", { name: "反转关键帧", cat: "关键帧", icon: "reverseKeys", hint: { title: "反转关键帧", click: "把选中关键帧的时间顺序倒过来" }, run: call("keyTime", { op: "reverse" }) });

    toolType("wiggle", { name: "抖动", cat: "表达式", icon: "wiggle", hint: { title: "抖动 wiggle", click: "添加 wiggle(3, 30)", alt: "同时在图层上加「抖动频率 / 抖动幅度」滑块并关联" }, run: call("wiggle") });
    toolType("loop", { name: "循环", cat: "表达式", icon: "loop", hint: { title: "循环 loopOut", click: "Cycle：从头循环", alt: "Ping-Pong：来回往返", shift: "Continue：按最后速度延续", ctrl: "Offset：每次循环累加" }, run: call("loop") });
    toolType("bounce", { name: "弹性", cat: "表达式", icon: "bounce", hint: { title: "弹性", click: "在关键帧后产生惯性回弹", alt: "更强的回弹" }, run: call("bounce") });
    toolType("clearExpr", { name: "清除表达式", cat: "表达式", icon: "clear", hint: { title: "清除表达式", click: "清除选中属性上的表达式", alt: "清除选中图层上的全部表达式" }, run: call("clearExpr") });

    toolType("dupComp", { name: "复制合成", cat: "合成 · 颜色", icon: "dupComp", hint: { title: "复制合成并更新表达式", click: "复制选中合成，并把表达式里对原合成名的引用改成新名字", alt: "复制后直接打开新合成" }, run: call("dupComp") });
    toolType("colors", { name: "收集颜色", cat: "合成 · 颜色", icon: "colors", hint: { title: "收集颜色", click: "收集选中图层（含图层样式）里不重复的颜色，放进「颜色控制器」并自动关联", alt: "只收集，不关联" }, run: call("collectColors") });

    // —— 智能组件：缓动 ——
    function widgetBox(cell, head, right) {
        var w = el("div", "widget");
        w.appendChild(el("div", "w-head", esc(head) + (right ? '<span class="r">' + esc(right) + "</span>" : "")));
        cell.appendChild(w);
        return w;
    }
    function row(parent) { var r = el("div", "w-row"); parent.appendChild(r); return r; }

    function sliderRow(parent, label, item, key, def, hint) {
        var r = row(parent);
        r.appendChild(el("span", "k", label));
        var range = el("input");
        range.type = "range"; range.min = 1; range.max = 100;
        range.value = item[key] || def;
        var num = numInput(range.value, function (n) {
            var v = Math.max(1, Math.min(100, parseFloat(n.value) || def));
            n.value = v; range.value = v; item[key] = v; saveConfig();
        });
        range.addEventListener("input", function () { num.value = range.value; item[key] = +range.value; });
        range.addEventListener("change", saveConfig);
        r.appendChild(range);
        r.appendChild(num);
        bindHint(r, hint);
    }

    reg("ease", {
        name: "缓动", cat: "智能组件", icon: "easeBoth", desc: "IN / OUT 影响滑块 + 缓动、线性、定格", size: "full",
        render: function (cell, item) {
            var w = widgetBox(cell, "EASE · 缓动", "影响 %");
            var h = { title: "缓动影响 %", click: "数值越大曲线越陡，AE 默认 33", note: "IN 控制进入关键帧，OUT 控制离开关键帧" };
            sliderRow(w, "IN", item, "inInfl", 33, h);
            sliderRow(w, "OUT", item, "outInfl", 33, h);
            var r = row(w);
            var args = function (mode, m) { return { mode: mode, inInfl: item.inInfl || 33, outInfl: item.outInfl || 33, mods: m }; };
            r.appendChild(tile({ icon: "easeBoth", label: "缓入缓出", left: false, cls: "grow", filled: true, hint: { title: "缓入缓出", click: "按上面的影响值应用（相当于 F9）", alt: "只缓入", shift: "只缓出" }, run: function (m) { return host("ease", args("both", m)); } }));
            r.appendChild(tile({ icon: "linear", hint: { title: "线性", click: "把选中关键帧设为线性" }, run: function (m) { return host("ease", args("linear", m)); } }));
            r.appendChild(tile({ icon: "hold", hint: { title: "定格", click: "把选中关键帧设为定格" }, run: function (m) { return host("ease", args("hold", m)); } }));
        }
    });

    // —— 智能组件：自定义缓动曲线 ——
    var BEZ_PRESETS = [
        ["平滑", [0.45, 0, 0.55, 1]], ["三次", [0.65, 0, 0.35, 1]], ["五次", [0.83, 0, 0.17, 1]], ["指数", [0.87, 0, 0.13, 1]],
        ["缓出", [0.22, 1, 0.36, 1]], ["缓入", [0.64, 0, 0.78, 0]], ["回弹", [0.34, 1.56, 0.64, 1]], ["预备", [0.36, 0, 0.66, -0.56]]
    ];

    reg("graph", {
        name: "缓动曲线", cat: "智能组件", icon: "graph", desc: "拖动手柄编辑贝塞尔曲线，一键应用到关键帧", size: "full",
        render: function (cell, item) {
            var b = item.bz || [0.65, 0, 0.35, 1];
            var w = widgetBox(cell, "CURVE · 缓动曲线", "拖动手柄");
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
            var val = el("span", "bz-val");
            var presetBox = el("div", "presets");

            function draw() {
                curve.setAttribute("d", "M" + X(0) + " " + Y(0) + " C" + X(b[0]) + " " + Y(b[1]) + " " + X(b[2]) + " " + Y(b[3]) + " " + X(1) + " " + Y(1));
                h1.setAttribute("cx", X(b[0])); h1.setAttribute("cy", Y(b[1]));
                h2.setAttribute("cx", X(b[2])); h2.setAttribute("cy", Y(b[3]));
                arm1.setAttribute("x1", X(0)); arm1.setAttribute("y1", Y(0)); arm1.setAttribute("x2", X(b[0])); arm1.setAttribute("y2", Y(b[1]));
                arm2.setAttribute("x1", X(1)); arm2.setAttribute("y1", Y(1)); arm2.setAttribute("x2", X(b[2])); arm2.setAttribute("y2", Y(b[3]));
                val.textContent = "(" + b.map(function (v) { return Math.round(v * 100) / 100; }).join(", ") + ")";
                $$(".preset", presetBox).forEach(function (p, k) { p.classList.toggle("on", BEZ_PRESETS[k][1].join() === b.join()); });
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
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                        item.bz = b.slice(); saveConfig();
                    }
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                };
            }
            h1.addEventListener("pointerdown", drag(0));
            h2.addEventListener("pointerdown", drag(2));
            BEZ_PRESETS.forEach(function (p) {
                var btn = el("button", "preset", esc(p[0]));
                bindHint(btn, { title: "预设 · " + p[0], click: "cubic-bezier(" + p[1].join(", ") + ")" });
                btn.addEventListener("click", function () { if (editing) return; b = p[1].slice(); item.bz = b.slice(); draw(); saveConfig(); });
                presetBox.appendChild(btn);
            });
            wrap.appendChild(g);
            wrap.appendChild(presetBox);
            w.appendChild(wrap);
            var r = row(w);
            r.appendChild(val);
            r.appendChild(tile({
                icon: "play", label: "应用", left: false, cls: "grow", filled: true,
                hint: { title: "应用曲线", click: "把曲线应用到选中的关键帧（每两个相邻关键帧之间算一段）", alt: "镜像应用（进出对调）", note: "只选一个关键帧时，应用到它和下一个关键帧之间" },
                run: function (m) { return host("bezier", { bezier: b, mods: m }); }
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
                icon: "copyKeys", hint: { title: "复制关键帧", click: "复制选中的关键帧（可以跨多个属性）" },
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
            r2.appendChild(tile({ icon: "stretchKeys", hint: { title: "拉伸关键帧", click: "以第一个选中关键帧为起点，按倍数拉长间隔", alt: "按倍数压缩" }, run: function (m) { return host("keyTime", { op: "stretch", factor: item.factor || 1.5, mods: m }); } }));

            var r3 = row(w);
            var frames = numInput(item.frames || 1, function (n) { item.frames = Math.max(1, parseInt(n.value, 10) || 1); n.value = item.frames; saveConfig(); });
            var nudge = function (dir) { return function (m) { return host("keyTime", { op: "nudge", dir: dir, frames: item.frames || 1, mods: m }); }; };
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
                return function () { return host("quickAnim", { kind: item.kind || "fade", dir: item.dir || "left", frames: item.frames || 12, mods: { alt: out } }); };
            };
            r.appendChild(tile({ icon: "arrowRight", label: "入场", left: false, cls: "grow", filled: true, hint: { title: "入场动画", click: "从播放头开始，给选中图层做入场动画" }, run: run(false) }));
            r.appendChild(tile({ icon: "arrowLeft", label: "出场", left: false, cls: "grow", hint: { title: "出场动画", click: "在播放头结束，给选中图层做出场动画" }, run: run(true) }));
        }
    });

    // —— 智能组件：依次排列 Num / Step ——
    reg("seq", {
        name: "依次排列", cat: "智能组件", icon: "seqForward", desc: "Num 个一组、Step 帧间隔，四种顺序", size: "full",
        render: function (cell, item) {
            var w = widgetBox(cell, "SEQUENCE · 依次排列");
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
            [["forward", "seqForward", "正序"], ["reverse", "seqReverse", "倒序"], ["center", "seqCenter", "从中间向两边"], ["random", "seqRandom", "随机"]].forEach(function (o, i) {
                var t = tile({
                    icon: o[1], filled: i === 0, hint: { title: "依次排列 · " + o[2], click: "按" + o[2] + "错开选中图层", note: "顺序以你选择图层的先后为准" },
                    run: function (m) { return host("sequence", { order: o[0], num: item.num || 1, step: item.step === undefined ? 2 : item.step, mods: m }); }
                });
                t.classList.add("grow");
                r2.appendChild(t);
            });
        }
    });

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
            var name = s ? s.name : "（已删除的片段）";
            cell.appendChild(tile({
                icon: s && s.kind === "expr" ? "exprSnippet" : "codeSnippet", label: name, cls: "script", filled: !!item.color,
                hint: function () {
                    if (!s) return { title: name };
                    return s.kind === "expr"
                        ? { title: name + " · 表达式", click: "应用到选中属性", alt: "追加到已有表达式后面", note: s.code.split("\n")[0] }
                        : { title: name + " · 脚本", click: "执行", note: s.code.split("\n")[0] };
                },
                run: function (m) { return s ? runSnippet(s, m) : Promise.resolve({ ok: false, msg: "这个片段已经被删除" }); }
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
            def.render(cell, item);
            if (editing) decorateEditable(cell, item, def);
            layoutEl.appendChild(cell);
        });
        if (!editing) {
            var add = el("div", "cell");
            add.appendChild(tile({ icon: "plus", cls: "add", hint: { title: "添加", click: "往这个面板添加组件、工具、脚本或代码片段" }, run: function () { openCatalog(); return null; } }));
            layoutEl.appendChild(add);
        }
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
                if (d.cat !== cat) return;
                list.appendChild(item(d.icon, d.name, d.desc, sizeLabel(d.size), function () {
                    addItem(type === "heading" ? { type: type, en: "SECTION", zh: "新分组" } : { type: type });
                }));
            });
            nodes.push(el("div", "cat-title", esc(cat)), list);
        });
        var sl = el("div", "cat-list");
        lib.items.forEach(function (it) {
            sl.appendChild(item(it.ext === "ffx" ? "preset" : "script", it.name, it.cat + " · " + it.type, "3×1", function () { addItem({ type: "script", key: it.key }); }));
        });
        if (!lib.items.length) sl.appendChild(el("div", "muted", "脚本库是空的，可以在「脚本库」页添加"));
        nodes.push(el("div", "cat-title", "我的脚本"), sl);
        var cl = el("div", "cat-list");
        snippets.forEach(function (s) {
            cl.appendChild(item(s.kind === "expr" ? "exprSnippet" : "codeSnippet", s.name, s.kind === "expr" ? "表达式" : "脚本", "3×1", function () { addItem({ type: "snippet", sid: s.id }); }));
        });
        nodes.push(el("div", "cat-title", "代码片段"), cl);
        dialog("(+) — ADD TO PANEL " + PANEL, nodes, [{ label: "关闭", value: function () { return null; } }]);
    }

    // =====================================================================
    // 脚本库
    // =====================================================================
    var lib = { items: [], categories: [], byKey: {}, libPath: "" };

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
        var files = Array.prototype.filter.call(e.dataTransfer.files, function (f) { return /\.(jsx|jsxbin|ffx)$/i.test(f.name); });
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
                var bad = rs.filter(function (r) { return !r.ok; });
                if (bad.length) { toast(bad[0]); return; }
                afterInstall(rs.map(function (r) { return r.data.key; }), v).then(function () {
                    toast({ ok: true, msg: "已添加 " + rs.length + " 个文件" + (v.pin ? "，并放到了当前面板" : "") });
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

    function act(parent, icon, cls, h, fn) {
        var b = el("button", "act " + (cls || ""), svg(icon));
        bindHint(b, h);
        b.addEventListener("click", function (e) { e.stopPropagation(); var p = fn(mods(e)); if (p && p.then) p.then(toast); });
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
            li.addEventListener("dblclick", function () { host("run", { path: it.path }).then(toast); });
            listEl.appendChild(li);
        });
    }

    catSel.addEventListener("change", renderLibrary);
    qInput.addEventListener("input", renderLibrary);
    $("#lib-add").addEventListener("click", function () { addScripts().then(toast); });
    $("#lib-refresh").addEventListener("click", function () { refreshLibrary().then(function () { toast({ ok: true, msg: "已刷新：" + lib.items.length + " 个脚本" }); }); });
    $("#lib-open").addEventListener("click", function () { host("reveal", {}).then(toast); });
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
        { kind: "expr", name: "循环抖动", code: "freq = 2; amp = 40; loopTime = 3;\nt = time % loopTime;\nw1 = wiggle(freq, amp, 1, 0.5, t);\nw2 = wiggle(freq, amp, 1, 0.5, t - loopTime);\nlinear(t, 0, loopTime, w1, w2)" },
        { kind: "expr", name: "匀速旋转", code: "value + time * 90" },
        { kind: "expr", name: "闪烁", code: "Math.sin(time * 20) > 0 ? 100 : 0" },
        { kind: "expr", name: "跟随父级延迟", code: "delay = 0.1;\nthisLayer.parent ? parent.transform.position.valueAtTime(time - delay) : value" },
        { kind: "script", name: "随机颜色标签", code: "var c = app.project.activeItem;\nif (c instanceof CompItem) {\n    var l = c.selectedLayers;\n    for (var i = 0; i < l.length; i++) l[i].label = 1 + Math.floor(Math.random() * 16);\n}" },
        { kind: "script", name: "切换 3D 图层", code: "var c = app.project.activeItem;\nif (c instanceof CompItem) {\n    var l = c.selectedLayers;\n    for (var i = 0; i < l.length; i++) l[i].threeDLayer = !l[i].threeDLayer;\n}" }
    ];

    function snippetById(id) { for (var i = 0; i < snippets.length; i++) if (snippets[i].id === id) return snippets[i]; return null; }
    function saveSnippets() { local.set("snippets", snippets); return host("saveSnippets", { text: JSON.stringify(snippets, null, 2) }); }
    function loadSnippets() {
        return host("loadSnippets").then(function (r) {
            var s = null;
            try { if (r.ok && r.data && r.data.text) s = JSON.parse(r.data.text); } catch (e) {}
            if (!s) s = local.get("snippets", null);
            if (!s) {
                s = DEFAULT_SNIPPETS.map(function (d) { return { id: uid(), kind: d.kind, name: d.name, code: d.code }; });
                snippets = s;
                saveSnippets();
            }
            snippets = s;
            renderSnippets();
        });
    }
    function runSnippet(s, m) {
        return s.kind === "expr" ? host("applyExpr", { code: s.code, name: s.name, mods: m }) : host("runCode", { code: s.code, name: s.name, mods: m });
    }

    function editSnippet(s, kind) {
        var isNew = !s;
        s = s || { id: uid(), kind: kind, name: "", code: "" };
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
            s.name = v.name; s.kind = v.kind; s.code = v.code;
            if (isNew) snippets.push(s);
            return saveSnippets().then(function () {
                renderSnippets(); renderLayout();
                return { ok: true, msg: (isNew ? "已新建" : "已保存") + "「" + s.name + "」" };
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
            var list = snippets.filter(function (s) { return s.kind === g[0]; });
            if (!list.length) ul.appendChild(el("li", "lib-empty", "还没有片段，点右边的 ＋ 新建"));
            list.forEach(function (s) {
                var li = el("li", "lib-item");
                li.innerHTML = '<div style="min-width:0"><div class="nm">' + esc(s.name) + '</div><div class="ds mono">' + esc(s.code.split("\n")[0]) + "</div></div>";
                var acts = el("div", "acts");
                var here = onPanel("snippet", "sid", s.id);
                act(acts, here ? "close" : "pin", "", { title: here ? "从当前面板移除" : "放到当前面板" }, function () {
                    var added = togglePanel("snippet", "sid", s.id);
                    renderSnippets();
                    return Promise.resolve({ ok: true, msg: added ? "已放到当前面板" : "已从当前面板移除" });
                });
                act(acts, "pencil", "", { title: "编辑" }, function () { return editSnippet(s); });
                act(acts, "trash", "", { title: "删除" }, function () {
                    return confirmBox("(−) — DELETE", "删除片段「" + s.name + "」？").then(function (ok) {
                        if (!ok) return null;
                        snippets.splice(snippets.indexOf(s), 1);
                        return saveSnippets().then(function () { renderSnippets(); renderLayout(); return { ok: true, msg: "已删除" }; });
                    });
                });
                act(acts, "play", "run", s.kind === "expr" ? { title: "应用表达式", click: "应用到选中属性", alt: "追加到已有表达式后面" } : { title: "执行脚本" }, function (m) { return runSnippet(s, m); });
                li.appendChild(acts);
                li.addEventListener("dblclick", function () { runSnippet(s, {}).then(toast); });
                ul.appendChild(li);
            });
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
        [["main", "主面板：全部工具"], ["animate", "动画：曲线 · 关键帧 · 快速动画"], ["organize", "整理：锚点 · 对齐 · 图层"], ["scripts", "我的脚本"], ["blank", "空白"]].forEach(function (p) { sel.appendChild(new Option(p[1], p[0])); });
        lab.appendChild(sel);
        dialog("(◇) — PRESET LAYOUT", [lab], [
            { label: "取消", value: function () { return null; } },
            { label: "载入", accent: true, value: function () { return sel.value; } }
        ]).then(function (key) {
            if (!key) return;
            var keepName = cfg.name, keepAccent = cfg.accent;
            cfg = fromPreset(key);
            cfg.name = keepName; cfg.accent = keepAccent;
            saveConfig(); renderLayout(); selectTab("panel");
            toast({ ok: true, msg: "已载入预设布局" });
        });
    });

    function updatePerm(canWrite) {
        var p = $("#set-perm");
        p.className = "status" + (canWrite ? "" : " bad");
        p.textContent = canWrite ? "已允许脚本写入文件，可以正常添加脚本。" : "未允许脚本写入文件：请到 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」。";
    }
    $("#set-change").addEventListener("click", function () {
        host("chooseLibrary").then(function (r) {
            if (!r.ok || !r.data.libPath) return toast(r);
            Promise.all([refreshLibrary(), loadSnippets()]).then(function () { toast({ ok: true, msg: "已切换脚本库（所有面板共用）" }); });
        });
    });
    $("#set-open").addEventListener("click", function () { host("reveal", {}).then(toast); });
    $("#set-samples").addEventListener("click", function () { host("importSamples").then(function (r) { toast(r); refreshLibrary(); }); });
    $("#set-recheck").addEventListener("click", function () { host("status").then(function (r) { if (r.ok) updatePerm(r.data.canWrite); toast({ ok: true, msg: "已重新检查" }); }); });
    $("#set-panels").addEventListener("click", function () { host("openPanelsFolder").then(toast); });

    // =====================================================================
    // 标签页 + 启动
    // =====================================================================
    function selectTab(name) {
        $$(".tab").forEach(function (t) { t.classList.toggle("on", t.dataset.tab === name); });
        $$(".page").forEach(function (p) { p.classList.toggle("on", p.id === "page-" + name); });
        local.set("tab" + PANEL, name);
        if (name !== "panel" && editing) setEditing(false);
    }
    $$(".tab").forEach(function (t) { t.addEventListener("click", function () { selectTab(t.dataset.tab); }); });
    $$("[data-icon]").forEach(function (n) { n.innerHTML = svg(n.dataset.icon); });

    hintEl.innerHTML = IDLE;
    selectTab(local.get("tab" + PANEL, "panel"));

    loadConfig().then(function () {
        applyAccent(cfg.accent || "#FF5900");
        $("#panel-name").textContent = cfg.name;
        renderLayout();
        renderSettings();
        return host("init", {});
    }).then(function (r) {
        if (!r || !r.ok) { toast(r); return; }
        var d = r.data;
        OS = d.os || OS;
        $("#set-about").textContent = "MOTIONHUB v" + d.version + " · 面板 " + PANEL + " · AE " + d.ae;
        updatePerm(d.canWrite);
        var seed = local.get("seeded", false) ? Promise.resolve() : host("importSamples").then(function () { local.set("seeded", true); });
        return seed.then(function () { return Promise.all([loadSnippets(), refreshLibrary()]); });
    });
})();
