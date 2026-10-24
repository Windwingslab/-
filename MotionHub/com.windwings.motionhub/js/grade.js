/* MotionHub Studio · 调色
   顺序：色阶（输入黑白点 + 伽马 + 输出黑白点）→ 色彩平衡（阴影 / 中间调 / 高光）→ 曲线（单通道后 RGB 总曲线）
   全部换算成 256 级查找表，逐像素应用 */
(function (root) {
    "use strict";

    function defaults() {
        return {
            levels: { inB: 0, inW: 255, gamma: 1, outB: 0, outW: 255 },
            balance: { shadows: [0, 0, 0], mid: [0, 0, 0], high: [0, 0, 0], preserve: true },
            curves: { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] }
        };
    }

    function clone(g) { return JSON.parse(JSON.stringify(g)); }

    function isNeutral(g) { return JSON.stringify(g) === JSON.stringify(defaults()); }

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

    // 单调三次插值（Fritsch–Carlson），曲线不会过冲
    function curveTable(points) {
        var p = points.slice().sort(function (a, b) { return a[0] - b[0]; });
        var n = p.length, out = new Uint8Array(256), i;
        if (n < 2) { for (i = 0; i < 256; i++) out[i] = i; return out; }
        var dx = [], dy = [], m = [], t = [];
        for (i = 0; i < n - 1; i++) { dx.push(Math.max(1e-6, p[i + 1][0] - p[i][0])); dy.push(p[i + 1][1] - p[i][1]); m.push(dy[i] / dx[i]); }
        t.push(m[0]);
        for (i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
        t.push(m[n - 2]);
        for (i = 0; i < n - 1; i++) {
            if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
            var a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
            if (s > 9) { var k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
        }
        for (var x = 0; x < 256; x++) {
            var y;
            if (x <= p[0][0]) y = p[0][1];
            else if (x >= p[n - 1][0]) y = p[n - 1][1];
            else {
                var j = 0;
                while (j < n - 2 && x > p[j + 1][0]) j++;
                var h = dx[j], u = (x - p[j][0]) / h, u2 = u * u, u3 = u2 * u;
                y = (2 * u3 - 3 * u2 + 1) * p[j][1] + (u3 - 2 * u2 + u) * h * t[j] + (-2 * u3 + 3 * u2) * p[j + 1][1] + (u3 - u2) * h * t[j + 1];
            }
            out[x] = clamp(Math.round(y), 0, 255);
        }
        return out;
    }

    function levelsTable(l) {
        var out = new Uint8Array(256), span = Math.max(1, l.inW - l.inB), g = Math.max(0.05, l.gamma);
        for (var x = 0; x < 256; x++) {
            var v = clamp((x - l.inB) / span, 0, 1);
            v = Math.pow(v, 1 / g);
            out[x] = clamp(Math.round(l.outB + v * (l.outW - l.outB)), 0, 255);
        }
        return out;
    }

    function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

    // 色彩平衡：每个通道按亮度分配到阴影 / 中间调 / 高光三段，滑块 -100…100
    function balanceTables(bal) {
        var tabs = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
        for (var x = 0; x < 256; x++) {
            var v = x / 255, ws = 1 - smooth(0, 0.5, v), wh = smooth(0.5, 1, v), wm = Math.max(0, 1 - ws - wh);
            for (var c = 0; c < 3; c++) {
                var d = (bal.shadows[c] * ws + bal.mid[c] * wm + bal.high[c] * wh) / 100 * 0.3;
                tabs[c][x] = clamp(Math.round((v + d) * 255), 0, 255);
            }
        }
        return tabs;
    }

    // 编译成一组查找表，渲染时复用
    function compile(g) {
        var lv = levelsTable(g.levels), bal = balanceTables(g.balance);
        var cm = curveTable(g.curves.rgb), cr = curveTable(g.curves.r), cg = curveTable(g.curves.g), cb = curveTable(g.curves.b);
        var balanced = g.balance.shadows.concat(g.balance.mid, g.balance.high).some(function (v) { return v !== 0; });
        return {
            neutral: isNeutral(g),
            lv: lv, br: bal[0], bg: bal[1], bb: bal[2], balanced: balanced, preserve: g.balance.preserve,
            cr: cr, cg: cg, cb: cb, cm: cm
        };
    }

    // 对 ImageData 原地调色
    function apply(data, c) {
        if (c.neutral) return;
        var lv = c.lv, br = c.br, bgt = c.bg, bb = c.bb, cr = c.cr, cg = c.cg, cb = c.cb, cm = c.cm;
        var bal = c.balanced, keep = c.preserve;
        for (var i = 0; i < data.length; i += 4) {
            var r = lv[data[i]], g = lv[data[i + 1]], b = lv[data[i + 2]];
            if (bal) {
                var r2 = br[r], g2 = bgt[g], b2 = bb[b];
                if (keep) {
                    var d = (0.2126 * (r - r2) + 0.7152 * (g - g2) + 0.0722 * (b - b2));
                    r2 += d; g2 += d; b2 += d;
                    r2 = r2 < 0 ? 0 : r2 > 255 ? 255 : r2 | 0;
                    g2 = g2 < 0 ? 0 : g2 > 255 ? 255 : g2 | 0;
                    b2 = b2 < 0 ? 0 : b2 > 255 ? 255 : b2 | 0;
                }
                r = r2; g = g2; b = b2;
            }
            data[i] = cm[cr[r]];
            data[i + 1] = cm[cg[g]];
            data[i + 2] = cm[cb[b]];
        }
    }

    // 预设风格（用曲线 + 色阶 + 色彩平衡组合出来）
    var LOOKS = [
        ["原图", function () { return defaults(); }],
        ["暖阳", function () { var g = defaults(); g.balance.mid = [18, 4, -22]; g.balance.high = [10, 0, -12]; g.curves.rgb = [[0, 0], [64, 58], [192, 200], [255, 255]]; return g; }],
        ["冷调", function () { var g = defaults(); g.balance.shadows = [-12, 0, 18]; g.balance.mid = [-10, 0, 14]; return g; }],
        ["胶片", function () { var g = defaults(); g.levels.outB = 18; g.levels.outW = 242; g.curves.rgb = [[0, 0], [70, 58], [185, 200], [255, 255]]; g.balance.shadows = [0, 6, 10]; g.balance.high = [8, 2, -10]; return g; }],
        ["高对比", function () { var g = defaults(); g.curves.rgb = [[0, 0], [64, 44], [192, 212], [255, 255]]; return g; }],
        ["柔和", function () { var g = defaults(); g.levels.outB = 24; g.levels.gamma = 1.1; g.curves.rgb = [[0, 0], [64, 72], [192, 186], [255, 255]]; return g; }],
        ["品牌橙", function () { var g = defaults(); g.balance.mid = [22, 6, -18]; g.balance.shadows = [8, 0, -6]; g.curves.r = [[0, 0], [128, 140], [255, 255]]; return g; }]
    ];

    root.MHGrade = { defaults: defaults, clone: clone, isNeutral: isNeutral, compile: compile, apply: apply, curveTable: curveTable, LOOKS: LOOKS };
})(typeof window !== "undefined" ? window : globalThis);
