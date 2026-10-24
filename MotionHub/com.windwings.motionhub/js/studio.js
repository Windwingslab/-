/* MotionHub Studio：视频裁切 · 拼图排版 · 调色 · 导出 GIF / MP4 / AE 合成 */
(function () {
    "use strict";

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
    var svg = window.MHIcons.svg;
    var CEP = window.__adobe_cep__;
    var NODE = typeof require === "function";
    var fs = NODE ? require("fs") : null, os = NODE ? require("os") : null, nodePath = NODE ? require("path") : null;
    var IS_WIN = navigator.platform.indexOf("Win") === 0;

    function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html !== undefined) n.innerHTML = html; return n; }
    function esc(s) { return String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function fmt(t) { return (Math.round(t * 100) / 100).toFixed(2); }
    var local = {
        get: function (k, d) { try { var v = localStorage.getItem("mhs." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem("mhs." + k, JSON.stringify(v)); } catch (e) {} }
    };

    function host(name, args) {
        return new Promise(function (resolve) {
            var code = "MH.call(" + JSON.stringify(name) + "," + JSON.stringify(args || {}) + ")";
            var done = function (r) {
                var o;
                try { o = JSON.parse(r); } catch (e) { o = { ok: false, msg: r === "EvalScript error." ? "后台脚本没有加载，请关闭面板后重新打开" : "返回数据异常" }; }
                resolve(o);
            };
            if (CEP) CEP.evalScript(code, done);
            else done(window.MHMock ? window.MHMock(name, args) : JSON.stringify({ ok: false, msg: "预览模式：没有连接 After Effects" }));
        });
    }

    // =====================================================================
    // 品牌色
    // =====================================================================
    var INK = "#171819";
    var PALETTE = [["#FF5900", "品牌橙"], ["#FF7A2F", "亮橙"], ["#FFD8BE", "桃"], ["#F4F4F2", "白"], ["#A8BBD6", "钢蓝"], ["#4A6285", "深钢蓝"], ["#8A8C8E", "灰"], ["#26110A", "深棕"], ["#171819", "墨"]];
    function rgb(hex) { var n = parseInt(hex.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    function lum(hex) { return rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }
    function onColor(hex) { var l = lum(hex), a = (l + 0.05) / (lum(INK) + 0.05), b = 1.05 / (l + 0.05); return a >= b ? INK : "#FFFFFF"; }
    function mixHex(a, b, t) { var x = rgb(a), y = rgb(b); return "#" + [0, 1, 2].map(function (i) { var v = Math.round(x[i] + (y[i] - x[i]) * t).toString(16); return v.length < 2 ? "0" + v : v; }).join(""); }
    function applyAccent(hex) {
        var r = document.documentElement.style;
        r.setProperty("--accent", hex);
        r.setProperty("--accent-hover", mixHex(hex, "#FFFFFF", 0.18));
        r.setProperty("--on-accent", onColor(hex));
    }

    // =====================================================================
    // 预设
    // =====================================================================
    var SIZES = [
        ["小红书", [["竖图 3:4", 1080, 1440], ["竖屏视频 9:16", 1080, 1920], ["方图 1:1", 1080, 1080]]],
        ["抖音 · 快手 · 视频号", [["竖屏 9:16", 1080, 1920], ["横屏 16:9", 1920, 1080], ["视频号 6:7", 1080, 1260]]],
        ["Instagram", [["帖子 1:1", 1080, 1080], ["帖子 4:5", 1080, 1350], ["Story · Reels", 1080, 1920]]],
        ["TikTok · YouTube Shorts", [["9:16", 1080, 1920]]],
        ["B站 · YouTube", [["横屏 16:9", 1920, 1080], ["B站封面 16:10", 1146, 717]]],
        ["微博 · 朋友圈", [["横 16:9", 1920, 1080], ["方 1:1", 1080, 1080], ["竖 3:4", 1080, 1440]]],
        ["公众号", [["头条封面 2.35:1", 900, 383], ["次条封面 1:1", 500, 500]]],
        ["X · Twitter", [["横 16:9", 1280, 720], ["方 1:1", 1080, 1080]]]
    ];

    function grid(cols, rows) {
        var out = [];
        for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) out.push([x / cols, y / rows, 1 / cols, 1 / rows]);
        return out;
    }
    var TEMPLATES = [
        { id: "1", name: "单个", cells: [[0, 0, 1, 1]] },
        { id: "2h", name: "左右", cells: grid(2, 1) },
        { id: "2v", name: "上下", cells: grid(1, 2) },
        { id: "3a", name: "左一右二", cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
        { id: "3b", name: "上一下二", cells: [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
        { id: "3c", name: "上二下一", cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 1, 0.5]] },
        { id: "3v", name: "三行", cells: grid(1, 3) },
        { id: "3h", name: "三列", cells: grid(3, 1) },
        { id: "4", name: "田字", cells: grid(2, 2) },
        { id: "4a", name: "一大三小", cells: [[0, 0, 1, 2 / 3], [0, 2 / 3, 1 / 3, 1 / 3], [1 / 3, 2 / 3, 1 / 3, 1 / 3], [2 / 3, 2 / 3, 1 / 3, 1 / 3]] },
        { id: "4b", name: "左一右三", cells: [[0, 0, 0.6, 1], [0.6, 0, 0.4, 1 / 3], [0.6, 1 / 3, 0.4, 1 / 3], [0.6, 2 / 3, 0.4, 1 / 3]] },
        { id: "4v", name: "四行", cells: grid(1, 4) },
        { id: "5", name: "二加三", cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 1 / 3, 0.5], [1 / 3, 0.5, 1 / 3, 0.5], [2 / 3, 0.5, 1 / 3, 0.5]] },
        { id: "6", name: "二乘三", cells: grid(2, 3) },
        { id: "6b", name: "三乘二", cells: grid(3, 2) },
        { id: "9", name: "九宫格", cells: grid(3, 3) }
    ];
    function tplById(id) { for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === id) return TEMPLATES[i]; return TEMPLATES[0]; }

    // 自动排版：按素材数量和画面方向挑模板
    function autoTemplate() {
        var n = Math.max(1, S.clips.length), portrait = S.size.h > S.size.w * 1.05, landscape = S.size.w > S.size.h * 1.05;
        var pick = {
            1: "1", 2: portrait ? "2v" : "2h", 3: portrait ? "3b" : landscape ? "3a" : "3b", 4: portrait ? "4a" : "4",
            5: "5", 6: portrait ? "6" : "6b"
        }[n];
        return pick || (n <= 9 ? "9" : "9");
    }

    // =====================================================================
    // 状态
    // =====================================================================
    var S = {
        size: local.get("size", { w: 1080, h: 1920, label: "抖音 · 竖屏 9:16" }),
        tpl: "auto",
        gap: local.get("gap", 12), pad: local.get("pad", 0), radius: local.get("radius", 0),
        bg: local.get("bg", "#171819"),
        clips: [],
        cells: [],
        sel: 0,
        playing: false,
        t: 0,
        exp: local.get("exp", { fps: 15, width: 540, dither: false, mp4fps: 30, dur: 0, audio: 0, render: true }),
        gradeAll: false
    };
    var uid = 0;

    function currentTemplate() { return tplById(S.tpl === "auto" ? autoTemplate() : S.tpl); }

    function syncCells() {
        var tpl = currentTemplate(), n = tpl.cells.length;
        while (S.cells.length < n) S.cells.push({ clip: S.clips.length ? S.cells.length % S.clips.length : -1, zoom: 1, panX: 0, panY: 0, fit: "cover" });
        S.cells.length = n;
        S.cells.forEach(function (c, i) {
            if (c.clip >= S.clips.length) c.clip = S.clips.length ? i % S.clips.length : -1;
            if (c.clip < 0 && S.clips.length) c.clip = i % S.clips.length;
        });
        S.sel = clamp(S.sel, 0, n - 1);
    }

    // 输出时长：默认取各格子素材裁切后最长的那段
    function duration() {
        if (S.exp.dur > 0) return S.exp.dur;
        var d = 0;
        S.cells.forEach(function (c) { var cl = S.clips[c.clip]; if (cl && cl.ok) d = Math.max(d, cl.out - cl.in); });
        return d || 3;
    }

    function cellRects(W, H) {
        var tpl = currentTemplate(), g = S.gap, p = S.pad, iw = W - 2 * p, ih = H - 2 * p;
        return tpl.cells.map(function (c) {
            var x = p + c[0] * iw, y = p + c[1] * ih, w = c[2] * iw, h = c[3] * ih;
            var l = c[0] > 0.001 ? g / 2 : 0, t = c[1] > 0.001 ? g / 2 : 0;
            var r = c[0] + c[2] < 0.999 ? g / 2 : 0, b = c[1] + c[3] < 0.999 ? g / 2 : 0;
            return { x: x + l, y: y + t, w: Math.max(1, w - l - r), h: Math.max(1, h - t - b) };
        });
    }

    // =====================================================================
    // 提示栏 / 对话框
    // =====================================================================
    var hintEl = $("#hint"), toastTimer = null, hovered = null;
    var IDLE = '<div class="muted">把鼠标移到按钮上可以看用法。画面里：点格子选中，拖动调整构图，滚轮缩放，双击复位。</div>';
    function showHint(h) {
        hovered = h;
        if (toastTimer) return;
        hintEl.className = "hint";
        hintEl.innerHTML = h ? '<div class="h-title">' + esc(h.title) + "</div>" + (h.text ? "<div>" + esc(h.text) + "</div>" : "") : IDLE;
    }
    function toast(r, keep) {
        if (!r || (!r.msg && r.ok)) return r;
        clearTimeout(toastTimer);
        hintEl.className = "hint " + (r.ok ? "ok" : "err");
        hintEl.innerHTML = '<div class="h-msg">' + esc(r.msg) + "</div>";
        toastTimer = keep ? null : setTimeout(function () { toastTimer = null; showHint(hovered); }, r.ok ? 3000 : 5000);
        return r;
    }
    function hint(node, title, text) {
        node.addEventListener("mouseenter", function () { showHint({ title: title, text: text }); });
        node.addEventListener("mouseleave", function () { showHint(null); });
    }

    function dialog(title, nodes, buttons) {
        return new Promise(function (resolve) {
            var m = $("#modal"), body = $("#dlg-body"), btns = $("#dlg-btns");
            $("#dlg-title").textContent = title;
            body.innerHTML = ""; btns.innerHTML = "";
            nodes.forEach(function (n) { body.appendChild(n); });
            function close(v) { m.hidden = true; resolve(v); }
            buttons.forEach(function (b) {
                var x = el("button", "btn" + (b.accent ? " accent" : ""), esc(b.label));
                x.addEventListener("click", function () { close(b.value()); });
                btns.appendChild(x);
            });
            m.hidden = false;
        });
    }

    var pop = $("#pop");
    function showPop(anchor, nodes) {
        pop.innerHTML = "";
        nodes.forEach(function (n) { pop.appendChild(n); });
        pop.hidden = false;
        var r = anchor.getBoundingClientRect();
        pop.style.left = Math.min(window.innerWidth - pop.offsetWidth - 6, Math.max(6, r.left - 8)) + "px";
        pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 6, r.bottom + 6) + "px";
    }
    document.addEventListener("mousedown", function (e) { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });

    function swatches(current, onPick) {
        var box = el("div", "swatches");
        PALETTE.forEach(function (p) {
            var s = el("button", "sw" + (current && current.toUpperCase() === p[0] ? " on" : ""));
            s.style.background = p[0]; s.title = p[1] + " " + p[0];
            s.addEventListener("click", function () { onPick(p[0]); });
            box.appendChild(s);
        });
        var c = el("label", "sw custom"), inp = el("input");
        c.title = "自定义颜色";
        inp.type = "color"; inp.value = current || "#FF5900";
        inp.addEventListener("input", function () { onPick(inp.value.toUpperCase()); });
        c.appendChild(inp);
        box.appendChild(c);
        return box;
    }

    // =====================================================================
    // 素材
    // =====================================================================
    function fileURL(p) {
        var norm = p.replace(/\\/g, "/");
        return (norm.charAt(0) === "/" ? "file://" : "file:///") + norm.split("/").map(function (s, i) { return i === 0 && /:$/.test(s) ? s : encodeURIComponent(s); }).join("/");
    }

    function addClip(src) {
        var c = { id: ++uid, name: src.name, path: src.path || null, blob: src.blob || null, el: document.createElement("video"), dur: 0, in: 0, out: 0, ok: false, err: "", grade: MHGrade.defaults(), lut: null };
        c.lut = MHGrade.compile(c.grade);
        var v = c.el;
        v.muted = true; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
        v.src = src.url || fileURL(src.path);
        v.addEventListener("loadedmetadata", function () {
            c.dur = v.duration || 0; c.in = 0; c.out = c.dur; c.ok = true;
            v.currentTime = Math.min(0.1, c.dur / 2);
            renderClips(); syncCells(); renderLayoutPanel(); renderTrim(); draw();
        });
        v.addEventListener("seeked", function () { drawThumb(c); if (!S.playing) draw(); });
        v.addEventListener("error", function () {
            c.err = "面板无法预览这个编码（ProRes / HEVC 等），可以先转成 H.264 MP4";
            renderClips();
            toast({ ok: false, msg: "「" + c.name + "」" + c.err });
        });
        S.clips.push(c);
        syncCells();
        renderClips();
        return c;
    }

    function drawThumb(c) {
        var cv = $('canvas[data-clip="' + c.id + '"]');
        if (!cv || !c.ok) return;
        var g = cv.getContext("2d"), v = c.el;
        cv.width = 128; cv.height = 80;
        var s = Math.max(128 / v.videoWidth, 80 / v.videoHeight);
        try { g.drawImage(v, (128 - v.videoWidth * s) / 2, (80 - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s); } catch (e) {}
    }

    function renderClips() {
        var list = $("#clip-list");
        list.innerHTML = "";
        $("#clip-count").textContent = S.clips.length ? S.clips.length + " 个素材" : "素材";
        $("#stage-empty").style.display = S.clips.length ? "none" : "";
        S.clips.forEach(function (c, i) {
            var used = [];
            S.cells.forEach(function (cell, k) { if (cell.clip === i) used.push(k + 1); });
            var row = el("div", "clip" + (S.cells[S.sel] && S.cells[S.sel].clip === i ? " sel" : ""));
            row.draggable = true;
            row.innerHTML = '<canvas data-clip="' + c.id + '"></canvas><div style="min-width:0"><div class="nm">' +
                used.map(function (u) { return '<span class="badge">' + u + "</span>"; }).join("") + esc(c.name) + "</div>" +
                (c.err ? '<div class="ds bad">无法预览</div>' : '<div class="ds">' + (c.ok ? fmt(c.in) + " – " + fmt(c.out) + " / " + fmt(c.dur) + "s" : "读取中…") + "</div>") + "</div>";
            var x = el("button", "act", svg("close"));
            x.title = "移除";
            x.addEventListener("click", function (e) {
                e.stopPropagation();
                c.el.pause(); c.el.removeAttribute("src");
                S.clips.splice(i, 1);
                S.cells.forEach(function (cell) { if (cell.clip === i) cell.clip = -1; else if (cell.clip > i) cell.clip--; });
                syncCells(); renderClips(); renderLayoutPanel(); renderTrim(); draw();
            });
            row.appendChild(x);
            row.addEventListener("click", function () {
                S.cells[S.sel].clip = i;
                renderClips(); renderTrim(); renderGradePanel(); draw();
            });
            row.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/mh-clip", String(i)); e.dataTransfer.effectAllowed = "copy"; });
            hint(row, c.name, "点一下：放进当前选中的格子；拖到画面里的格子上：放进那个格子");
            list.appendChild(row);
            requestAnimationFrame(function () { drawThumb(c); });
        });
    }

    function pickVideos() {
        if (!CEP) { $("#file-in").click(); return; }
        host("pickVideos").then(function (r) {
            if (!r.ok) return toast(r);
            r.data.files.forEach(function (f) { addClip({ name: f.name, path: f.path }); });
        });
    }

    // 浏览器预览模式下的文件选择
    var fileIn = el("input");
    fileIn.type = "file"; fileIn.accept = "video/*"; fileIn.multiple = true; fileIn.id = "file-in"; fileIn.hidden = true;
    document.body.appendChild(fileIn);
    fileIn.addEventListener("change", function () { Array.prototype.forEach.call(fileIn.files, addFile); fileIn.value = ""; });

    function addFile(f) {
        if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) return;
        addClip({ name: f.name, path: f.path || null, url: f.path ? null : URL.createObjectURL(f), blob: f.path ? null : f });
    }

    var dropDepth = 0, overlay = $("#drop-overlay");
    function isFiles(e) { return Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1; }
    document.addEventListener("dragenter", function (e) { if (isFiles(e)) { dropDepth++; overlay.hidden = false; } });
    document.addEventListener("dragleave", function (e) { if (isFiles(e) && --dropDepth <= 0) { dropDepth = 0; overlay.hidden = true; } });
    document.addEventListener("dragover", function (e) { if (isFiles(e)) e.preventDefault(); });
    document.addEventListener("drop", function (e) {
        if (!isFiles(e)) return;
        e.preventDefault(); dropDepth = 0; overlay.hidden = true;
        Array.prototype.forEach.call(e.dataTransfer.files, addFile);
    });

    // =====================================================================
    // 绘制
    // =====================================================================
    var view = $("#view"), vctx = view.getContext("2d"), stage = $("#stage");
    var scratch = document.createElement("canvas"), sctx = scratch.getContext("2d", { willReadFrequently: true });
    var viewScale = 1;

    function roundRect(g, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
    }

    // 计算素材在格子里的摆放（填满 / 完整 + 缩放 + 平移）
    function placement(cell, clip, rw, rh) {
        var vw = clip.el.videoWidth || 16, vh = clip.el.videoHeight || 9;
        var s = (cell.fit === "contain" ? Math.min(rw / vw, rh / vh) : Math.max(rw / vw, rh / vh)) * cell.zoom;
        var dw = vw * s, dh = vh * s;
        var ex = Math.max(0, dw - rw), ey = Math.max(0, dh - rh);
        return { x: (rw - dw) / 2 - cell.panX * ex / 2, y: (rh - dh) / 2 - cell.panY * ey / 2, w: dw, h: dh };
    }

    // 画一帧：k = 输出像素 / 设计像素
    function compose(g, k, preview) {
        var W = S.size.w * k, H = S.size.h * k;
        g.fillStyle = S.bg;
        g.fillRect(0, 0, W, H);
        var rects = cellRects(S.size.w, S.size.h);
        rects.forEach(function (r0, i) {
            var r = { x: r0.x * k, y: r0.y * k, w: r0.w * k, h: r0.h * k };
            var cell = S.cells[i], clip = cell && S.clips[cell.clip];
            g.save();
            roundRect(g, r.x, r.y, r.w, r.h, S.radius * k);
            g.clip();
            if (clip && clip.ok && clip.el.readyState >= 2) {
                var pw = Math.max(1, Math.round(r.w)), ph = Math.max(1, Math.round(r.h));
                if (scratch.width !== pw || scratch.height !== ph) { scratch.width = pw; scratch.height = ph; }
                sctx.fillStyle = S.bg;
                sctx.fillRect(0, 0, pw, ph);
                var p = placement(cell, clip, pw, ph);
                sctx.drawImage(clip.el, p.x, p.y, p.w, p.h);
                if (!clip.lut.neutral) {
                    var img = sctx.getImageData(0, 0, pw, ph);
                    MHGrade.apply(img.data, clip.lut);
                    sctx.putImageData(img, 0, 0);
                }
                g.drawImage(scratch, r.x, r.y, r.w, r.h);
            } else if (preview) {
                g.fillStyle = "rgba(244,244,242,.06)";
                g.fillRect(r.x, r.y, r.w, r.h);
                g.fillStyle = "rgba(244,244,242,.4)";
                g.font = Math.max(10, 12 * k * 2) + "px sans-serif";
                g.textAlign = "center";
                g.fillText(clip && clip.err ? "无法预览" : "拖入视频", r.x + r.w / 2, r.y + r.h / 2);
            }
            g.restore();
            if (preview) {
                g.strokeStyle = i === S.sel ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() : "rgba(244,244,242,.18)";
                g.lineWidth = i === S.sel ? 2 : 1;
                g.setLineDash(i === S.sel ? [] : [4, 4]);
                roundRect(g, r.x + 1, r.y + 1, r.w - 2, r.h - 2, Math.max(0, S.radius * k - 1));
                g.stroke();
                g.setLineDash([]);
                g.fillStyle = i === S.sel ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() : "rgba(23,24,25,.7)";
                g.fillRect(r.x + 6, r.y + 6, 18, 16);
                g.fillStyle = i === S.sel ? getComputedStyle(document.documentElement).getPropertyValue("--on-accent").trim() : "#F4F4F2";
                g.font = "600 10px Geist Mono, monospace";
                g.textAlign = "center";
                g.fillText(String(i + 1), r.x + 15, r.y + 18);
            }
        });
    }

    function fitView() {
        var sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
        viewScale = Math.max(0.05, Math.min(sw / S.size.w, sh / S.size.h));
        var dpr = window.devicePixelRatio || 1;
        view.style.width = Math.round(S.size.w * viewScale) + "px";
        view.style.height = Math.round(S.size.h * viewScale) + "px";
        view.width = Math.round(S.size.w * viewScale * dpr);
        view.height = Math.round(S.size.h * viewScale * dpr);
    }

    function draw() {
        var dpr = window.devicePixelRatio || 1;
        vctx.setTransform(1, 0, 0, 1, 0, 0);
        compose(vctx, viewScale * dpr, true);
        $("#size-label").textContent = S.size.w + " × " + S.size.h + " · " + (S.size.label || "");
        $("#t-total").textContent = fmt(duration()) + " s";
        var cell = S.cells[S.sel], clip = cell && S.clips[cell.clip];
        $("#cell-info").textContent = "格子 " + (S.sel + 1) + (clip ? " · " + clip.name : " · 空");
        drawPlayhead();
    }

    window.addEventListener("resize", function () { fitView(); draw(); renderTrim(); });

    // —— 播放 ——
    var lastTick = 0;
    function loop(now) {
        if (!S.playing) return;
        var dt = lastTick ? (now - lastTick) / 1000 : 0;
        lastTick = now;
        S.t = (S.t + dt) % duration();
        usedClips().forEach(function (c) {
            var len = c.out - c.in;
            if (c.el.currentTime >= c.out - 0.02 || c.el.currentTime < c.in - 0.05) c.el.currentTime = c.in;
            if (c.el.paused) c.el.play().catch(function () {});
            if (len <= 0) c.el.pause();
        });
        $("#t-now").textContent = fmt(S.t);
        draw();
        requestAnimationFrame(loop);
    }
    function usedClips() {
        var set = [];
        S.cells.forEach(function (cell) { var c = S.clips[cell.clip]; if (c && c.ok && set.indexOf(c) === -1) set.push(c); });
        return set;
    }
    function setPlaying(on) {
        S.playing = on;
        $("#btn-play").innerHTML = svg(on ? "hold" : "play");
        if (on) {
            usedClips().forEach(function (c) { c.el.currentTime = c.in + (S.t % Math.max(0.01, c.out - c.in)); });
            lastTick = 0;
            requestAnimationFrame(loop);
        } else {
            S.clips.forEach(function (c) { c.el.pause(); });
            draw();
        }
    }
    $("#btn-play").addEventListener("click", function () { setPlaying(!S.playing); });
    hint($("#btn-play"), "播放 / 暂停", "循环预览排版效果（空格键也可以）");
    document.addEventListener("keydown", function (e) {
        if (e.key === " " && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { e.preventDefault(); setPlaying(!S.playing); }
    });

    // 跳到某个时间：每个格子的素材按自己的裁切范围循环
    function seekAll(t) {
        return Promise.all(usedClips().map(function (c) {
            var len = Math.max(0.01, c.out - c.in), target = c.in + (t % len);
            return new Promise(function (res) {
                if (Math.abs(c.el.currentTime - target) < 0.001 && c.el.readyState >= 2) return res();
                var done = false;
                var fin = function () { if (!done) { done = true; c.el.removeEventListener("seeked", fin); res(); } };
                c.el.addEventListener("seeked", fin);
                setTimeout(fin, 2000);
                c.el.currentTime = target;
            });
        }));
    }

    // —— 画面交互：选格子、拖动构图、滚轮缩放、双击复位、接收拖入的素材 ——
    function hitCell(e) {
        var r = view.getBoundingClientRect(), x = (e.clientX - r.left) / viewScale, y = (e.clientY - r.top) / viewScale;
        var rects = cellRects(S.size.w, S.size.h);
        for (var i = 0; i < rects.length; i++) {
            var c = rects[i];
            if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return i;
        }
        return -1;
    }
    view.addEventListener("pointerdown", function (e) {
        var i = hitCell(e);
        if (i < 0) return;
        if (S.sel !== i) { S.sel = i; renderClips(); renderTrim(); renderLayoutPanel(); renderGradePanel(); draw(); }
        var cell = S.cells[i], clip = S.clips[cell.clip];
        if (!clip || !clip.ok) return;
        var rect = cellRects(S.size.w, S.size.h)[i], p = placement(cell, clip, rect.w, rect.h);
        var ex = Math.max(1, p.w - rect.w), ey = Math.max(1, p.h - rect.h), sx = e.clientX, sy = e.clientY, px = cell.panX, py = cell.panY;
        view.setPointerCapture(e.pointerId);
        view.classList.add("panning");
        function move(ev) {
            cell.panX = clamp(px - (ev.clientX - sx) / viewScale / (ex / 2), -1, 1);
            cell.panY = clamp(py - (ev.clientY - sy) / viewScale / (ey / 2), -1, 1);
            if (!S.playing) draw();
        }
        function up() { view.classList.remove("panning"); view.removeEventListener("pointermove", move); view.removeEventListener("pointerup", up); renderLayoutPanel(); }
        view.addEventListener("pointermove", move);
        view.addEventListener("pointerup", up);
    });
    view.addEventListener("wheel", function (e) {
        var i = hitCell(e);
        if (i < 0) return;
        e.preventDefault();
        var cell = S.cells[i];
        cell.zoom = clamp(cell.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06), 1, 5);
        if (S.sel !== i) S.sel = i;
        if (!S.playing) draw();
        renderLayoutPanel();
    }, { passive: false });
    view.addEventListener("dblclick", function (e) {
        var i = hitCell(e);
        if (i < 0) return;
        var c = S.cells[i];
        c.zoom = 1; c.panX = 0; c.panY = 0;
        draw(); renderLayoutPanel();
    });
    view.addEventListener("dragover", function (e) { if (Array.prototype.indexOf.call(e.dataTransfer.types, "text/mh-clip") !== -1) e.preventDefault(); });
    view.addEventListener("drop", function (e) {
        var data = e.dataTransfer.getData("text/mh-clip");
        if (data === "") return;
        e.preventDefault();
        e.stopPropagation();
        var i = hitCell(e);
        if (i < 0) return;
        S.cells[i].clip = +data;
        S.sel = i;
        renderClips(); renderTrim(); renderGradePanel(); draw();
    });

    // =====================================================================
    // 裁切时间线
    // =====================================================================
    var track = $("#track"), range = $("#range"), ph = $("#ph");
    function selClip() { var cell = S.cells[S.sel]; return cell ? S.clips[cell.clip] : null; }

    function renderTrim() {
        var c = selClip();
        track.classList.toggle("empty", !(c && c.ok));
        if (!c || !c.ok) { $("#trim-info").textContent = "选中一个有素材的格子后，在这里裁切它的时长"; return; }
        $("#trim-info").textContent = c.name + " · " + fmt(c.in) + "s – " + fmt(c.out) + "s（" + fmt(c.out - c.in) + "s）";
        var w = track.clientWidth;
        range.style.left = (c.in / c.dur * w) + "px";
        range.style.width = Math.max(4, (c.out - c.in) / c.dur * w) + "px";
        drawPlayhead();
    }
    function drawPlayhead() {
        var c = selClip();
        if (!c || !c.ok) return;
        ph.style.left = (c.el.currentTime / c.dur * track.clientWidth) + "px";
    }

    range.addEventListener("pointerdown", function (e) {
        var c = selClip();
        if (!c || !c.ok) return;
        e.preventDefault();
        var mode = e.target.classList.contains("in") ? "in" : e.target.classList.contains("out") ? "out" : "move";
        var sx = e.clientX, a = c.in, b = c.out, k = c.dur / track.clientWidth;
        range.setPointerCapture(e.pointerId);
        function move(ev) {
            var d = (ev.clientX - sx) * k;
            if (mode === "in") c.in = clamp(a + d, 0, c.out - 0.1);
            else if (mode === "out") c.out = clamp(b + d, c.in + 0.1, c.dur);
            else { var len = b - a; c.in = clamp(a + d, 0, c.dur - len); c.out = c.in + len; }
            c.el.currentTime = mode === "out" ? c.out - 0.02 : c.in;
            renderTrim();
        }
        function up() { range.removeEventListener("pointermove", move); range.removeEventListener("pointerup", up); renderClips(); draw(); }
        range.addEventListener("pointermove", move);
        range.addEventListener("pointerup", up);
    });
    track.addEventListener("pointerdown", function (e) {
        if (e.target !== track) return;
        var c = selClip();
        if (!c || !c.ok) return;
        var r = track.getBoundingClientRect();
        c.el.currentTime = clamp((e.clientX - r.left) / r.width * c.dur, 0, c.dur);
    });
    hint(track, "裁切", "拖动橙色框两端设置入点和出点，拖动中间整体移动；点空白处跳到那个位置");

    // =====================================================================
    // 右侧：排版
    // =====================================================================
    function head(parent, num, en, zh) {
        parent.appendChild(el("div", "sec-head", '<span class="num">(' + num + ") — " + en + '</span><span class="zh">' + esc(zh) + "</span>"));
    }
    function slider(parent, label, min, max, step, value, onInput, unit) {
        var r = el("div", "ctl"), rng = el("input"), num = el("input", "num-in");
        r.appendChild(el("span", "", esc(label)));
        rng.type = "range"; rng.min = min; rng.max = max; rng.step = step; rng.value = value;
        num.type = "text"; num.value = value;
        rng.addEventListener("input", function () { num.value = rng.value; onInput(+rng.value); });
        num.addEventListener("change", function () { var v = clamp(parseFloat(num.value) || 0, min, max); num.value = v; rng.value = v; onInput(v); });
        num.addEventListener("keydown", function (e) { e.stopPropagation(); });
        r.appendChild(rng); r.appendChild(num);
        parent.appendChild(r);
        return r;
    }

    function tplIcon(t) {
        var s = '<svg viewBox="0 0 40 40">';
        t.cells.forEach(function (c) { s += '<rect x="' + (c[0] * 38 + 1.5) + '" y="' + (c[1] * 38 + 1.5) + '" width="' + (c[2] * 38 - 2) + '" height="' + (c[3] * 38 - 2) + '" rx="1.5" fill="currentColor" opacity=".55"/>'; });
        return s + "</svg>";
    }

    function renderLayoutPanel() {
        var p = $("#sp-layout");
        var scroll = p.parentNode.scrollTop;
        p.innerHTML = "";
        head(p, "01", "SIZE", "社交媒体尺寸");
        SIZES.forEach(function (plat) {
            var box = el("div", "plat");
            box.appendChild(el("div", "plat-name", esc(plat[0])));
            var row = el("div", "sizes");
            plat[1].forEach(function (s) {
                var on = S.size.w === s[1] && S.size.h === s[2] && S.size.label === plat[0] + " · " + s[0];
                var k = 14 / Math.max(s[1], s[2]);
                var b = el("button", "size" + (on ? " on" : ""), '<i style="width:' + Math.round(s[1] * k) + "px;height:" + Math.round(s[2] * k) + 'px"></i>' + esc(s[0]));
                b.addEventListener("click", function () { setSize(s[1], s[2], plat[0] + " · " + s[0]); });
                hint(b, plat[0] + " · " + s[0], s[1] + " × " + s[2] + " 像素");
                row.appendChild(b);
            });
            box.appendChild(row);
            p.appendChild(box);
        });
        var cr = el("div", "ctl two");
        cr.appendChild(el("span", "", "自定义"));
        var cw = el("div", "w-row");
        var iw = el("input", "num-in"), ih = el("input", "num-in");
        iw.type = ih.type = "text"; iw.value = S.size.w; ih.value = S.size.h;
        [iw, ih].forEach(function (n) { n.addEventListener("keydown", function (e) { e.stopPropagation(); }); });
        var apply = function () { setSize(clamp(parseInt(iw.value, 10) || 1080, 16, 8192), clamp(parseInt(ih.value, 10) || 1920, 16, 8192), "自定义"); };
        iw.addEventListener("change", apply); ih.addEventListener("change", apply);
        cw.appendChild(iw); cw.appendChild(el("span", "unit", "×")); cw.appendChild(ih);
        cr.appendChild(cw);
        p.appendChild(cr);

        head(p, "02", "LAYOUT", "拼图模板");
        var tp = el("div", "tpls"), n = S.clips.length;
        var auto = el("button", "tpl" + (S.tpl === "auto" ? " on" : ""), tplIcon(tplById(autoTemplate())) + "<span>自动</span>");
        auto.addEventListener("click", function () { S.tpl = "auto"; syncCells(); renderLayoutPanel(); renderClips(); draw(); });
        hint(auto, "自动排版", "按素材数量和画面方向自动挑选模板");
        tp.appendChild(auto);
        TEMPLATES.forEach(function (t) {
            var b = el("button", "tpl" + (S.tpl === t.id ? " on" : "") + (n && t.cells.length !== n ? " dim" : ""), tplIcon(t) + "<span>" + esc(t.name) + "</span>");
            b.addEventListener("click", function () { S.tpl = t.id; syncCells(); renderLayoutPanel(); renderClips(); renderTrim(); draw(); });
            hint(b, t.name + " · " + t.cells.length + " 格", n && t.cells.length !== n ? "格子数和素材数不一样：多的格子会重复使用素材" : "");
            tp.appendChild(b);
        });
        p.appendChild(tp);

        head(p, "03", "STYLE", "间距 · 圆角 · 背景");
        slider(p, "间距", 0, 120, 1, S.gap, function (v) { S.gap = v; local.set("gap", v); draw(); });
        slider(p, "边距", 0, 200, 1, S.pad, function (v) { S.pad = v; local.set("pad", v); draw(); });
        slider(p, "圆角", 0, 200, 1, S.radius, function (v) { S.radius = v; local.set("radius", v); draw(); });
        var bgRow = el("div", "ctl two");
        bgRow.appendChild(el("span", "", "背景"));
        bgRow.appendChild(swatches(S.bg, function (hex) { S.bg = hex; local.set("bg", hex); renderLayoutPanel(); draw(); }));
        p.appendChild(bgRow);

        head(p, "04", "CELL", "格子 " + (S.sel + 1) + " · 构图");
        var cell = S.cells[S.sel];
        if (cell) {
            var fr = el("div", "ctl two");
            fr.appendChild(el("span", "", "适配"));
            var seg = el("div", "seg2");
            [["cover", "填满"], ["contain", "完整"]].forEach(function (o) {
                var b = el("button", cell.fit === o[0] ? "on" : "", o[1]);
                b.addEventListener("click", function () { cell.fit = o[0]; renderLayoutPanel(); draw(); });
                seg.appendChild(b);
            });
            fr.appendChild(seg);
            p.appendChild(fr);
            slider(p, "缩放", 1, 5, 0.01, Math.round(cell.zoom * 100) / 100, function (v) { cell.zoom = v; draw(); });
            slider(p, "水平", -1, 1, 0.01, Math.round(cell.panX * 100) / 100, function (v) { cell.panX = v; draw(); });
            slider(p, "垂直", -1, 1, 0.01, Math.round(cell.panY * 100) / 100, function (v) { cell.panY = v; draw(); });
            p.appendChild(el("p", "note", "也可以直接在画面里拖动调整构图、滚轮缩放、双击复位。"));
        }
        p.parentNode.scrollTop = scroll;
    }

    function setSize(w, h, label) {
        S.size = { w: w, h: h, label: label };
        local.set("size", S.size);
        syncCells(); fitView(); renderLayoutPanel(); renderClips(); draw();
    }

    // =====================================================================
    // 右侧：调色
    // =====================================================================
    var curveCh = "rgb", balTone = "mid";

    function gradeTargets() {
        var c = selClip();
        if (S.gradeAll) return S.clips.filter(function (x) { return x.ok; });
        return c ? [c] : [];
    }
    function updateGrade(mutate) {
        var c = selClip();
        if (!c) return;
        mutate(c.grade);
        c.lut = MHGrade.compile(c.grade);
        if (S.gradeAll) S.clips.forEach(function (o) { if (o !== c) { o.grade = MHGrade.clone(c.grade); o.lut = MHGrade.compile(o.grade); } });
        if (!S.playing) draw();
    }

    function renderGradePanel() {
        var p = $("#sp-grade"), c = selClip();
        var scroll = p.parentNode.scrollTop;
        p.innerHTML = "";
        if (!c) { p.appendChild(el("p", "note", "先选中一个有素材的格子。")); return; }
        var g = c.grade;

        var tr = el("div", "ctl two");
        tr.appendChild(el("span", "", "作用于"));
        var seg = el("div", "seg2");
        [[false, "当前素材"], [true, "全部素材"]].forEach(function (o) {
            var b = el("button", S.gradeAll === o[0] ? "on" : "", o[1]);
            b.addEventListener("click", function () {
                S.gradeAll = o[0];
                if (o[0]) updateGrade(function () {});
                renderGradePanel();
            });
            seg.appendChild(b);
        });
        tr.appendChild(seg);
        p.appendChild(tr);

        head(p, "01", "LOOKS", "风格");
        var looks = el("div", "looks");
        MHGrade.LOOKS.forEach(function (l) {
            var b = el("button", "chip", esc(l[0]));
            b.addEventListener("click", function () { updateGrade(function (gr) { var n = l[1](); gr.levels = n.levels; gr.balance = n.balance; gr.curves = n.curves; }); renderGradePanel(); });
            looks.appendChild(b);
        });
        p.appendChild(looks);

        // —— 色阶 ——
        head(p, "02", "LEVELS", "色阶 · 伽马");
        var hist = el("canvas", "hist-box");
        p.appendChild(hist);
        requestAnimationFrame(function () { drawHistogram(hist, c); });
        slider(p, "输入黑", 0, 254, 1, g.levels.inB, function (v) { updateGrade(function (gr) { gr.levels.inB = Math.min(v, gr.levels.inW - 1); }); drawHistogram(hist, c); });
        slider(p, "伽马", 0.1, 3, 0.01, g.levels.gamma, function (v) { updateGrade(function (gr) { gr.levels.gamma = v; }); drawHistogram(hist, c); });
        slider(p, "输入白", 1, 255, 1, g.levels.inW, function (v) { updateGrade(function (gr) { gr.levels.inW = Math.max(v, gr.levels.inB + 1); }); drawHistogram(hist, c); });
        slider(p, "输出黑", 0, 255, 1, g.levels.outB, function (v) { updateGrade(function (gr) { gr.levels.outB = v; }); });
        slider(p, "输出白", 0, 255, 1, g.levels.outW, function (v) { updateGrade(function (gr) { gr.levels.outW = v; }); });

        // —— 曲线 ——
        head(p, "03", "CURVES", "曲线");
        var chs = el("div", "seg2");
        [["rgb", "RGB"], ["r", "红"], ["g", "绿"], ["b", "蓝"]].forEach(function (o) {
            var b = el("button", curveCh === o[0] ? "on" : "", o[1]);
            b.addEventListener("click", function () { curveCh = o[0]; renderGradePanel(); });
            chs.appendChild(b);
        });
        p.appendChild(chs);
        var cv = el("canvas", "curve-box");
        cv.style.marginTop = "6px";
        p.appendChild(cv);
        requestAnimationFrame(function () { drawCurve(cv, c); });
        bindCurve(cv, c);
        p.appendChild(el("p", "note", "点击空白处加控制点，拖动调整，双击删除。"));

        // —— 色彩平衡 ——
        head(p, "04", "COLOR BALANCE", "色彩平衡");
        var tones = el("div", "seg2");
        [["shadows", "阴影"], ["mid", "中间调"], ["high", "高光"]].forEach(function (o) {
            var b = el("button", balTone === o[0] ? "on" : "", o[1]);
            b.addEventListener("click", function () { balTone = o[0]; renderGradePanel(); });
            tones.appendChild(b);
        });
        p.appendChild(tones);
        var bb = el("div");
        bb.style.marginTop = "8px";
        [["青", "红", "tint-r"], ["品", "绿", "tint-g"], ["黄", "蓝", "tint-b"]].forEach(function (o, ch) {
            var r = el("div", "bal-row"), rng = el("input"), num = el("input", "num-in");
            rng.type = "range"; rng.min = -100; rng.max = 100; rng.step = 1; rng.className = o[2];
            rng.value = g.balance[balTone][ch];
            num.type = "text"; num.value = rng.value;
            var set = function (v) { updateGrade(function (gr) { gr.balance[balTone][ch] = v; }); };
            rng.addEventListener("input", function () { num.value = rng.value; set(+rng.value); });
            num.addEventListener("change", function () { var v = clamp(parseInt(num.value, 10) || 0, -100, 100); num.value = v; rng.value = v; set(v); });
            num.addEventListener("keydown", function (e) { e.stopPropagation(); });
            r.appendChild(el("span", "", o[0])); r.appendChild(rng); r.appendChild(el("span", "", o[1])); r.appendChild(num);
            bb.appendChild(r);
        });
        p.appendChild(bb);
        var keep = el("label", "check", '<input type="checkbox"' + (g.balance.preserve ? " checked" : "") + "> 保持亮度");
        keep.querySelector("input").addEventListener("change", function (e) { updateGrade(function (gr) { gr.balance.preserve = e.target.checked; }); });
        p.appendChild(keep);

        var acts = el("div", "btn-row");
        acts.style.marginTop = "12px";
        var reset = el("button", "btn", svg("refresh") + "重置");
        reset.addEventListener("click", function () { updateGrade(function (gr) { var d = MHGrade.defaults(); gr.levels = d.levels; gr.balance = d.balance; gr.curves = d.curves; }); renderGradePanel(); });
        var copy = el("button", "btn", svg("copyKeys") + "复制到全部素材");
        copy.addEventListener("click", function () {
            S.clips.forEach(function (o) { o.grade = MHGrade.clone(c.grade); o.lut = MHGrade.compile(o.grade); });
            draw(); toast({ ok: true, msg: "已把当前调色复制到全部 " + S.clips.length + " 个素材" });
        });
        acts.appendChild(reset); acts.appendChild(copy);
        p.appendChild(acts);
        p.parentNode.scrollTop = scroll;
    }

    function drawHistogram(cv, c) {
        var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
        if (!W || !c.ok || c.el.readyState < 2) return;
        cv.width = W * dpr; cv.height = H * dpr;
        var g = cv.getContext("2d");
        g.scale(dpr, dpr);
        var tmp = document.createElement("canvas"), tw = 160, th = Math.max(1, Math.round(160 * c.el.videoHeight / c.el.videoWidth));
        tmp.width = tw; tmp.height = th;
        var t = tmp.getContext("2d");
        t.drawImage(c.el, 0, 0, tw, th);
        var d = t.getImageData(0, 0, tw, th).data, hist = new Float32Array(256), max = 0, i;
        for (i = 0; i < d.length; i += 4) hist[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
        for (i = 0; i < 256; i++) max = Math.max(max, hist[i]);
        g.fillStyle = "rgba(244,244,242,.4)";
        for (i = 0; i < 256; i++) { var h = Math.sqrt(hist[i] / max) * (H - 4); g.fillRect(i / 256 * W, H - h, W / 256 + 0.5, h); }
        var lv = c.grade.levels, accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
        g.fillStyle = accent;
        [lv.inB, lv.inB + (lv.inW - lv.inB) * Math.pow(0.5, lv.gamma), lv.inW].forEach(function (x) { g.fillRect(x / 255 * W - 1, 0, 2, H); });
    }

    function drawCurve(cv, c) {
        var dpr = window.devicePixelRatio || 1, W = cv.clientWidth;
        if (!W) return;
        cv.width = W * dpr; cv.height = W * dpr;
        var g = cv.getContext("2d");
        g.scale(dpr, dpr);
        g.strokeStyle = "rgba(244,244,242,.1)";
        g.lineWidth = 1;
        for (var i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * W / 4, 0); g.lineTo(i * W / 4, W); g.moveTo(0, i * W / 4); g.lineTo(W, i * W / 4); g.stroke(); }
        g.beginPath(); g.moveTo(0, W); g.lineTo(W, 0); g.strokeStyle = "rgba(244,244,242,.18)"; g.stroke();
        var colors = { rgb: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), r: "#ff5a5a", g: "#57d257", b: "#5a8dff" };
        ["r", "g", "b", "rgb"].forEach(function (ch) {
            var pts = c.grade.curves[ch];
            if (ch !== curveCh && pts.length === 2 && pts[0][1] === 0 && pts[1][1] === 255) return;
            var tab = MHGrade.curveTable(pts);
            g.beginPath();
            for (var x = 0; x < 256; x++) { var px = x / 255 * W, py = W - tab[x] / 255 * W; if (x) g.lineTo(px, py); else g.moveTo(px, py); }
            g.strokeStyle = colors[ch];
            g.globalAlpha = ch === curveCh ? 1 : 0.35;
            g.lineWidth = ch === curveCh ? 2 : 1;
            g.stroke();
            g.globalAlpha = 1;
        });
        c.grade.curves[curveCh].forEach(function (p) {
            g.beginPath();
            g.arc(p[0] / 255 * W, W - p[1] / 255 * W, 4.5, 0, Math.PI * 2);
            g.fillStyle = "#F4F4F2"; g.fill();
            g.strokeStyle = colors[curveCh]; g.lineWidth = 1.5; g.stroke();
        });
    }

    function bindCurve(cv, c) {
        function pos(e) { var r = cv.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width * 255, 0, 255), clamp(255 - (e.clientY - r.top) / r.height * 255, 0, 255)]; }
        function nearest(pts, p) {
            var bi = -1, bd = 12 * 12 * 4;
            pts.forEach(function (q, i) { var d = (q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]); if (d < bd) { bd = d; bi = i; } });
            return bi;
        }
        cv.addEventListener("pointerdown", function (e) {
            var pts = c.grade.curves[curveCh], p = pos(e), i = nearest(pts, p);
            if (i < 0) {
                pts.push([Math.round(p[0]), Math.round(p[1])]);
                pts.sort(function (a, b) { return a[0] - b[0]; });
                i = nearest(pts, p);
            }
            var isEnd = i === 0 || i === pts.length - 1;
            cv.setPointerCapture(e.pointerId);
            function move(ev) {
                var q = pos(ev), lo = i > 0 ? pts[i - 1][0] + 2 : 0, hi = i < pts.length - 1 ? pts[i + 1][0] - 2 : 255;
                if (!isEnd) pts[i][0] = Math.round(clamp(q[0], lo, hi));
                else pts[i][0] = Math.round(clamp(q[0], i === 0 ? 0 : lo, i === 0 ? hi : 255));
                pts[i][1] = Math.round(q[1]);
                updateGrade(function () {});
                drawCurve(cv, c);
            }
            function up() { cv.removeEventListener("pointermove", move); cv.removeEventListener("pointerup", up); }
            cv.addEventListener("pointermove", move);
            cv.addEventListener("pointerup", up);
            updateGrade(function () {});
            drawCurve(cv, c);
        });
        cv.addEventListener("dblclick", function (e) {
            var pts = c.grade.curves[curveCh], i = nearest(pts, pos(e));
            if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); updateGrade(function () {}); drawCurve(cv, c); }
        });
        hint(cv, "曲线", "横轴是原来的亮度，纵轴是调整后的亮度；往上提变亮，S 形增加对比");
    }

    // =====================================================================
    // 右侧：导出
    // =====================================================================
    var busy = false;

    function renderExportPanel() {
        var p = $("#sp-export");
        p.innerHTML = "";
        var E = S.exp;
        head(p, "01", "DURATION", "时长");
        slider(p, "时长 s", 0, 60, 0.1, E.dur, function (v) { E.dur = v; local.set("exp", E); draw(); });
        p.appendChild(el("p", "note", "0 = 自动，取各格子裁切后最长的那段；短的素材会循环。"));

        head(p, "02", "GIF", "动图");
        var fpsRow = el("div", "ctl two");
        fpsRow.appendChild(el("span", "", "帧率"));
        var fseg = el("div", "seg2");
        [10, 12, 15, 20, 25].forEach(function (f) {
            var b = el("button", E.fps === f ? "on" : "", String(f));
            b.addEventListener("click", function () { E.fps = f; local.set("exp", E); renderExportPanel(); });
            fseg.appendChild(b);
        });
        fpsRow.appendChild(fseg);
        p.appendChild(fpsRow);
        var wRow = el("div", "ctl two");
        wRow.appendChild(el("span", "", "宽度"));
        var wseg = el("div", "seg2");
        [[360, "360"], [540, "540"], [720, "720"], [0, "原尺寸"]].forEach(function (o) {
            var b = el("button", E.width === o[0] ? "on" : "", o[1]);
            b.addEventListener("click", function () { E.width = o[0]; local.set("exp", E); renderExportPanel(); });
            wseg.appendChild(b);
        });
        wRow.appendChild(wseg);
        p.appendChild(wRow);
        var dith = el("label", "check", '<input type="checkbox"' + (E.dither ? " checked" : "") + "> 抖动（渐变更平滑，文件更大）");
        dith.querySelector("input").addEventListener("change", function (e) { E.dither = e.target.checked; local.set("exp", E); });
        p.appendChild(dith);

        head(p, "03", "VIDEO", "视频 · AE");
        var mfRow = el("div", "ctl two");
        mfRow.appendChild(el("span", "", "帧率"));
        var mseg = el("div", "seg2");
        [24, 25, 30, 60].forEach(function (f) {
            var b = el("button", E.mp4fps === f ? "on" : "", String(f));
            b.addEventListener("click", function () { E.mp4fps = f; local.set("exp", E); renderExportPanel(); });
            mseg.appendChild(b);
        });
        mfRow.appendChild(mseg);
        p.appendChild(mfRow);
        var aRow = el("div", "ctl two");
        aRow.appendChild(el("span", "", "声音"));
        var asel = el("select");
        asel.appendChild(new Option("不要声音", "-1"));
        S.clips.forEach(function (c, i) { asel.appendChild(new Option("用「" + c.name + "」的声音", String(i))); });
        asel.value = String(Math.min(E.audio, S.clips.length - 1));
        asel.addEventListener("change", function () { E.audio = +asel.value; local.set("exp", E); });
        aRow.appendChild(asel);
        p.appendChild(aRow);
        var rend = el("label", "check", '<input type="checkbox"' + (E.render ? " checked" : "") + "> 加入渲染队列后立即渲染");
        rend.querySelector("input").addEventListener("change", function (e) { E.render = e.target.checked; local.set("exp", E); });
        p.appendChild(rend);

        head(p, "04", "EXPORT", "导出");
        var bar = el("div", "progress", "<i></i>");
        var btns = el("div", "exp-btns");
        function expBtn(icon, label, sub, accent, fn, tip) {
            var b = el("button", "btn" + (accent ? " accent" : ""), svg(icon) + esc(label) + "<small>" + esc(sub) + "</small>");
            b.addEventListener("click", function () { if (!busy) fn(bar.firstChild); });
            hint(b, label, tip);
            btns.appendChild(b);
        }
        expBtn("play", "导出 GIF", "面板直接生成", true, exportGif, "按上面的帧率和宽度生成循环 GIF，调色和排版与预览完全一致");
        expBtn("save", "导出 MP4", "交给 AE 渲染", false, exportMp4, "面板逐帧渲染成 PNG 序列，AE 导入后加入渲染队列（AE 2023 及以上输出 H.264）");
        expBtn("widgets", "发送到 AE", "可编辑的合成", false, sendToAE, "在 AE 里搭出同样的排版：每个格子一个预合成，裁切、构图、圆角都保留；带色阶和色彩平衡效果");
        expBtn("styleCopy", "导出封面 PNG", "当前画面", false, exportPng, "把当前这一帧按原尺寸存成 PNG，可以当封面");
        p.appendChild(btns);
        p.appendChild(bar);
        p.appendChild(el("p", "note", "「发送到 AE」里，曲线没办法用脚本写进 AE 的曲线效果，所以只带色阶和色彩平衡；GIF 和 MP4 的调色与预览完全一致。"));
    }

    function ready() {
        if (!usedClips().length) { toast({ ok: false, msg: "先添加视频并放进格子里" }); return false; }
        return true;
    }

    // 逐帧渲染：k = 输出缩放
    function renderFrames(fps, k, onFrame, bar) {
        var D = duration(), n = Math.max(1, Math.round(D * fps));
        var out = document.createElement("canvas");
        out.width = Math.max(2, Math.round(S.size.w * k));
        out.height = Math.max(2, Math.round(S.size.h * k));
        var g = out.getContext("2d", { willReadFrequently: true });
        setPlaying(false);
        var i = 0;
        function step() {
            if (i >= n) return Promise.resolve({ canvas: out, frames: n });
            return seekAll(i / fps).then(function () {
                compose(g, k, false);
                return onFrame(g, out, i, n);
            }).then(function () {
                i++;
                if (bar) bar.style.width = Math.round(i / n * 100) + "%";
                toast({ ok: true, msg: "正在渲染第 " + i + " / " + n + " 帧…" }, true);
                return step();
            });
        }
        return step();
    }

    function saveBytes(bytes, title, name, ext) {
        if (NODE && CEP) {
            return host("saveFile", { title: title, name: name, ext: ext }).then(function (r) {
                if (!r.ok || !r.data.path) return { ok: false, msg: r.msg || "已取消" };
                fs.writeFileSync(r.data.path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
                return { ok: true, msg: "已保存：" + r.data.path, path: r.data.path };
            });
        }
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([bytes]));
        a.download = name + "." + ext;
        a.click();
        return Promise.resolve({ ok: true, msg: "已下载 " + a.download });
    }

    function stamp() { var d = new Date(); return "MotionHub_" + d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2) + "_" + ("0" + d.getHours()).slice(-2) + ("0" + d.getMinutes()).slice(-2); }

    function exportGif(bar) {
        if (!ready()) return;
        busy = true;
        var E = S.exp, k = E.width ? Math.min(1, E.width / S.size.w) : 1, enc = null;
        renderFrames(E.fps, k, function (g, cv) {
            if (!enc) enc = new MHGif.Encoder(cv.width, cv.height, { delayCs: 100 / E.fps, dither: E.dither });
            enc.addFrame(g.getImageData(0, 0, cv.width, cv.height).data);
        }, bar).then(function () {
            toast({ ok: true, msg: "正在压缩 GIF…" }, true);
            return new Promise(function (res) { setTimeout(function () { res(enc.finish(function (p) { bar.style.width = Math.round(p * 100) + "%"; })); }, 20); });
        }).then(function (bytes) {
            return saveBytes(bytes, "保存 GIF", stamp(), "gif").then(function (r) {
                if (r.ok) r.msg += "（" + (bytes.length / 1024 / 1024).toFixed(1) + " MB）";
                return r;
            });
        }).then(function (r) { busy = false; toast(r); }).catch(function (e) { busy = false; toast({ ok: false, msg: "导出失败：" + (e.message || e) }); });
    }

    function exportPng(bar) {
        if (!ready()) return;
        var cv = document.createElement("canvas");
        cv.width = S.size.w; cv.height = S.size.h;
        compose(cv.getContext("2d"), 1, false);
        cv.toBlob(function (b) {
            b.arrayBuffer().then(function (buf) {
                return saveBytes(new Uint8Array(buf), "保存封面", stamp() + "_cover", "png");
            }).then(toast);
        }, "image/png");
    }

    // 需要真实文件路径的场合（发送到 AE、声音）：拖进来的文件没有路径时，先存一份到临时文件夹
    function ensurePath(c) {
        if (c.path) return Promise.resolve(c.path);
        if (!NODE || !c.blob) return Promise.reject(new Error("「" + c.name + "」没有文件路径，请用「添加视频」按钮重新添加"));
        return c.blob.arrayBuffer().then(function (buf) {
            var dir = nodePath.join(os.tmpdir(), "motionhub_studio");
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            var p = nodePath.join(dir, c.id + "_" + c.name);
            fs.writeFileSync(p, Buffer.from(buf));
            c.path = p;
            return p;
        });
    }

    function exportMp4(bar) {
        if (!ready()) return;
        if (!NODE || !CEP) { toast({ ok: false, msg: "导出 MP4 需要在 After Effects 里使用" }); return; }
        busy = true;
        var E = S.exp, name = stamp();
        var dir = nodePath.join(os.tmpdir(), "motionhub_studio", name);
        fs.mkdirSync(dir, { recursive: true });
        host("saveFile", { title: "导出 MP4", name: name, ext: "mp4" }).then(function (r) {
            if (!r.ok || !r.data.path) throw new Error("已取消");
            var out = r.data.path;
            return renderFrames(E.mp4fps, 1, function (g, cv, i) {
                var data = cv.toDataURL("image/png").split(",")[1];
                fs.writeFileSync(nodePath.join(dir, "frame_" + ("0000" + i).slice(-5) + ".png"), Buffer.from(data, "base64"));
            }, bar).then(function () {
                var ac = S.clips[E.audio];
                var audio = ac && ac.ok ? ensurePath(ac).then(function (p) { return { path: p, start: ac.in, length: ac.out - ac.in }; }) : Promise.resolve(null);
                return audio;
            }).then(function (audio) {
                toast({ ok: true, msg: E.render ? "AE 正在渲染…（期间 AE 会暂时不响应）" : "正在导入到 AE…" }, true);
                return host("studioRender", {
                    first: nodePath.join(dir, "frame_00000.png"), fps: E.mp4fps, width: S.size.w, height: S.size.h,
                    duration: duration(), name: name, out: out, render: E.render, audio: audio
                });
            });
        }).then(function (r) { busy = false; toast(r); }).catch(function (e) { busy = false; toast({ ok: false, msg: e.message === "已取消" ? "已取消" : "导出失败：" + (e.message || e) }); });
    }

    function sendToAE() {
        if (!ready()) return;
        if (!CEP) { toast({ ok: false, msg: "发送到 AE 需要在 After Effects 里使用" }); return; }
        busy = true;
        var rects = cellRects(S.size.w, S.size.h);
        Promise.all(S.cells.map(function (cell, i) {
            var c = S.clips[cell.clip];
            if (!c || !c.ok) return Promise.resolve(null);
            return ensurePath(c).then(function (path) {
                var r = rects[i], p = placement(cell, c, r.w, r.h);
                return {
                    x: r.x, y: r.y, w: r.w, h: r.h, path: path, name: c.name, start: c.in, length: c.out - c.in,
                    vw: c.el.videoWidth, vh: c.el.videoHeight, place: p, levels: c.grade.levels, balance: c.grade.balance,
                    curved: JSON.stringify(c.grade.curves) !== JSON.stringify(MHGrade.defaults().curves)
                };
            });
        })).then(function (cells) {
            var ac = S.clips[S.exp.audio];
            return (ac && ac.ok ? ensurePath(ac).then(function (p) { return { path: p, start: ac.in }; }) : Promise.resolve(null)).then(function (audio) {
                return host("studioBuild", {
                    name: stamp(), width: S.size.w, height: S.size.h, fps: S.exp.mp4fps, duration: duration(),
                    bg: rgb(S.bg).map(function (v) { return v / 255; }), radius: S.radius, cells: cells.filter(Boolean), audio: audio
                });
            });
        }).then(function (r) { busy = false; toast(r); }).catch(function (e) { busy = false; toast({ ok: false, msg: "发送失败：" + (e.message || e) }); });
    }

    // =====================================================================
    // 启动
    // =====================================================================
    $$(".tab", $("#stabs")).forEach(function (t) {
        t.addEventListener("click", function () {
            $$(".tab", $("#stabs")).forEach(function (x) { x.classList.toggle("on", x === t); });
            $$(".spage").forEach(function (p) { p.classList.toggle("on", p.id === "sp-" + t.dataset.tab); });
            if (t.dataset.tab === "grade") renderGradePanel();
            if (t.dataset.tab === "export") renderExportPanel();
        });
    });
    $$("[data-icon]").forEach(function (n) { n.innerHTML = svg(n.dataset.icon); });
    $("#add-clips").addEventListener("click", pickVideos);
    hint($("#add-clips"), "添加视频", "支持 MP4 / MOV / WebM（H.264、VP9 等可以在面板里预览的编码）");
    $("#btn-accent").addEventListener("click", function () {
        showPop($("#btn-accent"), [el("div", "p-title", "界面主题色"), swatches(local.get("accent", "#FF5900"), function (hex) { local.set("accent", hex); applyAccent(hex); draw(); })]);
    });
    hint($("#btn-accent"), "主题色", "默认是风翮品牌橙，也可以换成别的颜色");

    applyAccent(local.get("accent", "#FF5900"));
    hintEl.innerHTML = IDLE;
    syncCells();
    renderClips();
    renderLayoutPanel();
    renderExportPanel();
    requestAnimationFrame(function () { fitView(); draw(); renderTrim(); });
    window.MHStudio = { S: S, addClip: addClip, draw: draw, duration: duration };
})();
