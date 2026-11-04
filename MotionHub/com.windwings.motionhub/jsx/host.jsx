/*
    MotionHub 后台（ExtendScript）
    由 CEP 面板通过 evalScript 调用：MH.call("工具名", {参数})，返回 JSON 字符串 {ok, msg, data}
*/

var MH = (function () {
    var VERSION = "3.8.0";
    var EXT_RE = /\.(jsx|jsxbin|ffx)$/i;
    var IS_WIN = $.os.indexOf("Windows") !== -1;
    var EXT_ROOT = null;
    try { EXT_ROOT = new File($.fileName).parent.parent; } catch (e) {}

    var state = { libPath: null };
    try {
        if (app.settings.haveSetting("MotionHub", "libPath")) state.libPath = app.settings.getSetting("MotionHub", "libPath");
    } catch (e0) {}

    // 关键帧剪贴板放在全局，多个面板共用、重新加载脚本也不丢
    if (!$.global.MH_CLIP) $.global.MH_CLIP = null;

    // =====================================================================
    // JSON（ExtendScript 没有内置 JSON）
    // =====================================================================
    var HEX = "0123456789abcdef";
    function u4(c) { return "\\u00" + HEX.charAt((c >> 4) & 15) + HEX.charAt(c & 15); }
    function q(s) {
        s = String(s);
        var out = "", i, c, ch;
        for (i = 0; i < s.length; i++) {
            ch = s.charAt(i);
            c = s.charCodeAt(i);
            if (ch === "\\") out += "\\\\";
            else if (ch === '"') out += '\\"';
            else if (c === 10) out += "\\n";
            else if (c === 13) out += "\\r";
            else if (c === 9) out += "\\t";
            else if (c < 32) out += u4(c);
            else if (c === 0x2028) out += "\\u2028";
            else if (c === 0x2029) out += "\\u2029";
            else out += ch;
        }
        return '"' + out + '"';
    }

    function stringify(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return q(v);
        if (v instanceof Array) {
            var a = [];
            for (var i = 0; i < v.length; i++) a.push(stringify(v[i]));
            return "[" + a.join(",") + "]";
        }
        var o = [];
        for (var k in v) if (v.hasOwnProperty(k)) o.push(q(k) + ":" + stringify(v[k]));
        return "{" + o.join(",") + "}";
    }

    // 用户可读的错误：会原样显示在面板底部
    function fail(msg) {
        var e = new Error(msg);
        e.isUser = true;
        throw e;
    }

    // =====================================================================
    // 通用
    // =====================================================================
    function activeComp() {
        var c = app.project.activeItem;
        if (!(c && c instanceof CompItem)) fail("请先打开或选中一个合成");
        return c;
    }

    function needLayers(comp, n) {
        var l = comp.selectedLayers;
        if (l.length < n) fail("请先选择至少 " + n + " 个图层");
        return l;
    }

    function isTransformable(layer) {
        return !(layer instanceof CameraLayer || layer instanceof LightLayer);
    }

    function addVec(v, d) {
        if (typeof v === "number") return v + d[0];
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(v[i] + (i < d.length ? d[i] : 0));
        return out;
    }

    function offsetProp(prop, d) {
        if (prop.numKeys === 0) {
            // 用表达式之前的值：有表达式时 .value 是表达式算出来的，拿它加位移再写回去会多加一次（比如 value + [5, 0]）
            prop.setValue(addVec(prop.valueAtTime(0, true), d));
        } else {
            for (var k = 1; k <= prop.numKeys; k++) prop.setValueAtKey(k, addVec(prop.keyValue(k), d));
        }
    }

    // 在父级坐标里平移图层（位置有关键帧时整条轨迹一起平移）；dz 只对 3D 图层有用
    function moveLayerBy(layer, dx, dy, dz) {
        var tr = layer.transform, three = !!(dz && layer.threeDLayer);
        if (tr.position.dimensionsSeparated) {
            if (dx) offsetProp(tr.property("ADBE Position_0"), [dx]);
            if (dy) offsetProp(tr.property("ADBE Position_1"), [dy]);
            if (three) offsetProp(tr.property("ADBE Position_2"), [dz]);
        } else if (dx || dy || three) {
            offsetProp(tr.position, three ? [dx, dy, dz] : [dx, dy]);
        }
    }

    function layerPosition(layer, t) {
        var tr = layer.transform;
        if (tr.position.dimensionsSeparated) {
            var p = [tr.property("ADBE Position_0").valueAtTime(t, false),
                     tr.property("ADBE Position_1").valueAtTime(t, false)];
            if (layer.threeDLayer) p.push(tr.property("ADBE Position_2").valueAtTime(t, false));
            return p;
        }
        return tr.position.valueAtTime(t, false);
    }

    // =====================================================================
    // 图层几何（3.8）：锚点、居中、对齐、分布、空对象都按「看得见的部分」算——
    // 有遮罩时只算遮罩露出来的范围，时间轴上选中了遮罩（刚画完的遮罩默认就是选中的）就按选中的遮罩；
    // 带父级的图层按它在合成里的实际位置算；3D 图层转过 X / Y 时，锚点的补偿交给 AE 自己算
    // =====================================================================
    function emptyBox() { return { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }; }
    function addPt(b, x, y) {
        if (x < b.l) b.l = x;
        if (x > b.r) b.r = x;
        if (y < b.t) b.t = y;
        if (y > b.b) b.b = y;
    }
    function boxOk(b) { return !!b && b.r >= b.l && b.b >= b.t; }
    function hasArea(b) { return !!b && b.r > b.l && b.b > b.t; }
    function boxSize(b) { return Math.max(0, b.r - b.l) + Math.max(0, b.b - b.t); }
    function unionBox(a, b) {
        if (!boxOk(a)) return b;   // 空的（比如没有重叠的交集）：不能把它的四个角当成真的点
        if (!boxOk(b)) return a;
        var o = emptyBox(); addPt(o, a.l, a.t); addPt(o, a.r, a.b); addPt(o, b.l, b.t); addPt(o, b.r, b.b); return o;
    }
    function crossBox(a, b) { return { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) }; }
    // 外框往外推（ex、ey 是负数就往里收）
    function growBox(b, ex, ey) { return b ? { l: b.l - ex, t: b.t - ey, r: b.r + ex, b: b.b + ey } : null; }
    // 图层坐标里的一个矩形，经过 2D 变换 M 以后在合成里的外框（四个角变换过去）
    function mappedBox(b, M) {
        var o = emptyBox(), k = [[b.l, b.t], [b.r, b.t], [b.l, b.b], [b.r, b.b]], i;
        for (i = 0; i < 4; i++) { var q = applyM(M, k[i][0], k[i][1]); addPt(o, q[0], q[1]); }
        return o;
    }

    // 一段三次贝塞尔在一个坐标上导数为 0 的位置（0 < t < 1）
    function bezRoots(p0, p1, p2, p3) {
        var d0 = p1 - p0, d1 = p2 - p1, d2 = p3 - p2;
        var A = d0 - 2 * d1 + d2, Bq = 2 * (d1 - d0), C = d0, out = [], ts = [], i;
        if (Math.abs(A) < 1e-12) { if (Math.abs(Bq) > 1e-12) ts.push(-C / Bq); }
        else {
            var disc = Bq * Bq - 4 * A * C;
            if (disc >= 0) { var sq = Math.sqrt(disc); ts.push((-Bq + sq) / (2 * A), (-Bq - sq) / (2 * A)); }
        }
        for (i = 0; i < ts.length; i++) if (ts[i] > 0 && ts[i] < 1) out.push(ts[i]);
        return out;
    }
    function bezAt(p0, p1, p2, p3, t) { var u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; }

    // 路径（遮罩形状）的精确外框：顶点 + 每段曲线鼓出去最远的地方
    function shapeBox(sh) {
        var v = sh && sh.vertices, n = v ? v.length : 0, b = emptyBox(), i, k;
        if (!n) return null;
        var tin = sh.inTangents || [], tout = sh.outTangents || [];
        for (i = 0; i < n; i++) addPt(b, v[i][0], v[i][1]);
        var segs = sh.closed ? n : n - 1;
        for (i = 0; i < segs; i++) {
            var j = (i + 1) % n, o = tout[i] || [0, 0], q2 = tin[j] || [0, 0];
            var x0 = v[i][0], y0 = v[i][1], x3 = v[j][0], y3 = v[j][1];
            var x1 = x0 + o[0], y1 = y0 + o[1], x2 = x3 + q2[0], y2 = y3 + q2[1];
            var rs = bezRoots(x0, x1, x2, x3).concat(bezRoots(y0, y1, y2, y3));
            for (k = 0; k < rs.length; k++) addPt(b, bezAt(x0, x1, x2, x3, rs[k]), bezAt(y0, y1, y2, y3, rs[k]));
        }
        return b;
    }

    // 路径（顶点 + 切线手柄）经过 2D 变换：仿射变换后的贝塞尔还是贝塞尔，变换控制点就够了
    function mapShape(sh, M) {
        if (!M || !sh || !sh.vertices) return sh;
        var v = sh.vertices, tin = sh.inTangents || [], tout = sh.outTangents || [], o = { vertices: [], inTangents: [], outTangents: [], closed: sh.closed }, i;
        for (i = 0; i < v.length; i++) {
            var a = tin[i] || [0, 0], b = tout[i] || [0, 0];
            o.vertices.push(applyM(M, v[i][0], v[i][1]));
            o.inTangents.push([M[0] * a[0] + M[2] * a[1], M[1] * a[0] + M[3] * a[1]]);
            o.outTangents.push([M[0] * b[0] + M[2] * b[1], M[1] * b[0] + M[3] * b[1]]);
        }
        return o;
    }

    // 遮罩露出来的范围。返回 null：没有起作用的遮罩。
    // 结果按「块」记（parts）：每个相加的遮罩是一块；相交时每块各自去交，交不上的扔掉；相减的矩形遮罩从每块里切掉——
    // 伸到图层外面的遮罩、夹在两个相加遮罩中间的相交遮罩都不会把范围撑大。lbox / box 是所有块合起来的外框（图层坐标 / 合成坐标）
    // M：可选的 2D 变换（图层坐标 → 合成坐标）。给了 M 时每块也记合成坐标里的外框：
    //   「有没有交集、交出来是不是空的」都在图层坐标里判断——旋转以后外框会互相重叠，在合成里判断会把只碰到边、
    //   甚至隔着一条缝的两个遮罩当成有交集；合成里的外框按变换后的路径精确算（旋转后的圆不会大一圈），
    //   每次相交、切掉以后再用图层坐标里这一块的四个角收紧
    // c：内容的外框（图层坐标）：第一个遮罩是相减（或反转的相加）时从整个图层开始切
    // 选中了遮罩：只看选中的（包括模式是「无」的参考遮罩）；否则按遮罩模式从上往下合起来：
    // 相加 / 变亮 / 差值 = 并上，相交 / 变暗 / 反转的相减 = 交上，相减 / 反转的相交 / 反转的变暗 = 切掉（矩形遮罩才切得准，
    // 别的形状不缩小范围），反转的相加 = 并上遮罩外面的部分（矩形遮罩），别的形状 = 整个图层
    function maskInfo(layer, t, M, c) {
        var g = null, n = 0, i, k;
        try { g = layer.property("ADBE Mask Parade"); n = g ? g.numProperties : 0; } catch (e) { return null; }
        if (!n) return null;
        var all = [], sel = [];
        for (i = 1; i <= n; i++) {
            var m, sh, lb = null, cb = null, mode, isSel = false, ex = 0;
            try {
                m = g.property(i);
                mode = m.maskMode;
                try { isSel = !!m.selected; } catch (e1) {}
                if (mode === MaskMode.NONE && !isSel) continue;
                sh = m.property("ADBE Mask Shape").valueAtTime(t, false);
                try { ex = m.property("ADBE Mask Offset").valueAtTime(t, false) || 0; } catch (e2) {}   // 「蒙版扩展」的 matchName
                lb = growBox(shapeBox(sh), ex, ex);
                // 扩展是在图层坐标里推 ex 个像素：到了合成里，横向推 ex·|M 的第一行|、纵向推 ex·|第二行|（不等比缩放时两个方向不一样）
                if (M && lb) cb = growBox(shapeBox(mapShape(sh, M)), ex * Math.sqrt(M[0] * M[0] + M[2] * M[2]), ex * Math.sqrt(M[1] * M[1] + M[3] * M[3]));
            } catch (e3) { continue; }
            // 往里收得比形状还大（负的扩展）：形状没了，但它还在遮罩的顺序里——第一个遮罩是什么决定从哪里开始算，不能跳过
            if (!boxOk(lb)) { if (mode !== MaskMode.NONE) all.push({ nil: true, mode: mode, inv: !!m.inverted }); continue; }
            if (M) cb = boxOk(cb) ? crossBox(cb, mappedBox(lb, M)) : mappedBox(lb, M);   // 往里收（负的扩展）时用四个角收紧
            // 相减时一定被挖空的矩形：边和坐标轴平行的矩形遮罩（扩展为正时取圆角矩形里面的两个十字矩形）
            var ar = axisRect(sh), cut = null;
            if (ar) { var gr = growBox(ar, ex, ex); cut = ex <= 0 ? (boxOk(gr) ? [gr] : []) : [growBox(ar, ex, 0), growBox(ar, 0, ex)]; }
            var it = { lb: lb, cb: cb, mode: mode, inv: !!m.inverted, cut: cut, sh: ex ? null : sh };   // 折线（poly）用到时才压
            if (isSel) sel.push(it);
            if (mode !== MaskMode.NONE) all.push(it);
        }
        if (sel.length) {
            var sl = sel[0].lb, sc = sel[0].cb;
            for (i = 1; i < sel.length; i++) { sl = unionBox(sl, sel[i].lb); if (M) sc = unionBox(sc, sel[i].cb); }
            return { box: M ? sc : sl, lbox: sl, sel: true };
        }
        // P：现在露出来的块；null = 整个图层（还没被遮罩限制）
        var P = null, first = true, whole = function () { return c ? [{ lb: c, cb: M ? mappedBox(c, M) : null, sh: null }] : null; };
        for (i = 0; i < all.length; i++) {
            var x = all[i], md = x.mode, kind;
            var add = md === MaskMode.ADD || md === MaskMode.LIGHTEN || md === MaskMode.DIFFERENCE;
            var cutm = md === MaskMode.INTERSECT || md === MaskMode.DARKEN;
            if (add) kind = x.inv ? "outside" : "union";
            else if (cutm) kind = x.inv ? "minus" : "cross";
            else if (md === MaskMode.SUBTRACT) kind = x.inv ? "cross" : "minus";
            else kind = "keep";
            if (x.nil) {
                // 空形状：相加 / 相交 → 这一步什么都没有（第一个就是空的开始）；反转的相加 → 并上整个图层；相减 → 不变
                if (first) { first = false; P = kind === "union" || kind === "cross" ? [] : null; continue; }
                if (kind === "cross") P = [];
                else if (kind === "outside") P = null;
                continue;
            }
            if (first) {
                first = false;
                if (kind === "union" || kind === "cross") { P = [piece(x)]; continue; }
                // 第一个是反转的相加：只露出遮罩外面。矩形遮罩 = 整个图层切掉这个矩形；别的形状当成整个图层
                if (kind === "outside") { var W0 = x.cut ? whole() : null; if (W0) P = cutParts(W0, x.cut, M); continue; }
                // 相减、反转的相交：从整个图层开始，下面照常切
            }
            if (kind === "union") { if (P) P.push(piece(x)); }
            else if (kind === "cross") {
                if (!P) { P = [piece(x)]; continue; }
                var Q = [];
                for (k = 0; k < P.length; k++) {
                    var l2 = crossBox(P[k].lb, x.lb);
                    if (!hasArea(l2)) continue;   // 只碰到边、角，或者隔着缝：这一块什么都露不出来
                    var poly2 = P[k].poly, pure = P[k].pure;
                    if (polyOf(x) && x.cvx) {
                        // 交上一个凸的形状（椭圆、圆这类）：按形状本身交（外框重叠、形状交不上的两个圆也认得出来）
                        poly2 = clipConvex(polyOf(P[k]) || rectPoly(l2), x.poly); pure = false;
                        if (!poly2.length) continue;
                        l2 = crossBox(l2, polyBox(poly2, null));
                        if (!hasArea(l2)) continue;
                    }
                    var c2 = M ? crossBox(crossBox(P[k].cb, x.cb), mappedBox(l2, M)) : null;
                    if (M && poly2 && !pure) c2 = crossBox(c2, polyBox(poly2, M));
                    if (M && !boxOk(c2)) continue;
                    Q.push({ lb: l2, cb: c2, sh: P[k].sh, poly: poly2, pure: pure });
                }
                P = Q;
            } else if (kind === "minus") {
                if (!x.cut) continue;   // 曲线形状挖掉的部分算不准：范围不缩小
                if (!P) P = whole();
                if (P) P = cutParts(P, x.cut, M);
            } else if (kind === "outside") {
                // 反转的相加：并上遮罩外面的部分。矩形遮罩 = 整个图层切掉这个矩形；别的形状算不准，当成整个图层
                if (!P) continue;
                var W = x.cut ? whole() : null;
                if (W) P = P.concat(cutParts(W, x.cut, M)); else P = null;
            }
        }
        if (!P) return null;
        var RL = emptyBox(), RC = emptyBox();
        for (k = 0; k < P.length; k++) { RL = unionBox(RL, P[k].lb); if (M) RC = unionBox(RC, P[k].cb); }
        return { box: M ? RC : RL, lbox: RL, parts: P, sel: false, empty: !P.length };
    }
    // 一个遮罩变成一块
    function piece(x) { return { lb: x.lb, cb: x.cb, sh: x.sh, poly: x.poly, pure: true }; }
    // 遮罩 / 块的折线：第一次用到时才把路径压成折线（大多数情况用不到：遮罩整个在图层里面时外框已经是准的）
    function polyOf(x) {
        if (x.poly === undefined) { x.poly = x.sh && x.sh.closed ? flatPath(x.sh) : null; x.cvx = !!x.poly && polyConvex(x.poly); }
        return x.poly;
    }
    function inside(b, c) { return b.l >= c.l && b.t >= c.t && b.r <= c.r && b.b <= c.b; }
    function rectPoly(b) { return [[b.l, b.t], [b.r, b.t], [b.r, b.b], [b.l, b.b]]; }
    // 折线的外框（给了 M 就是变换以后的外框）；往外放 0.1 px：折线比曲线稍微往里，放一点保证不比真实的小
    function polyBox(P, M) {
        var o = emptyBox(), i, ex = 0.1, ey = 0.1;
        for (i = 0; i < P.length; i++) { var q = M ? applyM(M, P[i][0], P[i][1]) : P[i]; addPt(o, q[0], q[1]); }
        if (M) { ex = 0.1 * Math.sqrt(M[0] * M[0] + M[2] * M[2]); ey = 0.1 * Math.sqrt(M[1] * M[1] + M[3] * M[3]); }
        return growBox(o, ex, ey);
    }
    function polyArea(P) { var a = 0, i; for (i = 0; i < P.length; i++) { var p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
    // 折线是不是凸的（每个拐角都往同一边拐）
    function polyConvex(P) {
        var n = P.length, sgn = 0, i;
        if (n < 3) return false;
        for (i = 0; i < n; i++) {
            var a = P[i], b = P[(i + 1) % n], c = P[(i + 2) % n];
            var z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
            if (Math.abs(z) < 1e-9) continue;
            if (!sgn) sgn = z > 0 ? 1 : -1; else if ((z > 0 ? 1 : -1) !== sgn) return false;
        }
        return true;
    }
    // 折线 S 和凸折线 C 的交（Sutherland–Hodgman）；交出来没有面积返回 []
    function clipConvex(S, C) {
        var n = C.length, sg = polyArea(C) >= 0 ? 1 : -1, out = S, i, j;
        for (i = 0; i < n && out.length; i++) {
            var a = C[i], b = C[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1];
            if (!ex && !ey) continue;
            var inp = out; out = [];
            for (j = 0; j < inp.length; j++) {
                var p = inp[j], q = inp[(j + 1) % inp.length];
                var dp = sg * (ex * (p[1] - a[1]) - ey * (p[0] - a[0])), dq = sg * (ex * (q[1] - a[1]) - ey * (q[0] - a[0]));
                if (dp >= 0) out.push(p);
                if ((dp >= 0) !== (dq >= 0)) { var s0 = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * s0, p[1] + (q[1] - p[1]) * s0]); }
            }
        }
        return Math.abs(polyArea(out)) < 1e-6 ? [] : out;
    }
    // 折线留在矩形 R 里面的部分
    function clipRectPoly(P, R) {
        P = clipHalf(P, 0, R.l, true); if (P.length) P = clipHalf(P, 0, R.r, false);
        if (P.length) P = clipHalf(P, 1, R.t, true); if (P.length) P = clipHalf(P, 1, R.b, false);
        return P;
    }
    // 一块和矩形 R（内容和这一块的交）求交以后的外框（给了 M 就是变换以后的）：
    // 还是原来遮罩的形状 → 按路径精确算（曲线鼓出去的点也算上）；被别的曲线交过 → 按交出来的折线。完全交不上返回空框
    function pieceClipBox(pk, R, M) {
        if (pk.pure && pk.sh) return clipPathBox(pk.sh, R, M, polyOf(pk));
        if (!pk.poly) return null;
        var pc = clipRectPoly(pk.poly, R);
        return pc.length && Math.abs(polyArea(pc)) >= 1e-6 ? polyBox(pc, M) : emptyBox();
    }
    // 边和坐标轴平行的矩形遮罩（4 个顶点、没有曲线）在图层坐标里的范围；别的形状返回 null
    function axisRect(sh) {
        var v = sh && sh.vertices, i;
        if (!v || v.length !== 4 || !sh.closed) return null;
        var tin = sh.inTangents || [], tout = sh.outTangents || [];
        for (i = 0; i < 4; i++) {
            var a = tin[i] || [0, 0], b = tout[i] || [0, 0], p = v[i], q = v[(i + 1) % 4];
            if (a[0] || a[1] || b[0] || b[1]) return null;
            if (Math.abs(p[0] - q[0]) > 1e-6 && Math.abs(p[1] - q[1]) > 1e-6) return null;
        }
        return shapeBox(sh);
    }
    // 矩形 b 去掉矩形 r 以后剩下的部分（最多 4 块）
    function minusBox(b, r) {
        var x = crossBox(b, r);
        if (!hasArea(x)) return [b];
        var out = [];
        if (x.t > b.t) out.push({ l: b.l, t: b.t, r: b.r, b: x.t });
        if (x.b < b.b) out.push({ l: b.l, t: x.b, r: b.r, b: b.b });
        if (x.l > b.l) out.push({ l: b.l, t: x.t, r: x.l, b: x.b });
        if (x.r < b.r) out.push({ l: x.r, t: x.t, r: b.r, b: x.b });
        return out;
    }
    // 每一块都切掉这几个矩形；切出来的块在合成里的外框用它的四个角收紧
    function cutParts(P, rects, M) {
        var out = [], k, j, c;
        for (k = 0; k < P.length; k++) {
            var parts = [P[k].lb];
            for (c = 0; c < rects.length; c++) { var nx = []; for (j = 0; j < parts.length; j++) nx = nx.concat(minusBox(parts[j], rects[c])); parts = nx; }
            for (j = 0; j < parts.length; j++) {
                if (!hasArea(parts[j])) continue;
                var c3 = M ? crossBox(P[k].cb, mappedBox(parts[j], M)) : null;
                if (!M || boxOk(c3)) out.push({ lb: parts[j], cb: c3, sh: P[k].sh, poly: P[k].poly, pure: P[k].pure });
            }
        }
        return out;
    }
    // 路径压成折线（每段曲线按控制线的长度分 24–256 份，大的遮罩分得更细，折线和曲线差不到 0.05 px；直线段不分）
    function flatPath(sh) {
        var v = sh.vertices, tin = sh.inTangents || [], tout = sh.outTangents || [], N = v.length, out = [], i, k;
        for (i = 0; i < N; i++) {
            var j = (i + 1) % N, o = tout[i] || [0, 0], q2 = tin[j] || [0, 0];
            var x0 = v[i][0], y0 = v[i][1], x3 = v[j][0], y3 = v[j][1], x1 = x0 + o[0], y1 = y0 + o[1], x2 = x3 + q2[0], y2 = y3 + q2[1];
            var lc = Math.sqrt(o[0] * o[0] + o[1] * o[1]) + Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) + Math.sqrt(q2[0] * q2[0] + q2[1] * q2[1]);
            var steps = (!o[0] && !o[1] && !q2[0] && !q2[1]) ? 1 : Math.max(24, Math.min(256, Math.ceil(Math.sqrt(4 * lc))));
            for (k = 0; k < steps; k++) { var s0 = k / steps; out.push([bezAt(x0, x1, x2, x3, s0), bezAt(y0, y1, y2, y3, s0)]); }
        }
        return out;
    }
    // 折线留下 ax 这一维 ≥ lim（keepGreater）或 ≤ lim 的部分（Sutherland–Hodgman）
    function clipHalf(P, ax, lim, keepGreater) {
        var out = [], n = P.length, i;
        for (i = 0; i < n; i++) {
            var a = P[i], b = P[(i + 1) % n];
            var ina = keepGreater ? a[ax] >= lim : a[ax] <= lim, inb = keepGreater ? b[ax] >= lim : b[ax] <= lim;
            if (ina) out.push(a);
            if (ina !== inb) { var s0 = (lim - a[ax]) / (b[ax] - a[ax]); out.push([a[0] + (b[0] - a[0]) * s0, a[1] + (b[1] - a[1]) * s0]); }
        }
        return out;
    }
    // 闭合路径和图层坐标里的矩形 R 相交的部分，经过 M（不给 = 不变换）以后的外框：
    // 折线裁剪，再加上曲线在 R 里面鼓出去最远的点（按变换以后的方向找）。一点都不相交返回空框；路径不闭合返回 null
    function clipPathBox(sh, R, M, poly) {
        if (!sh || !sh.closed || !sh.vertices || !sh.vertices.length) return null;
        var I = M || [1, 0, 0, 1, 0, 0], P = clipRectPoly(poly || flatPath(sh), R), o = emptyBox(), i, k;
        if (!P.length || Math.abs(polyArea(P)) < 1e-6) return o;
        for (i = 0; i < P.length; i++) { var q = applyM(I, P[i][0], P[i][1]); addPt(o, q[0], q[1]); }
        var v = sh.vertices, tin = sh.inTangents || [], tout = sh.outTangents || [], N = v.length, ms = mapShape(sh, I), mv = ms.vertices;
        for (i = 0; i < N; i++) {
            var j = (i + 1) % N, a = tout[i] || [0, 0], b = tin[j] || [0, 0], ma = ms.outTangents[i], mb = ms.inTangents[j];
            var rs = bezRoots(mv[i][0], mv[i][0] + ma[0], mv[j][0] + mb[0], mv[j][0]).concat(bezRoots(mv[i][1], mv[i][1] + ma[1], mv[j][1] + mb[1], mv[j][1]));
            for (k = 0; k < rs.length; k++) {
                var px = bezAt(v[i][0], v[i][0] + a[0], v[j][0] + b[0], v[j][0], rs[k]), py = bezAt(v[i][1], v[i][1] + a[1], v[j][1] + b[1], v[j][1], rs[k]);
                if (px >= R.l && px <= R.r && py >= R.t && py <= R.b) { var w = applyM(I, px, py); addPt(o, w[0], w[1]); }
            }
        }
        return o;
    }

    // 内容的外框（图层坐标）：形状图层算上描边，文字按字形
    function contentBox(layer, t) {
        var r = layer.sourceRectAtTime(t, layer instanceof ShapeLayer);
        return { l: r.left, t: r.top, r: r.left + r.width, b: r.top + r.height };
    }

    // 看得见的部分（图层坐标）。via：content 内容 / mask 遮罩露出的部分 / selMask 选中的遮罩
    function visibleBox(layer, t) {
        var c = contentBox(layer, t), m = maskInfo(layer, t, null, c);
        if (!m || m.empty) return { box: c, via: "content" };
        if (m.sel) return { box: m.box, via: "selMask" };
        // 每一块各自和内容求交（伸到图层外面的块不撑大范围）；曲线遮罩被图层边裁掉时按裁剪后的形状算
        var x = emptyBox(), any = false, k;
        for (k = 0; k < m.parts.length; k++) {
            var pk = m.parts[k], xk = crossBox(c, pk.lb);
            if (!(boxOk(xk) && boxSize(xk) > 0)) continue;
            if (!inside(pk.lb, c)) {   // 伸出内容边界才需要按形状裁（整块在里面时外框已经是准的）
                var q = pieceClipBox(pk, xk, null);
                if (q && !boxOk(q)) continue;   // 这一块的形状和内容交不上
                if (q) xk = crossBox(xk, q);
            }
            x = unionBox(x, xk); any = true;
        }
        return { box: any ? x : m.box, via: "mask" };
    }

    // 为什么不能按 2D 算：cam 摄像机 / 灯光，orient 开了自动定向，rot 3D 图层转过 X / Y，tilt「方向」带 X / Y 角度；能算返回 ""
    // （3D 图层只转了 Z、方向只有 Z、没开自动定向时，x、y 不受 z 影响，可以按 2D 算：方向的 Z 和 Z 旋转加在一起）
    function notFlatWhy(L, t) {
        if (L instanceof CameraLayer || L instanceof LightLayer) return "cam";
        try { if (L.autoOrient !== AutoOrientType.NO_AUTO_ORIENT) return "orient"; } catch (e) {}
        if (!L.threeDLayer) return "";
        var tr = L.transform, o = tr.property("ADBE Orientation").valueAtTime(t, false);
        if (tr.property("ADBE Rotate X").valueAtTime(t, false) || tr.property("ADBE Rotate Y").valueAtTime(t, false)) return "rot";
        return o[0] || o[1] ? "tilt" : "";
    }
    // 绕 Z 的总角度（度）：Z 旋转，3D 图层再加上「方向」的 Z
    function zAngle(L, t) {
        var tr = L.transform, r = tr.property("ADBE Rotate Z").valueAtTime(t, false);
        if (L.threeDLayer) { try { r += tr.property("ADBE Orientation").valueAtTime(t, false)[2] || 0; } catch (e) {} }
        return r;
    }
    function flat(L, t) { return !notFlatWhy(L, t); }
    // 整条父级链里第一个不能按 2D 算的原因，带上是图层自己还是父级："self:rot"、"parent:cam" …；都能算返回 ""
    function chainWhy(L, t) {
        var c = L, g = 0;
        while (c && g++ < 64) { var w = notFlatWhy(c, t); if (w) return (c === L ? "self:" : "parent:") + w; c = c.parent; }
        return "";
    }
    var WHY_TEXT = {
        "self:rot": "带 X / Y 旋转", "self:tilt": "的方向带 X / Y 角度", "self:orient": "开了自动定向", "self:cam": "是摄像机或灯光",
        "parent:rot": "的父级带 X / Y 旋转", "parent:tilt": "的父级方向带 X / Y 角度", "parent:orient": "的父级开了自动定向", "parent:cam": "的父级是摄像机或灯光"
    };
    // 跳过的原因汇总成提示里的几句：「2 个图层的父级是摄像机或灯光，没动」
    function whyNotes(why, tail) {
        var out = [];
        for (var k in why) if (why.hasOwnProperty(k) && why[k]) out.push([why[k], "图层" + (WHY_TEXT[k] || "在合成里的位置算不出来") + "，" + tail]);
        return out;
    }
    function countWhy(why, L, t) { var k = chainWhy(L, t) || "?"; why[k] = (why[k] || 0) + 1; }
    function firstWhy(why) { for (var k in why) if (why.hasOwnProperty(k)) return WHY_TEXT[k] || "的位置算不出来"; return "的位置算不出来"; }
    function whyKinds(why) { var n = 0; for (var k in why) if (why.hasOwnProperty(k) && why[k]) n++; return n; }
    // 几种原因列成一句：「1 个图层带 X / Y 旋转，1 个图层的父级是摄像机或灯光」
    function whyList(why) {
        var out = [];
        for (var k in why) if (why.hasOwnProperty(k) && why[k]) out.push(why[k] + " 个图层" + (WHY_TEXT[k] || "在合成里的位置算不出来"));
        return out.join("，");
    }
    // 外框算不准时的失败说明：一种原因说「选中的图层……」，几种原因逐条列出来
    function whyFail(why, what) {
        return whyKinds(why) > 1 ? what + "：" + whyList(why) + "，在合成里的外框算不准" : "选中的图层" + firstWhy(why) + "，在合成里的外框算不准，" + what;
    }

    // 图层自己的 2D 变换（图层坐标 → 父级坐标）：[a, b, c, d, e, f]，x' = a·x + c·y + e，y' = b·x + d·y + f
    function localMatrix(L, t) {
        var tr = L.transform;
        var A = tr.anchorPoint.valueAtTime(t, false), P = layerPosition(L, t), s = tr.scale.valueAtTime(t, false);
        var rot = zAngle(L, t) * Math.PI / 180;
        var cs = Math.cos(rot), sn = Math.sin(rot), sx = s[0] / 100, sy = s[1] / 100;
        var a = cs * sx, b = sn * sx, c = -sn * sy, d = cs * sy;
        return [a, b, c, d, P[0] - (a * A[0] + c * A[1]), P[1] - (b * A[0] + d * A[1])];
    }
    function mulM(m, n) {   // 先 n 后 m
        return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
                m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
                m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    }
    function applyM(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

    // 图层坐标 → 合成坐标；父级链上有 3D 旋转、摄像机、灯光时算不准，返回 null
    function compMatrix(L, t) {
        var m = null, cur = L, guard = 0;
        while (cur && guard++ < 64) {
            if (!flat(cur, t)) return null;
            var lm = localMatrix(cur, t);
            m = m ? mulM(lm, m) : lm;
            cur = cur.parent;
        }
        return m;
    }

    // 看得见的部分在合成里的外框；算不准时返回 null。
    // 遮罩路径先变换到合成坐标再算外框（不是把图层坐标里的外框四个角变换过去——那样旋转后的圆会大一圈）
    // mm：可选，直接给图层坐标 → 目标坐标的 2D 变换（比如空对象 ⌥ 用的「图层平面 → 世界」）
    function compBox(L, t, mm) {
        var m = mm || compMatrix(L, t);
        if (!m) return null;
        var c = contentBox(L, t), cb = mappedBox(c, m);
        var mi = maskInfo(L, t, m, c), out = cb, via = "content";
        if (mi && !mi.empty) {
            if (mi.sel) { out = mi.box; via = "selMask"; }
            else {
                // 每一块各自和内容求交（交不交在图层坐标里判断）；合成里取：内容的外框、这一块的外框、交集四个角变换过去的外框，
                // 曲线遮罩被图层边裁掉时再按裁剪后的形状收紧
                var o2 = emptyBox(), any = false, k;
                for (k = 0; k < mi.parts.length; k++) {
                    var pk = mi.parts[k], xl = crossBox(c, pk.lb);
                    if (!(boxOk(xl) && boxSize(xl) > 0)) continue;
                    var q = crossBox(crossBox(cb, pk.cb), mappedBox(xl, m));
                    var qc = inside(pk.lb, c) ? null : pieceClipBox(pk, xl, m);
                    if (qc && !boxOk(qc)) continue;
                    if (qc) q = crossBox(q, qc);
                    if (boxOk(q)) { o2 = unionBox(o2, q); any = true; }
                }
                out = any ? o2 : mi.box;
                via = "mask";
            }
        }
        return { l: out.l, t: out.t, r: out.r, b: out.b, via: via };
    }

    // 合成坐标里的一段位移 → 这个图层的父级坐标里的位移（没有父级就是它本身）；父级缩放成 0、带 3D 旋转时返回 null
    function compToParentVec(L, dx, dy, t) {
        if (!L.parent) return [dx, dy];
        var pm = compMatrix(L.parent, t);
        if (!pm) return null;
        var det = pm[0] * pm[3] - pm[2] * pm[1];
        if (Math.abs(det) < 1e-9) return null;
        return [(pm[3] * dx - pm[2] * dy) / det, (-pm[1] * dx + pm[0] * dy) / det];
    }

    // 一批图层各自要在合成里平移多少：父级也在这批里时先移父级，子图层只补差（不会被移两次）。
    // 每项 { L, dx, dy, b 可选：移之前的外框（旋转、缩放带表达式时用来检查） }；移好了的项标上 applied。
    // 返回 { failed 没能移动的个数, expr 位置由表达式控制、移了画面不动（已还原）的个数 }
    function moveAll(list, t) {
        var byIdx = {}, i, failed = 0, expr = 0;
        var depth = function (L) { var d = 0, p = L.parent; while (p && d < 64) { d++; p = p.parent; } return d; };
        for (i = 0; i < list.length; i++) { list[i].d = depth(list[i].L); byIdx[list[i].L.index] = list[i]; }
        list.sort(function (x, y) { return x.d - y.d; });
        for (i = 0; i < list.length; i++) {
            var it = list[i], dx = it.dx, dy = it.dy, p = it.L.parent, g = 0;
            // 最近的、已经移过的上级：它（连同它的上级）已经把这个图层带着走了 it.dx / it.dy
            while (p && g++ < 64) {
                var up = byIdx[p.index];
                if (up && up.applied) { dx -= up.dx; dy -= up.dy; break; }
                p = p.parent;
            }
            if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) { it.applied = true; continue; }
            if (zeroScaleChain(it.L, t)) { failed++; continue; }
            var v = compToParentVec(it.L, dx, dy, t);
            if (!v) { failed++; continue; }
            var guard = posHasExpr(it.L), boxG = !!it.b && xformHasExpr(it.L), before = guard ? anchorInComp(it.L, t) : null;
            moveLayerBy(it.L, v[0], v[1]);
            if (guard || boxG) {
                // 表达式不跟着数值走（比如钉死的位置、关联到别的图层），或者旋转、缩放跟着位置变：画面没按算的走，还原
                var after = guard ? anchorInComp(it.L, t) : null, nb = boxG ? compBox(it.L, t) : null;
                var off = guard && (!before || !after || Math.abs(after[0] - before[0] - dx) > 0.5 || Math.abs(after[1] - before[1] - dy) > 0.5);
                if (boxG && (!nb || Math.abs(nb.l - it.b.l - it.dx) > 0.5 || Math.abs(nb.t - it.b.t - it.dy) > 0.5 || Math.abs(nb.r - it.b.r - it.dx) > 0.5 || Math.abs(nb.b - it.b.b - it.dy) > 0.5)) off = true;
                if (off) {
                    moveLayerBy(it.L, -v[0], -v[1]);
                    expr++;
                    continue;
                }
            }
            it.applied = true;
        }
        return { failed: failed, expr: expr };
    }

    // 让 AE 自己算一个表达式（结果 3 个数）：临时加一个 3D 点控制、用表达式求值，读完就删掉（都在同一个撤销组里）。
    // 加过效果以后，这个图层之前取到的属性对象会失效：调用的地方都重新从 L.transform 取。算不出来返回 null
    function probe(L, expr, t) {
        var fx, p = null, out = null;
        try {
            fx = L.property("ADBE Effect Parade");
            p = fx.addProperty("ADBE Point3D Control");
            var prop = p.property(1);
            prop.expression = expr;
            out = prop.valueAtTime(t, false);
            if (prop.expressionError) out = null;
        } catch (e) { out = null; }
        try { if (p) p.remove(); } catch (e2) {}
        if (!out || !(out.length >= 3) || !isFinite(out[0]) || !isFinite(out[1]) || !isFinite(out[2])) return null;
        return [out[0], out[1], out[2]];
    }
    // 图层坐标里的一段位移，在父级坐标里是多少（含图层自己的缩放、XYZ 旋转、方向、自动定向）
    function probeVec(L, v, t) {
        return probe(L, "var v = thisLayer.toWorldVec([" + v[0] + ", " + v[1] + ", " + (v[2] || 0) + "], " + t + ");\n" +
            "thisLayer.hasParent ? thisLayer.parent.fromWorldVec(v, " + t + ") : v;", t);
    }
    // 合成（世界）里的一段位移，在父级坐标里是多少（父级带 3D 旋转、是摄像机时也行）
    function probeParentVec(L, dx, dy, t) {
        return probe(L, "thisLayer.hasParent ? thisLayer.parent.fromWorldVec([" + dx + ", " + dy + ", 0], " + t + ") : [" + dx + ", " + dy + ", 0];", t);
    }
    // 图层上的一点画在合成画面里的哪里（含摄像机 / 默认摄像机的透视）
    function probeToComp(L, x, y, t) {
        var r = probe(L, "var c = thisLayer.toComp([" + x + ", " + y + ", 0], " + t + ");\n[c[0], c[1], 0];", t);
        return r ? [r[0], r[1]] : null;
    }
    // 父级坐标里的一段位移在世界里是多少（父级带 3D 旋转时 2D 子图层用）
    function probeParentToWorld(L, v, t) {
        var s3 = "[" + v[0] + ", " + v[1] + ", " + (v[2] || 0) + "]";
        return probe(L, "thisLayer.hasParent ? thisLayer.parent.toWorldVec(" + s3 + ", " + t + ") : " + s3 + ";", t);
    }
    // 图层上的一点 / 一段位移在世界坐标里（不经过摄像机）
    function probeToWorld(L, x, y, t, z) { return probe(L, "thisLayer.toWorld([" + x + ", " + y + ", " + (z || 0) + "], " + t + ");", t); }
    function probeToWorldVec(L, x, y, t) { return probe(L, "thisLayer.toWorldVec([" + x + ", " + y + ", 0], " + t + ");", t); }
    // 合成正在用的摄像机图层（没有摄像机图层时是 AE 的默认摄像机：返回 null）
    function activeCam(comp) { try { return comp.activeCamera || null; } catch (e) { return null; } }

    // 图层坐标里的位移 → 父级坐标（锚点挪了多少，位置就要补多少）
    // 3D 转过、自动定向的图层要让 AE 算；AE 也算不出来（比如父级缩放是 0）返回 null——这时按 2D 算会让画面跳
    function toParentVec(L, dx, dy, t) {
        if (!flat(L, t)) return probeVec(L, [dx, dy, 0], t);
        var s = L.transform.scale.valueAtTime(t, false);
        var rot = zAngle(L, t) * Math.PI / 180;
        var sx = dx * s[0] / 100, sy = dy * s[1] / 100;
        return [sx * Math.cos(rot) - sy * Math.sin(rot), sx * Math.sin(rot) + sy * Math.cos(rot), 0];
    }

    // 图层的锚点在合成里的位置：锚点总是落在「位置」上，所以只要父级链能按 2D 算就行（图层自己转过 X / Y 也可以）。
    // 父级链上有 3D 旋转时返回 null
    function anchorInComp(L, t) {
        var pos = layerPosition(L, t);
        if (!L.parent) return [pos[0], pos[1]];
        var pm = compMatrix(L.parent, t);
        return pm ? applyM(pm, pos[0], pos[1]) : null;
    }

    // 图层坐标里的一点画在合成里的哪里：2D 图层、整条链能按 2D 算就直接算；3D 图层用 AE 的 toComp（透视、摄像机都算上）
    function drawnPoint(L, x, y, t) {
        if (!L.threeDLayer) { var m = compMatrix(L, t); if (m) return applyM(m, x, y); }
        return probeToComp(L, x, y, t);
    }
    function hasExpr(p) { try { return !!p && p.canSetExpression && p.expressionEnabled && p.expression !== ""; } catch (e) { return false; } }
    // 旋转、缩放、方向带表达式（比如滚轮跟着位置转）：改位置时画面可能不按算的走，改完要量一下
    function xformHasExpr(L) {
        var tr = L.transform, names = ["ADBE Rotate Z", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Orientation", "ADBE Scale"], i;
        for (i = 0; i < names.length; i++) { try { if (hasExpr(tr.property(names[i]))) return true; } catch (e) {} }
        return false;
    }
    // 父级链上有缩放是 0（或不到 0.01%）的图层（比如弹出动画的第一帧）：AE 没法从世界坐标换回来；
    // 几乎是 0 时虽然算得出来，但要在画面上动一点，父级坐标里就得移几百万像素，等父级长大图层就飞走了——一律当成 0
    function zeroScaleChain(L, t) {
        var p = L.parent, g = 0;
        while (p && g++ < 64) {
            try {
                var s3 = p.transform.scale.valueAtTime(t, false);
                if (Math.abs(s3[0]) < 0.01 || Math.abs(s3[1]) < 0.01 || (p.threeDLayer && s3.length > 2 && Math.abs(s3[2]) < 0.01)) return true;
            } catch (e) {}
            p = p.parent;
        }
        return false;
    }
    // 「位置」的原始数值（表达式之前；有关键帧时是每个关键帧的值）：量着贴没贴上时原样写回去，不靠加减（数很大时加减会丢精度）
    function posProps(L) {
        var tr = L.transform;
        if (!tr.position.dimensionsSeparated) return [tr.position];
        var out = [tr.property("ADBE Position_0"), tr.property("ADBE Position_1")];
        if (L.threeDLayer) out.push(tr.property("ADBE Position_2"));
        return out;
    }
    function savePos(L) {
        var props = posProps(L), out = [], i, k;
        for (i = 0; i < props.length; i++) {
            var p = props[i], keys = [];
            for (k = 1; k <= p.numKeys; k++) keys.push(p.keyValue(k));
            out.push({ v: p.numKeys ? null : p.valueAtTime(0, true), keys: keys });
        }
        return out;
    }
    function restorePos(L, saved) {
        var props = posProps(L), i, k;
        for (i = 0; i < saved.length && i < props.length; i++) {
            var p = props[i], sv = saved[i];
            if (sv.v !== null) p.setValue(sv.v);
            else for (k = 1; k <= sv.keys.length && k <= p.numKeys; k++) p.setValueAtKey(k, sv.keys[k - 1]);
        }
    }
    function posHasExpr(L) {
        var tr = L.transform;
        if (tr.position.dimensionsSeparated) return hasExpr(tr.property("ADBE Position_0")) || hasExpr(tr.property("ADBE Position_1")) || (L.threeDLayer && hasExpr(tr.property("ADBE Position_2")));
        return hasExpr(tr.position);
    }

    // L 的子孙图层（最多 n 个，摄像机、灯光不算）：L 带表达式时，改锚点也要看它们的画面不动——
    // 位置取整这类表达式会让 L 差一点点，离摄像机很近的 3D 子图层会把这点误差放大很多倍
    function kidsOf(comp, L, n) {
        var out = [], byParent = {}, q = [L.index], i, g = 0;
        if (!comp) return out;
        // 合成里的图层只扫一遍，记下谁是谁的子图层，再从 L 往下找
        for (i = 1; i <= comp.numLayers; i++) {
            var c = comp.layer(i), pr = c.parent;
            if (pr) (byParent[pr.index] = byParent[pr.index] || []).push(c);
        }
        while (q.length && out.length < n && g++ < 256) {
            var list = byParent[q.shift()] || [];
            for (i = 0; i < list.length && out.length < n; i++) { q.push(list[i].index); if (isTransformable(list[i])) out.push(list[i]); }
        }
        return out;
    }
    function kidPts(kids, t) {
        var out = [], i;
        for (i = 0; i < kids.length; i++) { var a = kids[i].transform.anchorPoint.valueAtTime(t, false); out.push(drawnPoint(kids[i], a[0], a[1], t) || [NaN, NaN]); }
        return out;
    }
    // 几个点画在画面上的位置前后一样（差不到 0.5 px）
    function samePts(a, b) {
        for (var i = 0; i < a.length; i++) if (!a[i] || !b[i] || Math.abs(a[i][0] - b[i][0]) > 0.5 || Math.abs(a[i][1] - b[i][1]) > 0.5) return false;
        return true;
    }
    // 把锚点放到图层坐标 (x, y)，画面不动。返回 "" 改好了 / "same" 本来就在那里 /
    // "expr" 锚点、位置、旋转或缩放由表达式控制（比如文字自动居中的表达式），改了画面会跳——已经还原，没改 /
    // "nocalc" AE 算不出位置要补多少（比如父级缩放是 0）——没改
    function anchorTo(L, x, y, t, comp) {
        var a = L.transform.anchorPoint.valueAtTime(t, false);
        var dx = x - a[0], dy = y - a[1];
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return "same";
        // 有表达式时先记下这一点画在哪里，改完再量一次：表达式不跟着数值走（画面动了）就还原
        var guard = hasExpr(L.transform.anchorPoint) || posHasExpr(L) || xformHasExpr(L);
        // 量两个点：新锚点本身，和离它 100 px 的一点（旋转、缩放跟着位置变时只有它会动）；再加上子孙图层的锚点
        var kids = guard ? kidsOf(comp, L, 12) : [];
        var before = guard ? [drawnPoint(L, x, y, t), drawnPoint(L, x + 100, y + 100, t)].concat(kidPts(kids, t)) : null;
        var d = toParentVec(L, dx, dy, t);          // 可能临时加过效果：下面的属性重新取
        if (!d) return "nocalc";
        offsetProp(L.transform.anchorPoint, [dx, dy]);
        moveLayerBy(L, d[0], d[1], d[2]);
        if (guard) {
            // 画面跳了（锚点不跟着数值走、位置跟着走），或者锚点根本没到 (x, y)（锚点和位置的表达式都不看数值）：都还原
            var after = [drawnPoint(L, x, y, t), drawnPoint(L, x + 100, y + 100, t)].concat(kidPts(kids, t)), na = L.transform.anchorPoint.valueAtTime(t, false);
            if (!samePts(before, after) || Math.abs(na[0] - x) > 1e-3 || Math.abs(na[1] - y) > 1e-3) {
                offsetProp(L.transform.anchorPoint, [-dx, -dy]);
                moveLayerBy(L, -d[0], -d[1], -(d[2] || 0));
                return "expr";
            }
        }
        return "";
    }

    // 2D 图层挂在带 3D 旋转的父级下：AE 把父级的 3D 变换压平画到画面上（不透视）。量出父级的 x、y 轴在世界里的方向：
    // e1、e2 是压平以后的两个方向，r1、r2 是压平以后还剩多长（侧着转到接近 90° 时接近 0）
    function flatAxes(L, t) {
        var a = probeParentToWorld(L, [1, 0, 0], t), b = probeParentToWorld(L, [0, 1, 0], t);
        if (!a || !b) return null;
        var la = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]), lb = Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
        if (la < 1e-12 || lb < 1e-12) return null;
        return { e1: [a[0], a[1]], e2: [b[0], b[1]], r1: Math.sqrt(a[0] * a[0] + a[1] * a[1]) / la, r2: Math.sqrt(b[0] * b[0] + b[1] * b[1]) / lb };
    }
    // 父级坐标里移多少，画面上才移 (dx, dy)。父级侧着（某个方向压得只剩不到 1%）时只能沿另一个方向移：
    // 要移的方向正好是它就照算，不是返回 null
    function flatSolve(F, dx, dy) {
        var e1 = F.e1, e2 = F.e2, ok1 = F.r1 >= 0.01, ok2 = F.r2 >= 0.01;
        var n1 = Math.sqrt(e1[0] * e1[0] + e1[1] * e1[1]), n2 = Math.sqrt(e2[0] * e2[0] + e2[1] * e2[1]), det = e1[0] * e2[1] - e2[0] * e1[1];
        if (ok1 && ok2 && Math.abs(det) >= 0.01 * n1 * n2) return [(e2[1] * dx - e2[0] * dy) / det, (-e1[1] * dx + e1[0] * dy) / det, 0];
        var use1 = ok1 && (!ok2 || n1 >= n2), c = use1 ? e1 : e2, nc = use1 ? n1 : n2, nd = Math.sqrt(dx * dx + dy * dy);
        if (!(use1 || ok2) || nc < 1e-12) return null;
        if (Math.abs(c[0] * dy - c[1] * dx) > 0.01 * nc * nd) return null;
        var k = (c[0] * dx + c[1] * dy) / (nc * nc);
        return use1 ? [k, 0, 0] : [0, k, 0];
    }
    // 3D 图层沿画面的方向移 (x, y)，在父级坐标里是多少：有摄像机图层时沿摄像机的 x、y（按单位长度：摄像机挂在缩放过的
    // 父级下也不影响距离；离摄像机的远近不变，画面上就是水平 / 竖直地走；挂在摄像机下面的 HUD 也一样），没有就沿世界的 x、y
    function screenAxisVec(L, cam, x, y, t) {
        if (cam && cam !== L) {
            return probe(L, "var c = thisComp.layer(" + cam.index + "), dx = " + x + ", dy = " + y + ", t = " + t + ";\n" +
                "var w = add(mul(normalize(c.toWorldVec([1, 0, 0], t)), dx), mul(normalize(c.toWorldVec([0, 1, 0], t)), dy));\n" +
                "thisLayer.hasParent ? thisLayer.parent.fromWorldVec(w, t) : w;", t);
        }
        if (!L.parent) return [x, y, 0];
        var v = compToParentVec(L, x, y, t);
        if (v) return [v[0], v[1], 0];
        return probeParentVec(L, x, y, t);
    }
    // 量着贴用的两步（父级坐标）：各让图层大约在画面上移 (1, 0) / (0, 1)。父级侧着返回 "edge"，算不出来返回 null
    function moveBasis(L, cam, t) {
        if (L.threeDLayer) {
            var b1 = screenAxisVec(L, cam, 1, 0, t), b2 = screenAxisVec(L, cam, 0, 1, t);
            return b1 && b2 ? [b1, b2] : null;
        }
        if (!L.parent) return [[1, 0, 0], [0, 1, 0]];
        var v = compToParentVec(L, 1, 0, t), w = compToParentVec(L, 0, 1, t);
        if (v && w) return [[v[0], v[1], 0], [w[0], w[1], 0]];
        var F = flatAxes(L, t);
        if (!F) return null;
        var u1 = flatSolve(F, 1, 0), u2 = flatSolve(F, 0, 1);
        return u1 && u2 ? [u1, u2] : "edge";
    }
    // 锚点离摄像机多远（沿镜头方向）：小于 1 就在摄像机后面，画面上看不见。默认摄像机在 z = -zoom
    function camDepth(L, ctx, a, t) {
        var s3 = "[" + a[0] + ", " + a[1] + ", " + (a[2] || 0) + "]";
        if (ctx.cam) {
            var r = probe(L, "var c = thisComp.layer(" + ctx.cam.index + ");\nc.fromWorld(thisLayer.toWorld(" + s3 + ", " + t + "), " + t + ");", t);
            return r ? r[2] : null;
        }
        var w = probe(L, "thisLayer.toWorld(" + s3 + ", " + t + ");", t);
        return w ? w[2] + ctx.zoom : null;
    }
    // L 带着摄像机走（摄像机挂在 L 或 L 的子图层下面）：移 L 摄像机也跟着移，画面上看不出来
    function carriesCam(L, cam) {
        var p = cam ? cam.parent : null, g = 0;
        while (p && g++ < 64) { if (p.index === L.index) return true; p = p.parent; }
        return false;
    }

    // 把图层的锚点（画在合成里的位置）量着移到 (tx, ty)：每移一步量一次画在哪里，用量出来的结果修正
    // 「移多少 → 画面上动多少」的 2×2 关系（Broyden），直到差不到 0.25 px。2D 子图层在 3D 父级下一步就准；
    // 3D 有透视（默认摄像机或摄像机图层）时两三步。最后没贴上（比如位置的表达式不看数值）就退回原位，不留半路的位置。
    // 返回 "" 贴好了 / "expr" 锚点或位置由表达式控制，没动 / "edge" 父级转到了侧面，没动 / "fail" 没贴上，没动
    function snapAnchor(L, tx, ty, t, cam, guard) {
        var B = moveBasis(L, cam, t);
        if (B === "edge") return "edge";
        if (!B) return zeroScaleChain(L, t) ? "zero" : "fail";
        var a = L.transform.anchorPoint.valueAtTime(t, false), cur = drawnPoint(L, a[0], a[1], t);
        if (!cur) return "fail";
        var J = [1, 0, 0, 1], saved = savePos(L), moved = false, k;
        for (k = 0; k < 8; k++) {
            var ex = tx - cur[0], ey = ty - cur[1];
            if (Math.abs(ex) < 0.25 && Math.abs(ey) < 0.25) return "";
            var det = J[0] * J[3] - J[1] * J[2];
            if (Math.abs(det) < 1e-6) break;
            var wx = (J[3] * ex - J[1] * ey) / det, wy = (-J[2] * ex + J[0] * ey) / det;
            var mv = [B[0][0] * wx + B[1][0] * wy, B[0][1] * wx + B[1][1] * wy, (B[0][2] || 0) * wx + (B[1][2] || 0) * wy];
            moveLayerBy(L, mv[0], mv[1], mv[2]);
            moved = true;
            a = L.transform.anchorPoint.valueAtTime(t, false);
            var nxt = drawnPoint(L, a[0], a[1], t);
            if (!nxt) { cur = null; break; }
            var ww = wx * wx + wy * wy, rx = nxt[0] - cur[0] - (J[0] * wx + J[1] * wy), ry = nxt[1] - cur[1] - (J[2] * wx + J[3] * wy);
            if (ww > 1e-12) J = [J[0] + rx * wx / ww, J[1] + rx * wy / ww, J[2] + ry * wx / ww, J[3] + ry * wy / ww];
            cur = nxt;
        }
        if (cur && Math.abs(tx - cur[0]) < 0.5 && Math.abs(ty - cur[1]) < 0.5) return "";
        if (moved) restorePos(L, saved);   // 没贴上：原样退回，不留半路的位置
        return guard ? "expr" : "fail";
    }
    function depthOf(L) { var d = 0, p = L.parent; while (p && d < 64) { d++; p = p.parent; } return d; }
    // 把一个图层的锚点放到合成的 (tx, ty)：2D 图层、父级链能按 2D 算就直接算；3D、父级带 3D 旋转时量着贴。
    // ctx = { cam 摄像机图层或 null, zoom 默认摄像机的距离 }。返回 "" / "expr" / "edge" / "fail" /
    // "carrier" 摄像机挂在它下面 / "behind" 在摄像机后面
    function placeAnchor(L, tx, ty, t, ctx) {
        var cam = ctx.cam, guard = posHasExpr(L) || hasExpr(L.transform.anchorPoint) || xformHasExpr(L);
        if (zeroScaleChain(L, t)) return "zero";
        if (carriesCam(L, cam)) return "carrier";
        if (L.threeDLayer) {
            var a3 = L.transform.anchorPoint.valueAtTime(t, false), dep = camDepth(L, ctx, a3, t);
            if (dep !== null && dep < 1) return "behind";   // 贴的时候离摄像机的远近不变：在后面就一直看不见
        }
        if (!L.threeDLayer) {
            var p = anchorInComp(L, t);
            if (p) {
                var dx = tx - p[0], dy = ty - p[1];
                if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return "";
                var v = compToParentVec(L, dx, dy, t);
                if (!v) return zeroScaleChain(L, t) ? "zero" : "fail";
                moveLayerBy(L, v[0], v[1]);
                if (guard) {
                    var q = anchorInComp(L, t);
                    if (!q || Math.abs(q[0] - tx) > 0.5 || Math.abs(q[1] - ty) > 0.5) { moveLayerBy(L, -v[0], -v[1]); return "expr"; }
                }
                return "";
            }
        }
        return snapAnchor(L, tx, ty, t, cam, guard);
    }
    // 一批图层都把锚点放到 (tx, ty)：按层级从上往下，一个放好了再量下一个——父子一起选中时
    // （包括 3D 父级 + 2D 子级）子图层在父级放好以后才量，不会被父级再带走。
    // list 的每项 { L, ... }，放完标上 st（placeAnchor 的结果）。返回各种结果的个数
    function placeAll(list, tx, ty, t, ctx) {
        var out = { ok: 0, stuck: 0, expr: 0, edge: 0, carrier: 0, behind: 0, zero: 0 }, i;
        list.sort(function (x, y) { return depthOf(x.L) - depthOf(y.L); });
        for (i = 0; i < list.length; i++) {
            var r = placeAnchor(list[i].L, tx, ty, t, ctx);
            list[i].st = r;
            if (r === "") out.ok++;
            else if (out[r] !== undefined) out[r]++;
            else out.stuck++;
        }
        return out;
    }
    function camCtx(comp) { return { cam: activeCam(comp), zoom: comp.width * 50 / 36 }; }
    // 没放好的原因汇总成提示里的几句
    function placeNotes(pr, what) {
        return [[pr.expr, "图层的位置由表达式控制，没" + what], [pr.edge, "图层的父级转到了侧面（X / Y 接近 90°），画面上移不动，没" + what],
            [pr.behind, "图层在摄像机后面，画面上看不见，没" + what], [pr.carrier, "图层带着摄像机（摄像机挂在它下面），画面上移不动，没" + what],
            [pr.zero, "图层的父级缩放是 0，画面上移不动，没" + what + "（把播放头移到父级显示出来的地方再试）"],
            [pr.stuck, "图层没" + what + "（AE 算不出它在画面上的位置），留在原地"]];
    }
    // 图层（的锚点）画在合成里的哪里：外框算不出来时用（3D 转过、父级是摄像机；摄像机、灯光用它的位置）
    function whereInComp(L, t) {
        if (!isTransformable(L)) return anchorInComp(L, t);
        var a = L.transform.anchorPoint.valueAtTime(t, false);
        return drawnPoint(L, a[0], a[1], t) || anchorInComp(L, t);
    }
    // 图层坐标里的矩形画在合成里的外框（四个角各量一次；父级带 3D 旋转的 2D 图层用）
    function drawnBox(L, b, t) {
        var o = emptyBox(), k = [[b.l, b.t], [b.r, b.t], [b.l, b.b], [b.r, b.b]], i;
        for (i = 0; i < 4; i++) { var q = drawnPoint(L, k[i][0], k[i][1], t); if (!q) return null; addPt(o, q[0], q[1]); }
        return o;
    }
    // 看得见的部分在世界坐标里的范围（空对象 ⌥ 用；z 是 3D 图层内容所在的深度）：
    // 2D 图层就是合成坐标；3D 图层按世界坐标，不是画在画面上的位置——空对象也是 3D 的，再经过摄像机会被透视两次
    function worldBoxOf(L, t) {
        if (!isTransformable(L)) { var p0 = anchorInComp(L, t); return p0 ? { l: p0[0], t: p0[1], r: p0[0], b: p0[1] } : null; }
        var b = visibleBox(L, t).box;
        if (!boxOk(b)) return null;
        var cb = compBox(L, t);
        if (!L.threeDLayer) {
            if (cb && boxOk(cb)) return cb;
            // 父级带 3D 旋转的 2D 图层：画出来是图层平面的一个仿射变换，量 3 个点得到它，遮罩按路径精确算
            var d0 = drawnPoint(L, 0, 0, t), d1 = drawnPoint(L, 1, 0, t), d2 = drawnPoint(L, 0, 1, t);
            var md = d0 && d1 && d2 ? compBox(L, t, [d1[0] - d0[0], d1[1] - d0[1], d2[0] - d0[0], d2[1] - d0[1], d0[0], d0[1]]) : null;
            return md && boxOk(md) ? md : drawnBox(L, b, t);
        }
        var o, z;
        if (cb && boxOk(cb)) {
            // 父级链能按 2D 算：x、y 就是合成坐标；深度：没有父级直接算，有父级让 AE 算中心点在世界里的 z
            o = { l: cb.l, t: cb.t, r: cb.r, b: cb.b };
            if (!L.parent) {
                var tr = L.transform, P = layerPosition(L, t), A = tr.anchorPoint.valueAtTime(t, false), S = tr.scale.valueAtTime(t, false);
                z = (P[2] || 0) - (A[2] || 0) * (S.length > 2 ? S[2] : 100) / 100;
            } else { var wc = probeToWorld(L, (b.l + b.r) / 2, (b.t + b.b) / 2, t); z = wc ? wc[2] : 0; }
        } else {
            // 转过 X / Y、父级带 3D 旋转：让 AE 算原点和 x、y 两个方向在世界里的位置，四个角算出来
            var w0 = probeToWorld(L, 0, 0, t), e1 = probeToWorldVec(L, 1, 0, t), e2 = probeToWorldVec(L, 0, 1, t);
            if (!w0 || !e1 || !e2) return null;
            // 图层平面 → 世界的 x、y 是仿射的：遮罩按路径精确算（曲线不按四个角算大一圈）；深度取看得见部分中心的 z
            var wb = compBox(L, t, [e1[0], e1[1], e2[0], e2[1], w0[0], w0[1]]);
            if (wb && boxOk(wb)) o = { l: wb.l, t: wb.t, r: wb.r, b: wb.b };
            else {
                var k = [[b.l, b.t], [b.r, b.t], [b.l, b.b], [b.r, b.b]], i;
                o = emptyBox();
                for (i = 0; i < 4; i++) addPt(o, w0[0] + k[i][0] * e1[0] + k[i][1] * e2[0], w0[1] + k[i][0] * e1[1] + k[i][1] * e2[1]);
            }
            var mx = (b.l + b.r) / 2, my = (b.t + b.b) / 2;
            z = w0[2] + mx * e1[2] + my * e2[2];
        }
        o.z = z;
        return o;
    }
    // 看得见的部分的中心画在画面上的哪里（依次排列「按位置」用）：2D 按合成坐标，3D 一律按透视后画出来的位置
    function screenCenter(L, t) {
        if (!isTransformable(L)) return anchorInComp(L, t);
        if (!L.threeDLayer) { var cb = compBox(L, t); if (cb && boxOk(cb)) return [(cb.l + cb.r) / 2, (cb.t + cb.b) / 2]; }
        var b = visibleBox(L, t).box;
        if (!boxOk(b)) return whereInComp(L, t);
        return drawnPoint(L, (b.l + b.r) / 2, (b.t + b.b) / 2, t) || whereInComp(L, t);
    }
    // 滑动的方向和距离（画面上的 dx, dy）换算成「位置」上要加的量（父级坐标；3D 图层带 z）。
    // 2D 图层：父级链能按 2D 算就直接算；父级带 3D 旋转时按 AE 画 2D 子图层的方式解 2×2（画面上滑的还是 dx, dy）。
    // 3D 图层：沿画面的方向（有摄像机图层时是摄像机的 x、y）。父级侧着、画面上滑不动时返回 null
    function slideVec(L, cam, dx, dy, t) {
        if (L.threeDLayer) return screenAxisVec(L, cam, dx, dy, t);
        if (!L.parent) return [dx, dy, 0];
        var v = compToParentVec(L, dx, dy, t);
        if (v) return [v[0], v[1], 0];
        var F = flatAxes(L, t);
        return F ? flatSolve(F, dx, dy) : null;
    }

    // 属性的“地址”：图层 + 从图层开始的属性序号。
    // 给同一图层加效果后，原来的属性对象会失效，所以先记地址、改完再重新取。
    function propPath(p) {
        var idx = [], q2 = p;
        while (q2.propertyDepth > 0) {
            idx.unshift(q2.propertyIndex);
            q2 = q2.parentProperty;
        }
        return { layer: q2, idx: idx };
    }

    function resolvePath(path) {
        var p = path.layer;
        for (var i = 0; i < path.idx.length; i++) p = p.property(path.idx[i]);
        return p;
    }

    function walkProps(group, fn, idx) {
        idx = idx || [];
        var n = 0;
        try { n = group.numProperties; } catch (e) { return; }
        for (var i = 1; i <= n; i++) {
            var p;
            try { p = group.property(i); } catch (e2) { continue; }
            if (!p) continue;
            var here = idx.concat([i]);
            if (p.propertyType === PropertyType.PROPERTY) fn(p, here);
            else walkProps(p, fn, here);
        }
    }

    function selectedKeyedProps(comp) {
        var out = [], props = comp.selectedProperties;
        for (var i = 0; i < props.length; i++) {
            var p = props[i];
            if (p.propertyType === PropertyType.PROPERTY && p.selectedKeys && p.selectedKeys.length) out.push(p);
        }
        return out;
    }

    function selectedExprProps(comp) {
        var out = [], props = comp.selectedProperties;
        for (var i = 0; i < props.length; i++) {
            if (props[i].propertyType === PropertyType.PROPERTY && props[i].canSetExpression) out.push(props[i]);
        }
        if (!out.length) fail("请先在时间轴上选中要加表达式的属性（如位置、旋转）");
        return out;
    }

    function topmost(layers) {
        var top = layers[0];
        for (var i = 1; i < layers.length; i++) if (layers[i].index < top.index) top = layers[i];
        return top;
    }

    function uniqueLayerName(comp, base) {
        var names = {};
        for (var i = 1; i <= comp.numLayers; i++) names[comp.layer(i).name] = true;
        if (!names[base]) return base;
        for (var n = 2; ; n++) if (!names[base + " " + n]) return base + " " + n;
    }

    function uniqueItemName(base) {
        var names = {};
        for (var i = 1; i <= app.project.numItems; i++) names[app.project.item(i).name] = true;
        if (!names[base]) return base;
        for (var n = 2; ; n++) if (!names[base + " " + n]) return base + " " + n;
    }

    // =====================================================================
    // 工具（每个返回提示文字；出错用 fail）
    // =====================================================================
    var T = {};

    var GRID_NAMES = [["左上", "上中", "右上"], ["左中", "中心", "右中"], ["左下", "下中", "右下"]];
    function gridName(fx, fy) {
        var r = GRID_NAMES[Math.max(0, Math.min(2, Math.round(fy * 2)))];
        return r ? r[Math.max(0, Math.min(2, Math.round(fx * 2)))] : "";
    }
    // 「按遮罩」的说明：一个图层时直接说按的是什么，几个图层时说其中几个
    function viaNote(n, viaMask, viaSel) {
        if (!viaMask && !viaSel) return "";
        if (n === 1) return viaSel ? "，按选中的遮罩" : "，按遮罩露出来的范围";
        return "（其中 " + (viaMask + viaSel) + " 个按遮罩）";
    }
    function skipNote(parts) {
        var out = [];
        for (var i = 0; i < parts.length; i++) if (parts[i][0]) out.push(parts[i][0] + " 个" + parts[i][1]);
        return out.length ? "。" + out.join("，") : "";
    }

    // 锚点九宫格：按看得见的部分（有遮罩按遮罩）放锚点，画面不动；⌥ 再把图层贴到合成的同一个位置
    T.anchor = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), t = comp.time, n = 0, i;
        var viaMask = 0, viaSel = 0, cams = 0, empty = 0, exprN = 0, zeroN = 0, nocalc = 0, place = [];
        var tx = comp.width * a.fx, ty = comp.height * a.fy;
        for (i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) { cams++; continue; }
            var v = visibleBox(L, t), b = v.box;
            if (!boxOk(b) || boxSize(b) <= 0) { empty++; continue; }
            var st = anchorTo(L, b.l + (b.r - b.l) * a.fx, b.t + (b.b - b.t) * a.fy, t, comp);
            if (st === "expr") { exprN++; continue; }
            if (st === "nocalc") { if (zeroScaleChain(L, t)) zeroN++; else nocalc++; continue; }
            if (v.via === "mask") viaMask++;
            if (v.via === "selMask") viaSel++;
            n++;
            if (a.mods.alt) place.push({ L: L });
        }
        if (!n) {
            var rs = [];
            if (exprN) rs.push(exprN + " 个图层的锚点或位置由表达式控制（先关掉表达式再试）");
            if (zeroN) rs.push(zeroN + " 个图层的父级缩放是 0（把播放头移到父级显示出来的地方再试）");
            if (nocalc) rs.push(nocalc + " 个图层在合成里的位置 AE 算不出来");
            if (empty) rs.push(empty + " 个图层没有画面（比如空文字）");
            if (cams) rs.push(cams + " 个是摄像机或灯光，没有锚点");
            fail(rs.length > 1 ? "锚点没改：" + rs.join("，") :
                exprN ? "选中图层的锚点或位置由表达式控制，改了画面会跳，所以没改：先关掉表达式再试" :
                zeroN ? "选中图层的父级缩放是 0，锚点没改：把播放头移到父级显示出来的地方再试" :
                nocalc ? "选中图层在合成里的位置 AE 算不出来，锚点没改" :
                empty ? "选中的图层没有画面（比如空文字），锚点没法放" : "摄像机和灯光没有锚点：请选中其他图层");
        }
        // ⌥：按层级从上往下逐个贴（父子一起选中时子图层不会被父级再带走）；2D 直接算，3D、父级带 3D 旋转的量着贴
        var pr = place.length ? placeAll(place, tx, ty, t, camCtx(comp)) : null;
        var where = gridName(a.fx, a.fy), head;
        if (!pr) head = "锚点已移到" + where + "：" + n + " 个图层";
        else if (pr.ok === n) head = "锚点已移到" + where + "并贴到合成的" + where + "：" + n + " 个图层";
        else head = "锚点已移到" + where + "：" + n + " 个图层，其中 " + pr.ok + " 个贴到了合成的" + where;
        return head + viaNote(n, viaMask, viaSel) +
            skipNote([[cams, "摄像机 / 灯光没有锚点"], [empty, "图层没有画面，没动"], [exprN, "图层的锚点或位置由表达式控制，没改"],
                [zeroN, "图层的父级缩放是 0，锚点没改（把播放头移到父级显示出来的地方再试）"], [nocalc, "图层在合成里的位置 AE 算不出来，锚点没改"]]
                .concat(pr ? placeNotes(pr, "贴上合成") : []));
    };

    // 居中到合成：锚点放到看得见的部分的中心，再把这个点移到合成中心；⌥ 不改锚点，按外框居中
    T.centerComp = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), t = comp.time, moves = [], place = [], i;
        var cx = comp.width / 2, cy = comp.height / 2, n = 0, empty = 0, exprN = 0, cams = 0, zeroN = 0, nocalc = 0, why = {};
        for (i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) { cams++; continue; }
            var v = visibleBox(L, t), b = v.box;
            if (!boxOk(b) || boxSize(b) <= 0) { empty++; continue; }
            if (!a.mods.alt) {
                // 锚点放到中心，再把锚点移到合成中心（3D、父级链不能按 2D 算时量着移）
                var st = anchorTo(L, (b.l + b.r) / 2, (b.t + b.b) / 2, t, comp);
                if (st === "expr") { exprN++; continue; }
                if (st === "nocalc") { if (zeroScaleChain(L, t)) zeroN++; else nocalc++; continue; }
                place.push({ L: L, via: v.via });
            } else {
                var cb = compBox(L, t);
                if (!cb) { countWhy(why, L, t); continue; }
                moves.push({ L: L, dx: cx - (cb.l + cb.r) / 2, dy: cy - (cb.t + cb.b) / 2, b: cb, via: cb.via });
            }
            n++;
        }
        if (!n) {
            var rs = [], wk = whyKinds(why);
            if (exprN) rs.push(exprN + " 个图层的锚点或位置由表达式控制（先关掉表达式再试）");
            if (zeroN) rs.push(zeroN + " 个图层的父级缩放是 0（把播放头移到父级显示出来的地方再试）");
            if (nocalc) rs.push(nocalc + " 个图层在合成里的位置 AE 算不出来");
            if (wk) rs.push(whyList(why) + "（按外框居中算不准，去掉 ⌥ 按锚点居中）");
            if (empty) rs.push(empty + " 个图层没有画面（比如空文字）");
            if (cams) rs.push(cams + " 个是摄像机或灯光");
            fail(rs.length > 1 ? "没有居中：" + rs.join("，") :
                exprN ? "选中图层的锚点或位置由表达式控制，改了画面会跳，所以没改：先关掉表达式再试" :
                zeroN ? "选中图层的父级缩放是 0，没有居中：把播放头移到父级显示出来的地方再试" :
                nocalc ? "选中图层在合成里的位置 AE 算不出来，没有居中" :
                wk ? "选中的图层" + firstWhy(why) + "，按外框居中算不准：去掉 ⌥，按锚点居中" :
                empty ? "选中的图层没有画面（比如空文字），没法居中" : "请选中要居中的图层（摄像机、灯光除外）");
        }
        // 按外框（⌥）：一批直接算；按锚点：按层级从上往下逐个放（3D、父级带 3D 旋转的量着贴）
        var mr = moves.length ? moveAll(moves, t) : { failed: 0, expr: 0 }, pr = place.length ? placeAll(place, cx, cy, t, camCtx(comp)) : null;
        // 只数真的居中了的（按遮罩的说明也只数它们）
        var done = 0, viaMask = 0, viaSel = 0, items = moves.concat(place);
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.st !== undefined ? it.st !== "" : !it.applied) continue;
            done++;
            if (it.via === "mask") viaMask++;
            if (it.via === "selMask") viaSel++;
        }
        return (a.mods.alt ? "已按外框居中：" : "已居中：") + done + " 个图层" + viaNote(done, viaMask, viaSel) +
            skipNote(whyNotes(why, "没动").concat([[mr.failed, "图层没居中（父级缩放成 0？），留在原地"], [mr.expr, "图层的位置由表达式控制，没居中"],
                [exprN, "图层的锚点或位置由表达式控制，没改"], [zeroN, "图层的父级缩放是 0，没居中（把播放头移到父级显示出来的地方再试）"],
                [nocalc, "图层在合成里的位置 AE 算不出来，没居中"]]).concat(pr ? placeNotes(pr, "居中") : [])
                .concat([[empty, "图层没有画面，没动"], [cams, "摄像机 / 灯光没动"]]));
    };

    // 空对象。⌥：放到选中图层（看得见的部分）的中心并设为它们的父级——
    // 选中的图层原来有同一个父级时，空对象接到那个父级下面，层级不断开；子图层跟着它选中的上级走，不单独挂
    T.nullLayer = function (a) {
        var comp = activeComp(), sel = comp.selectedLayers, t = comp.time, i;
        var box = emptyBox(), any3D = false, zs = 0, zn = 0;
        if (a.mods.alt && sel.length) {
            // 空对象放在世界坐标里：2D 图层按合成坐标，3D 图层按它在世界里的范围和深度（转过 X / Y 的也按世界坐标，不按透视后的位置）
            for (i = 0; i < sel.length; i++) {
                var L = sel[i], wb = null;
                if (L.threeDLayer) any3D = true;
                try { wb = worldBoxOf(L, t); } catch (eW) { wb = null; }
                if (!wb) continue;
                addPt(box, wb.l, wb.t); addPt(box, wb.r, wb.b);
                if (L.threeDLayer && wb.z !== undefined) { zs += wb.z; zn++; }
            }
        }
        var nl = comp.layers.addNull();
        nl.name = uniqueLayerName(comp, "控制器");
        nl.label = 2;
        if (!sel.length) return "已新建空对象";
        nl.moveBefore(topmost(sel));
        if (!a.mods.alt) return "已新建空对象";
        if (any3D) nl.threeDLayer = true;
        var pos = boxOk(box) ? [(box.l + box.r) / 2, (box.t + box.b) / 2] : [comp.width / 2, comp.height / 2];
        if (any3D) pos.push(zn ? zs / zn : 0);
        nl.transform.position.setValue(pos);
        // 图层序号在加空对象、移动之后才稳定：这时再找「根」（父级链上没有别的选中图层）
        var picked = {}, roots = [];
        for (i = 0; i < sel.length; i++) picked[sel[i].index] = true;
        for (i = 0; i < sel.length; i++) {
            var p = sel[i].parent, inSel = false, g = 0;
            while (p && g++ < 64) { if (picked[p.index]) { inSel = true; break; } p = p.parent; }
            if (!inSel) roots.push(sel[i]);
        }
        var common = -1, same = true;
        for (i = 0; i < roots.length; i++) {
            var pi = roots[i].parent ? roots[i].parent.index : 0;
            if (common === -1) common = pi; else if (common !== pi) same = false;
        }
        var under = null;
        if (same && common > 0) {
            under = comp.layer(common);
            var um = compMatrix(under, t), det = um ? um[0] * um[3] - um[2] * um[1] : 0;
            if (um && Math.abs(det) > 1e-9) {
                // 空对象接到父级下面，但不带上父级的反向变换：保持缩放 100%、不旋转，只在父级坐标里放到中心。
                // 这样选中的图层挂过来时只换位置，缩放和旋转不变（父级不等比缩放、子图层又转过时也不会被拉歪）
                nl.setParentWithJump(under);
                var ddx = pos[0] - um[4], ddy = pos[1] - um[5];
                var local = [(um[3] * ddx - um[2] * ddy) / det, (-um[1] * ddx + um[0] * ddy) / det];
                if (any3D) {
                    // 深度：把算好的世界坐标 z（看得见部分的深度）换到父级坐标里。父级链能按 2D 算时 z 和 x、y 无关
                    var o0 = probe(under, "thisLayer.toWorld([0, 0, 0], " + t + ");", t), ez = probe(under, "thisLayer.toWorldVec([0, 0, 1], " + t + ");", t);
                    local.push(o0 && ez && Math.abs(ez[2]) > 1e-9 ? (pos[2] - o0[2]) / ez[2] : pos[2]);
                }
                nl.transform.position.setValue(local);
            } else nl.parent = under;   // 父级带 3D 旋转：交给 AE 换算（.parent = 赋值不跳，画面不动）
        }
        var linked = 0, kept = 0;
        for (i = 0; i < roots.length; i++) {
            if (roots[i].parent && !under) { kept++; continue; }
            roots[i].parent = nl;
            linked++;
        }
        return "已新建空对象，放在选中图层的中心，并设为 " + linked + " 个图层的父级" +
            (under ? "（接在原来的父级「" + under.name + "」下面）" : "") +
            (kept ? "。" + kept + " 个图层原来有别的父级，没改" : "") +
            (sel.length - roots.length > 0 ? "。" + (sel.length - roots.length) + " 个子图层跟着它们选中的上级走" : "");
    };

    T.addLayer = function (a) {
        var comp = activeComp(), sel = comp.selectedLayers, L;
        if (a.kind === "adjust") {
            L = comp.layers.addSolid([1, 1, 1], uniqueLayerName(comp, "调整图层"), comp.width, comp.height, comp.pixelAspect, comp.duration);
            L.adjustmentLayer = true;
        } else if (a.kind === "solid") {
            L = comp.layers.addSolid([0.09, 0.094, 0.098], uniqueLayerName(comp, "纯色"), comp.width, comp.height, comp.pixelAspect, comp.duration);
        } else if (a.kind === "camera") {
            L = comp.layers.addCamera(uniqueLayerName(comp, "摄像机"), [comp.width / 2, comp.height / 2]);
        } else if (a.kind === "light") {
            L = comp.layers.addLight(uniqueLayerName(comp, "灯光"), [comp.width / 2, comp.height / 2]);
        } else if (a.kind === "null") {
            L = comp.layers.addNull();
            L.name = uniqueLayerName(comp, "空对象");
        } else if (a.kind === "text") {
            L = comp.layers.addText("文字");
            L.name = uniqueLayerName(comp, "文字");
            var r = L.sourceRectAtTime(comp.time, false);
            L.transform.anchorPoint.setValue([r.left + r.width / 2, r.top + r.height / 2]);
            L.transform.position.setValue([comp.width / 2, comp.height / 2]);
        } else if (a.kind === "shape") {
            L = comp.layers.addShape();
            L.name = uniqueLayerName(comp, "形状");
            var grp = L.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
            grp.name = "矩形";
            var vec = grp.property("ADBE Vectors Group");
            vec.addProperty("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").setValue([comp.width / 4, comp.height / 4]);
            vec.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([1, 0.349, 0, 1]);
            L.transform.position.setValue([comp.width / 2, comp.height / 2]);
            L.transform.anchorPoint.setValue([0, 0]);
        }
        if (!L) fail("不支持的图层类型");
        if (sel.length) L.moveBefore(topmost(sel));
        return "已新建：" + L.name;
    };

    function easeDims(p) {
        var t = p.propertyValueType;
        if (t === PropertyValueType.TwoD) return 2;
        if (t === PropertyValueType.ThreeD) return 3;
        return 1;
    }

    T.ease = function (a) {
        var comp = activeComp(), props = selectedKeyedProps(comp), count = 0;
        if (!props.length) fail("请先选中关键帧");
        var mode = a.mode;
        if (mode === "both" && a.mods.alt) mode = "in";
        if (mode === "both" && a.mods.shift) mode = "out";
        var KIT = KeyframeInterpolationType;
        for (var i = 0; i < props.length; i++) {
            var p = props[i], keys = p.selectedKeys;
            for (var j = 0; j < keys.length; j++) {
                var k = keys[j];
                try {
                    if (mode === "linear") { p.setInterpolationTypeAtKey(k, KIT.LINEAR, KIT.LINEAR); count++; continue; }
                    if (mode === "hold") { p.setInterpolationTypeAtKey(k, KIT.HOLD, KIT.HOLD); count++; continue; }
                    var eIn = [], eOut = [];
                    for (var d = 0; d < easeDims(p); d++) {
                        eIn.push(new KeyframeEase(0, a.inInfl));
                        eOut.push(new KeyframeEase(0, a.outInfl));
                    }
                    var inE = mode === "out" ? p.keyInTemporalEase(k) : eIn;
                    var outE = mode === "in" ? p.keyOutTemporalEase(k) : eOut;
                    var inT = mode === "out" ? p.keyInInterpolationType(k) : KIT.BEZIER;
                    var outT = mode === "in" ? p.keyOutInterpolationType(k) : KIT.BEZIER;
                    if (inT === KIT.HOLD) inT = KIT.BEZIER;
                    if (outT === KIT.HOLD) outT = KIT.BEZIER;
                    p.setInterpolationTypeAtKey(k, inT, outT);
                    p.setTemporalEaseAtKey(k, inE, outE);
                    count++;
                } catch (e) { /* 源文本等不支持插值的属性跳过 */ }
            }
        }
        var names = { both: "缓入缓出", "in": "缓入", out: "缓出", linear: "线性", hold: "定格" };
        return names[mode] + "：" + count + " 个关键帧";
    };

    // 选中图层在合成里看得见的外框（带父级的也算；3D 旋转过的算不准，记在 rotated 里）
    function boxesOf(layers, t) {
        var list = [], rotated = 0, empty = 0, viaMask = 0, cams = 0, why = {};
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) { cams++; continue; }
            var b = compBox(L, t);
            if (!b) { rotated++; countWhy(why, L, t); continue; }
            if (boxSize(b) <= 0) { empty++; continue; }
            if (b.via !== "content") viaMask++;
            list.push({ L: L, b: b });
        }
        return { list: list, rotated: rotated, empty: empty, viaMask: viaMask, cams: cams, why: why };
    }

    // 对齐：默认对齐到合成；⌥ 对齐到选区（选中图层的整体外框）；⇧ 对齐到最上面那个选中的图层（它不动）
    T.align = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), t = comp.time, i;
        var got = boxesOf(layers, t), list = got.list, key = null, to = "合成";
        if (!list.length) {
            var kinds = whyKinds(got.why) + (got.empty ? 1 : 0) + (got.cams ? 1 : 0);
            if (kinds > 1) {
                var rs = [];
                if (got.rotated) rs.push(whyList(got.why) + "（在合成里的外框算不准）");
                if (got.empty) rs.push(got.empty + " 个图层没有画面");
                if (got.cams) rs.push(got.cams + " 个是摄像机或灯光");
                fail("没有对齐：" + rs.join("，"));
            }
            fail(got.rotated ? whyFail(got.why, "没有对齐") : got.cams ? "摄像机和灯光没有外框，没法对齐：请选中其他图层" : "选中的图层没有可以对齐的画面");
        }
        var ref = { l: 0, t: 0, r: comp.width, b: comp.height };
        if (a.mods.shift) {
            if (list.length < 2) fail("对齐到图层需要选中至少 2 个图层");
            for (i = 0; i < list.length; i++) if (!key || list[i].L.index < key.L.index) key = list[i];
            ref = key.b; to = "「" + key.L.name + "」";
        } else if (a.mods.alt) {
            if (list.length < 2) fail("对齐到选区需要至少 2 个图层");
            ref = emptyBox();
            for (i = 0; i < list.length; i++) { addPt(ref, list[i].b.l, list[i].b.t); addPt(ref, list[i].b.r, list[i].b.b); }
            to = "选区";
        }
        var moves = [];
        for (i = 0; i < list.length; i++) {
            // 参照层不动：也放进这一批（位移 0），它是别的选中图层的子图层时，父级带走的会被补回来
            if (list[i] === key) { moves.push({ L: key.L, dx: 0, dy: 0, key: true }); continue; }
            var b = list[i].b, dx = 0, dy = 0;
            if (a.mode === "left") dx = ref.l - b.l;
            else if (a.mode === "hcenter") dx = (ref.l + ref.r) / 2 - (b.l + b.r) / 2;
            else if (a.mode === "right") dx = ref.r - b.r;
            else if (a.mode === "top") dy = ref.t - b.t;
            else if (a.mode === "vcenter") dy = (ref.t + ref.b) / 2 - (b.t + b.b) / 2;
            else if (a.mode === "bottom") dy = ref.b - b.b;
            moves.push({ L: list[i].L, dx: dx, dy: dy, b: b });
        }
        var mr = moveAll(moves, t), done = 0, vm = 0;
        for (i = 0; i < moves.length; i++) if (!moves[i].key && moves[i].applied) { done++; if (moves[i].b.via !== "content") vm++; }
        return "已对齐到" + to + "：" + done + " 个图层" + (vm ? "（" + vm + " 个按遮罩范围）" : "") +
            skipNote(whyNotes(got.why, "没动").concat([[mr.failed, "图层没能移动（父级缩放成 0？）"], [mr.expr, "图层的位置由表达式控制，没动"],
                [got.empty, "图层没有画面，没动"], [got.cams, "摄像机 / 灯光没动"]]));
    };

    // 分布：默认按中心等距（两头的不动）；⌥ 按间距均分（相邻两个之间的空隙一样大）
    T.distribute = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 3), t = comp.time, H = !!a.horizontal, i;
        var got = boxesOf(layers, t), list = got.list;
        if (list.length < 3) {
            var nb = [];
            if (got.rotated) nb.push(whyList(got.why));
            if (got.cams) nb.push(got.cams + " 个是摄像机或灯光");
            if (got.empty) nb.push(got.empty + " 个图层没有画面");
            fail("分布需要至少 3 个能算出外框的图层" + (nb.length ? "（" + nb.join("，") + "，不算）" : ""));
        }
        var lo = function (b) { return H ? b.l : b.t; }, hi = function (b) { return H ? b.r : b.b; };
        for (i = 0; i < list.length; i++) list[i].c = (lo(list[i].b) + hi(list[i].b)) / 2;
        list.sort(function (x, y) { return x.c - y.c; });
        var moves = [], last = list.length - 1, gapText = "";
        if (a.mods.alt) {
            var total = 0;
            for (i = 0; i <= last; i++) total += hi(list[i].b) - lo(list[i].b);
            var gap = (hi(list[last].b) - lo(list[0].b) - total) / last, x = lo(list[0].b);
            for (i = 0; i <= last; i++) {
                // 两端不动，也放进这一批（位移 0）：两端是中间某个图层的子图层时，父级带走的会被补回来
                var d = i > 0 && i < last ? x - lo(list[i].b) : 0;
                moves.push({ L: list[i].L, dx: H ? d : 0, dy: H ? 0 : d, b: list[i].b });
                x += hi(list[i].b) - lo(list[i].b) + gap;
            }
            gapText = "，空隙 " + (Math.round(gap * 10) / 10) + " px";
        } else {
            var first = list[0].c, step = (list[last].c - first) / last;
            for (i = 0; i <= last; i++) {
                var dc = i > 0 && i < last ? first + step * i - list[i].c : 0;
                moves.push({ L: list[i].L, dx: H ? dc : 0, dy: H ? 0 : dc, b: list[i].b });
            }
        }
        var mr = moveAll(moves, t), bad = mr.failed + mr.expr;
        // 中间有图层没动：间距不均，直说
        return (bad ? "只分布了一部分：" + list.length + " 个图层里 " + bad + " 个没动，间距不均" : (a.mods.alt ? "已按间距均分 " : "已按中心均匀分布 ") + list.length + " 个图层" + gapText) +
            skipNote(whyNotes(got.why, "没动").concat([[mr.failed, "图层没能移动（父级缩放成 0？）"], [mr.expr, "图层的位置由表达式控制，没动"],
                [got.empty, "图层没有画面，没动"], [got.cams, "摄像机 / 灯光没动"]]));
    };

    // 依次排列：每 num 个图层一组，组与组之间错开 step 帧
    // order：forward 正序 / reverse 倒序 / center 从中间向两边 / random 随机；Alt 倒序、Shift 随机
    T.sequence = function (a) {
        var comp = activeComp(), sel = needLayers(comp, 2), layers = [], i;
        for (i = 0; i < sel.length; i++) layers.push(sel[i]);
        var order = a.order || "forward", posAxis = -1;
        // 「按位置」自己处理 ⌥（反过来）；其他顺序 ⌥ = 倒序、⇧ = 随机（老用法不变）
        if (order !== "position") {
            if (a.mods.alt) order = "reverse";
            if (a.mods.shift) order = "random";
        }
        var num = Math.max(1, a.num || 1), step = (a.step === undefined ? (a.frames || 2) : a.step);
        var rank = [];
        for (i = 0; i < layers.length; i++) rank.push(i);
        if (order === "reverse") rank.reverse();
        else if (order === "random") {
            for (i = rank.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1)), tmp = rank[i];
                rank[i] = rank[j]; rank[j] = tmp;
            }
        } else if (order === "center") {
            var mid = (layers.length - 1) / 2;
            rank.sort(function (x, y) { return Math.abs(x - mid) - Math.abs(y - mid); });
        } else if (order === "position") {
            // 按画面位置：图层铺得更宽就从左到右，更高就从上到下（看得见的部分的中心画在画面上的位置；
            // 3D 图层一律按透视后的位置，平放的和转过的放在一起比也一致；⌥ 反过来）
            var ctr = [], minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (i = 0; i < layers.length; i++) {
                var c = null;
                try { c = screenCenter(layers[i], comp.time); } catch (eS) { c = null; }
                if (!c) { try { c = layerPosition(layers[i], comp.time); } catch (eP) { c = [0, 0]; } }
                ctr.push(c);
                minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
            }
            var ax = maxX - minX >= maxY - minY ? 0 : 1;
            rank.sort(function (x, y) { return (ctr[x][ax] - ctr[y][ax]) || (ctr[x][1 - ax] - ctr[y][1 - ax]) || (x - y); });
            if (a.mods.alt) rank.reverse();
            posAxis = ax;
        }
        var base = Infinity;
        for (i = 0; i < layers.length; i++) base = Math.min(base, layers[i].inPoint);
        for (i = 0; i < rank.length; i++) {
            var L = layers[rank[i]], g = Math.floor(i / num);
            L.startTime += (base + g * step * comp.frameDuration) - L.inPoint;
        }
        var names = { forward: "正序", reverse: "倒序", center: "从中间", random: "随机",
            position: posAxis === 1 ? (a.mods.alt ? "从下到上" : "从上到下") : (a.mods.alt ? "从右到左" : "从左到右") };
        return "已依次排列 " + layers.length + " 个图层（" + names[order] + "，每组 " + num + " 个，间隔 " + step + " 帧）";
    };

    T.trim = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1);
        var s = comp.workAreaStart, e = comp.workAreaStart + comp.workAreaDuration;
        for (var i = 0; i < layers.length; i++) {
            try {
                if (a.mods.alt) layers[i].inPoint = comp.time;
                else { layers[i].inPoint = s; layers[i].outPoint = e; }
            } catch (err) {}
        }
        return a.mods.alt ? "已把入点剪到播放头" : "已剪到工作区";
    };

    T.precompEach = function () {
        var comp = activeComp(), layers = needLayers(comp, 1), idx = [];
        for (var i = 0; i < layers.length; i++) idx.push(layers[i].index);
        idx.sort(function (x, y) { return y - x; });
        for (var j = 0; j < idx.length; j++) {
            comp.layers.precompose([idx[j]], uniqueItemName(comp.layer(idx[j]).name + " 预合成"), true);
        }
        return "已逐个预合成 " + idx.length + " 个图层";
    };

    T.reverse = function () {
        var comp = activeComp(), sel = needLayers(comp, 2), list = [];
        for (var i = 0; i < sel.length; i++) list.push(sel[i]);
        list.sort(function (x, y) { return x.index - y.index; });
        for (var j = 1; j < list.length; j++) list[j].moveBefore(list[j - 1]);
        return "已反转 " + list.length + " 个图层的顺序";
    };

    T.rename = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1);
        if (!a.base) fail("名称不能为空");
        var pad = layers.length >= 100 ? 3 : 2;
        for (var i = 0; i < layers.length; i++) {
            var num = String(i + 1);
            while (num.length < pad) num = "0" + num;
            layers[i].name = a.base + "_" + num;
        }
        return "已重命名 " + layers.length + " 个图层";
    };

    // —— 关键帧：从播放头克隆 ——
    // 读取一个关键帧的完整信息（值、插值、缓动、空间切线）
    function keyData(p, k) {
        var d = {
            t: p.keyTime(k), v: p.keyValue(k),
            inI: p.keyInInterpolationType(k), outI: p.keyOutInterpolationType(k),
            inE: null, outE: null, inS: null, outS: null
        };
        try { d.inE = p.keyInTemporalEase(k); d.outE = p.keyOutTemporalEase(k); } catch (e1) {}
        if (p.isSpatial) {
            try { d.inS = p.keyInSpatialTangent(k); d.outS = p.keyOutSpatialTangent(k); } catch (e2) {}
        }
        return d;
    }

    // 在时间 t 写入关键帧；reverse 时进出缓动对调
    function writeKey(p, t, d, reverse) {
        var KIT = KeyframeInterpolationType;
        p.setValueAtTime(t, d.v);
        var idx = p.nearestKeyIndex(t);
        try {
            p.setInterpolationTypeAtKey(idx, reverse ? d.outI : d.inI, reverse ? d.inI : d.outI);
            if (d.inE && d.inI !== KIT.HOLD && d.outI !== KIT.HOLD) {
                p.setTemporalEaseAtKey(idx, reverse ? d.outE : d.inE, reverse ? d.inE : d.outE);
            }
            if (d.inS) p.setSpatialTangentsAtKey(idx, reverse ? d.outS : d.inS, reverse ? d.inS : d.outS);
        } catch (e) {}
        return idx;
    }

    function selectTimes(p, times, clearOthers) {
        if (clearOthers) for (var j = 1; j <= p.numKeys; j++) p.setSelectedAtKey(j, false);
        for (var i = 0; i < times.length; i++) p.setSelectedAtKey(p.nearestKeyIndex(times[i]), true);
    }

    // 把选中的关键帧按 mapFn(旧时间, 序号, 全部数据) 移到新时间
    function remapSelected(p, mapFn, reverse) {
        var ks = p.selectedKeys, data = [], i;
        for (i = 0; i < ks.length; i++) data.push(keyData(p, ks[i]));
        for (i = ks.length - 1; i >= 0; i--) p.removeKey(ks[i]);
        var times = [];
        for (i = 0; i < data.length; i++) {
            var nt = mapFn(data[i].t, i, data);
            try { writeKey(p, nt, data[i], reverse); times.push(nt); } catch (e) {}
        }
        selectTimes(p, times, false);
        return times.length;
    }

    T.cloneKeys = function (a) {
        var comp = activeComp(), props = selectedKeyedProps(comp), total = 0;
        if (!props.length) fail("请先选中要克隆的关键帧");
        var reverse = !!a.mods.shift;
        for (var i = 0; i < props.length; i++) {
            var p = props[i], ks = p.selectedKeys, data = [], t0 = Infinity, t1 = -Infinity, j;
            for (j = 0; j < ks.length; j++) {
                var d = keyData(p, ks[j]);
                t0 = Math.min(t0, d.t); t1 = Math.max(t1, d.t);
                data.push(d);
            }
            var newTimes = [];
            for (j = 0; j < data.length; j++) {
                var nt = reverse ? comp.time + (t1 - data[j].t) : comp.time + (data[j].t - t0);
                try { writeKey(p, nt, data[j], reverse); newTimes.push(nt); total++; } catch (e3) {}
            }
            if (a.mods.alt) selectTimes(p, newTimes, true);
        }
        return "已从播放头" + (reverse ? "反向" : "") + "克隆 " + total + " 个关键帧" + (a.mods.alt ? "并选中" : "");
    };

    // 属性地址（用 matchName），用来把关键帧粘贴到别的图层的同名属性上
    function matchPath(p) {
        var names = [], idx = [], q2 = p;
        while (q2.propertyDepth > 0) {
            names.unshift(q2.matchName);
            idx.unshift(q2.propertyIndex);
            q2 = q2.parentProperty;
        }
        return { names: names, idx: idx };
    }

    function findOnLayer(layer, mp) {
        var p = layer, i;
        try {
            for (i = 0; i < mp.idx.length; i++) p = p.property(mp.idx[i]);
            if (p && p.matchName === mp.names[mp.names.length - 1]) return p;
        } catch (e) {}
        p = layer;
        try {
            for (i = 0; i < mp.names.length; i++) { p = p.property(mp.names[i]); if (!p) return null; }
            return p;
        } catch (e2) { return null; }
    }

    T.copyKeys = function () {
        var comp = activeComp(), props = selectedKeyedProps(comp), clip = [], t0 = Infinity, count = 0, i, j;
        if (!props.length) fail("请先选中要复制的关键帧");
        for (i = 0; i < props.length; i++) {
            var ks = props[i].selectedKeys;
            for (j = 0; j < ks.length; j++) t0 = Math.min(t0, props[i].keyTime(ks[j]));
        }
        for (i = 0; i < props.length; i++) {
            var p = props[i], keys = [];
            for (j = 0; j < p.selectedKeys.length; j++) {
                var d = keyData(p, p.selectedKeys[j]);
                d.t -= t0;
                keys.push(d);
                count++;
            }
            clip.push({ path: matchPath(p), name: p.name, keys: keys, span: 0 });
            for (j = 0; j < keys.length; j++) clip[clip.length - 1].span = Math.max(clip[clip.length - 1].span, keys[j].t);
        }
        $.global.MH_CLIP = clip;
        return { msg: "已复制 " + count + " 个关键帧（" + props.length + " 个属性）", count: count };
    };

    T.pasteKeys = function (a) {
        var clip = $.global.MH_CLIP;
        if (!clip || !clip.length) fail("剪贴板是空的，请先复制关键帧");
        var comp = activeComp(), targets = [], i, j;
        var sel = comp.selectedProperties;
        for (i = 0; i < sel.length; i++) {
            if (sel[i].propertyType === PropertyType.PROPERTY && sel[i].canVaryOverTime) targets.push(sel[i]);
        }
        var pairs = [];
        if (targets.length) {
            // 选了属性：按顺序对应；只复制了一个属性时，粘到所有选中属性上
            for (i = 0; i < targets.length; i++) pairs.push({ p: targets[i], c: clip[clip.length === 1 ? 0 : i % clip.length] });
        } else {
            // 只选了图层：粘到每个图层的同名属性上
            var layers = needLayers(comp, 1);
            for (i = 0; i < layers.length; i++) {
                for (j = 0; j < clip.length; j++) {
                    var tp = findOnLayer(layers[i], clip[j].path);
                    if (tp) pairs.push({ p: tp, c: clip[j] });
                }
            }
        }
        if (!pairs.length) fail("没有找到可以粘贴的属性");
        var reverse = !!a.mods.alt, total = 0;
        for (i = 0; i < pairs.length; i++) {
            var c = pairs[i].c, times = [];
            for (j = 0; j < c.keys.length; j++) {
                var d = c.keys[j];
                var nt = comp.time + (reverse ? c.span - d.t : d.t);
                try { writeKey(pairs[i].p, nt, d, reverse); times.push(nt); total++; } catch (e) {}
            }
            if (a.mods.shift) selectTimes(pairs[i].p, times, true);
        }
        return "已在播放头" + (reverse ? "反向" : "") + "粘贴 " + total + " 个关键帧";
    };

    // 关键帧时间：微移 / 拉伸 / 均分 / 反转
    T.keyTime = function (a) {
        var comp = activeComp(), props = selectedKeyedProps(comp), total = 0, fd = comp.frameDuration;
        if (!props.length) fail("请先选中关键帧");
        var op = a.op;
        for (var i = 0; i < props.length; i++) {
            var p = props[i], ks = p.selectedKeys;
            var t0 = p.keyTime(ks[0]), t1 = p.keyTime(ks[ks.length - 1]);
            if (op === "nudge") {
                var off = (a.dir || 1) * (a.frames || 1) * fd * (a.mods.shift ? 10 : 1);
                total += remapSelected(p, function (t) { return t + off; }, false);
            } else if (op === "stretch") {
                var f = a.factor > 0 ? a.factor : 1.5;
                if (a.mods.alt) f = 1 / f;
                total += remapSelected(p, function (t) { return t0 + Math.round((t - t0) * f / fd) * fd; }, false);
            } else if (op === "distribute") {
                if (ks.length < 3) continue;
                var stepT = (t1 - t0) / (ks.length - 1);
                total += remapSelected(p, function (t, idx) { return t0 + Math.round(stepT * idx / fd) * fd; }, false);
            } else if (op === "reverse") {
                total += remapSelected(p, function (t) { return t0 + t1 - t; }, true);
            }
        }
        var names = { nudge: "移动", stretch: a.mods.alt ? "压缩" : "拉伸", distribute: "均分", reverse: "反转" };
        return "已" + names[op] + " " + total + " 个关键帧";
    };

    // 把 CSS cubic-bezier(x1, y1, x2, y2) 换算成 AE 的速度 + 影响，应用到 k1 → k2 这一段
    function bezierBetween(p, k1, k2, b) {
        var KIT = KeyframeInterpolationType;
        var t1 = p.keyTime(k1), t2 = p.keyTime(k2), dt = t2 - t1;
        if (dt <= 0) return false;
        var v1 = p.keyValue(k1), v2 = p.keyValue(k2), dv = [], i;
        var dims = easeDims(p);
        if (dims === 1) {
            if (typeof v1 === "number") dv = [v2 - v1];
            else {
                var s = 0;
                for (i = 0; i < v1.length; i++) s += (v2[i] - v1[i]) * (v2[i] - v1[i]);
                dv = [Math.sqrt(s)];
            }
        } else {
            for (i = 0; i < dims; i++) dv.push(v2[i] - v1[i]);
        }
        var x1 = Math.min(1, Math.max(0.001, b[0])), y1 = b[1];
        var x2 = Math.min(0.999, Math.max(0, b[2])), y2 = b[3];
        var outE = [], inE = [];
        for (i = 0; i < dv.length; i++) {
            var avg = dv[i] / dt;
            outE.push(new KeyframeEase(avg * y1 / x1, Math.max(0.1, Math.min(100, x1 * 100))));
            inE.push(new KeyframeEase(avg * (1 - y2) / (1 - x2), Math.max(0.1, Math.min(100, (1 - x2) * 100))));
        }
        var k1In = p.keyInTemporalEase(k1), k2Out = p.keyOutTemporalEase(k2);
        var k1InT = p.keyInInterpolationType(k1), k2OutT = p.keyOutInterpolationType(k2);
        p.setInterpolationTypeAtKey(k1, k1InT === KIT.HOLD ? KIT.BEZIER : k1InT, KIT.BEZIER);
        p.setInterpolationTypeAtKey(k2, KIT.BEZIER, k2OutT === KIT.HOLD ? KIT.BEZIER : k2OutT);
        p.setTemporalEaseAtKey(k1, k1In, outE);
        p.setTemporalEaseAtKey(k2, inE, k2Out);
        return true;
    }

    T.bezier = function (a) {
        var comp = activeComp(), props = selectedKeyedProps(comp), segs = 0;
        if (!props.length) fail("请先选中至少两个关键帧");
        var b = a.bezier;
        if (a.mods.alt) b = [1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]];
        for (var i = 0; i < props.length; i++) {
            var p = props[i], ks = p.selectedKeys;
            try {
                if (ks.length === 1) {
                    if (ks[0] < p.numKeys && bezierBetween(p, ks[0], ks[0] + 1, b)) segs++;
                } else {
                    for (var j = 0; j < ks.length - 1; j++) if (bezierBetween(p, ks[j], ks[j + 1], b)) segs++;
                }
            } catch (e) {}
        }
        if (!segs) fail("没有可以应用的关键帧段（需要选中至少两个关键帧）");
        return "已应用曲线 (" + b.join(", ") + ")：" + segs + " 段";
    };

    // 快速动画：单击 = 从播放头开始入场；Alt = 在播放头结束出场
    var EASE_OUT = [0.22, 1, 0.36, 1], EASE_IN = [0.64, 0, 0.78, 0];

    function keySegments(p, times, values, b) {
        for (var i = 0; i < times.length; i++) p.setValueAtTime(times[i], values[i]);
        for (var j = 0; j < times.length - 1; j++) {
            try { bezierBetween(p, p.nearestKeyIndex(times[j]), p.nearestKeyIndex(times[j + 1]), b); } catch (e) {}
        }
    }

    function scaleVec(v, f) {
        var o = [];
        for (var i = 0; i < v.length; i++) o.push(v[i] * f);
        return o;
    }

    // 加了关键帧，但表达式不看数值（比如钉死的位置）：画面上看不出动画
    function exprHides(p, t0, t1) {
        if (!hasExpr(p)) return false;
        return !sameVal(p.valueAtTime(t0, true), p.valueAtTime(t1, true)) && sameVal(p.valueAtTime(t0, false), p.valueAtTime(t1, false));
    }
    function sameVal(a, b) {
        if (typeof a === "number") return Math.abs(a - b) < 1e-6;
        for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
        return true;
    }

    T.quickAnim = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), out = !!a.mods.alt, n = 0, edgeOn = 0, zeroQ = 0, camsQ = 0, hid = 0, cam = activeCam(comp);
        var dur = Math.max(1, a.frames || 12) * comp.frameDuration;
        var t0 = out ? comp.time - dur : comp.time, t1 = t0 + dur;
        var tRest = out ? t0 : t1, b = out ? EASE_IN : EASE_OUT;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) { camsQ++; continue; }
            // 关键帧写的是表达式之前的值：从表达式之前的值出发（不然跟着数值走的表达式会被算两遍，停下来时位置跳一下）
            var tr = L.transform, p, base, keyed = [];
            if (a.kind === "fade") {
                p = tr.opacity; base = p.valueAtTime(tRest, true);
                keySegments(p, [t0, t1], out ? [base, 0] : [0, base], b); keyed.push(p);
            } else if (a.kind === "scale") {
                p = tr.scale; base = p.valueAtTime(tRest, true); keyed.push(p);
                var t2 = t0 + dur * (out ? 0.4 : 0.6);
                keySegments(p, [t0, t2, t1], out ? [base, scaleVec(base, 1.1), scaleVec(base, 0)] : [scaleVec(base, 0), scaleVec(base, 1.1), base], [0.33, 0, 0.2, 1]);
            } else if (a.kind === "slide") {
                var dist = (a.dir === "left" || a.dir === "right") ? comp.width * 0.25 : comp.height * 0.25;
                var dx = a.dir === "left" ? -dist : a.dir === "right" ? dist : 0;
                var dy = a.dir === "up" ? -dist : a.dir === "down" ? dist : 0;
                // 滑动的距离按画面算：带父级（缩放、旋转过，或带 3D 旋转、是摄像机）时换算到父级坐标，画面上滑的还是合成的 1/4；
                // 3D 图层沿画面的方向滑（有摄像机图层时沿摄像机的 x、y，离摄像机的远近不变）
                if (zeroScaleChain(L, tRest)) { zeroQ++; continue; }
                var sv = slideVec(L, cam, dx, dy, tRest);
                tr = L.transform;   // 可能临时加过效果：属性重新取
                if (!sv) { if (zeroScaleChain(L, tRest)) zeroQ++; else edgeOn++; continue; }
                dx = sv[0]; dy = sv[1];
                var dz = L.threeDLayer ? (sv[2] || 0) : 0;
                if (tr.position.dimensionsSeparated) {
                    var px = tr.property("ADBE Position_0"), py = tr.property("ADBE Position_1");
                    var bx = px.valueAtTime(tRest, true), by = py.valueAtTime(tRest, true);
                    if (dx) { keySegments(px, [t0, t1], out ? [bx, bx + dx] : [bx + dx, bx], b); keyed.push(px); }
                    if (dy) { keySegments(py, [t0, t1], out ? [by, by + dy] : [by + dy, by], b); keyed.push(py); }
                    if (dz) { var pz = tr.property("ADBE Position_2"), bz = pz.valueAtTime(tRest, true); keySegments(pz, [t0, t1], out ? [bz, bz + dz] : [bz + dz, bz], b); keyed.push(pz); }
                } else {
                    p = tr.position; base = p.valueAtTime(tRest, true);
                    var moved = addVec(base, dz ? [dx, dy, dz] : [dx, dy]);
                    keySegments(p, [t0, t1], out ? [base, moved] : [moved, base], b); keyed.push(p);
                }
            } else if (a.kind === "rotate") {
                p = tr.property("ADBE Rotate Z"); base = p.valueAtTime(tRest, true);
                keySegments(p, [t0, t1], out ? [base, base + 90] : [base - 90, base], b); keyed.push(p);
            } else if (a.kind === "blur") {
                var fxs = L.property("ADBE Effect Parade");
                if (!fxs) continue;
                var blur = fxs.property("MH 模糊") || fxs.addProperty("ADBE Gaussian Blur 2");
                blur.name = "MH 模糊";
                p = fxs.property("MH 模糊").property(1);
                keySegments(p, [t0, t1], out ? [0, 40] : [40, 0], b);
            }
            for (var q = 0; q < keyed.length; q++) if (exprHides(keyed[q], t0, t1)) { hid++; break; }
            n++;
        }
        var names = { fade: "透明度", scale: "缩放", slide: "滑动", rotate: "旋转", blur: "模糊" };
        if (!n && zeroQ && !edgeOn) fail("选中图层的父级缩放是 0，画面上滑不动：把播放头移到父级显示出来的地方再试");
        if (!n && edgeOn) fail("选中图层的父级转到了侧面（X / Y 接近 90°），画面上往这个方向滑不动：先把父级转回来一点再试");
        if (!n && camsQ) fail("摄像机和灯光不能加这个动画：请选中其他图层");
        return "已添加" + names[a.kind] + (out ? "出场" : "入场") + "动画：" + n + " 个图层，" + (a.frames || 12) + " 帧" +
            skipNote([[hid, "图层的属性由表达式控制，加的关键帧被表达式盖住，画面上看不出来（可以撤销）"],
                [edgeOn, "图层的父级转到了侧面，画面上往这个方向滑不动，没加"], [zeroQ, "图层的父级缩放是 0，画面上滑不动，没加"], [camsQ, "摄像机 / 灯光没加"]]);
    };

    // —— 图层时间 ——
    T.splitLayer = function () {
        var comp = activeComp(), layers = needLayers(comp, 1), t = comp.time, n = 0;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (t <= L.inPoint || t >= L.outPoint) continue;
            var dup = L.duplicate();
            L.outPoint = t;
            dup.inPoint = t;
            n++;
        }
        if (!n) fail("播放头不在选中图层的范围内");
        return "已在播放头拆分 " + n + " 个图层";
    };

    T.toPlayhead = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1);
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            L.startTime += comp.time - (a.mods.alt ? L.outPoint : L.inPoint);
        }
        return a.mods.alt ? "已把出点对齐到播放头" : "已把入点对齐到播放头";
    };

    T.motionBlur = function () {
        var comp = activeComp(), layers = needLayers(comp, 1), on = !layers[0].motionBlur;
        for (var i = 0; i < layers.length; i++) { try { layers[i].motionBlur = on; } catch (e) {} }
        if (on) comp.motionBlur = true;
        return (on ? "已开启" : "已关闭") + "运动模糊：" + layers.length + " 个图层";
    };


    // —— 曲线：从选中的两个关键帧读出 cubic-bezier ——
    T.bezierRead = function () {
        var comp = activeComp(), props = selectedKeyedProps(comp);
        for (var i = 0; i < props.length; i++) {
            var p = props[i], ks = p.selectedKeys;
            var k1 = ks[0], k2 = ks.length > 1 ? ks[1] : ks[0] + 1;
            if (k2 > p.numKeys) continue;
            var dt = p.keyTime(k2) - p.keyTime(k1);
            var v1 = p.keyValue(k1), v2 = p.keyValue(k2), dv;
            if (typeof v1 === "number") dv = v2 - v1;
            else if (easeDims(p) === 1) {
                var s2 = 0;
                for (var d = 0; d < v1.length; d++) s2 += (v2[d] - v1[d]) * (v2[d] - v1[d]);
                dv = Math.sqrt(s2);
            } else {
                // 多维非空间属性：取变化最大的那一维
                var best = 0;
                for (var e = 0; e < v1.length; e++) if (Math.abs(v2[e] - v1[e]) > Math.abs(v2[best] - v1[best])) best = e;
                dv = v2[best] - v1[best];
            }
            if (!dt || !dv) continue;
            var avg = dv / dt;
            var o = p.keyOutTemporalEase(k1)[0], n = p.keyInTemporalEase(k2)[0];
            var x1 = o.influence / 100, x2 = 1 - n.influence / 100;
            var y1 = o.speed / avg * x1, y2 = 1 - n.speed / avg * (1 - x2);
            if (p.keyOutInterpolationType(k1) === KeyframeInterpolationType.LINEAR) { x1 = 1 / 3; y1 = 1 / 3; }
            if (p.keyInInterpolationType(k2) === KeyframeInterpolationType.LINEAR) { x2 = 2 / 3; y2 = 2 / 3; }
            var r = function (v) { return Math.round(v * 100) / 100; };
            return { msg: "已读取曲线", bezier: [r(x1), r(y1), r(x2), r(y2)] };
        }
        fail("请选中同一属性上两个数值不同的关键帧");
    };

    // —— 节拍：标记、吸附、按节拍排列 ——
    T.beatMarkers = function (a) {
        var comp = activeComp();
        var mk = a.target === "comp" ? comp.markerProperty : comp.layer(a.index).property("ADBE Marker");
        for (var i = 0; i < a.times.length; i++) {
            var mv = new MarkerValue(a.numbered ? String(i + 1) : "");
            try { mv.label = 2; } catch (e) {}
            mk.setValueAtTime(a.times[i], mv);
        }
        return "已添加 " + a.times.length + " 个节拍标记到" + (a.target === "comp" ? "合成" : "音频图层");
    };

    T.clearMarkers = function (a) {
        var comp = activeComp();
        var mk = a.target === "comp" ? comp.markerProperty : comp.layer(a.index).property("ADBE Marker");
        var n = mk.numKeys;
        for (var i = n; i >= 1; i--) mk.removeKey(i);
        return "已清除 " + n + " 个标记";
    };

    T.beatLayers = function (a) {
        var comp = activeComp(), sel = comp.selectedLayers, list = [], i;
        for (i = 0; i < sel.length; i++) if (sel[i].index !== a.index) list.push(sel[i]);
        if (!list.length) fail("请先选中要对齐节拍的图层（不包括音频图层）");
        var times = a.times;
        if (!times.length) fail("没有节拍");
        if (a.mode === "snap") {
            // 每个图层的入点吸附到最近的节拍
            for (i = 0; i < list.length; i++) {
                var best = times[0];
                for (var j = 1; j < times.length; j++) if (Math.abs(times[j] - list[i].inPoint) < Math.abs(best - list[i].inPoint)) best = times[j];
                list[i].startTime += best - list[i].inPoint;
            }
            return "已把 " + list.length + " 个图层吸附到最近的节拍";
        }
        // 按节拍排列：从播放头之后的第一个节拍开始，每隔 every 拍放一个图层；Alt 同时把出点剪到下一个位置
        var start = 0;
        while (start < times.length && times[start] < comp.time - comp.frameDuration / 2) start++;
        var every = Math.max(1, a.every || 1), placed = 0;
        for (i = 0; i < list.length; i++) {
            var k = start + i * every;
            if (k >= times.length) break;
            var L = list[i];
            L.startTime += times[k] - L.inPoint;
            if (a.mods && a.mods.alt && k + every < times.length) { try { L.outPoint = times[k + every]; } catch (e2) {} }
            placed++;
        }
        return "已按节拍排列 " + placed + " 个图层" + (placed < list.length ? "（节拍不够，剩下 " + (list.length - placed) + " 个没动）" : "");
    };

    // —— 解散预合成：把里面的图层放回当前合成，位置保持不变 ——
    function isNeutral(L, inner, comp) {
        var tr = L.transform;
        if (L.parent || L.threeDLayer) return false;
        var props = [tr.anchorPoint, tr.position, tr.scale, tr.property("ADBE Rotate Z")];
        for (var i = 0; i < props.length; i++) if (props[i].numKeys) return false;
        var a = tr.anchorPoint.value, p = tr.position.value, s = tr.scale.value;
        return Math.abs(a[0] - p[0]) < 0.01 && Math.abs(a[1] - p[1]) < 0.01 &&
            Math.abs(s[0] - 100) < 0.01 && Math.abs(s[1] - 100) < 0.01 &&
            Math.abs(tr.property("ADBE Rotate Z").value) < 0.01 &&
            inner.width === comp.width && inner.height === comp.height;
    }

    T.decompose = function (a) {
        var comp = activeComp(), sel = comp.selectedLayers, pre = null, i;
        for (i = 0; i < sel.length; i++) if (sel[i].source instanceof CompItem) { pre = sel[i]; break; }
        if (!pre) fail("请先选中一个预合成图层");
        var inner = pre.source, warn = [];
        if (pre.timeRemapEnabled) warn.push("时间重映射");
        if (pre.stretch !== 100) warn.push("时间伸缩");
        if (pre.property("ADBE Effect Parade").numProperties) warn.push("效果");
        if (pre.property("ADBE Mask Parade").numProperties) warn.push("蒙版");

        // 预合成图层本身有变换时，用一个空对象接住它，里面的图层挂上去，画面不变
        var carrier = null;
        if (!isNeutral(pre, inner, comp)) {
            carrier = comp.layers.addNull(comp.duration);
            carrier.name = uniqueLayerName(comp, pre.name + " 变换");
            var names = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"];
            for (i = 0; i < names.length; i++) {
                var from = pre.transform.property(names[i]), to = carrier.transform.property(names[i]);
                if (from.numKeys) for (var k = 1; k <= from.numKeys; k++) writeKey(to, from.keyTime(k), keyData(from, k), false);
                else to.setValue(from.value);
            }
            if (pre.parent) carrier.setParentWithJump(pre.parent);
            carrier.inPoint = pre.inPoint;
            carrier.outPoint = pre.outPoint;
        }
        var moved = [];
        for (i = inner.numLayers; i >= 1; i--) {
            inner.layer(i).copyToComp(comp);
            moved.unshift(comp.layer(1));
        }
        for (i = 0; i < moved.length; i++) {
            var L = moved[i];
            L.moveBefore(pre);
            L.startTime += pre.startTime;
            try {
                if (L.inPoint < pre.inPoint) L.inPoint = pre.inPoint;
                if (L.outPoint > pre.outPoint) L.outPoint = pre.outPoint;
            } catch (e) {}
            if (carrier && !L.parent) L.setParentWithJump(carrier);
        }
        if (carrier && moved.length) carrier.moveBefore(moved[0]);
        var name = pre.name;
        pre.remove();
        var removedItem = false;
        if (a.mods.alt && inner.usedIn.length === 0) { inner.remove(); removedItem = true; }
        return "已解散「" + name + "」：放回 " + moved.length + " 个图层" +
            (removedItem ? "，并删除了项目里的原合成" : "") +
            (warn.length ? "（预合成图层上的" + warn.join("、") + "没有带过来）" : "");
    };

    // —— 复制预合成：得到一份独立的副本，改它不影响原来的 ——
    function cloneComp(c, deep, done) {
        if (done[c.id]) return done[c.id];
        var d = c.duplicate();
        d.name = uniqueItemName(c.name.replace(/ 副本( \d+)?$/, "") + " 副本");
        done[c.id] = d;
        if (deep) {
            for (var i = 1; i <= d.numLayers; i++) {
                var L = d.layer(i);
                if (L.source instanceof CompItem) { try { L.replaceSource(cloneComp(L.source, true, done), false); } catch (e) {} }
            }
        }
        return d;
    }

    T.dupPrecomp = function (a) {
        var comp = activeComp(), sel = comp.selectedLayers, list = [], i;
        for (i = 0; i < sel.length; i++) if (sel[i].source instanceof CompItem) list.push(sel[i]);
        if (!list.length) fail("请先选中预合成图层");
        var done = {}, n = 0;
        for (i = 0; i < list.length; i++) {
            var L = list[i], copy = cloneComp(L.source, !!a.mods.alt, done);
            var target = a.mods.shift ? L : L.duplicate();
            target.replaceSource(copy, false);
            if (!a.mods.shift) target.name = copy.name;
            n++;
        }
        var comps = 0;
        for (var k in done) if (done.hasOwnProperty(k)) comps++;
        return (a.mods.shift ? "已把 " + n + " 个预合成图层换成独立副本" : "已复制 " + n + " 个预合成图层并使用独立副本") +
            (a.mods.alt ? "（连同里面嵌套的 " + (comps - n) + " 个合成）" : "");
    };

    // —— 智能重命名：按图层类型和内容起名 ——
    function layerKind(L) {
        if (L instanceof CameraLayer) return "摄像机";
        if (L instanceof LightLayer) return "灯光";
        if (L instanceof TextLayer) return "文字";
        if (L instanceof ShapeLayer) return "形状";
        if (L.nullLayer) return "空对象";
        if (L.adjustmentLayer) return "调整";
        var s = L.source;
        if (s instanceof CompItem) return "合成";
        if (s && s.mainSource instanceof SolidSource) return "纯色";
        if (s && s.mainSource && s.mainSource.isStill) return "图片";
        if (s && !s.hasVideo && s.hasAudio) return "音频";
        return "视频";
    }

    function layerLabel(L, kind) {
        try {
            if (kind === "文字") {
                var t = String(L.property("ADBE Text Properties").property("ADBE Text Document").value.text).replace(/[\r\n]+/g, " ");
                return t.length > 20 ? t.substr(0, 19) + "…" : t;
            }
            if (kind === "调整") { var fx = L.property("ADBE Effect Parade"); return fx.numProperties ? fx.property(1).name : "调整"; }
            if (kind === "形状") { var c = L.property("ADBE Root Vectors Group"); return c.numProperties ? c.property(1).name : "形状"; }
            if (kind === "合成" || kind === "纯色") return L.source.name;
            if (kind === "图片" || kind === "视频" || kind === "音频") {
                return File.decode(L.source.file ? L.source.file.name : L.source.name).replace(/\.[^.]+$/, "");
            }
        } catch (e) {}
        return kind === "空对象" ? "控制器" : kind;
    }

    T.smartRename = function (a) {
        var comp = activeComp(), list = [], i;
        if (a.mods.alt) for (i = 1; i <= comp.numLayers; i++) list.push(comp.layer(i));
        else list = needLayers(comp, 1);
        var used = {};
        for (i = 0; i < list.length; i++) {
            var L = list[i], kind = layerKind(L), name = layerLabel(L, kind);
            if (a.mods.shift) name = "[" + kind + "] " + name;
            var base = name, n = 2;
            while (used[name]) name = base + " " + (n++);
            used[name] = true;
            var locked = L.locked;
            L.locked = false;
            L.name = name;
            L.locked = locked;
        }
        return "已智能重命名 " + list.length + " 个图层";
    };

    // —— 首尾相接：选中图层一个接一个排开 ——
    T.chain = function (a) {
        var comp = activeComp(), sel = needLayers(comp, 2), list = [], i;
        for (i = 0; i < sel.length; i++) list.push(sel[i]);
        if (a.mods.shift) list.reverse();
        var t = Infinity;
        if (a.mods.alt) t = comp.time;
        else for (i = 0; i < list.length; i++) t = Math.min(t, list[i].inPoint);
        var gap = (a.gap || 0) * comp.frameDuration;
        for (i = 0; i < list.length; i++) {
            var L = list[i], locked = L.locked;
            L.locked = false;
            L.startTime += t - L.inPoint;
            t = L.outPoint + gap;
            L.locked = locked;
        }
        return "已首尾相接排列 " + list.length + " 个图层" + (a.gap ? "，间隔 " + a.gap + " 帧" : "");
    };

    // —— 样式：复制一个图层的效果（含关键帧）、变换和混合模式，粘贴到别的图层 ——
    function readEffectProps(group, withKeys, path, out) {
        for (var i = 1; i <= group.numProperties; i++) {
            var p;
            try { p = group.property(i); } catch (e) { continue; }
            var here = path.concat([i]);
            if (p.propertyType === PropertyType.PROPERTY) {
                var vt = p.propertyValueType;
                if (vt === PropertyValueType.NO_VALUE || vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.LAYER_INDEX || vt === PropertyValueType.MASK_INDEX) continue;
                var rec = { path: here, value: null, keys: null, expr: "" };
                try {
                    if (withKeys && p.numKeys) {
                        rec.keys = [];
                        for (var k = 1; k <= p.numKeys; k++) rec.keys.push(keyData(p, k));
                    } else rec.value = p.value;
                    if (p.canSetExpression && p.expressionEnabled) rec.expr = p.expression;
                } catch (e2) { continue; }
                out.push(rec);
            } else readEffectProps(p, withKeys, here, out);
        }
        return out;
    }

    function scaleEase(list, k) {
        if (!list || k === 1) return list;
        var out = [];
        for (var i = 0; i < list.length; i++) out.push(new KeyframeEase(list[i].speed / k, list[i].influence));
        return out;
    }

    T.styleCopy = function () {
        var comp = activeComp(), L = needLayers(comp, 1)[0];
        var fxg = L.property("ADBE Effect Parade"), effects = [], keys = 0, i, j;
        for (i = 1; i <= fxg.numProperties; i++) {
            var fx = fxg.property(i), props = readEffectProps(fx, true, [], []);
            for (j = 0; j < props.length; j++) if (props[j].keys) keys += props[j].keys.length;
            effects.push({ match: fx.matchName, name: fx.name, props: props, enabled: fx.enabled });
        }
        var tr = L.transform;
        $.global.MH_STYLE = {
            layer: L.name, inPoint: L.inPoint, duration: L.outPoint - L.inPoint, effects: effects, keys: keys,
            scale: tr.scale.value, rotation: tr.property("ADBE Rotate Z").value, opacity: tr.opacity.value,
            blend: L.blendingMode, motionBlur: L.motionBlur
        };
        return { msg: "已复制「" + L.name + "」的样式：" + effects.length + " 个效果，" + keys + " 个关键帧", layer: L.name, effects: effects.length, keys: keys };
    };

    T.stylePaste = function (a) {
        var st = $.global.MH_STYLE;
        if (!st) fail("还没有复制样式");
        var comp = activeComp(), sel = needLayers(comp, 1), n = 0, i, j, q;
        for (i = 0; i < sel.length; i++) {
            var L = sel[i];
            if (!isTransformable(L)) continue;
            // 关键帧时间映射：保持原来离入点的时间；「适配长度」时按新图层的长度等比例拉伸
            var len = L.outPoint - L.inPoint;
            var k = a.fit && st.duration > 0 && len > 0 ? len / st.duration : 1;
            var mapT = function (t) { return L.inPoint + (t - st.inPoint) * k; };
            if (a.effects) {
                var fxg = L.property("ADBE Effect Parade");
                if (a.replace) for (q = fxg.numProperties; q >= 1; q--) fxg.property(q).remove();
                for (j = 0; j < st.effects.length; j++) {
                    var src = st.effects[j], fx = fxg.addProperty(src.match);
                    try { fx.name = src.name; } catch (e) {}
                    for (q = 0; q < src.props.length; q++) {
                        var rec = src.props[q], p = fx;
                        try {
                            for (var d = 0; d < rec.path.length; d++) p = p.property(rec.path[d]);
                            if (rec.keys && a.keys) {
                                for (var kk = 0; kk < rec.keys.length; kk++) {
                                    var kd = rec.keys[kk], copy = {};
                                    for (var f in kd) if (kd.hasOwnProperty(f)) copy[f] = kd[f];
                                    copy.inE = scaleEase(kd.inE, k);
                                    copy.outE = scaleEase(kd.outE, k);
                                    writeKey(p, mapT(kd.t), copy, false);
                                }
                            } else if (rec.keys) {
                                p.setValue(rec.keys[0].v);
                            } else if (rec.value !== null) {
                                p.setValue(rec.value);
                            }
                            if (rec.expr) p.expression = rec.expr;
                        } catch (e3) {}
                    }
                    // 效果对象可能因为加属性失效，重新取一次再设开关
                    try { fxg.property(fxg.numProperties).enabled = src.enabled; } catch (e4) {}
                }
            }
            if (a.transform) {
                var sc = st.scale;
                if (L.threeDLayer && sc.length < 3) sc = [sc[0], sc[1], 100];
                L.transform.scale.setValue(sc);
                L.transform.property("ADBE Rotate Z").setValue(st.rotation);
            }
            if (a.blend) {
                L.blendingMode = st.blend;
                L.transform.opacity.setValue(st.opacity);
                try { L.motionBlur = st.motionBlur; } catch (e5) {}
            }
            n++;
        }
        return "已把「" + st.layer + "」的样式粘贴到 " + n + " 个图层" + (a.fit && a.keys ? "（关键帧已适配各图层长度）" : "");
    };

    // —— 效果收藏 ——
    T.applyEffect = function (a) {
        var comp = activeComp(), sel = comp.selectedLayers, targets = [], i;
        if (a.mods.alt || !sel.length) {
            var adj = comp.layers.addSolid([1, 1, 1], uniqueLayerName(comp, a.name || "调整图层"), comp.width, comp.height, comp.pixelAspect, comp.duration);
            adj.adjustmentLayer = true;
            if (sel.length) adj.moveBefore(topmost(sel));
            targets.push(adj);
        } else {
            for (i = 0; i < sel.length; i++) if (isTransformable(sel[i])) targets.push(sel[i]);
        }
        for (i = 0; i < targets.length; i++) {
            var fxg = targets[i].property("ADBE Effect Parade");
            if (!fxg.canAddProperty(a.match)) fail("这个图层不能添加「" + a.name + "」");
            fxg.addProperty(a.match);
        }
        return "已添加「" + a.name + "」" + (a.mods.alt || !sel.length ? "到新的调整图层" : "到 " + targets.length + " 个图层");
    };

    // —— 线框叠加：把图层边界、锚点、运动轨迹、摄像机信息做成真实图层，渲染时也看得到 ——
    var WIRE_TAG = "motionhub-wireframe";

    function isWire(L) { try { return L.comment === WIRE_TAG; } catch (e) { return false; } }

    function wireControl(comp) {
        for (var i = 1; i <= comp.numLayers; i++) if (isWire(comp.layer(i)) && comp.layer(i).name === "MH 线框控制") return comp.layer(i);
        var c = comp.layers.addNull(comp.duration);
        c.name = "MH 线框控制";
        c.comment = WIRE_TAG;
        c.label = 2;
        var fx = c.property("ADBE Effect Parade");
        var col = fx.addProperty("ADBE Color Control"); col.name = "线框颜色"; col.property(1).setValue([1, 0.349, 0, 1]);
        var w = fx.addProperty("ADBE Slider Control"); w.name = "线宽"; w.property(1).setValue(Math.max(1, Math.round(comp.height / 540)));
        var o = fx.addProperty("ADBE Slider Control"); o.name = "不透明度"; o.property(1).setValue(100);
        return c;
    }

    var CTRL = 'thisComp.layer("MH 线框控制")';

    function wireStroke(group, dashed) {
        var st = group.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Stroke");
        st.property("ADBE Vector Stroke Color").expression = CTRL + '.effect("线框颜色")(1)';
        st.property("ADBE Vector Stroke Width").expression = CTRL + '.effect("线宽")(1)';
        if (dashed) {
            try {
                var d = st.property("ADBE Vector Stroke Dashes").addProperty("ADBE Vector Stroke Dash 1");
                d.expression = CTRL + '.effect("线宽")(1) * 4';
            } catch (e) {}
        }
        return st;
    }

    function wirePath(root, name, expr, dashed) {
        var g = root.addProperty("ADBE Vector Group");
        g.name = name;
        var p = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");
        p.property("ADBE Vector Shape").expression = expr;
        wireStroke(g, dashed);
        return g;
    }

    function newWireShape(comp, name) {
        var S = comp.layers.addShape();
        S.name = name;
        S.comment = WIRE_TAG;
        S.label = 2;
        S.transform.anchorPoint.setValue([0, 0]);
        S.transform.position.setValue([0, 0]);
        return S;
    }

    T.wireframe = function (a) {
        var comp = activeComp(), o = a.opts || {}, i;
        var targets = [];
        if (a.mods.alt) { for (i = 1; i <= comp.numLayers; i++) targets.push(comp.layer(i)); }
        else targets = needLayers(comp, 1);
        var list = [], seen = {}, dup = 0;
        for (i = 0; i < targets.length; i++) {
            var T0 = targets[i];
            if (isWire(T0) || T0 instanceof CameraLayer || T0 instanceof LightLayer) continue;
            if (!a.mods.alt || T0.enabled) { if (seen[T0.name]) dup++; seen[T0.name] = true; list.push(T0); }
        }
        var ctrl = wireControl(comp), made = 0, top = comp.layer(1);
        var opacity = CTRL + '.effect("不透明度")(1)';
        for (i = 0; i < list.length; i++) {
            var L = list[i], ref = "thisComp.layer(" + q(L.name) + ")";
            var isNull = L.nullLayer;
            var S = newWireShape(comp, "MH 线框 · " + L.name);
            var root = S.property("ADBE Root Vectors Group");
            if (o.bounds !== false && !isNull) {
                wirePath(root, "边界框",
                    "var L = " + ref + ";\n" +
                    "var r = L.sourceRectAtTime(time, false);\n" +
                    "var c = [[r.left, r.top, 0], [r.left + r.width, r.top, 0], [r.left + r.width, r.top + r.height, 0], [r.left, r.top + r.height, 0]];\n" +
                    "var pts = [];\n" +
                    "for (var i = 0; i < 4; i++) { var v = L.toComp(c[i]); pts.push([v[0], v[1]]); }\n" +
                    "createPath(pts, [], [], true);", false);
            }
            if (o.anchor !== false) {
                wirePath(root, "锚点",
                    "var L = " + ref + ";\n" +
                    "var a = L.toComp(L.transform.anchorPoint);\n" +
                    "var s = " + CTRL + '.effect("线宽")(1) * 6;\n' +
                    "createPath([[a[0] - s, a[1]], [a[0] + s, a[1]], [a[0], a[1]], [a[0], a[1] - s], [a[0], a[1] + s]], [], [], false);", false);
            }
            if (o.path) {
                wirePath(root, "运动轨迹",
                    "var L = " + ref + ";\n" +
                    "var a = Math.max(L.inPoint, 0), b = Math.min(L.outPoint, thisComp.duration)" + (o.grow ? ", b = Math.min(b, time)" : "") + ";\n" +
                    "var step = Math.max(thisComp.frameDuration, (b - a) / 300);\n" +
                    "var pts = [];\n" +
                    "for (var t = a; t <= b + 0.0001; t += step) { var v = L.toComp(L.transform.anchorPoint.valueAtTime(t), t); pts.push([v[0], v[1]]); }\n" +
                    "if (pts.length < 2) pts = [[0, 0], [0, 0]];\n" +
                    "createPath(pts, [], [], false);", true);
            }
            // 图层不显示的时候，线框也隐藏（轨迹除外）
            S.transform.opacity.expression = (o.path && o.grow === false ? opacity : "var L = " + ref + ";\n(L.active ? 1 : 0) * " + opacity);
            S.moveBefore(top);
            if (o.labels !== false) {
                var tx = comp.layers.addText(L.name);
                tx.name = "MH 标签 · " + L.name;
                tx.comment = WIRE_TAG;
                var doc = tx.property("ADBE Text Properties").property("ADBE Text Document").value;
                doc.fontSize = Math.max(12, Math.round(comp.height / 60));
                doc.fillColor = [1, 0.349, 0];
                doc.applyFill = true;
                doc.applyStroke = false;
                doc.justification = ParagraphJustification.LEFT_JUSTIFY;
                tx.property("ADBE Text Properties").property("ADBE Text Document").setValue(doc);
                tx.transform.anchorPoint.setValue([0, 0]);
                tx.transform.position.expression =
                    "var L = " + ref + ";\n" +
                    "var r = L.sourceRectAtTime(time, false);\n" +
                    "var v = L.toComp([r.left, r.top, 0]);\n" +
                    "[v[0], v[1] - " + CTRL + '.effect("线宽")(1) * 4]';
                tx.transform.opacity.expression = "var L = " + ref + ";\n(L.active ? 1 : 0) * " + opacity;
                tx.moveBefore(S);
            }
            made++;
        }
        var has3D = false;
        for (i = 1; i <= comp.numLayers; i++) if (comp.layer(i) instanceof CameraLayer || comp.layer(i).threeDLayer) has3D = true;
        var extras = [];
        if (o.grid && has3D && !findWire(comp, "MH 地面网格")) { addGrid(comp); extras.push("地面网格"); }
        if (o.hud && !findWire(comp, "MH 摄像机信息")) { addHud(comp); extras.push("摄像机信息"); }
        if (o.safe && !findWire(comp, "MH 安全框")) { addSafe(comp); extras.push("安全框"); }
        ctrl.moveToBeginning();
        return "已为 " + made + " 个图层生成线框" + (extras.length ? "，并加上" + extras.join("、") : "") +
            "。颜色、线宽和不透明度在「MH 线框控制」的效果控件里改" + (dup ? "（有 " + dup + " 个图层重名，线框会跟着第一个同名图层）" : "");
    };

    function findWire(comp, name) {
        for (var i = 1; i <= comp.numLayers; i++) if (isWire(comp.layer(i)) && comp.layer(i).name === name) return comp.layer(i);
        return null;
    }

    // 3D 地面网格：放在画面底部所在的水平面上，跟着摄像机一起透视
    function addGrid(comp) {
        var S = comp.layers.addShape();
        S.name = "MH 地面网格";
        S.comment = WIRE_TAG;
        S.threeDLayer = true;
        S.transform.anchorPoint.setValue([0, 0, 0]);
        S.transform.position.setValue([comp.width / 2, comp.height, 0]);
        S.transform.property("ADBE Orientation").setValue([90, 0, 0]);
        var size = Math.max(comp.width, comp.height) * 4, n = 20, root = S.property("ADBE Root Vectors Group");
        for (var dir = 0; dir < 2; dir++) {
            var g = root.addProperty("ADBE Vector Group");
            g.name = dir ? "纵线" : "横线";
            var rect = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
            rect.property("ADBE Vector Rect Size").setValue(dir ? [0.01, size] : [size, 0.01]);
            rect.property("ADBE Vector Rect Position").setValue(dir ? [-size / 2, 0] : [0, -size / 2]);
            wireStroke(g, false);
            var rep = g.property("ADBE Vectors Group").addProperty("ADBE Vector Filter - Repeater");
            rep.property("ADBE Vector Repeater Copies").setValue(n + 1);
            rep.property("ADBE Vector Repeater Transform").property("ADBE Vector Repeater Position").setValue(dir ? [size / n, 0] : [0, size / n]);
        }
        S.transform.opacity.expression = CTRL + '.effect("不透明度")(1) * 0.45';
        S.moveToEnd();
        try { S.moveBefore(comp.layer(comp.numLayers)); } catch (e) {}
    }

    function addHud(comp) {
        var tx = comp.layers.addText("CAM");
        tx.name = "MH 摄像机信息";
        tx.comment = WIRE_TAG;
        var src = tx.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = src.value;
        doc.fontSize = Math.max(12, Math.round(comp.height / 54));
        doc.fillColor = [1, 0.349, 0];
        doc.applyFill = true;
        doc.justification = ParagraphJustification.LEFT_JUSTIFY;
        src.setValue(doc);
        src.expression =
            "function f(v) { return (v >= 0 ? \" \" : \"\") + v.toFixed(0); }\n" +
            "var out = \"TC  \" + timeToTimecode(time);\n" +
            "try {\n" +
            "  var c = thisComp.activeCamera;\n" +
            "  var p = c.toWorld([0, 0, 0]);\n" +
            "  out += \"\\rCAM  X\" + f(p[0]) + \"  Y\" + f(p[1]) + \"  Z\" + f(p[2]) + \"\\rZOOM \" + c.zoom.toFixed(0);\n" +
            "} catch (e) { out += \"\\r没有摄像机\"; }\n" +
            "out;";
        tx.transform.anchorPoint.setValue([0, 0]);
        tx.transform.position.setValue([Math.round(comp.width * 0.04), Math.round(comp.height * 0.05)]);
        tx.transform.opacity.expression = CTRL + '.effect("不透明度")(1)';
    }

    function addSafe(comp) {
        var S = newWireShape(comp, "MH 安全框");
        var root = S.property("ADBE Root Vectors Group"), w = comp.width, h = comp.height;
        var frames = [[0.9, false], [0.8, true]];
        for (var i = 0; i < frames.length; i++) {
            var s = frames[i], g = root.addProperty("ADBE Vector Group");
            g.name = s[1] ? "字幕安全框" : "动作安全框";
            var r = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
            r.property("ADBE Vector Rect Size").setValue([w * s[0], h * s[0]]);
            r.property("ADBE Vector Rect Position").setValue([w / 2, h / 2]);
            wireStroke(g, s[1]);
        }
        wirePath(root, "中心十字", "var w = thisComp.width, h = thisComp.height, s = Math.min(w, h) * 0.03;\ncreatePath([[w / 2 - s, h / 2], [w / 2 + s, h / 2], [w / 2, h / 2], [w / 2, h / 2 - s], [w / 2, h / 2 + s]], [], [], false);", false);
        S.transform.opacity.expression = CTRL + '.effect("不透明度")(1) * 0.6';
    }

    T.wireClear = function () {
        var comp = activeComp(), n = 0;
        for (var i = comp.numLayers; i >= 1; i--) {
            var L = comp.layer(i);
            if (isWire(L)) { L.locked = false; L.remove(); n++; }
        }
        return n ? "已清除 " + n + " 个线框图层" : "这个合成里没有线框图层";
    };

    T.wireStyle = function (a) {
        var comp = activeComp(), c = findWire(comp, "MH 线框控制");
        if (!c) fail("先生成线框");
        var fx = c.property("ADBE Effect Parade");
        if (a.color) fx.property("线框颜色").property(1).setValue(a.color);
        return "已更新线框颜色";
    };

    // —— 代码片段 ——
    T.applyExpr = function (a) {
        var comp = activeComp(), props = selectedExprProps(comp);
        for (var i = 0; i < props.length; i++) {
            props[i].expression = a.mods.alt && props[i].expression ? props[i].expression + "\n" + a.code : a.code;
        }
        return "已应用表达式「" + (a.name || "") + "」：" + props.length + " 个属性";
    };

    T.runCode = function (a) {
        (new Function(a.code))();
        return "已执行「" + (a.name || "脚本") + "」";
    };

    // —— 表达式 ——
    function setExpr(props, code) {
        for (var i = 0; i < props.length; i++) props[i].expression = code;
        return props.length;
    }

    T.wiggle = function (a) {
        var comp = activeComp(), props = selectedExprProps(comp);
        if (!a.mods.alt) return "已添加抖动：" + setExpr(props, "wiggle(3, 30);") + " 个属性";
        // Alt：在图层上加「抖动频率 / 抖动幅度」滑块并关联
        var paths = [], i;
        for (i = 0; i < props.length; i++) paths.push(propPath(props[i]));
        var done = {};
        for (i = 0; i < paths.length; i++) {
            var L = paths[i].layer;
            if (done[L.index]) continue;
            done[L.index] = true;
            var fx = L.property("ADBE Effect Parade");
            if (!fx.property("抖动频率")) {
                var f = fx.addProperty("ADBE Slider Control"); f.name = "抖动频率"; f.property(1).setValue(3);
            }
            if (!fx.property("抖动幅度")) {
                var m = fx.addProperty("ADBE Slider Control"); m.name = "抖动幅度"; m.property(1).setValue(30);
            }
        }
        for (i = 0; i < paths.length; i++) {
            resolvePath(paths[i]).expression = 'wiggle(effect("抖动频率")(1), effect("抖动幅度")(1));';
        }
        return "已添加抖动和控制滑块：" + paths.length + " 个属性";
    };

    T.loop = function (a) {
        var comp = activeComp(), props = selectedExprProps(comp);
        var type = "cycle", label = "循环";
        if (a.mods.alt) { type = "pingpong"; label = "往返"; }
        else if (a.mods.shift) { type = "continue"; label = "延续"; }
        else if (a.mods.ctrl) { type = "offset"; label = "累加"; }
        var n = setExpr(props, 'loopOut("' + type + '");');
        return "已添加" + label + " loopOut(\"" + type + "\")：" + n + " 个属性" + keysNote(props, 2, "loopOut 要至少 2 个关键帧才会动");
    };

    // 加了表达式但属性上的关键帧不够，看不出效果：说一声（不拦着，先加表达式再打关键帧也是常见做法）
    function keysNote(props, need, why) {
        var few = 0;
        for (var i = 0; i < props.length; i++) { try { if (props[i].numKeys < need) few++; } catch (e) {} }
        if (!few) return "";
        return "。" + (few === props.length && few === 1 ? "这个属性" : few + " 个属性") + "关键帧不够：" + why;
    }

    T.bounce = function (a) {
        var comp = activeComp(), props = selectedExprProps(comp);
        var amp = a.mods.alt ? 0.1 : 0.06, freq = a.mods.alt ? 3 : 2.5, decay = a.mods.alt ? 4 : 6;
        var code =
            "amp = " + amp + "; freq = " + freq + "; decay = " + decay + ";\n" +
            "n = 0;\n" +
            "if (numKeys > 0) { n = nearestKey(time).index; if (key(n).time > time) n--; }\n" +
            "t = (n == 0) ? 0 : time - key(n).time;\n" +
            "if (n > 0 && t < 1) {\n" +
            "  v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);\n" +
            "  value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n" +
            "} else { value; }";
        return "已添加" + (a.mods.alt ? "强" : "") + "弹性：" + setExpr(props, code) + " 个属性" + keysNote(props, 2, "弹性要至少 2 个关键帧，在最后一个之后回弹");
    };

    T.clearExpr = function (a) {
        var comp = activeComp(), n = 0;
        if (a.mods.alt) {
            var layers = needLayers(comp, 1);
            for (var i = 0; i < layers.length; i++) {
                walkProps(layers[i], function (p) {
                    try { if (p.canSetExpression && p.expression !== "") { p.expression = ""; n++; } } catch (e) {}
                });
            }
            return "已清除选中图层上的全部表达式：" + n + " 个";
        }
        return "已清除表达式：" + setExpr(selectedExprProps(comp), "") + " 个属性";
    };

    // —— 合成：复制并更新表达式里的合成名 ——
    function replaceCompRefs(expr, oldName, newName) {
        var out = expr.split('comp("' + oldName + '")').join('comp("' + newName + '")');
        return out.split("comp('" + oldName + "')").join("comp('" + newName + "')");
    }

    T.dupComp = function (a) {
        var comps = [], sel = app.project.selection, i;
        for (i = 0; i < sel.length; i++) if (sel[i] instanceof CompItem) comps.push(sel[i]);
        if (!comps.length && app.project.activeItem instanceof CompItem) comps.push(app.project.activeItem);
        if (!comps.length) fail("请先在项目面板选中合成，或打开一个合成");
        var fixed = 0, last = null;
        for (i = 0; i < comps.length; i++) {
            var src = comps[i], dup = src.duplicate();
            dup.name = uniqueItemName(src.name + " 副本");
            for (var l = 1; l <= dup.numLayers; l++) {
                walkProps(dup.layer(l), function (p) {
                    try {
                        if (p.canSetExpression && p.expression.indexOf(src.name) !== -1) {
                            var ne = replaceCompRefs(p.expression, src.name, dup.name);
                            if (ne !== p.expression) { p.expression = ne; fixed++; }
                        }
                    } catch (e) {}
                });
            }
            last = dup;
        }
        if (a.mods.alt && last) last.openInViewer();
        return "已复制 " + comps.length + " 个合成，更新了 " + fixed + " 处表达式引用";
    };

    // —— 颜色：收集选中图层（含图层样式）里所有不重复的颜色到控制器 ——
    function toHex(c) {
        var s = "#";
        for (var i = 0; i < 3; i++) {
            var h = Math.round(Math.max(0, Math.min(1, c[i])) * 255).toString(16);
            s += h.length < 2 ? "0" + h : h;
        }
        return s.toUpperCase();
    }

    T.collectColors = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), colors = [], byHex = {}, i;
        for (i = 0; i < layers.length; i++) {
            (function (L) {
                walkProps(L, function (p, idx) {
                    try {
                        if (p.propertyValueType !== PropertyValueType.COLOR) return;
                        if (p.numKeys > 0 || !p.canSetExpression || (p.expressionEnabled && p.expression !== "")) return;
                        var hx = toHex(p.value);
                        if (!byHex[hx]) { byHex[hx] = { hex: hx, value: p.value, uses: [] }; colors.push(byHex[hx]); }
                        byHex[hx].uses.push({ layer: L, idx: idx });
                    } catch (e) {}
                });
            })(layers[i]);
        }
        if (!colors.length) fail("选中的图层里没有找到可收集的颜色（已跳过带关键帧或表达式的颜色）");

        var ctrl = comp.layers.addNull();
        ctrl.name = uniqueLayerName(comp, "颜色控制器");
        ctrl.label = 2;
        ctrl.moveBefore(topmost(layers));
        var fxGroup = ctrl.property("ADBE Effect Parade");
        for (i = 0; i < colors.length; i++) {
            var fx = fxGroup.addProperty("ADBE Color Control");
            fx.name = "颜色 " + (i + 1) + " " + colors[i].hex;
            fx.property(1).setValue(colors[i].value);
            colors[i].fxName = fx.name;
        }
        var linked = 0;
        if (!a.mods.alt) {
            for (i = 0; i < colors.length; i++) {
                for (var u = 0; u < colors[i].uses.length; u++) {
                    try {
                        resolvePath(colors[i].uses[u]).expression =
                            'thisComp.layer("' + ctrl.name + '").effect("' + colors[i].fxName + '")(1)';
                        linked++;
                    } catch (e) {}
                }
            }
        }
        return "收集到 " + colors.length + " 种颜色" + (a.mods.alt ? "（未关联）" : "，已关联 " + linked + " 处");
    };

    // =====================================================================
    // 脚本库
    // =====================================================================
    // 建不了文件夹时返回 null，不抛异常；需要文件夹的地方用 needFolder() 给出明确提示
    function ensureFolder(f) {
        try {
            if (!f.exists) {
                if (f.parent && !f.parent.exists && !ensureFolder(f.parent)) return null;
                f.create();
            }
        } catch (e) { return null; }
        return f.exists ? f : null;
    }
    function needFolder(f, what) {
        var r = ensureFolder(f);
        if (!r) fail("没法创建" + (what || "文件夹") + "：" + f.fsName + "。" + (canWriteFiles()
            ? "检查这个位置是否可写，或在设置页「更换文件夹」换一个位置"
            : "先在 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」"));
        return r;
    }
    function listFiles(folder, mask) {
        var r = null;
        try { r = mask ? folder.getFiles(mask) : folder.getFiles(); } catch (e) {}
        return r || [];
    }

    function libPath() { return state.libPath || (Folder.myDocuments.fsName + "/MotionHub/Library"); }
    function libRoot() { return needFolder(new Folder(libPath()), "脚本库文件夹"); }

    // =====================================================================
    // 不覆盖任何用户文件：同名同内容 → 算已经有了；同名不同内容 → 新的另起名字，两个都保留
    // =====================================================================
    function readBinary(f) {
        var s = null;
        try {
            f.encoding = "BINARY";
            // open() 读到 BOM 会自己改编码并跳过 BOM：打开后再设一次 BINARY、回到开头，读到的才是原始字节
            if (f.open("r")) { f.encoding = "BINARY"; f.seek(0, 0); s = f.read(); f.close(); }
        } catch (e) { try { f.close(); } catch (e1) {} s = null; }
        return s;
    }
    function sameContent(a, b) {
        try { if (a.length !== b.length) return false; } catch (e) { return false; }
        var x = readBinary(a), y = readBinary(b);
        return x !== null && y !== null && x === y;
    }
    // 弹跳.jsx → 弹跳 (2).jsx → 弹跳 (3).jsx …（name 是解码后的文件名）沿着这串名字往下找：
    // 遇到 isSame(已有的文件) 为真 → {file: 那个文件, same: true}；都不是 → {file: 第一个空着的名字, same: false}
    // first = 第一个名字就是空着的（没有改名）：用它判断 new / renamed，不再拿解码后的名字比（名字里本来就有 %20 时会比错）
    function findPlace(folder, name, isSame) {
        var m = /^(.*?)(\.[^.]*)?$/.exec(name), base = m[1], ext = m[2] || "";
        var f = new File(folder.fsName + "/" + name), n = 2;
        while (f.exists) {
            if (isSame && isSame(f)) return { file: f, same: true };
            f = new File(folder.fsName + "/" + base + " (" + n + ")" + ext);
            n++;
        }
        // 编号中间有空缺（比如删掉过「弹跳.jsx」，「弹跳 (2).jsx」还在）：再按文件夹列表把后面的编号副本也比一遍
        if (isSame) {
            var lb = base.toLowerCase(), le = ext.toLowerCase(), items = listFiles(folder);
            for (var i = 0; i < items.length; i++) {
                if (items[i] instanceof Folder) continue;
                var lo = File.decode(items[i].name).toLowerCase();
                if (lo.length <= lb.length + le.length || lo.substring(0, lb.length) !== lb || lo.substring(lo.length - le.length) !== le) continue;
                if (!/^ \(\d+\)$/.test(lo.substring(lb.length, lo.length - le.length))) continue;
                if (isSame(items[i])) return { file: items[i], same: true };
            }
        }
        return { file: f, same: false, first: n === 2 };
    }
    function freeFile(folder, name) { return findPlace(folder, name, null).file; }
    // Windows / macOS 的磁盘默认不分大小写：new File(".../Bounce.JSX") 也能找到 bounce.jsx，但 fsName 还是 Bounce.JSX。
    // 换成目录里真实的那一项，key 才和 scan 报告的一致。先找完全同名的：大小写敏感的磁盘上不会认错文件
    function onDisk(folder, f) {
        var items = listFiles(folder), name = File.decode(f.name), want = name.toLowerCase(), hit = null;
        for (var i = 0; i < items.length; i++) {
            if (items[i] instanceof Folder) continue;
            var nm = File.decode(items[i].name);
            if (nm === name) return items[i];
            if (!hit && nm.toLowerCase() === want) hit = items[i];
        }
        return hit || f;
    }
    // 把 src 放进 folder，不覆盖：返回 {file, state}，state = new / exists（库里已经有内容一样的，没复制）/ renamed（另起了名字）
    // 内容一样的可能就是同名文件，也可能是以前另起名字存下的「弹跳 (2).jsx」
    function placeInto(src, folder) {
        var name = File.decode(src.name), dest = new File(folder.fsName + "/" + name);
        if (dest.fsName === src.fsName) return { file: onDisk(folder, dest), state: "exists" };
        var p = findPlace(folder, name, function (d) { return sameContent(src, d); });
        if (p.same) return { file: onDisk(folder, p.file), state: "exists" };
        dest = p.file;
        if (!src.copy(dest.fsName)) {
            // dest 刚确认是空着的名字：复制到一半留下的残缺文件可以放心删掉，重试时还能用原来的名字
            var why = src.error;
            try { if (dest.exists) dest.remove(); } catch (e) {}
            fail("没能复制「" + name + "」（" + why + "）：检查脚本库文件夹是否可写");
        }
        return p.first ? { file: dest, state: "new" } : { file: dest, state: "renamed", from: name };
    }
    // 添加 / 拖入的结果说明
    function placedMsg(n, renamed, existing) {
        var msg = n ? "已添加 " + n + " 个文件" : "";
        var i, parts = [];
        for (i = 0; i < renamed.length; i++) parts.push("「" + renamed[i].from + "」库里已经有一个内容不同的，新的存为「" + renamed[i].to + "」");
        if (parts.length) msg += "。" + parts.join("；") + "，两个都保留了";
        if (existing) msg += (msg ? "。" : "") + existing + " 个已经在库里（内容完全一样），没有重复添加";
        return msg || "没有添加任何文件：选中的文件都不存在了";
    }

    // 返回 {copied, existing}：真正复制了几个文件、几个已经存在被跳过
    function copyFolder(src, dst, count) {
        count = count || { copied: 0, existing: 0 };
        needFolder(dst);
        var items = listFiles(src);
        for (var i = 0; i < items.length; i++) {
            var target = dst.fsName + "/" + File.decode(items[i].name);
            if (items[i] instanceof Folder) copyFolder(items[i], new Folder(target), count);
            else if (new File(target).exists) count.existing++;
            else if (items[i].copy(target)) count.copied++;
        }
        return count;
    }

    function readMeta(file, cat, root) {
        var base = File.decode(file.name);
        var ext = base.substring(base.lastIndexOf(".") + 1).toLowerCase();
        var it = {
            path: file.fsName,
            key: file.fsName.substring(root.fsName.length).replace(/\\/g, "/"),
            name: base.substring(0, base.lastIndexOf(".")),
            file: base, cat: cat, ext: ext, desc: "", author: "",
            type: ext === "ffx" ? "预设" : (ext === "jsxbin" ? "加密脚本" : "脚本")
        };
        if (ext === "jsx") {
            try {
                file.encoding = "UTF-8";
                if (file.open("r")) {
                    var head = file.read(4000);
                    file.close();
                    var m;
                    if ((m = head.match(/@name[ \t]+([^\r\n*]+)/))) it.name = m[1].replace(/\s+$/, "");
                    if ((m = head.match(/@desc(?:ription)?[ \t]+([^\r\n*]+)/))) it.desc = m[1].replace(/\s+$/, "");
                    if ((m = head.match(/@author[ \t]+([^\r\n*]+)/))) it.author = m[1].replace(/\s+$/, "");
                    if (/instanceof\s+Panel/.test(head)) it.type = "面板";
                }
            } catch (e) {}
        }
        return it;
    }

    function scanDir(dir, cat, out, depth, root) {
        var items = listFiles(dir);
        for (var i = 0; i < items.length; i++) {
            var f = items[i], nm = File.decode(f.name);
            if (f instanceof Folder) {
                if (depth < 3 && nm.charAt(0) !== "_" && nm.charAt(0) !== ".") scanDir(f, depth === 0 ? nm : cat, out, depth + 1, root);
            } else if (EXT_RE.test(nm)) {
                out.push(readMeta(f, cat, root));
            }
        }
    }

    function categories() {
        var list = [], dirs = listFiles(libRoot());
        for (var i = 0; i < dirs.length; i++) {
            var nm = File.decode(dirs[i].name);
            if (dirs[i] instanceof Folder && nm.charAt(0) !== "_" && nm.charAt(0) !== ".") list.push(nm);
        }
        list.sort();
        return list;
    }

    function canWriteFiles() {
        try {
            return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1;
        } catch (e) { return true; }
    }

    function userPanelsFolder() {
        var v = app.version.split(".");
        var ver = v[0] + "." + parseInt(v[1], 10);
        var base = IS_WIN
            ? Folder.userData.fsName + "/Adobe/After Effects/"
            : Folder("~/Library/Preferences/Adobe/After Effects/").fsName + "/";
        return new Folder(base + ver + "/Scripts/ScriptUI Panels");
    }

    var LIB = {};

    LIB.init = function (a) {
        if (a.libPath && !state.libPath) state.libPath = a.libPath;
        var root = ensureFolder(new Folder(libPath()));
        // 文件夹建不了时也用 Folder 的 fsName（Windows 上是统一的 \ 写法），和 loadSnippets 报告的 libPath 一致，面板可以直接比较
        return { libPath: root ? root.fsName : new Folder(libPath()).fsName, libReady: !!root, version: VERSION, ae: app.version, canWrite: canWriteFiles(), os: IS_WIN ? "win" : "mac" };
    };

    LIB.scan = function () {
        var root = libRoot(), out = [];
        scanDir(root, "未分类", out, 0, root);
        out.sort(function (x, y) {
            if (x.cat !== y.cat) return x.cat < y.cat ? -1 : 1;
            return x.name < y.name ? -1 : (x.name > y.name ? 1 : 0);
        });
        return { items: out, categories: categories(), libPath: root.fsName };
    };

    // 脚本库里有没有任何脚本 / 预设（和 scanDir 一样跳过 _ 和 . 开头的文件夹）
    function hasAnyScript(dir, depth) {
        var items = listFiles(dir);
        for (var i = 0; i < items.length; i++) {
            var f = items[i], nm = File.decode(f.name);
            if (f instanceof Folder) {
                if (depth < 3 && nm.charAt(0) !== "_" && nm.charAt(0) !== "." && hasAnyScript(f, depth + 1)) return true;
            } else if (EXT_RE.test(nm)) return true;
        }
        return false;
    }

    // a.auto = 启动时自动导入：脚本库里已经有脚本就不导，用户删掉的示例不会被导回来。
    // 设置页的「导入示例」不带 auto，照常补齐缺的示例
    LIB.importSamples = function (a) {
        if (!EXT_ROOT) fail("找不到插件目录");
        var src = new Folder(EXT_ROOT.fsName + "/library_seed");
        if (!src.exists) fail("没有找到示例脚本文件夹");
        var root = libRoot();
        if (a && a.auto && hasAnyScript(root, 0)) return { copied: 0, existing: 0, skipped: true, msg: "脚本库里已经有脚本，没有自动导入示例" };
        var n = copyFolder(src, root);
        return {
            copied: n.copied, existing: n.existing,
            msg: n.copied ? "已导入 " + n.copied + " 个示例脚本" : (n.existing ? "示例脚本已经在脚本库里了" : "没有导入任何示例脚本：检查脚本库文件夹是否可写")
        };
    };

    LIB.pickFiles = function () {
        var filter = IS_WIN
            ? "AE 脚本和预设:*.jsx;*.jsxbin;*.ffx,所有文件:*.*"
            : function (f) { return f instanceof Folder || EXT_RE.test(File.decode(f.name)); };
        var files = File.openDialog("选择要添加的脚本 / 预设（可多选）", filter, true);
        if (!files) return { files: [] };
        if (!(files instanceof Array)) files = [files];
        var out = [];
        for (var i = 0; i < files.length; i++) out.push({ path: files[i].fsName, name: File.decode(files[i].name) });
        return { files: out };
    };

    LIB.install = function (a) {
        if (!canWriteFiles()) fail("请先在 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」");
        var root = libRoot(), target = root;
        var cat = (a.cat || "").replace(/^\s+|\s+$/g, "").replace(/[\\\/:*?"<>|]/g, "_");
        if (cat && cat !== "未分类") target = needFolder(new Folder(root.fsName + "/" + cat), "分类文件夹");
        var keys = [], panels = 0, panelSkip = [], panelFail = [], renamed = [], existing = 0, added = 0;
        for (var i = 0; i < a.paths.length; i++) {
            var f = new File(a.paths[i]);
            if (!f.exists) continue;
            var put = placeInto(f, target);
            if (put.state === "exists") existing++; else added++;
            if (put.state === "renamed") renamed.push({ from: put.from, to: File.decode(put.file.name) });
            keys.push(put.file.fsName.substring(root.fsName.length).replace(/\\/g, "/"));
            if (a.toPanels && /\.(jsx|jsxbin)$/i.test(f.name)) {
                // ScriptUI Panels 里的同名文件可能是用户自己装的别的面板：不覆盖
                var pf = needFolder(userPanelsFolder(), "ScriptUI Panels 文件夹");
                var pd = new File(pf.fsName + "/" + File.decode(f.name));
                if (pd.exists && !sameContent(f, pd)) panelSkip.push(File.decode(f.name));
                else if (pd.exists || f.copy(pd.fsName)) panels++;
                else {
                    // pd 原来不存在：复制失败留下的残缺文件删掉，免得 AE 下次启动时加载半个面板
                    panelFail.push("「" + File.decode(f.name) + "」（" + f.error + "）");
                    try { if (pd.exists) pd.remove(); } catch (e) {}
                }
            }
        }
        var msg = placedMsg(added, renamed, existing);
        if (panels) msg += "。" + panels + " 个已装到 ScriptUI Panels（重启 AE 生效）";
        if (panelSkip.length) msg += "。没有覆盖 ScriptUI Panels 里内容不同的「" + panelSkip.join("」「") + "」：要换成新版，点设置页的「ScriptUI Panels」打开文件夹，删掉旧文件后再添加一次";
        if (panelFail.length) msg += "。" + panelFail.join("、") + "没能装到 ScriptUI Panels：点设置页的「ScriptUI Panels」打开文件夹，检查它是否可写后再添加一次";
        return { keys: keys, renamed: renamed, existing: existing, msg: msg };
    };

    LIB.run = function (a) {
        var f = new File(a.path);
        if (!f.exists) fail("文件不存在，请刷新脚本库");
        if (/\.ffx$/i.test(f.name)) {
            var comp = activeComp(), layers = needLayers(comp, 1);
            // applyPreset 本身就作用于合成里所有选中的图层：只调用一次，否则 3 个图层会各加 3 份
            app.beginUndoGroup("MotionHub：应用预设");
            try {
                layers[0].applyPreset(f);
            } finally {
                app.endUndoGroup();
            }
            return "已对 " + layers.length + " 个图层应用预设";
        }
        $.evalFile(f);
        return "已运行：" + File.decode(f.name);
    };

    // 缓动滑块松手时直接应用：选中了关键帧才应用，整次只开一个撤销组；
    // 没选中就什么都不做——不报错，也不在「编辑 → 撤销」里留下空记录
    LIB.easeIfKeys = function (a) {
        var c = null;
        try { c = app.project.activeItem; } catch (e) {}
        if (!(c && c instanceof CompItem)) return { applied: false };
        if (!selectedKeyedProps(c).length) return { applied: false };
        var msg;
        app.beginUndoGroup("MotionHub：缓动");
        try { msg = T.ease(a); } finally { app.endUndoGroup(); }
        return { applied: true, msg: msg };
    };

    LIB.reveal = function (a) {
        var f = a.path ? new File(a.path) : null;
        (f && f.exists ? f.parent : libRoot()).execute();
        return "";
    };

    LIB.remove = function (a) {
        var f = new File(a.path);
        if (!f.exists) fail("文件不存在");
        var root = libRoot(), trashPath = root.fsName + "/_已移除", where = "_已移除";
        // 列表可能是旧的：脚本库在别的面板换过，这个面板还列着原来那个库里的文件。不在当前库里的一律不动。
        // 路径前缀不分大小写比较，前缀后面必须紧跟路径分隔符；先去掉根目录末尾的分隔符，D:\ 这样的盘符根目录也适用
        var rp = root.fsName.replace(/[\\\/]+$/, ""), fp = f.fsName;
        if (!(fp.length > rp.length && fp.substring(0, rp.length).toLowerCase() === rp.toLowerCase() && /[\\\/]/.test(fp.charAt(rp.length))))
            fail("没能移除「" + File.decode(f.name) + "」：它不在当前脚本库「" + root.fsName + "」里（脚本库在别的面板换过）。列表已经刷新，重新选择要移除的脚本");
        // 原来在哪个分类，就放进 _已移除 里的同名子文件夹，方便找回
        var rel = f.parent.fsName.substring(root.fsName.length).replace(/\\/g, "/").replace(/^\/+/, "");
        var cat = rel.split("/")[0];
        if (cat) { trashPath += "/" + cat; where += "/" + cat; }
        var trash = needFolder(new Folder(trashPath), "「_已移除」文件夹");
        var dest = freeFile(trash, File.decode(f.name));
        if (!f.copy(dest.fsName)) {
            // dest 刚确认是空着的名字：复制到一半留下的残缺副本删掉，免得看起来像一份备份
            var why = f.error;
            try { if (dest.exists) dest.remove(); } catch (e0) {}
            fail("没能移除「" + File.decode(f.name) + "」（" + why + "）：检查脚本库文件夹是否可写");
        }
        if (!f.remove()) {
            try { dest.remove(); } catch (e) {}
            fail("没能移除「" + File.decode(f.name) + "」（" + f.error + "）：文件可能正被占用，关掉用到它的程序再试");
        }
        var renamed = File.decode(dest.name) !== File.decode(f.name);
        return "已移到 " + where + (renamed ? "（那里已有同名文件，存为「" + File.decode(dest.name) + "」）" : "") + "，可以手动恢复";
    };

    LIB.chooseLibrary = function () {
        var f = Folder.selectDialog("选择脚本库文件夹");
        if (!f) return { libPath: null };
        state.libPath = f.fsName;
        try { app.settings.saveSetting("MotionHub", "libPath", f.fsName); } catch (e) {}
        return { libPath: f.fsName };
    };

    LIB.openPanelsFolder = function () {
        var f = userPanelsFolder();
        if (!f.exists && canWriteFiles()) ensureFolder(f);
        if (!f.exists) fail("文件夹不存在：" + f.fsName);
        f.execute();
        return "";
    };

    // 面板布局等配置：存在用户数据目录，4 个面板共用
    function configDir() { return new Folder(Folder.userData.fsName + "/MotionHub"); }
    function configFile(name, forWrite) {
        var dir = forWrite ? needFolder(configDir(), "配置文件夹") : configDir();
        return new File(dir.fsName + "/" + String(name).replace(/[^\w.\-]/g, "_") + ".json");
    }

    function readText(f) {
        if (!f.exists) return null;
        f.encoding = "UTF-8";
        if (!f.open("r")) return null;
        var t = f.read();
        f.close();
        return t;
    }

    function writeText(f, text) {
        f.encoding = "UTF-8";
        if (!f.open("w")) fail("无法写入：" + f.fsName);
        f.write(text);
        f.close();
    }

    LIB.loadConfig = function (a) { return { text: readText(configFile(a.name)) }; };
    LIB.saveConfig = function (a) { writeText(configFile(a.name, true), a.text); return { saved: true }; };

    // 代码片段存在脚本库根目录，跟着脚本库一起同步。
    // 同时报告这次读的是哪个脚本库：面板拿它和自己记的比，就知道脚本库是不是在别的面板换过
    LIB.loadSnippets = function () { return { text: readText(new File(libPath() + "/_snippets.json")), libPath: new Folder(libPath()).fsName }; };
    LIB.saveSnippets = function (a) { writeText(new File(libRoot().fsName + "/_snippets.json"), a.text); return { saved: true }; };

    var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function b64decode(s) {
        var out = [], buf = 0, bits = 0;
        s = s.replace(/[^A-Za-z0-9+\/]/g, "");
        for (var i = 0; i < s.length; i++) {
            buf = (buf << 6) | B64.indexOf(s.charAt(i));
            bits += 6;
            if (bits >= 8) { bits -= 8; out.push(String.fromCharCode((buf >> bits) & 255)); }
        }
        return out.join("");
    }

    // 从面板拖进来的文件：面板读出内容（base64）交给这里写进脚本库
    LIB.writeDropped = function (a) {
        if (!canWriteFiles()) fail("请先在 AE「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」");
        if (!EXT_RE.test(a.name)) fail("只支持 .jsx / .jsxbin / .ffx 文件");
        var root = libRoot(), target = root;
        var cat = (a.cat || "").replace(/^\s+|\s+$/g, "").replace(/[\\\/:*?"<>|]/g, "_");
        if (cat && cat !== "未分类") target = needFolder(new Folder(root.fsName + "/" + cat), "分类文件夹");
        var name = a.name.replace(/[\\\/:*?"<>|]/g, "_"), bytes = b64decode(a.b64);
        // 和「添加」一样：库里已经有字节完全一样的（同名的，或以前另起名字存下的）→ 算已经有了
        var p = findPlace(target, name, function (d) { return d.length === bytes.length && readBinary(d) === bytes; });
        if (p.same) {
            var g = onDisk(target, p.file);
            return { key: g.fsName.substring(root.fsName.length).replace(/\\/g, "/"), state: "exists", name: name, savedAs: File.decode(g.name) };
        }
        var f = p.file, st = p.first ? "new" : "renamed";
        f.encoding = "BINARY";
        if (!f.open("w")) fail("没能写入「" + name + "」（" + f.error + "）：检查脚本库文件夹是否可写");
        var wrote = f.write(bytes);
        // 很多写入错误要到 close() 把缓存写进磁盘时才出现（比如磁盘满了）
        if (f.close() === false) wrote = false;
        if (wrote === false) {
            // f 刚确认是空着的名字：写坏的文件删掉，重试时还能用原来的名字
            var why = f.error;
            try { f.remove(); } catch (e) {}
            fail("没能写完「" + name + "」（" + why + "）：检查磁盘空间和脚本库文件夹是否可写");
        }
        return { key: f.fsName.substring(root.fsName.length).replace(/\\/g, "/"), state: st, name: name, savedAs: File.decode(f.name) };
    };

    // —— 音频：找到选中的音频图层，返回文件路径和时间信息 ——
    LIB.audioInfo = function () {
        var comp = activeComp(), sel = comp.selectedLayers, L = null;
        for (var i = 0; i < sel.length; i++) {
            if (sel[i].hasAudio && sel[i].source && sel[i].source.file) { L = sel[i]; break; }
        }
        if (!L) fail("请先选中一个带声音的素材图层（音频或视频）");
        var f = L.source.file;
        return {
            path: f.fsName, name: L.name, index: L.index, sourceId: L.source.id,
            startTime: L.startTime, inPoint: L.inPoint, outPoint: L.outPoint, stretch: L.stretch,
            timeRemap: L.timeRemapEnabled, isVideo: !!L.source.hasVideo, fps: comp.frameRate
        };
    };

    // 视频里的声音面板读不了：让 AE 把它渲染成临时 WAV（每个素材只渲染一次）
    LIB.extractAudio = function (a) {
        var comp = activeComp(), L = comp.layer(a.index);
        if (!L || !L.hasAudio || !L.source) fail("这个图层没有声音");
        var src = L.source, out = new File(Folder.temp.fsName + "/motionhub_audio_" + src.id + ".wav");
        if (out.exists && out.length > 1024) return { path: out.fsName, cached: true };
        var rq = app.project.renderQueue, keep = [], tmp = null, item = null, i;
        try {
            tmp = app.project.items.addComp("MotionHub 音频（临时）", 16, 16, 1, Math.max(src.duration, 0.1), 25);
            var t = tmp.layers.add(src);
            t.startTime = 0;
            try { t.enabled = false; } catch (e0) {}
            for (i = 1; i <= rq.numItems; i++) { keep.push(rq.item(i).render); try { rq.item(i).render = false; } catch (e1) {} }
            item = rq.items.add(tmp);
            var om = item.outputModule(1);
            om.setSettings({ "Format": "WAV", "Output File Info": { "Full Flat Path": out.fsName } });
            try { om.setSettings({ "Output Audio": "On" }); } catch (e2) {}
            rq.render();
        } catch (e) {
            fail("无法从视频里提取声音（" + (e.message || e) + "），可以先把音频导出成 WAV 再用");
        } finally {
            try { if (item) item.remove(); } catch (e3) {}
            for (i = 0; i < keep.length && i < rq.numItems; i++) { try { rq.item(i + 1).render = keep[i]; } catch (e4) {} }
            try { if (tmp) tmp.remove(); } catch (e5) {}
        }
        if (!out.exists) fail("无法从视频里提取声音，可以先把音频导出成 WAV 再用");
        return { path: out.fsName };
    };

    // 已安装的全部效果（给「效果收藏」挑选用）
    LIB.listEffects = function () {
        var out = [];
        for (var i = 0; i < app.effects.length; i++) {
            var e = app.effects[i];
            if (e.displayName && e.category) out.push({ name: e.displayName, match: e.matchName, cat: e.category });
        }
        return { effects: out };
    };

    // =====================================================================
    // Studio：剪辑排版
    // =====================================================================
    var VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

    LIB.pickVideos = function () {
        var filter = IS_WIN
            ? "视频:*.mp4;*.mov;*.m4v;*.webm;*.mkv;*.avi,所有文件:*.*"
            : function (f) { return f instanceof Folder || VIDEO_RE.test(File.decode(f.name)); };
        var files = File.openDialog("选择视频（可多选）", filter, true);
        if (!files) return { files: [] };
        if (!(files instanceof Array)) files = [files];
        var out = [];
        for (var i = 0; i < files.length; i++) out.push({ path: files[i].fsName, name: File.decode(files[i].name) });
        return { files: out };
    };

    LIB.chooseFolder = function (a) {
        var f = Folder.selectDialog(a.title || "选择文件夹");
        return f ? { path: f.fsName } : { path: null, msg: "已取消" };
    };

    LIB.saveFile = function (a) {
        var start = new File(Folder.desktop.fsName + "/" + a.name + "." + a.ext);
        var f = start.saveDlg(a.title || "保存", IS_WIN ? (a.ext.toUpperCase() + ":*." + a.ext) : undefined);
        if (!f) return { path: null, msg: "已取消" };
        var path = f.fsName;
        if (!new RegExp("\\." + a.ext + "$", "i").test(path)) path += "." + a.ext;
        return { path: path };
    };

    function studioFolder() {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === "MotionHub Studio") return it;
        }
        return app.project.items.addFolder("MotionHub Studio");
    }

    function importFootage(path) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FootageItem && it.file && it.file.fsName === new File(path).fsName) return it;
        }
        var item = app.project.importFile(new ImportOptions(new File(path)));
        item.parentFolder = studioFolder();
        return item;
    }

    function addAudio(comp, audio) {
        if (!audio) return;
        var foot = audio.compId ? app.project.itemByID(audio.compId) : importFootage(audio.path);
        if (!foot.hasAudio) return;
        var L = comp.layers.add(foot);
        L.name = "声音 · " + foot.name;
        L.startTime = -audio.start;
        try { L.enabled = false; } catch (e) {}
        L.audioEnabled = true;
        L.moveToEnd();
    }

    // PNG 序列 → 合成 → 渲染队列（优先 H.264）
    LIB.studioRender = function (a) {
        var io = new ImportOptions(new File(a.first));
        io.sequence = true;
        io.forceAlphabetical = true;
        var seq = app.project.importFile(io);
        seq.mainSource.conformFrameRate = a.fps;
        seq.parentFolder = studioFolder();
        seq.name = a.name + " 帧序列";
        var comp = app.project.items.addComp(a.name, a.width, a.height, 1, a.duration, a.fps);
        comp.parentFolder = studioFolder();
        comp.layers.add(seq).startTime = 0;
        addAudio(comp, a.audio);

        var rq = app.project.renderQueue.items.add(comp), om = rq.outputModule(1), used = "";
        var tpls = om.templates;
        for (var i = 0; i < tpls.length; i++) {
            if (/H\.?264/i.test(tpls[i])) { used = tpls[i]; break; }
        }
        if (used) om.applyTemplate(used);
        var outPath = a.out;
        if (!used) outPath = outPath.replace(/\.mp4$/i, ".mov");
        om.file = new File(outPath);
        if (a.render) {
            app.project.renderQueue.render();
            if (a.cleanup) {
                try { rq.remove(); } catch (e0) {}
                try { comp.remove(); seq.remove(); } catch (e1) {}
            }
            return { msg: "已渲染：" + outPath + (used ? "" : "（这个 AE 版本没有 H.264 输出模板，已输出为 MOV）"), out: outPath, h264: !!used };
        }
        comp.openInViewer();
        return { msg: "已加入渲染队列：" + comp.name + (used ? "（H.264）" : "（没有 H.264 模板，输出为 MOV）"), out: outPath, h264: !!used };
    };

    // 圆角矩形蒙版
    function roundRectShape(w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        var sh = new Shape(), k = 0.5523 * r;
        if (r <= 0) {
            sh.vertices = [[0, 0], [w, 0], [w, h], [0, h]];
        } else {
            sh.vertices = [[r, 0], [w - r, 0], [w, r], [w, h - r], [w - r, h], [r, h], [0, h - r], [0, r]];
            sh.inTangents = [[-k, 0], [0, 0], [0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0]];
            sh.outTangents = [[0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k]];
        }
        sh.closed = true;
        return sh;
    }

    function findParam(fx, matchNames, names, index) {
        var i, p;
        for (i = 0; i < matchNames.length; i++) { try { p = fx.property(matchNames[i]); if (p) return p; } catch (e) {} }
        for (i = 0; i < names.length; i++) { try { p = fx.property(names[i]); if (p) return p; } catch (e2) {} }
        try { return fx.property(index); } catch (e3) { return null; }
    }

    // 色阶：数值单位跟着项目位深变（0–1、0–255 或 0–32768），按「输入白色」的默认值换算
    function addLevels(L, lv) {
        if (lv.inB === 0 && lv.inW === 255 && lv.gamma === 1 && lv.outB === 0 && lv.outW === 255) return true;
        var fxs = L.property("ADBE Effect Parade");
        if (!fxs.canAddProperty("ADBE Easy Levels2")) return false;
        var fx = fxs.addProperty("ADBE Easy Levels2");
        var inB = findParam(fx, ["ADBE Easy Levels2-0003"], ["Input Black", "输入黑色"], 3);
        var inW = findParam(fx, ["ADBE Easy Levels2-0004"], ["Input White", "输入白色"], 4);
        var gm = findParam(fx, ["ADBE Easy Levels2-0005"], ["Gamma", "灰度系数"], 5);
        var outB = findParam(fx, ["ADBE Easy Levels2-0006"], ["Output Black", "输出黑色"], 6);
        var outW = findParam(fx, ["ADBE Easy Levels2-0007"], ["Output White", "输出白色"], 7);
        var unit = inW.value / 255;
        inB.setValue(lv.inB * unit); inW.setValue(lv.inW * unit); gm.setValue(lv.gamma);
        outB.setValue(lv.outB * unit); outW.setValue(lv.outW * unit);
        return true;
    }

    function addBalance(L, bal) {
        var all = bal.shadows.concat(bal.mid, bal.high), any = false, i;
        for (i = 0; i < all.length; i++) if (all[i]) any = true;
        if (!any) return true;
        var fxs = L.property("ADBE Effect Parade"), mn = null, cands = ["ADBE Color Balance 2", "ADBE Color Balance"];
        for (i = 0; i < cands.length; i++) if (fxs.canAddProperty(cands[i])) { mn = cands[i]; break; }
        if (!mn) return false;
        var fx = fxs.addProperty(mn);
        for (i = 0; i < 9; i++) { try { fx.property(i + 1).setValue(all[i]); } catch (e) {} }
        try { fx.property(10).setValue(bal.preserve ? 1 : 0); } catch (e2) {}
        return true;
    }

    // 可编辑排版：背景纯色 + 每个格子一个预合成（裁切、构图、调色在里面，圆角用蒙版）
    LIB.studioBuild = function (a) {
        app.beginUndoGroup("MotionHub Studio：发送到 AE");
        var notes = [];
        try {
            var folder = studioFolder();
            var comp = app.project.items.addComp(a.name, a.width, a.height, 1, a.duration, a.fps);
            comp.parentFolder = folder;
            var bg = comp.layers.addSolid(a.bg, "背景", a.width, a.height, 1, a.duration);
            bg.locked = true;
            var curved = false;
            for (var i = 0; i < a.cells.length; i++) {
                var c = a.cells[i], foot = c.compId ? app.project.itemByID(c.compId) : importFootage(c.path);
                var w = Math.max(4, Math.round(c.w)), h = Math.max(4, Math.round(c.h));
                var pre = app.project.items.addComp(a.name + " · 格子 " + (i + 1), w, h, 1, Math.max(c.length, 1 / a.fps), a.fps);
                pre.parentFolder = folder;
                var L = pre.layers.add(foot);
                L.startTime = -c.start;
                var sx = c.place.w / c.vw * 100, sy = c.place.h / c.vh * 100;
                L.transform.scale.setValue([sx, sy]);
                L.transform.position.setValue([c.place.x + c.place.w / 2, c.place.y + c.place.h / 2]);
                if (!addLevels(L, c.levels)) notes.push("色阶");
                if (!addBalance(L, c.balance)) notes.push("色彩平衡");
                if (c.curved) curved = true;

                var cell = comp.layers.add(pre);
                cell.name = "格子 " + (i + 1) + " · " + c.name;
                cell.transform.position.setValue([c.x + w / 2, c.y + h / 2]);
                // 素材比成片短：时间重映射循环播放
                if (c.length < a.duration - 0.001) {
                    cell.timeRemapEnabled = true;
                    cell.property("ADBE Time Remapping").expression = 'loopOut("cycle")';
                }
                cell.inPoint = 0;
                cell.outPoint = a.duration;
                if (a.radius > 0) {
                    var m = cell.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
                    m.property("ADBE Mask Shape").setValue(roundRectShape(w, h, a.radius));
                }
                cell.moveBefore(bg);
            }
            addAudio(comp, a.audio);
            comp.openInViewer();
            var msg = "已在 AE 里生成合成「" + comp.name + "」：" + a.cells.length + " 个格子";
            if (curved) msg += "。曲线不能通过脚本写进 AE，这个合成里没有曲线调整";
            if (notes.length) msg += "。没能添加：" + notes.join("、");
            return msg;
        } finally {
            app.endUndoGroup();
        }
    };

    // —— 把 AE 合成送进 Studio：列出合成，渲染成 PNG 序列 ——
    LIB.listComps = function () {
        var out = [], active = app.project.activeItem, sel = app.project.selection, selIds = {};
        for (var s = 0; s < sel.length; s++) selIds[sel[s].id] = true;
        for (var i = 1; i <= app.project.numItems; i++) {
            var c = app.project.item(i);
            if (!(c instanceof CompItem)) continue;
            out.push({
                id: c.id, name: c.name, width: c.width, height: c.height, duration: c.duration, fps: c.frameRate,
                workStart: c.workAreaStart, workDur: c.workAreaDuration,
                active: !!(active && active.id === c.id), selected: !!selIds[c.id]
            });
        }
        return { comps: out };
    };

    // 输出模块设成 PNG 序列。格式名随 AE 界面语言变化，新版 AE 也不一定自带 PNG 模板，所以挨个试
    var PNG_FORMATS = ["PNG Sequence", "PNG 序列", "PNG序列", "PNG シーケンス", "PNG 시퀀스", "PNG-Sequenz", "Séquence PNG",
        "Secuencia PNG", "Sequenza PNG", "Sequência PNG", "Последовательность PNG"];
    function isPng(om) {
        try { return /PNG/i.test(om.getSettings(GetSettingsFormat.STRING)["Format"]); } catch (e) { return false; }
    }
    function setPngFormat(om) {
        var tpls = om.templates, i;
        for (i = 0; i < tpls.length; i++) {
            if (/PNG/i.test(tpls[i])) { try { om.applyTemplate(tpls[i]); if (isPng(om)) return true; } catch (e) {} }
        }
        for (i = 0; i < PNG_FORMATS.length; i++) {
            try { om.setSettings({ "Format": PNG_FORMATS[i] }); if (isPng(om)) return true; } catch (e2) {}
        }
        return false;
    }
    function pad5(n) { return ("0000" + n).slice(-5); }

    // 备用：不经过渲染队列，逐帧存 PNG（AE 2022 起在后台写文件，需要等它写完）
    function saveFramesPng(comp, dir, start, dur) {
        if (typeof comp.saveFrameToPng !== "function") return false;
        var fps = comp.frameRate, n = Math.max(1, Math.round(dur * fps)), i;
        for (i = 0; i < n; i++) comp.saveFrameToPng(start + i / fps, new File(dir.fsName + "/frame_" + pad5(i) + ".png"));
        var last = new File(dir.fsName + "/frame_" + pad5(n - 1) + ".png"), t0 = new Date().getTime();
        while (!(last.exists && last.length > 0) && new Date().getTime() - t0 < 120000) $.sleep(100);
        $.sleep(200);
        return true;
    }

    LIB.renderComp = function (a) {
        var comp = app.project.itemByID(a.id);
        if (!(comp instanceof CompItem)) fail("找不到这个合成");
        var dir = new Folder(Folder.temp.fsName + "/motionhub_comp_" + comp.id + "_" + new Date().getTime());
        dir.create();
        var start = a.workArea ? comp.workAreaStart : 0, dur = a.workArea ? comp.workAreaDuration : comp.duration;
        var rq = app.project.renderQueue, keep = [], item = null, i, viaQueue = false, why = "";
        try {
            for (i = 1; i <= rq.numItems; i++) { keep.push(rq.item(i).render); try { rq.item(i).render = false; } catch (e0) {} }
            item = rq.items.add(comp);
            item.timeSpanStart = start;
            item.timeSpanDuration = dur;
            if (a.half) { try { item.setSettings({ "Resolution": [2, 2] }); } catch (e1) {} }
            var om = item.outputModule(1);
            if (setPngFormat(om)) {
                om.file = new File(dir.fsName + "/frame_[#####].png");
                rq.render();
                viaQueue = true;
            }
        } catch (e) {
            why = e.message || String(e);
        } finally {
            try { if (item) item.remove(); } catch (e2) {}
            for (i = 0; i < keep.length && i < rq.numItems; i++) { try { rq.item(i + 1).render = keep[i]; } catch (e3) {} }
        }
        if (!viaQueue || !listFiles(dir, "*.png").length) {
            var old = listFiles(dir, "*"), saved = false;
            for (i = 0; i < old.length; i++) { try { old[i].remove(); } catch (e4) {} }
            try { saved = saveFramesPng(comp, dir, start, dur); } catch (e5) { why = why || (e5.message || String(e5)); }
            if (!saved) fail("渲染合成失败" + (why ? "：" + why : "：这个 AE 版本既没有 PNG 序列输出，也不支持逐帧存图"));
        }
        var files = listFiles(dir, "*.png"), names = [];
        for (i = 0; i < files.length; i++) names.push(File.decode(files[i].name));
        names.sort();
        if (!names.length) fail("没有渲染出画面，请检查合成的工作区");
        var k = a.half && viaQueue ? 0.5 : 1;
        return {
            dir: dir.fsName, files: names, fps: comp.frameRate, name: comp.name, id: comp.id,
            width: Math.round(comp.width * k), height: Math.round(comp.height * k),
            msg: "已把「" + comp.name + "」渲染成 " + names.length + " 帧"
        };
    };

    LIB.status = function () {
        return { canWrite: canWriteFiles() };
    };

    // 选区快照：面板据此把条件不满足的按钮变暗。只读、不开撤销组、任何一项出错都不影响其他项
    LIB.ctx = function () {
        var out = { comp: "", layers: 0, keys: 0, exprProps: 0, precomps: 0, projComps: 0, lib: "" }, i;
        try { out.lib = new Folder(libPath()).fsName; } catch (eL) {}
        try {
            var sel = app.project.selection;
            for (i = 0; i < sel.length; i++) if (sel[i] instanceof CompItem) out.projComps++;
        } catch (e0) {}
        var c = null;
        try { c = app.project.activeItem; } catch (e1) {}
        if (!(c && c instanceof CompItem)) return out;
        out.comp = c.name;
        try {
            var L = c.selectedLayers;
            out.layers = L.length;
            for (i = 0; i < L.length; i++) { try { if (L[i].source && L[i].source instanceof CompItem) out.precomps++; } catch (e2) {} }
        } catch (e3) {}
        try {
            var P = c.selectedProperties;
            for (i = 0; i < P.length; i++) {
                var p = P[i];
                if (p.propertyType !== PropertyType.PROPERTY) continue;
                if (p.canSetExpression) out.exprProps++;
                if (p.selectedKeys) out.keys += p.selectedKeys.length;
            }
        } catch (e4) {}
        return out;
    };

    // 自检：后台能回答的几项（版本、AE、写入权限、脚本库文件夹）
    LIB.selfCheck = function () {
        var canWrite = canWriteFiles(), dir = new Folder(libPath()), exists = false, writable = false, why = "";
        try { exists = dir.exists; } catch (e0) {}
        if (exists && canWrite) {
            var f = new File(dir.fsName + "/_motionhub_write_test.tmp");
            try {
                if (f.open("w")) { f.write("ok"); f.close(); writable = f.remove(); }
                else why = f.error || "打不开文件";
            } catch (e1) { why = String(e1); }
        }
        return { version: VERSION, ae: app.version, canWrite: canWrite, libPath: dir.fsName, libExists: exists, libWritable: writable, libError: why };
    };

    // =====================================================================
    // 入口
    // =====================================================================
    var UNDO_NAMES = {
        anchor: "设置锚点", centerComp: "居中", nullLayer: "空对象", addLayer: "新建图层", ease: "缓动",
        align: "对齐", distribute: "分布", sequence: "依次排列", trim: "剪切图层", precompEach: "逐个预合成",
        reverse: "反转顺序", rename: "批量重命名", cloneKeys: "克隆关键帧", wiggle: "抖动", loop: "循环",
        bounce: "弹性", clearExpr: "清除表达式", dupComp: "复制合成", collectColors: "收集颜色",
        copyKeys: "复制关键帧", pasteKeys: "粘贴关键帧", keyTime: "关键帧时间", bezier: "自定义缓动",
        quickAnim: "快速动画", splitLayer: "拆分图层", toPlayhead: "移到播放头", motionBlur: "运动模糊",
        applyExpr: "应用表达式", runCode: "执行脚本", bezierRead: "读取曲线",
        beatMarkers: "节拍标记", clearMarkers: "清除标记", beatLayers: "按节拍排列", decompose: "解散预合成",
        dupPrecomp: "复制预合成", smartRename: "智能重命名", chain: "首尾相接", styleCopy: "复制样式",
        stylePaste: "粘贴样式", applyEffect: "添加效果", wireframe: "线框叠加", wireClear: "清除线框", wireStyle: "线框颜色"
    };

    // 只读：不改工程，不开撤销组（否则会在「编辑 → 撤销」里留下空记录）
    var READ_ONLY = { bezierRead: true, copyKeys: true, styleCopy: true };

    function call(name, args) {
        args = args || {};
        if (!args.mods) args.mods = {};
        try {
            if (T[name]) {
                var res, undo = !READ_ONLY[name];
                if (undo) app.beginUndoGroup("MotionHub：" + (UNDO_NAMES[name] || name));
                try { res = T[name](args); } finally { if (undo) app.endUndoGroup(); }
                if (res && typeof res === "object") return stringify({ ok: true, msg: res.msg || "", data: res });
                return stringify({ ok: true, msg: res || "" });
            }
            if (LIB[name]) {
                var r = LIB[name](args);
                if (typeof r === "string") return stringify({ ok: true, msg: r });
                return stringify({ ok: true, msg: (r && r.msg) || "", data: r });
            }
            return stringify({ ok: false, msg: "未知操作：" + name });
        } catch (e) {
            return stringify({ ok: false, msg: e.isUser ? e.message : "出错了：" + e.toString() + (e.line ? "（第 " + e.line + " 行）" : "") });
        }
    }

    return { call: call, version: VERSION };
})();
