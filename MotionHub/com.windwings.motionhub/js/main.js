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
    var host = B.host;

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
        if (h.na) html += '<div class="na-line">现在不可用：' + esc(h.na) + "（仍然可以点，AE 会再检查一次）</div>";
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

    var PRESETS = {
        main: {
            name: "主面板", items: [
                H("CREATE", "新建图层"), T("create"), T("studio"),
                H("ANCHOR", "锚点"), T("anchor"), T("centerComp"), T("nullLayer"), T("precomp"),
                H("KEYFRAME", "缓动 · 关键帧"), T("ease"), T("keys"), T("graph"),
                H("ANIMATE", "快速动画 · 依次排列"), T("quick"), T("seq"),
                H("BEAT", "音乐节拍"), T("beat"),
                H("STYLE · EFFECTS", "样式 · 效果"), T("style"), T("effects"),
                H("WIREFRAME", "线框叠加"), T("wire"),
                H("ALIGN", "对齐 · 分布"), T("alignLeft"), T("alignHCenter"), T("alignRight"), T("alignTop"), T("alignVCenter"), T("alignBottom"), T("distH"), T("distV"),
                H("LAYER", "图层"), T("decompose"), T("dupPrecomp"), T("smartRename"), T("chain"), T("trim"), T("split"), T("toPlayhead"), T("reverseLayers"), T("motionBlur"), T("rename"),
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
                H("BEAT", "音乐节拍"), T("beat"),
                H("WIREFRAME", "线框叠加"), T("wire"),
                H("EXPRESSION", "表达式"), T("wiggle"), T("loop"), T("bounce"), T("clearExpr")
            ]
        },
        organize: {
            name: "整理", items: [
                H("ANCHOR", "锚点"), T("anchor"), T("centerComp"), T("nullLayer"), T("precomp"),
                H("ALIGN", "对齐"), T("alignLeft"), T("alignHCenter"), T("alignRight"), T("alignTop"), T("alignVCenter"), T("alignBottom"), T("distH"), T("distV"),
                H("CREATE", "新建图层"), T("create"),
                H("LAYER", "图层"), T("decompose"), T("dupPrecomp"), T("smartRename"), T("chain"), T("trim"), T("split"), T("toPlayhead"), T("reverseLayers"), T("rename"),
                H("STYLE · EFFECTS", "样式 · 效果"), T("style"), T("effects"),
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
            if (cfgSynced) host("saveConfig", { name: "panel" + PANEL, text: text });
            else cfgDirty = true;   // 没连上磁盘时的改动，恢复连接后推到磁盘
        }, 250);
    }

    function loadConfig() {
        return host("loadConfig", { name: "panel" + PANEL }).then(function (r) {
            var c = null, bad = false;
            try { if (r.ok && r.data && r.data.text) c = JSON.parse(r.data.text); } catch (e) { bad = true; }
            cfgSynced = r.ok && !bad;
            cfgBad = bad;
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
    var CATS = ["智能组件", "新建", "锚点 · 对齐", "关键帧", "图层", "表达式", "合成 · 颜色", "结构"];

    function reg(type, def) { W[type] = def; }

    // 单个工具方块：size [宽, 高]，宽 > 1 时显示文字
    function toolType(type, o) {
        reg(type, {
            name: o.name, cat: o.cat, icon: o.icon, desc: o.hint.click, size: [o.w || 1, 1], run: o.run, hint: o.hint,
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
    toolType("trim", { name: "剪到工作区", cat: "图层", icon: "trim", hint: { title: "剪到工作区", click: "把选中图层的入点和出点剪到工作区", alt: "只把入点剪到播放头" }, run: call("trim") });
    toolType("split", { name: "在播放头拆分", cat: "图层", icon: "split", hint: { title: "在播放头拆分", click: "把选中图层在播放头位置拆成两段" }, run: call("splitLayer") });
    toolType("toPlayhead", { name: "移到播放头", cat: "图层", icon: "toPlayhead", hint: { title: "移到播放头", click: "把选中图层的入点对齐到播放头", alt: "把出点对齐到播放头" }, run: call("toPlayhead") });
    toolType("reverseLayers", { name: "反转顺序", cat: "图层", icon: "reverse", hint: { title: "反转图层顺序", click: "反转选中图层的上下顺序" }, run: call("reverse") });
    toolType("motionBlur", { name: "运动模糊", cat: "图层", icon: "motionBlur", hint: { title: "运动模糊", click: "开 / 关选中图层的运动模糊（同时打开合成开关）" }, run: call("motionBlur") });
    toolType("rename", {
        name: "批量重命名", cat: "图层", icon: "rename", needs: "layer", hint: { title: "批量重命名", click: "输入名称后，按 名称_01、名称_02 … 重命名" },
        run: function () {
            return ask("(R) — RENAME", "新名称（会自动加编号）", "Layer").then(function (base) { return base ? host("rename", { base: base }) : null; });
        }
    });

    toolType("easeBoth", { name: "缓入缓出", cat: "关键帧", icon: "easeBoth", hint: { title: "缓入缓出", click: "等同 F9（影响 33%）", alt: "只缓入", shift: "只缓出" }, needs: NEEDS.ease, run: function (m) { return host("ease", { mode: "both", inInfl: 33, outInfl: 33, mods: m }); } });
    toolType("linear", { name: "线性", cat: "关键帧", icon: "linear", hint: { title: "线性", click: "把选中关键帧设为线性" }, needs: NEEDS.ease, run: function (m) { return host("ease", { mode: "linear", mods: m }); } });
    toolType("hold", { name: "定格", cat: "关键帧", icon: "hold", hint: { title: "定格", click: "把选中关键帧设为定格" }, needs: NEEDS.ease, run: function (m) { return host("ease", { mode: "hold", mods: m }); } });
    toolType("cloneKeys", { name: "克隆关键帧", cat: "关键帧", icon: "cloneKeys", hint: { title: "克隆关键帧", click: "从播放头克隆选中关键帧", alt: "克隆后选中新关键帧", shift: "反向克隆" }, run: call("cloneKeys") });
    toolType("reverseKeys", { name: "反转关键帧", cat: "关键帧", icon: "reverseKeys", hint: { title: "反转关键帧", click: "把选中关键帧的时间顺序倒过来" }, run: call("keyTime", { op: "reverse" }) });

    toolType("wiggle", { name: "抖动", cat: "表达式", icon: "wiggle", hint: { title: "抖动 wiggle", click: "添加 wiggle(3, 30)", alt: "同时在图层上加「抖动频率 / 抖动幅度」滑块并关联" }, run: call("wiggle") });
    toolType("loop", { name: "循环", cat: "表达式", icon: "loop", hint: { title: "循环 loopOut", click: "Cycle：从头循环", alt: "Ping-Pong：来回往返", shift: "Continue：按最后速度延续", ctrl: "Offset：每次循环累加" }, run: call("loop") });
    toolType("bounce", { name: "弹性", cat: "表达式", icon: "bounce", hint: { title: "弹性", click: "在关键帧后产生惯性回弹", alt: "更强的回弹" }, run: call("bounce") });
    toolType("clearExpr", { name: "清除表达式", cat: "表达式", icon: "clear", hint: { title: "清除表达式", click: "清除选中属性上的表达式", alt: "清除选中图层上的全部表达式" }, run: call("clearExpr") });

    toolType("dupComp", { name: "复制合成", cat: "合成 · 颜色", icon: "dupComp", hint: { title: "复制合成并更新表达式", click: "复制选中合成，并把表达式里对原合成名的引用改成新名字", alt: "复制后直接打开新合成" }, run: call("dupComp") });
    // 新建图层（单个按钮版，也可以用整行的「新建图层」组件）
    var CREATE = [
        ["text", "textLayer", "文字"], ["shape", "shapeLayer", "形状"], ["solid", "solid", "纯色"], ["adjust", "adjust", "调整图层"],
        ["null", "nullLayer", "空对象"], ["camera", "camera", "摄像机"], ["light", "light", "灯光"]
    ];
    toolType("textLayer", { name: "文字图层", cat: "新建", icon: "textLayer", hint: { title: "文字图层", click: "在合成中心新建文字图层" }, run: call("addLayer", { kind: "text" }) });
    toolType("shapeLayer", { name: "形状图层", cat: "新建", icon: "shapeLayer", hint: { title: "形状图层", click: "新建带矩形和填充的形状图层" }, run: call("addLayer", { kind: "shape" }) });
    toolType("light", { name: "灯光", cat: "新建", icon: "light", hint: { title: "灯光", click: "新建灯光" }, run: call("addLayer", { kind: "light" }) });

    toolType("decompose", { name: "解散预合成", cat: "图层", icon: "decompose", hint: { title: "解散预合成", click: "把预合成里的图层放回当前合成，画面位置保持不变", alt: "同时删除项目里不再使用的原合成", note: "预合成图层自己有变换时，会用一个空对象接住它" }, run: call("decompose") });
    toolType("dupPrecomp", { name: "复制预合成（独立）", cat: "图层", icon: "dupPrecomp", hint: { title: "复制预合成（独立副本）", click: "复制图层，并换成一份独立的合成副本，改副本不会影响原来的", alt: "连里面嵌套的预合成也一起独立复制", shift: "不新建图层，直接把当前图层换成独立副本" }, run: call("dupPrecomp") });
    toolType("smartRename", { name: "智能重命名", cat: "图层", icon: "smartRename", hint: { title: "智能重命名", click: "按图层内容自动起名：文字用文字内容，素材用文件名，调整层用第一个效果名", alt: "重命名合成里的全部图层", shift: "名字前加上类型，例如 [文字] 标题" }, run: call("smartRename") });
    toolType("chain", { name: "首尾相接", cat: "图层", icon: "chain", hint: { title: "首尾相接", click: "按选择顺序把图层一个接一个排开", alt: "从播放头开始排", shift: "倒序" }, run: call("chain", { gap: 0 }) });

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
            r.appendChild(tile({ icon: "easeBoth", label: "缓入缓出", left: false, cls: "grow", filled: true, hint: { title: "缓入缓出", click: "按上面的影响值应用（相当于 F9）", alt: "只缓入", shift: "只缓出" }, needs: NEEDS.ease, run: function (m) { return host("ease", args("both", m)); } }));
            r.appendChild(tile({ icon: "linear", hint: { title: "线性", click: "把选中关键帧设为线性" }, needs: NEEDS.ease, run: function (m) { return host("ease", args("linear", m)); } }));
            r.appendChild(tile({ icon: "hold", hint: { title: "定格", click: "把选中关键帧设为定格" }, needs: NEEDS.ease, run: function (m) { return host("ease", args("hold", m)); } }));
        }
    });

    // —— 智能组件：自定义缓动曲线 ——
    // 用户自己保存的曲线，存在共享配置 curves.json 里
    var userCurves = [];
    function saveCurves() { local.set("curves", userCurves); host("saveConfig", { name: "curves", text: JSON.stringify(userCurves) }); }
    function loadCurves() {
        return host("loadConfig", { name: "curves" }).then(function (r) {
            var c = null;
            try { if (r.ok && r.data && r.data.text) c = JSON.parse(r.data.text); } catch (e) {}
            userCurves = c || local.get("curves", []);
        });
    }

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
                        userCurves.splice(i - BEZ_PRESETS.length, 1);
                        saveCurves(); renderLayout();
                        toast({ ok: true, msg: "已删除预设「" + p[0] + "」" });
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
                        userCurves.push([name, b.slice()]);
                        saveCurves(); renderLayout();
                        return { ok: true, msg: "已保存预设「" + name + "」" };
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
                    needs: NEEDS.sequence, run: function (m) { return host("sequence", { order: o[0], num: item.num || 1, step: item.step === undefined ? 2 : item.step, mods: m }); }
                });
                t.classList.add("grow");
                r2.appendChild(t);
            });
        }
    });

    // —— 智能组件：新建图层 ——
    reg("create", {
        name: "新建图层", cat: "新建", icon: "textLayer", desc: "文字、形状、纯色、调整、空对象、摄像机、灯光一键新建", size: "full",
        render: function (cell) {
            var r = el("div", "w-row create-row");
            CREATE.forEach(function (c) {
                var t = tile({ icon: c[1], hint: { title: "新建" + c[2], click: "在选中图层上方新建" + c[2] }, run: call("addLayer", { kind: c[0] }) });
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
        name: "音乐节拍", cat: "智能组件", icon: "beat", desc: "分析音频节拍：加标记、吸附图层、按节拍排列", size: "full",
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
            var every = numInput(item.every || 1, function (n) { item.every = Math.max(1, parseInt(n.value, 10) || 1); n.value = item.every; saveConfig(); });
            bindHint(every, { title: "每几拍", click: "按节拍排列时，每个图层占几拍" });
            r2.appendChild(every);
            r2.appendChild(el("span", "unit", "拍"));
            r2.appendChild(tile({ icon: "seqForward", hint: { title: "按节拍排列", click: "按选择顺序，从播放头后的第一拍开始，每隔 N 拍放一个图层", alt: "同时把每个图层的出点剪到下一个位置（卡点剪辑）" }, needs: NEEDS.beatLayers, run: function (m) { return host("beatLayers", { index: beat.info.index, times: times(), mode: "sequence", every: item.every || 1, mods: m }); } }));
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
            var name = s ? s.name : "（已删除的片段）";
            cell.appendChild(tile({
                icon: s && s.kind === "expr" ? "exprSnippet" : "codeSnippet", label: name, cls: "script", filled: !!item.color,
                needs: s && s.kind === "expr" ? NEEDS.applyExpr : "",
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
            if (!r.ok) throw new Error(r.msg);
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
                    var r = { ok: true, msg: "已添加 " + rs.length + " 个文件" + (v.pin ? "，并放到了当前面板" : "") };
                    B.show(null, "ok", r.msg); toast(r);
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
        { kind: "expr", name: "循环抖动", code: "freq = 2; amp = 40; loopTime = 3;\nt = time % loopTime;\nw1 = wiggle(freq, amp, 1, 0.5, t);\nw2 = wiggle(freq, amp, 1, 0.5, t - loopTime);\nlinear(t, 0, loopTime, w1, w2)" },
        { kind: "expr", name: "匀速旋转", code: "value + time * 90" },
        { kind: "expr", name: "闪烁", code: "Math.sin(time * 20) > 0 ? 100 : 0" },
        { kind: "expr", name: "跟随父级延迟", code: "delay = 0.1;\nthisLayer.parent ? parent.transform.position.valueAtTime(time - delay) : value" },
        { kind: "script", name: "随机颜色标签", code: "var c = app.project.activeItem;\nif (c instanceof CompItem) {\n    var l = c.selectedLayers;\n    for (var i = 0; i < l.length; i++) l[i].label = 1 + Math.floor(Math.random() * 16);\n}" },
        { kind: "script", name: "切换 3D 图层", code: "var c = app.project.activeItem;\nif (c instanceof CompItem) {\n    var l = c.selectedLayers;\n    for (var i = 0; i < l.length; i++) l[i].threeDLayer = !l[i].threeDLayer;\n}" }
    ];

    function snippetById(id) { for (var i = 0; i < snippets.length; i++) if (snippets[i].id === id) return snippets[i]; return null; }
    // 没从磁盘读到片段时（后台没连上 / 文件损坏）只存本机缓存，不覆盖磁盘上的文件
    function saveSnippets() {
        local.set("snippets", snippets);
        if (snippetsSynced) return host("saveSnippets", { text: JSON.stringify(snippets, null, 2) });
        snippetsDirty = true;
        return Promise.resolve({ ok: true });
    }
    var snippetsSynced = false, snippetsBad = false, snippetsDirty = false;
    function loadSnippets() {
        return host("loadSnippets").then(function (r) {
            var s = null, bad = false;
            try { if (r.ok && r.data && r.data.text) s = JSON.parse(r.data.text); } catch (e) { bad = true; }
            snippetsSynced = r.ok && !bad;
            snippetsBad = bad;
            if (!s) s = local.get("snippets", null);
            if (!s && !snippetsSynced) { snippets = []; renderSnippets(); throw new Error(r.ok ? "代码片段文件损坏，已保留原文件没有改动" : r.msg); }
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
                li.addEventListener("dblclick", function (e) { if (rowDblclick(e)) act0(li, function () { return runSnippet(s, {}); }); });
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
            B.show(null, "ok", "已载入预设布局");
            toast({ ok: true, msg: "已载入预设布局" });
        });
    });

    function updatePerm(canWrite) {
        var p = $("#set-perm");
        p.className = "status" + (canWrite ? "" : " bad");
        p.textContent = canWrite ? "已允许脚本写入文件，可以正常添加脚本。" : "未允许脚本写入文件：请到 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」。";
    }
    $("#set-change").addEventListener("click", function () {
        act0(this, function () {
            return host("chooseLibrary").then(function (r) {
                if (!r.ok || !r.data || !r.data.libPath) return r.ok ? null : r;
                return Promise.all([refreshLibrary(), loadSnippets()]).then(function () { return { ok: true, msg: "已切换脚本库（所有面板共用）" }; });
            });
        });
    });
    $("#set-open").addEventListener("click", function () { act0(this, function () { return host("reveal", {}); }); });
    $("#set-samples").addEventListener("click", function () {
        act0(this, function () { return host("importSamples").then(function (r) { return refreshLibrary().then(function () { return r; }); }); });
    });
    $("#set-recheck").addEventListener("click", function () { act0(this, selfCheck); });
    bindHint($("#set-recheck"), { title: "自检", click: "逐项检查：后台连接、前后端版本、AE 版本、写入权限、脚本库文件夹、Node、本地字体" });

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
        CREATE.forEach(function (c) { list.push({ icon: c[1], name: "新建" + c[2], sub: "新建", run: call("addLayer", { kind: c[0] }) }); });
        list.push({ icon: "copyKeys", name: "复制关键帧", sub: "关键帧", run: call("copyKeys") });
        list.push({ icon: "pasteKeys", name: "粘贴关键帧", sub: "关键帧", run: call("pasteKeys") });
        list.push({ icon: "styleCopy", name: "复制样式", sub: "样式", run: call("styleCopy") });
        lib.items.forEach(function (it) { list.push({ icon: it.ext === "ffx" ? "preset" : "script", name: it.name, sub: "脚本 · " + it.cat, run: function () { return host("run", { path: it.path }); } }); });
        snippets.forEach(function (s) { list.push({ icon: s.kind === "expr" ? "exprSnippet" : "codeSnippet", name: s.name, sub: s.kind === "expr" ? "表达式片段" : "脚本片段", run: function (m) { return runSnippet(s, m); } }); });
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
        if (name !== "panel" && editing) setEditing(false);
    }
    $$(".tab").forEach(function (t) { t.addEventListener("click", function () { selectTab(t.dataset.tab); }); });
    $$("[data-icon]").forEach(function (n) { n.innerHTML = svg(n.dataset.icon); });

    hintEl.innerHTML = IDLE;
    selectTab(local.get("tab" + PANEL, "panel"));

    // =====================================================================
    // 选区状态：条件不满足的按钮变暗（仍可点），悬停写明缺什么
    // 只在三种时机查询：鼠标在面板里移动（节流 900ms）、面板获得焦点、每次操作完成后
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
        if (!force && now - ctxAt < 900) {                     // 节流窗口内：窗口结束时补一次，不丢掉最后一次移动
            if (!ctxTrail) ctxTrail = setTimeout(function () { ctxTrail = 0; refreshCtx(true); }, 900 - (now - ctxAt));
            return;
        }
        clearTimeout(ctxTrail); ctxTrail = 0;
        ctxBusy = true; ctxAt = now;
        host("ctx").then(function (r) {
            ctxBusy = false;
            if (r && r.ok) { ctx = r.data; applyNeeds(); }
            if (ctxPending) { ctxPending = false; refreshCtx(false); }
        }, function () { ctxBusy = false; });
    }
    // mousemove 只在鼠标位于面板里时才会触发，所以鼠标在面板外时不会查询
    document.addEventListener("mousemove", function () { refreshCtx(false); });
    window.addEventListener("focus", function () { refreshCtx(true); });

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
    function resync() {
        if (resyncing) return resyncing;
        var jobs = [];
        if (!cfgSynced && !cfgBad) {
            jobs.push(step("同步面板布局", function () {
                if (cfgDirty) {
                    return host("saveConfig", { name: "panel" + PANEL, text: JSON.stringify(cfg) }).then(function (r) {
                        if (!r.ok) throw new Error(r.msg);
                        cfgSynced = true; cfgDirty = false;
                    });
                }
                return loadConfig().then(function () { applyAccent(cfg.accent || "#FF5900"); $("#panel-name").textContent = cfg.name; renderLayout(); renderSettings(); });
            }));
        }
        if (!snippetsSynced && !snippetsBad) {
            jobs.push(step("同步代码片段", function () {
                if (snippetsDirty) {
                    snippetsSynced = true;
                    return host("saveSnippets", { text: JSON.stringify(snippets, null, 2) }).then(function (r) {
                        if (!r.ok) { snippetsSynced = false; throw new Error(r.msg); }
                        snippetsDirty = false;
                    });
                }
                return loadSnippets().then(renderLayout);
            }));
        }
        jobs.push(step("连接后台", initInfo));
        jobs.push(step("读取脚本库", refreshLibrary));
        jobs.push(step("读取曲线预设", function () { return loadCurves().then(renderLayout); }));
        resyncing = Promise.all(jobs).then(function (rs) {
            resyncing = null;
            var bad = rs.filter(function (r) { return r && r.ok === false; });
            if (bad.length) toast({ ok: false, msg: bad.map(function (r) { return r.msg; }).join("；") });
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

    function boot() {
        return step("读取面板布局", loadConfig).then(function () {
            if (!cfg) cfg = local.get("panel" + PANEL, null) || fromPreset(PANEL_PRESET[PANEL] || "blank");
            applyAccent(cfg.accent || "#FF5900");
            $("#panel-name").textContent = cfg.name;
            renderLayout();
            renderSettings();
            return step("连接后台", initInfo);
        }).then(function (initRes) {
            var failed = initRes && initRes.ok === false;
            // 示例脚本：真正复制了文件才记下「已导入」，下次还会再试
            var seed = (failed || local.get("seeded", false)) ? Promise.resolve() : step("导入示例脚本", function () {
                return host("importSamples").then(function (r) {
                    if (r.ok && r.data && r.data.copied > 0) local.set("seeded", true);
                    if (r.ok && r.data && r.data.copied === 0 && r.data.existing > 0) local.set("seeded", true);
                    if (!r.ok) throw new Error(r.msg);
                });
            });
            return Promise.all([
                seed.then(function () { return step("读取脚本库", refreshLibrary); }),
                step("读取代码片段", loadSnippets),
                step("读取曲线预设", function () { return loadCurves().then(renderLayout); })
            ]).then(function (rs) {
                refreshCtx(true);
                var bad = [initRes].concat(rs).filter(function (r) { return r && r.ok === false; });
                if (bad.length) toast({ ok: false, msg: bad.map(function (r) { return r.msg; }).join("；") });
                return bad;
            });
        });
    }

    B.registerKeys(["cmdK", "esc"]);
    boot();
})();
