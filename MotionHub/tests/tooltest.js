// 图层工具的几何测试（3.8）：在 Node 里模拟 AE 的图层变换、遮罩、父级、3D，直接调用 host.jsx 的 MH.call
// 每个场景都检查两件事：
//   1. 结果对：锚点落在遮罩 / 内容的正确位置，对齐、居中、分布后外框在合成里的位置对
//   2. 画面不动：只改锚点的操作前后，图层上每个点在合成里的位置不变（误差 < 0.001 px）
"use strict";
const fs = require("fs");
const path = require("path");

const HOST = path.join(__dirname, "../com.windwings.motionhub/jsx/host.jsx");
let failures = 0;
function check(name, cond, detail) {
    console.log((cond ? "✓ " : "✗ ") + name + (cond ? "" : "：" + (detail || "")));
    if (!cond) failures++;
}
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-3);
const nearV = (a, b, eps) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const fmt = v => "[" + v.map(x => Math.round(x * 1000) / 1000).join(", ") + "]";

// —— 假的 AE 对象模型 ——
const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 };
const AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213, CAMERA_OR_POINT_OF_INTEREST: 4214 };
function CompItem() {}
function AVLayer() {}
function ShapeLayer() {} ShapeLayer.prototype = Object.create(AVLayer.prototype);
function TextLayer() {} TextLayer.prototype = Object.create(AVLayer.prototype);
function CameraLayer() {}
function LightLayer() {}

// 一个可以有关键帧的属性
function prop(value, o) {
    o = o || {};
    const p = {
        _v: value, _keys: [], expression: o.exprFn ? "模拟的表达式" : "", expressionError: "", dimensionsSeparated: !!o.separated, name: o.name || "",
        canSetExpression: true, expressionEnabled: !!o.exprFn,
        get numKeys() { return this._keys.length; },
        get value() { return this.valueAtTime(0, false); },
        valueAtTime(t, pre) {
            if (this.expression && o.evalExpr && !pre) return o.evalExpr(this.expression, t);
            if (o.exprFn && !pre) return o.exprFn(t, this.valueAtTime(t, true));
            if (!this._keys.length) return clone(this._v);
            // 测试里只在关键帧上取值：取最近的那个
            let best = this._keys[0];
            for (const k of this._keys) if (Math.abs(k.t - t) < Math.abs(best.t - t)) best = k;
            return clone(best.v);
        },
        setValue(v) { if (this._keys.length) throw new Error("有关键帧时不能 setValue"); this._v = clone(v); },
        setValueAtTime(t, v) { this._keys.push({ t, v: clone(v) }); this._keys.sort((a, b) => a.t - b.t); },
        setValueAtKey(k, v) { this._keys[k - 1].v = clone(v); },
        keyValue(k) { return clone(this._keys[k - 1].v); },
        keyTime(k) { return this._keys[k - 1].t; }
    };
    return p;
}
const clone = v => (Array.isArray(v) ? v.slice() : v && typeof v === "object" && v.vertices ? { vertices: v.vertices.map(x => x.slice()), inTangents: v.inTangents.map(x => x.slice()), outTangents: v.outTangents.map(x => x.slice()), closed: v.closed } : v);

const rad = d => d * Math.PI / 180;
// 3D 旋转（模拟里用的顺序：先 Z、再 Y、再 X，最后方向 X→Y→Z 的同样顺序）。
// 测试只要求后台和模拟自洽：后台在 3D 旋转时把换算交给「AE」（这里就是这套数学），不自己假设顺序
function rotZ(v, a) { const c = Math.cos(rad(a)), s = Math.sin(rad(a)); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; }
function rotY(v, a) { const c = Math.cos(rad(a)), s = Math.sin(rad(a)); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }
function rotX(v, a) { const c = Math.cos(rad(a)), s = Math.sin(rad(a)); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; }

let ALL_LAYERS = [];
function makeLayer(o) {
    const Ctor = o.kind === "shape" ? ShapeLayer : o.kind === "text" ? TextLayer : o.kind === "camera" ? CameraLayer : AVLayer;
    const L = Object.create(Ctor.prototype);
    const three = !!o.three;
    const vec = (v2, z) => (three ? [v2[0], v2[1], z || 0] : v2.slice(0, 2));
    const sep = !!o.separated;
    const pos = vec(o.pos || [0, 0], o.z);
    const tr = {
        anchorPoint: prop(vec(o.anchor || [0, 0]), { exprFn: o.anchorExpr ? (t, v) => o.anchorExpr(L, t, v) : null }),
        position: prop(pos, { separated: sep, exprFn: o.posExpr ? (t, v) => o.posExpr(L, t, v) : null }),
        scale: prop(vec(o.scale || [100, 100], 100)),
        opacity: prop(100)
    };
    const px = { "ADBE Position_0": prop(pos[0]), "ADBE Position_1": prop(pos[1]), "ADBE Position_2": prop(pos[2] || 0) };
    const rz = prop(o.rot || 0), rx = prop(o.rotX || 0), ry = prop(o.rotY || 0), orient = prop(o.orient || [0, 0, 0]);
    tr.property = (n) => ({ "ADBE Rotate Z": rz, "ADBE Rotate X": rx, "ADBE Rotate Y": ry, "ADBE Orientation": orient,
        "ADBE Anchor Point": tr.anchorPoint, "ADBE Position": tr.position, "ADBE Scale": tr.scale }[n] || px[n]);
    // 位置分开维度时，position 本身的值由 X / Y / Z 组成
    if (sep) Object.defineProperty(tr.position, "valueAtTime", { value: (t) => three ? [px["ADBE Position_0"].valueAtTime(t), px["ADBE Position_1"].valueAtTime(t), px["ADBE Position_2"].valueAtTime(t)] : [px["ADBE Position_0"].valueAtTime(t), px["ADBE Position_1"].valueAtTime(t)] });
    const masks = (o.masks || []).map((m, i) => ({
        name: "蒙版 " + (i + 1), maskMode: m.mode || MaskMode.ADD, inverted: !!m.inverted, selected: !!m.selected,
        _shape: prop(m.shape), _exp: prop(m.expansion || 0),
        // 和真实 AE 一样：「蒙版扩展」的 matchName 是 ADBE Mask Offset；不认识的名字返回 null
        property(n) { return n === "ADBE Mask Shape" ? this._shape : n === "ADBE Mask Offset" ? this._exp : null; }
    }));
    const effects = [];
    const fxParade = {
        get numProperties() { return effects.length; },
        property(i) { return effects[i - 1]; },
        addProperty(match) {
            L._invalid++;   // 加效果以后，之前取到的属性对象作废（真实 AE 的行为）
            const fx = { matchName: match, remove() { effects.splice(effects.indexOf(fx), 1); L._invalid++; } };
            const p1 = prop([0, 0, 0], { evalExpr: (expr, t) => evalProbe(L, expr, t) });
            fx.property = (i) => (i === 1 ? p1 : null);
            effects.push(fx);
            L._probes++;
            return fx;
        }
    };
    Object.assign(L, {
        name: o.name || "图层", index: 0, threeDLayer: three, parent: null, autoOrient: o.autoOrient || AutoOrientType.NO_AUTO_ORIENT,
        transform: tr, _rect: o.rect || [0, 0, 100, 100], _strokeRect: o.strokeRect, _invalid: 0, _probes: 0, nullLayer: !!o.nullLayer,
        sourceRectAtTime(t, extents) {
            const r = extents && this._strokeRect ? this._strokeRect : this._rect;
            return { left: r[0], top: r[1], width: r[2], height: r[3] };
        },
        property(n) {
            if (n === "ADBE Mask Parade") return { numProperties: masks.length, property: (i) => masks[i - 1] };
            if (n === "ADBE Effect Parade") return fxParade;
            return null;
        },
        moveBefore() {}, _masks: masks, _effects: effects,
        // 模拟里不换算：直接改指针（真实 AE 的 setParentWithJump 也不换算变换，所以这里是准的）
        setParentWithJump(par) { this.parent = par; }
    });
    if (o.kind === "camera") { delete L.transform; }
    // 时间：入点 = 开始时间（模拟里图层从 0 开始，没有裁剪）
    L.startTime = o.start || 0;
    Object.defineProperty(L, "inPoint", { get() { return this.startTime; }, configurable: true });
    return L;
}

// 参考实现：图层坐标 → 父级坐标（2D 或 3D）
function toParent(L, p, t) {
    t = t || 0;
    const tr = L.transform;
    const A = tr.anchorPoint.valueAtTime(t), P = tr.position.valueAtTime(t), S = tr.scale.valueAtTime(t);
    // 2D 图层不改 z（和 AE 一样：3D 子图层挂在 2D 父级下时深度不丢）
    let v = [(p[0] - A[0]) * S[0] / 100, (p[1] - A[1]) * S[1] / 100, L.threeDLayer ? ((p[2] || 0) - (A[2] || 0)) * (S[2] || 100) / 100 : (p[2] || 0)];
    v = rotZ(v, tr.property("ADBE Rotate Z").valueAtTime(t));
    if (L.threeDLayer) {
        v = rotY(v, tr.property("ADBE Rotate Y").valueAtTime(t));
        v = rotX(v, tr.property("ADBE Rotate X").valueAtTime(t));
        const o = tr.property("ADBE Orientation").valueAtTime(t);
        v = rotZ(rotY(rotX(v, o[0]), o[1]), o[2]);
    }
    return [v[0] + P[0], v[1] + P[1], v[2] + (P[2] || 0)];
}
function toComp(L, p, t) { let q = p; for (let c = L; c; c = c.parent) q = toParent(c, q, t); return q; }
// 只有线性部分（向量）
function vecToParent(L, v, t) { const o = toParent(L, [0, 0, 0], t), e = toParent(L, v, t); return [e[0] - o[0], e[1] - o[1], e[2] - o[2]]; }
function vecToWorld(L, v, t) { let q = v; for (let c = L; c; c = c.parent) q = vecToParent(c, q, t); return q; }
// 用解方程的办法求 fromWorldVec（模拟里够用：线性部分可逆）
function vecFromWorld(L, w, t) {
    const ex = vecToWorld(L, [1, 0, 0], t), ey = vecToWorld(L, [0, 1, 0], t), ez = vecToWorld(L, [0, 0, 1], t);
    const m = [[ex[0], ey[0], ez[0]], [ex[1], ey[1], ez[1]], [ex[2], ey[2], ez[2]]];
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const inv = [
        [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det],
        [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det],
        [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det]
    ];
    return [0, 1, 2].map(i => inv[i][0] * w[0] + inv[i][1] * w[1] + inv[i][2] * w[2]);
}
// 后台的探针表达式：var v = thisLayer.toWorldVec([x, y, z], t); thisLayer.hasParent ? thisLayer.parent.fromWorldVec(v, t) : v;
let CUR_COMP = null;
function project(P) {
    const W = CUR_COMP ? CUR_COMP.width : 1920, H = CUR_COMP ? CUR_COMP.height : 1080, zoom = W * 50 / 36, k = zoom / ((P[2] || 0) + zoom);
    return [W / 2 + (P[0] - W / 2) * k, H / 2 + (P[1] - H / 2) * k];
}
// 图层上一点画在合成画面上的位置（3D 链 + 默认摄像机透视；2D 图层不受摄像机影响）
function drawnOf(L, p, t) { const w = toComp(L, p, t); return L.threeDLayer ? project(w) : [w[0], w[1]]; }
// 后台的三种探针表达式：toWorldVec + parent.fromWorldVec / parent.fromWorldVec([dx, dy, 0]) / toComp
function evalProbe(L, expr, t) {
    let m = /toWorldVec\(\[([^\]]+)\],\s*([^)]+)\)/.exec(expr);
    if (m && /hasParent \? thisLayer\.parent\.fromWorldVec\(v, /.test(expr)) {
        const v = m[1].split(",").map(Number), tt = Number(m[2]);
        const w = vecToWorld(L, v, tt);
        return L.parent ? vecFromWorld(L.parent, w, tt) : w;
    }
    m = /^thisLayer\.hasParent \? thisLayer\.parent\.fromWorldVec\(\[([^\]]+)\],\s*([^)]+)\) :/.exec(expr);
    if (m) {
        const v = m[1].split(",").map(Number), tt = Number(m[2]);
        return L.parent ? vecFromWorld(L.parent, v, tt) : v;
    }
    m = /thisLayer\.toComp\(\[([^\]]+)\],\s*([^)]+)\)/.exec(expr);
    if (m) {
        const v = m[1].split(",").map(Number), tt = Number(m[2]);
        const d = drawnOf(L, v, tt);
        return [d[0], d[1], 0];
    }
    // 第 3 轮新加的探针：父级的 toWorldVec（2D 子图层挂在 3D 父级下）、图层自己的 toWorld / toWorldVec（空对象 ⌥ 的世界坐标）、
    // 沿摄像机方向的位移（var w = thisComp.layer(i).toWorldVec(...); 再换到父级坐标）
    m = /^thisLayer\.hasParent \? thisLayer\.parent\.toWorldVec\(\[([^\]]+)\],\s*([^)]+)\) :/.exec(expr);
    if (m) {
        const v = m[1].split(",").map(Number), tt = Number(m[2]);
        return L.parent ? vecToWorld(L.parent, v, tt) : v;
    }
    m = /^thisLayer\.toWorld\(\[([^\]]+)\],\s*([^)]+)\);$/.exec(expr);
    if (m) return toComp(L, m[1].split(",").map(Number), Number(m[2]));
    m = /^thisLayer\.toWorldVec\(\[([^\]]+)\],\s*([^)]+)\);$/.exec(expr);
    if (m) return vecToWorld(L, m[1].split(",").map(Number), Number(m[2]));
    // 沿摄像机的 x、y（单位长度）移 (dx, dy)，再换到父级坐标
    m = /^var c = thisComp\.layer\((\d+)\), dx = ([^,]+), dy = ([^,]+), t = ([^;]+);\nvar w = add\(mul\(normalize\(c\.toWorldVec\(\[1, 0, 0\], t\)\), dx\), mul\(normalize\(c\.toWorldVec\(\[0, 1, 0\], t\)\), dy\)\);\nthisLayer\.hasParent \? thisLayer\.parent\.fromWorldVec\(w, t\) : w;$/.exec(expr);
    if (m) {
        const C = ALL_LAYERS[Number(m[1]) - 1], dx = Number(m[2]), dy = Number(m[3]), tt = Number(m[4]);
        const nz = v => { const l = Math.hypot(v[0], v[1], v[2]); return v.map(x => x / l); };
        const ux = nz(vecToWorld(C, [1, 0, 0], tt)), uy = nz(vecToWorld(C, [0, 1, 0], tt));
        const w = [0, 1, 2].map(i => ux[i] * dx + uy[i] * dy);
        return L.parent ? vecFromWorld(L.parent, w, tt) : w;
    }
    // 一点在摄像机坐标里（z = 沿镜头方向离摄像机多远）
    m = /^var c = thisComp\.layer\((\d+)\);\nc\.fromWorld\(thisLayer\.toWorld\(\[([^\]]+)\],\s*([^)]+)\),\s*[^)]+\);$/.exec(expr);
    if (m) {
        const C = ALL_LAYERS[Number(m[1]) - 1], tt = Number(m[3]), w = toComp(L, m[2].split(",").map(Number), tt), o = toComp(C, [0, 0, 0], tt);
        return vecFromWorld(C, [w[0] - o[0], w[1] - o[1], w[2] - o[2]], tt);
    }
    throw new Error("看不懂的表达式：" + expr);
}

function makeComp(layers, o) {
    o = o || {};
    const comp = Object.assign(Object.create(CompItem.prototype), {
        name: "合成", width: o.width || 1920, height: o.height || 1080, time: o.time || 0, frameDuration: 1 / 25, activeCamera: o.activeCamera || null,
        selectedLayers: [], selectedProperties: [],
        layer(i) { return ALL_LAYERS[i - 1]; },
        layers: {
            addNull() {
                const n = makeLayer({ name: "空对象", nullLayer: true, rect: [0, 0, 100, 100], anchor: [50, 50], pos: [comp.width / 2, comp.height / 2] });
                // 模拟里 .parent = 只改指针（真实 AE 会换算变换、画面不动）：记下接到父级那一刻的位置（那时还是合成坐标）
                let par = null;
                Object.defineProperty(n, "parent", { get() { return par; }, set(v) { if (v && !n._posWhenParented) n._posWhenParented = n.transform.position.value.slice(); par = v; }, configurable: true });
                ALL_LAYERS.unshift(n); reindex(); return n;
            }
        }
    });
    CUR_COMP = comp;
    // Object.assign 会把 getter 抄成当时的值：图层数要用 defineProperty 才能跟着变
    Object.defineProperty(comp, "numLayers", { get() { return ALL_LAYERS.length; } });
    ALL_LAYERS = layers.slice();
    reindex();
    return comp;
}
function reindex() { ALL_LAYERS.forEach((L, i) => { L.index = i + 1; }); }

function loadHost(comp) {
    const undo = [];
    const g = {
        File: function () {}, Folder: function () {}, FootageItem: function () {}, FolderItem: function () {},
        CompItem, AVLayer, ShapeLayer, TextLayer, CameraLayer, LightLayer, MaskMode, AutoOrientType,
        $: { os: "Macintosh OS 14", fileName: "/x/jsx/host.jsx", global: {} },
        app: {
            version: "24.3.0",
            settings: { haveSetting: () => false, getSetting: () => "", saveSetting: () => {} },
            beginUndoGroup: (n) => undo.push("begin:" + n), endUndoGroup: () => undo.push("end"),
            project: { activeItem: comp, selection: [] }
        },
        PropertyType: { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 },
        KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
        KeyframeEase: function (s, i) { this.speed = s; this.influence = i; }
    };
    g.Folder.myDocuments = { fsName: "/tmp/mh-tooltest-docs" };
    g.Folder.userData = { fsName: "/tmp/mh-tooltest-data" };
    g.$.global = g;
    const src = fs.readFileSync(HOST, "utf8").replace(/^\uFEFF/, "");
    const MH = new Function(...Object.keys(g), src + "\nreturn MH;")(...Object.values(g));
    return { undo, call: (name, args) => JSON.parse(MH.call(name, args || {})) };
}

// 图层上几个点在合成里的位置（检查「画面不动」）
function snapshot(L) {
    const r = L._rect;
    const pts = [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0], r[1] + r[3]], [r[0] + r[2] / 3, r[1] + r[3] * 0.7]];
    return pts.map(p => toComp(L, p));
}
function same(a, b) { return a.every((p, i) => nearV(p, b[i])); }
function anchorComp(L) { return toComp(L, L.transform.anchorPoint.valueAtTime(0)); }
// 合成里看得见的外框（按参考实现，给定图层坐标的矩形）
function compBoxOf(L, box) {
    const pts = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].map(p => toComp(L, p));
    return { l: Math.min(...pts.map(p => p[0])), t: Math.min(...pts.map(p => p[1])), r: Math.max(...pts.map(p => p[0])), b: Math.max(...pts.map(p => p[1])) };
}
const rectShape = (l, t, r, b) => ({ vertices: [[l, t], [r, t], [r, b], [l, b]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], closed: true });
// 椭圆（4 个顶点 + 切线，和 AE 画出来的一样）：中心 (cx, cy)，半径 rx、ry
function ellipseShape(cx, cy, rx, ry) {
    const k = 0.5523;
    return {
        vertices: [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]],
        inTangents: [[-rx * k, 0], [0, -ry * k], [rx * k, 0], [0, ry * k]],
        outTangents: [[rx * k, 0], [0, ry * k], [-rx * k, 0], [0, -ry * k]],
        closed: true
    };
}
function run(layers, sel, name, args, compOpts) {
    const comp = makeComp(layers, compOpts);
    comp.selectedLayers = sel;
    const h = loadHost(comp);
    const r = h.call(name, Object.assign({ mods: {} }, args || {}));
    return { r, h, comp };
}

// 1. 画完遮罩重置锚点：锚点放到遮罩中心（不是整个纯色层的中心），画面不动
{
    const L = makeLayer({ name: "纯色", rect: [0, 0, 1920, 1080], anchor: [960, 540], pos: [960, 540], masks: [{ shape: rectShape(100, 200, 500, 400) }] });
    const before = snapshot(L);
    const { r, h } = run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("遮罩：锚点放到遮罩中心 (300, 300)", r.ok && nearV(L.transform.anchorPoint.value, [300, 300]), JSON.stringify(r) + " " + fmt(L.transform.anchorPoint.value));
    check("遮罩：画面不动（图层上每个点在合成里的位置不变）", same(before, snapshot(L)), fmt(snapshot(L)[0]));
    check("遮罩：提示里说明按遮罩", /按遮罩/.test(r.msg) && /中心/.test(r.msg), r.msg);
    check("遮罩：一个撤销组", h.undo.join(",") === "begin:MotionHub：设置锚点,end", h.undo.join(","));
}

// 2. 遮罩是曲线（椭圆）：外框按曲线算，不是按顶点 + 切线手柄
{
    const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [{ shape: ellipseShape(400, 300, 150, 80) }] });
    run([L], [L], "anchor", { fx: 0, fy: 0 });
    const a = L.transform.anchorPoint.value;
    check("曲线遮罩：左上角是椭圆的外框 (250, 220)", nearV(a, [250, 220], 1e-6), fmt(a));
    const L2 = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [{ shape: ellipseShape(400, 300, 150, 80) }] });
    run([L2], [L2], "anchor", { fx: 1, fy: 1 });
    check("曲线遮罩：右下角 (550, 380)", nearV(L2.transform.anchorPoint.value, [550, 380], 1e-6), fmt(L2.transform.anchorPoint.value));
    // 两个顶点的「透镜」：曲线鼓到 y = ±37.5；只看顶点是 0，看切线手柄是 ±50，都不对
    const lens = { vertices: [[0, 0], [100, 0]], outTangents: [[0, -50], [0, 50]], inTangents: [[0, 50], [0, -50]], closed: true };
    const L3 = makeLayer({ rect: [-500, -500, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [{ shape: lens }] });
    run([L3], [L3], "anchor", { fx: 0, fy: 0 });
    check("曲线遮罩：曲线鼓出去的地方也算进外框 (0, -37.5)", nearV(L3.transform.anchorPoint.value, [0, -37.5], 1e-6), fmt(L3.transform.anchorPoint.value));
}

// 3. 选中了某个遮罩：只按选中的那个（刚画完的遮罩默认是选中的）；模式是「无」的参考遮罩被选中时也算
{
    const L = makeLayer({ rect: [0, 0, 1920, 1080], anchor: [960, 540], pos: [960, 540], masks: [{ shape: rectShape(0, 0, 200, 200) }, { shape: rectShape(1000, 600, 1200, 800), selected: true }] });
    const { r } = run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("选中的遮罩：锚点放到选中遮罩的中心 (1100, 700)", nearV(L.transform.anchorPoint.value, [1100, 700]), fmt(L.transform.anchorPoint.value));
    check("选中的遮罩：提示里说按选中的遮罩", /按选中的遮罩/.test(r.msg), r.msg);
    const G = makeLayer({ rect: [0, 0, 1920, 1080], anchor: [960, 540], pos: [960, 540], masks: [{ shape: rectShape(10, 10, 30, 30), mode: MaskMode.NONE, selected: true }] });
    run([G], [G], "anchor", { fx: 0.5, fy: 0.5 });
    check("参考遮罩（模式「无」、被选中）：锚点放到它的中心 (20, 20)", nearV(G.transform.anchorPoint.value, [20, 20]), fmt(G.transform.anchorPoint.value));
    const N = makeLayer({ rect: [0, 0, 1920, 1080], anchor: [0, 0], pos: [0, 0], masks: [{ shape: rectShape(10, 10, 30, 30), mode: MaskMode.NONE }] });
    run([N], [N], "anchor", { fx: 0.5, fy: 0.5 });
    check("模式「无」、没选中的遮罩不算：按整个内容 (960, 540)", nearV(N.transform.anchorPoint.value, [960, 540]), fmt(N.transform.anchorPoint.value));
}

// 4. 遮罩模式：相减不缩小范围；两个相加取并集；相交取交集；反转的相加 = 整个图层；扩展会让范围变大
{
    const mk = (masks) => makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks });
    const cases = [
        ["只有相减遮罩 → 按整个内容", [{ shape: rectShape(0, 0, 100, 100), mode: MaskMode.SUBTRACT }], [500, 500]],
        ["两个相加 → 并集的中心", [{ shape: rectShape(100, 100, 200, 200) }, { shape: rectShape(300, 300, 500, 400) }], [300, 250]],
        ["相加 + 相交 → 交集的中心", [{ shape: rectShape(0, 0, 400, 400) }, { shape: rectShape(200, 200, 600, 600), mode: MaskMode.INTERSECT }], [300, 300]],
        ["反转的相加 → 整个内容", [{ shape: rectShape(100, 100, 200, 200), inverted: true }], [500, 500]],
        ["反转的相减（= 只留遮罩里面）→ 遮罩中心", [{ shape: rectShape(100, 100, 300, 300), mode: MaskMode.SUBTRACT, inverted: true }], [200, 200]],
        ["扩展 20 px：外框各边大 20（中心不变，左上角变）", [{ shape: rectShape(100, 100, 300, 300), expansion: 20 }], [80, 80], 0]
    ];
    for (const [name, masks, want, f] of cases) {
        const L = mk(masks);
        const fx = f === undefined ? 0.5 : f;
        run([L], [L], "anchor", { fx, fy: fx });
        check("遮罩模式：" + name, nearV(L.transform.anchorPoint.value, want), fmt(L.transform.anchorPoint.value));
    }
    // 遮罩有一半在内容外面：按露出来的部分（交集）
    const T = makeLayer({ kind: "text", rect: [0, -40, 300, 50], anchor: [0, 0], pos: [500, 500], masks: [{ shape: rectShape(-100, -100, 150, 100) }] });
    run([T], [T], "anchor", { fx: 0.5, fy: 0.5 });
    check("遮罩超出文字：按露出来的部分 (75, -15)", nearV(T.transform.anchorPoint.value, [75, -15]), fmt(T.transform.anchorPoint.value));
}

// 5. 带缩放和旋转的图层：画面不动；带父级（父级缩放 + 旋转）也不动
{
    const P = makeLayer({ name: "父级", rect: [0, 0, 100, 100], anchor: [50, 50], pos: [800, 400], scale: [50, 80], rot: 30 });
    const L = makeLayer({ name: "子", rect: [0, 0, 400, 200], anchor: [0, 0], pos: [100, 50], scale: [120, -90], rot: -15, masks: [{ shape: rectShape(50, 20, 250, 180) }] });
    L.parent = P;
    const before = snapshot(L);
    run([L, P], [L], "anchor", { fx: 1, fy: 0 });
    check("父级缩放旋转 + 自己翻转：锚点到遮罩右上 (250, 20)", nearV(L.transform.anchorPoint.value, [250, 20]), fmt(L.transform.anchorPoint.value));
    check("父级缩放旋转 + 自己翻转：画面不动", same(before, snapshot(L)), fmt(snapshot(L)[0]) + " vs " + fmt(before[0]));
}

// 6. 位置有关键帧、分开维度：整条轨迹一起补，画面不动
{
    const L = makeLayer({ rect: [0, 0, 200, 100], anchor: [0, 0], pos: [300, 300], scale: [200, 200], separated: true });
    L.transform.property("ADBE Position_0").setValueAtTime(0, 300);
    L.transform.property("ADBE Position_0").setValueAtTime(1, 900);
    const before = snapshot(L);
    run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("分开维度 + 关键帧：锚点 (100, 50)", nearV(L.transform.anchorPoint.value, [100, 50]), fmt(L.transform.anchorPoint.value));
    check("分开维度 + 关键帧：两个关键帧都补了 +200", near(L.transform.property("ADBE Position_0").keyValue(1), 500) && near(L.transform.property("ADBE Position_0").keyValue(2), 1100), [L.transform.property("ADBE Position_0").keyValue(1), L.transform.property("ADBE Position_0").keyValue(2)].join(","));
    check("分开维度 + 关键帧：画面不动", same(before, snapshot(L)));
}

// 7. 3D 图层转过 X / Y、有方向：锚点补偿交给 AE 算（探针），画面不动；只转 Z 的 3D 图层不用探针
{
    const L = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [0, 0, 0], pos: [960, 540], z: 200, rotX: 35, rotY: -20, orient: [10, 25, 5], scale: [80, 120] });
    const before = snapshot(L);
    run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("3D 旋转：锚点 (200, 150)", nearV(L.transform.anchorPoint.value.slice(0, 2), [200, 150]), fmt(L.transform.anchorPoint.value));
    check("3D 旋转：画面不动（含 z）", same(before, snapshot(L)), fmt(snapshot(L)[1]) + " vs " + fmt(before[1]));
    check("3D 旋转：用了一次探针，用完删掉", L._probes === 1 && L._effects.length === 0, L._probes + " / " + L._effects.length);
    const Z = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [0, 0, 0], pos: [960, 540], rot: 45 });
    const bz = snapshot(Z);
    run([Z], [Z], "anchor", { fx: 0.5, fy: 0.5 });
    check("只转 Z 的 3D 图层：直接算，不用探针，画面不动", Z._probes === 0 && same(bz, snapshot(Z)));
    // 3D 图层挂在转过的父级下：位置在父级坐标里，补偿只看自己
    const P = makeLayer({ three: true, rect: [0, 0, 100, 100], anchor: [50, 50, 0], pos: [500, 500], rotY: 60 });
    const C = makeLayer({ three: true, rect: [0, 0, 200, 200], anchor: [0, 0, 0], pos: [10, 20], rotX: 30 });
    C.parent = P;
    const bc = snapshot(C);
    run([C, P], [C], "anchor", { fx: 1, fy: 1 });
    check("3D 子图层（父级转过 Y）：画面不动", same(bc, snapshot(C)), fmt(snapshot(C)[0]) + " vs " + fmt(bc[0]));
}

// 8. 形状图层：外框算上描边（sourceRectAtTime 的 extents）
{
    const S = makeLayer({ kind: "shape", rect: [-100, -50, 200, 100], strokeRect: [-110, -60, 220, 120], anchor: [0, 0], pos: [500, 500] });
    run([S], [S], "anchor", { fx: 0, fy: 0 });
    check("形状图层：左上角算上描边 (-110, -60)", nearV(S.transform.anchorPoint.value, [-110, -60]), fmt(S.transform.anchorPoint.value));
}

// 9. ⌥ 锚点贴到合成：带父级的也能贴（以前跳过）
{
    const P = makeLayer({ name: "父级", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [300, 200], scale: [50, 50], rot: 90 });
    const L = makeLayer({ name: "子", rect: [0, 0, 200, 100], anchor: [0, 0], pos: [40, 40] });
    L.parent = P;
    const { r } = run([L, P], [L], "anchor", { fx: 1, fy: 1, mods: { alt: true } });
    check("⌥ 贴到合成右下：带父级的图层也贴上了 (1920, 1080)", r.ok && nearV(anchorComp(L).slice(0, 2), [1920, 1080]), JSON.stringify(r) + " " + fmt(anchorComp(L)));
}

// 10. 居中到合成：按遮罩的中心居中；带父级的也居中；⌥ 按外框居中、不改锚点
{
    const L = makeLayer({ rect: [0, 0, 1920, 1080], anchor: [960, 540], pos: [960, 540], masks: [{ shape: rectShape(100, 100, 300, 200) }] });
    run([L], [L], "centerComp", {});
    check("居中：遮罩的中心到了合成中心", nearV(toComp(L, [200, 150]).slice(0, 2), [960, 540]), fmt(toComp(L, [200, 150])));
    const P = makeLayer({ name: "父级", rect: [0, 0, 10, 10], anchor: [0, 0], pos: [100, 100], scale: [200, 200], rot: 45 });
    const C = makeLayer({ name: "子", rect: [0, 0, 100, 60], anchor: [0, 0], pos: [30, 10] });
    C.parent = P;
    const { r } = run([C, P], [C], "centerComp", {});
    check("居中：带父级的图层也居中了（以前跳过）", r.ok && nearV(toComp(C, [50, 30]).slice(0, 2), [960, 540]), JSON.stringify(r) + " " + fmt(toComp(C, [50, 30])));
    const A = makeLayer({ rect: [0, 0, 200, 100], anchor: [0, 0], pos: [10, 10], rot: 90 });
    run([A], [A], "centerComp", { mods: { alt: true } });
    const b = compBoxOf(A, [0, 0, 200, 100]);
    check("⌥ 居中：外框中心到合成中心、锚点没改", near((b.l + b.r) / 2, 960) && near((b.t + b.b) / 2, 540) && nearV(A.transform.anchorPoint.value, [0, 0]), JSON.stringify(b));
}

// 11. 对齐：带父级的图层按它在合成里的外框对齐；父子都选中时子图层不会被移两次；⇧ 对齐到最上面的图层
{
    const P = makeLayer({ name: "父级", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [500, 300], scale: [50, 50] });
    const C = makeLayer({ name: "子", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [300, 100] });
    C.parent = P;
    const { r } = run([C, P], [C, P], "align", { mode: "left" });
    const bp = compBoxOf(P, [0, 0, 100, 100]), bc = compBoxOf(C, [0, 0, 100, 100]);
    check("左对齐到合成：父级和子图层的左边都在 x = 0", r.ok && near(bp.l, 0) && near(bc.l, 0), JSON.stringify(r) + " P " + bp.l + " C " + bc.l);
    const K = makeLayer({ name: "参照", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [700, 100] });
    const M = makeLayer({ name: "要动的", rect: [0, 0, 50, 50], anchor: [0, 0], pos: [100, 400], masks: [{ shape: rectShape(10, 10, 40, 40) }] });
    const r2 = run([K, M], [M, K], "align", { mode: "right", mods: { shift: true } }).r;
    check("⇧ 右对齐到最上面的图层：参照不动，遮罩的右边对齐到参照的右边", r2.ok && near(K.transform.position.value[0], 700) && near(toComp(M, [40, 0])[0], 800), JSON.stringify(r2) + " " + toComp(M, [40, 0])[0]);
    check("⇧ 对齐：提示里写了参照图层的名字", /「参照」/.test(r2.msg), r2.msg);
}

// 12. 分布：默认按中心等距；⌥ 按间距均分（两头不动，中间的空隙一样大）
{
    const mk = (x, w) => makeLayer({ rect: [0, 0, w, 50], anchor: [0, 0], pos: [x, 0] });
    const a = mk(0, 100), b = mk(150, 300), c = mk(1000, 100);
    const { r } = run([a, b, c], [a, b, c], "distribute", { horizontal: true, mods: { alt: true } });
    const gap1 = b.transform.position.value[0] - (0 + 100), gap2 = 1000 - (b.transform.position.value[0] + 300);
    check("⌥ 按间距均分：两个空隙一样大（各 300）", r.ok && near(gap1, 300) && near(gap2, 300), JSON.stringify(r) + " " + gap1 + " / " + gap2);
    const d = mk(0, 100), e = mk(150, 300), f = mk(1000, 100);
    run([d, e, f], [d, e, f], "distribute", { horizontal: true });
    check("按中心等距：中间那个的中心在两头中心的正中间", near(e.transform.position.value[0] + 150, (50 + 1050) / 2), e.transform.position.value[0]);
}

// 13. ⌥ 空对象：放到选中图层看得见的范围的中心；原来有同一个父级时，空对象接到那个父级下面，画面都不动
{
    const P = makeLayer({ name: "总控", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [250, 120], scale: [50, 50] });
    const A = makeLayer({ name: "A", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] });
    const Bm = makeLayer({ name: "B", rect: [0, 0, 400, 400], anchor: [0, 0], pos: [600, 200], masks: [{ shape: rectShape(0, 0, 200, 200) }] });
    A.parent = P; Bm.parent = P;
    const { r, comp } = run([A, Bm, P], [A, Bm], "nullLayer", { mods: { alt: true } });
    const nl = comp.layer(1);
    // A 在合成里：250..300 × 120..170；B 的遮罩部分：250+300=550..650 × 120+100=220..320 → 外框 250..650 × 120..320 → 中心 (450, 220)
    const nc = toComp(nl, nl.transform.anchorPoint.value);
    check("⌥ 空对象：在合成里正好放在选中图层（按遮罩）的中心 (450, 220)", r.ok && nearV(nc.slice(0, 2), [450, 220]), JSON.stringify(r) + " " + fmt(nc));
    check("⌥ 空对象：接到父级下面时缩放 100%、不旋转（选中的图层挂过来只换位置，不会被拉歪）", nearV(nl.transform.scale.value, [100, 100]) && near(nl.transform.property("ADBE Rotate Z").value, 0), fmt(nl.transform.scale.value));
    check("⌥ 空对象：接在原来的父级「总控」下面，A、B 挂到空对象上", nl.parent === P && A.parent === nl && Bm.parent === nl, [nl.parent && nl.parent.name, A.parent && A.parent.name, Bm.parent && Bm.parent.name].join(","));
    check("⌥ 空对象：提示里说接在原来的父级下面", /接在原来的父级「总控」下面/.test(r.msg), r.msg);
}
{
    // 选中的图层里有父子：子图层不单独挂到空对象上（它跟着它的父级走）
    const A = makeLayer({ name: "A", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] });
    const Bc = makeLayer({ name: "B", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [50, 50] });
    Bc.parent = A;
    const { r, comp } = run([A, Bc], [A, Bc], "nullLayer", { mods: { alt: true } });
    const nl = comp.layer(1);
    check("⌥ 空对象：父子都选中时只挂父级，子图层还挂在原来的父级上", A.parent === nl && Bc.parent === A && /1 个子图层跟着/.test(r.msg), r.msg);
}

// 14. 摄像机：跳过并说明；全是摄像机时报错说清楚
{
    const cam = makeLayer({ kind: "camera" });
    const L = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] });
    const { r } = run([cam, L], [cam, L], "anchor", { fx: 0.5, fy: 0.5 });
    check("摄像机 + 图层：图层照常，提示里说摄像机没有锚点", r.ok && /摄像机 \/ 灯光没有锚点/.test(r.msg) && nearV(L.transform.anchorPoint.value, [50, 50]), r.msg);
    const r2 = run([cam], [cam], "anchor", { fx: 0.5, fy: 0.5 }).r;
    check("只选了摄像机：报错并说怎么办", !r2.ok && /摄像机和灯光没有锚点/.test(r2.msg), r2.msg);
}

// 15. 滑动入场：带父级（父级缩放 50%）时滑的还是合成宽度的 1/4
{
    const P = makeLayer({ name: "父级", rect: [0, 0, 10, 10], anchor: [0, 0], pos: [0, 0], scale: [50, 50] });
    const L = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [400, 400] });
    L.parent = P;
    run([L, P], [L], "quickAnim", { kind: "slide", dir: "left", frames: 10 });
    const k1 = L.transform.position.keyValue(1), k2 = L.transform.position.keyValue(2);
    const slid = (toComp(P, k2)[0] - toComp(P, k1)[0]);
    check("滑动入场：父级缩放 50% 时，画面上仍然滑了合成宽度的 1/4（480 px）", near(slid, 480), slid);
}

// 16. 错开排列「按位置」：铺得宽就从左到右（和选择顺序无关），⌥ 反过来；铺得高就从上到下
{
    const mk = (name, x, y) => makeLayer({ name, rect: [0, 0, 100, 100], anchor: [0, 0], pos: [x, y] });
    const A = mk("A", 900, 0), B = mk("B", 100, 30), C = mk("C", 500, 10);
    const { r } = run([A, B, C], [A, B, C], "sequence", { order: "position", num: 1, step: 2 });
    const f = L => Math.round(L.startTime * 25);
    check("按位置错开：从左到右 B → C → A（不看选择顺序）", r.ok && f(B) === 0 && f(C) === 2 && f(A) === 4 && /从左到右/.test(r.msg), r.msg + " " + [f(A), f(B), f(C)].join(","));
    const D = mk("D", 0, 800), E = mk("E", 30, 100), F = mk("F", 10, 400);
    const r2 = run([D, E, F], [D, E, F], "sequence", { order: "position", num: 1, step: 3, mods: { alt: true } }).r;
    check("按位置错开 + ⌥：铺得高 → 从下到上 D → F → E", r2.ok && f(D) === 0 && f(F) === 3 && f(E) === 6 && /从下到上/.test(r2.msg), r2.msg + " " + [f(D), f(E), f(F)].join(","));
    // 带遮罩的图层按露出来的部分的中心排
    const M = makeLayer({ name: "M", rect: [0, 0, 1000, 100], anchor: [0, 0], pos: [0, 0], masks: [{ shape: rectShape(800, 0, 900, 100) }] });
    const N = mk("N", 400, 0);
    run([M, N], [M, N], "sequence", { order: "position", num: 1, step: 2 });
    check("按位置错开：带遮罩的按露出来的部分算（遮罩在右边 → 排在后面）", f(N) === 0 && f(M) === 2, [f(M), f(N)].join(","));
}

// 17. 循环 / 弹性：关键帧不够时照样加上表达式，但提示里说为什么看不出效果
{
    const mkProp = (keys) => ({ propertyType: 6212, canSetExpression: true, numKeys: keys, expression: "" });
    const comp = makeComp([]);
    const p0 = mkProp(0), p3 = mkProp(3);
    comp.selectedProperties = [p0];
    let h = loadHost(comp), r = h.call("loop", { mods: {} });
    check("循环：没有关键帧时也加上，并说明要至少 2 个关键帧", r.ok && p0.expression === 'loopOut("cycle");' && /关键帧不够：loopOut 要至少 2 个关键帧/.test(r.msg), r.msg);
    comp.selectedProperties = [p3];
    h = loadHost(comp); r = h.call("loop", { mods: { alt: true } });
    check("循环：关键帧够时不多说", r.ok && !/关键帧不够/.test(r.msg) && /往返/.test(r.msg), r.msg);
    const q0 = mkProp(0), q2 = mkProp(2);
    comp.selectedProperties = [q0, q2];
    h = loadHost(comp); r = h.call("bounce", { mods: {} });
    check("弹性：两个属性里 1 个没有关键帧 → 提示「1 个属性关键帧不够」", r.ok && /1 个属性关键帧不够/.test(r.msg), r.msg);
}

// 18. 审查回归（3.8.0）
{
    // ⇧ 对齐：参照层是另一个选中图层的子图层——参照层不能被父级带走
    const P = makeLayer({ name: "P", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [500, 0] });
    const K = makeLayer({ name: "K", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [200, 0] });   // 合成里在 700
    K.parent = P;
    const r = run([K, P], [K, P], "align", { mode: "left", mods: { shift: true } }).r;
    check("⇧ 对齐：参照层是另一个选中图层的子图层时，参照层不动，另一个对齐到它", r.ok && near(toComp(K, [0, 0])[0], 700) && near(toComp(P, [0, 0])[0], 700), JSON.stringify(r) + " K " + toComp(K, [0, 0])[0] + " P " + toComp(P, [0, 0])[0]);
}
{
    // 分布：一端是中间那个图层的子图层——两端都不能被带走
    const mk = (name, x) => makeLayer({ name, rect: [0, 0, 100, 50], anchor: [0, 0], pos: [x, 0] });
    const A = mk("A", 0), Bm = mk("B", 300), C = mk("C", 700);   // C 是 B 的子图层，合成里在 1000
    C.parent = Bm;
    run([A, Bm, C], [A, Bm, C], "distribute", { horizontal: true });
    const cx = L => toComp(L, [50, 0])[0];
    check("分布（按中心）：一端是中间图层的子图层时两端不动，中间在正中", near(cx(A), 50) && near(cx(C), 1050) && near(cx(Bm), 550), [cx(A), cx(Bm), cx(C)].join(" / "));
    const A2 = mk("A", 0), B2 = mk("B", 300), C2 = mk("C", 700);
    C2.parent = B2;
    run([A2, B2, C2], [A2, B2, C2], "distribute", { horizontal: true, mods: { alt: true } });
    const l = L => toComp(L, [0, 0])[0];
    check("分布（⌥ 按间距）：一端是中间图层的子图层时两端不动，空隙一样大", near(l(A2), 0) && near(l(C2), 1000) && near(l(B2) - 100, 1000 - (l(B2) + 100)), [l(A2), l(B2), l(C2)].join(" / "));
}
{
    // ⌥ 贴到合成：没有父级、自己转过 X 的 3D 图层（3.7.2 能贴，3.8 一开始退化成跳过）
    const L = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [0, 0, 0], pos: [960, 540], rotX: 30 });
    const r = run([L], [L], "anchor", { fx: 1, fy: 1, mods: { alt: true } }).r;
    const dr = drawnOf(L, L.transform.anchorPoint.value);
    check("⌥ 贴到合成：自己转过 X 的 3D 图层也贴上了（画面上锚点在合成右下角，透视算上）", r.ok && nearV(dr, [1920, 1080], 0.5) && !/没贴上/.test(r.msg), JSON.stringify(r) + " " + fmt(dr));
    // 居中：转过 Y 的 3D 图层挂在普通 2D 父级下
    const P = makeLayer({ name: "P", rect: [0, 0, 10, 10], anchor: [0, 0], pos: [100, 50], scale: [50, 50] });
    const C = makeLayer({ three: true, rect: [0, 0, 200, 100], anchor: [0, 0, 0], pos: [40, 40], rotY: 40 });
    C.parent = P;
    const before = snapshot(C);
    const r2 = run([C, P], [C], "centerComp", {}).r;
    const dc = drawnOf(C, C.transform.anchorPoint.value);
    check("居中：转过 Y 的 3D 图层挂在 2D 父级下也能居中（画面上锚点到合成中心）", r2.ok && nearV(dc, [960, 540], 0.5) && /已居中：1 个图层/.test(r2.msg), JSON.stringify(r2) + " " + fmt(dc));
    void before;
}
{
    // 遮罩：相交没有重叠（空）之后再相加——只算后面那个
    const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [
        { shape: rectShape(0, 0, 100, 100) }, { shape: rectShape(200, 0, 300, 100), mode: MaskMode.INTERSECT }, { shape: rectShape(500, 500, 600, 600) }] });
    run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("遮罩：相交没有重叠以后再相加，按后加的那个算 (550, 550)", nearV(L.transform.anchorPoint.value, [550, 550]), fmt(L.transform.anchorPoint.value));
}
{
    // 弹性：只有 1 个关键帧时看不出效果，要提示
    const comp = makeComp([]);
    const one = { propertyType: 6212, canSetExpression: true, numKeys: 1, expression: "" };
    comp.selectedProperties = [one];
    const r = loadHost(comp).call("bounce", { mods: {} });
    check("弹性：只有 1 个关键帧时也提示「至少 2 个关键帧」", r.ok && /至少 2 个关键帧/.test(r.msg), r.msg);
}

// 19. 第二轮复核回归（3.8.0）
{
    // 透视：3D 卡片转过 Y，⌥ 贴右上——画面上锚点正好在合成右上角（以前差 117 px 还说贴上了）
    const L = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [0, 0, 0], pos: [960, 540], rotY: 40 });
    const r = run([L], [L], "anchor", { fx: 1, fy: 0, mods: { alt: true } }).r;
    const d = drawnOf(L, L.transform.anchorPoint.value);
    check("透视：转过 Y 的 3D 卡片 ⌥ 贴右上，画面上正好在合成右上角", r.ok && nearV(d, [1920, 0], 0.5), JSON.stringify(r) + " " + fmt(d));
    // 只转了 Z、但在 z = 500 的 3D 图层：居中后画面上的锚点在合成中心
    const Z = makeLayer({ three: true, rect: [0, 0, 200, 200], anchor: [0, 0, 0], pos: [300, 200], z: 500 });
    run([Z], [Z], "centerComp", {});
    const dz = drawnOf(Z, Z.transform.anchorPoint.value);
    check("透视：z = 500 的 3D 图层居中，画面上的锚点在合成中心", nearV(dz, [960, 540], 0.5), fmt(dz));
}
{
    // 锚点由表达式控制（文字自动居中）：改了画面会跳，所以不改，并说明
    const expr = (L) => { const r = L._rect; return [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
    const T = makeLayer({ kind: "text", rect: [0, -80, 600, 100], anchor: [0, 0], pos: [960, 540], anchorExpr: (L) => expr(L) });
    const before = snapshot(T);
    const r = run([T], [T], "anchor", { fx: 0, fy: 0 }).r;
    check("锚点由表达式控制：画面不动，并说明没改", same(before, snapshot(T)) && !r.ok && /表达式/.test(r.msg), JSON.stringify(r));
    // 跟着数值走的表达式（value + [5, 0]）：照常改，画面不动
    const V = makeLayer({ rect: [0, 0, 200, 100], anchor: [0, 0], pos: [300, 300], anchorExpr: (L, t, v) => [v[0] + 5, v[1]] });
    const bv = snapshot(V);
    const r2 = run([V], [V], "anchor", { fx: 0.5, fy: 0.5 }).r;
    check("跟着数值走的锚点表达式：照常改，画面不动", r2.ok && same(bv, snapshot(V)) && /锚点已移到中心：1 个图层/.test(r2.msg), JSON.stringify(r2));
    // 位置由不看数值的表达式控制：改了会跳，还原
    const P = makeLayer({ rect: [0, 0, 200, 100], anchor: [0, 0], pos: [300, 300], posExpr: () => [500, 500] });
    const bp = snapshot(P);
    const r3 = run([P], [P], "anchor", { fx: 0.5, fy: 0.5 }).r;
    check("位置由不看数值的表达式控制：还原、画面不动，并说明", same(bp, snapshot(P)) && /表达式/.test(r3.msg) && nearV(P.transform.anchorPoint.valueAtTime(0, true), [0, 0]), JSON.stringify(r3));
}
{
    // 旋转过的图层上的圆形遮罩：左对齐后，画面上圆的最左边正好在 x = 0
    const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [500, 500], pos: [900, 500], rot: 45, masks: [{ shape: ellipseShape(500, 500, 100, 100) }] });
    run([L], [L], "align", { mode: "left" });
    let minX = Infinity;
    for (let i = 0; i < 720; i++) { const a = i / 720 * Math.PI * 2; minX = Math.min(minX, toComp(L, [500 + 100 * Math.cos(a), 500 + 100 * Math.sin(a)])[0]); }
    check("旋转 45° 的图层上的圆形遮罩：左对齐后圆的最左边在 x = 0（以前差 41 px）", Math.abs(minX) < 0.2, minX);
}
{
    // 遮罩：相交只碰到边（零面积），之后再相加——只算后加的
    const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [
        { shape: rectShape(0, 0, 100, 100) }, { shape: rectShape(100, 0, 200, 100), mode: MaskMode.INTERSECT }, { shape: rectShape(500, 500, 600, 600) }] });
    run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("遮罩：相交只碰到边以后再相加，按后加的算 (550, 550)", nearV(L.transform.anchorPoint.value, [550, 550]), fmt(L.transform.anchorPoint.value));
}
{
    // ⌥ 空对象：挂在 2D 父级下、转过 Y 的两张 3D 卡片——空对象放在它们画面上的中间（以前掉到合成中心）
    const rig = makeLayer({ name: "rig", rect: [0, 0, 10, 10], anchor: [0, 0], pos: [1500, 800] });
    const A = makeLayer({ name: "A", three: true, rect: [0, 0, 100, 100], anchor: [0, 0, 0], pos: [0, 0], rotY: 30 });
    const Bc = makeLayer({ name: "B", three: true, rect: [0, 0, 100, 100], anchor: [0, 0, 0], pos: [200, 0], rotY: -30 });
    A.parent = rig; Bc.parent = rig;
    const pts = [A, Bc].flatMap(L => [[0, 0], [100, 0], [0, 100], [100, 100]].map(q => toComp(L, q)));
    const { comp } = run([A, Bc, rig], [A, Bc], "nullLayer", { mods: { alt: true } });
    const nl = comp.layer(1), w = toComp(nl, nl.transform.anchorPoint.value);
    const want = [(Math.min(...pts.map(q => q[0])) + Math.max(...pts.map(q => q[0]))) / 2, (Math.min(...pts.map(q => q[1])) + Math.max(...pts.map(q => q[1]))) / 2, pts.reduce((a, q) => a + q[2], 0) / pts.length];
    check("⌥ 空对象：转过 Y 的 3D 卡片挂在父级下，空对象在卡片（世界坐标）范围的中心", nearV(w, want, 0.01), fmt(w) + " 应为 " + fmt(want));
}
{
    // 滑动入场：父级是转过 Y、缩放 50% 的 3D 图层——在合成（世界）里还是滑合成宽度的 1/4，不跑到纵深里
    const P = makeLayer({ name: "P", three: true, rect: [0, 0, 10, 10], anchor: [0, 0, 0], pos: [960, 540], rotY: 60, scale: [50, 50] });
    const C = makeLayer({ three: true, rect: [0, 0, 100, 100], anchor: [0, 0, 0], pos: [0, 0] });
    C.parent = P;
    run([C, P], [C], "quickAnim", { kind: "slide", dir: "left", frames: 12 });
    const k1 = C.transform.position.keyValue(1), k2 = C.transform.position.keyValue(2);
    const w1 = toComp(P, k1), w2 = toComp(P, k2);
    check("滑动入场：3D 父级下在世界里横着滑 480 px、不往纵深跑", near(w2[0] - w1[0], 480, 0.01) && near(w2[2] - w1[2], 0, 0.01) && near(w2[1] - w1[1], 0, 0.01), fmt(w1) + " → " + fmt(w2));
}
{
    // 跳过时说真实原因：父级是摄像机、开了自动定向，不再一律说「3D 旋转」
    const cam = makeLayer({ kind: "camera", name: "摄像机" });
    const H = makeLayer({ name: "HUD", rect: [0, 0, 100, 50], anchor: [0, 0], pos: [0, 0] });
    H.parent = cam;
    const r = run([H, cam], [H], "align", { mode: "left" }).r;
    check("对齐：父级是摄像机时说「父级是摄像机或灯光」", !r.ok && /父级是摄像机或灯光/.test(r.msg) && !/3D 旋转/.test(r.msg), r.msg);
    const O = makeLayer({ name: "定向", rect: [0, 0, 100, 50], anchor: [0, 0], pos: [100, 100], autoOrient: AutoOrientType.ALONG_PATH });
    const r2 = run([O], [O], "align", { mode: "left" }).r;
    check("对齐：开了自动定向时说「开了自动定向」", !r2.ok && /开了自动定向/.test(r2.msg), r2.msg);
}

// 20. 第三轮复核回归（3.8.0）
const outline = (L, pts) => { const q = pts.map(p => toComp(L, p)); return { l: Math.min(...q.map(p => p[0])), t: Math.min(...q.map(p => p[1])), r: Math.max(...q.map(p => p[0])), b: Math.max(...q.map(p => p[1])) }; };
const rectPts = (l, t, r, b) => [[l, t], [r, t], [l, b], [r, b]];
// 扩展过的矩形遮罩的真实轮廓（四个角是圆角）：每个角取一圈点
const grownRect = (l, t, r, b, e) => [[l, t], [r, t], [l, b], [r, b]].flatMap(c => Array.from({ length: 720 }, (_, i) => [c[0] + e * Math.cos(i / 720 * 2 * Math.PI), c[1] + e * Math.sin(i / 720 * 2 * Math.PI)]));
{
    // 旋转过的图层：相交只碰到边 / 隔着缝，再相加——只算后加的（以前合成里的外框互相重叠，当成有交集，差几百 px）
    for (const rot of [10, 30, 45]) for (const gap of [0, 50]) {
        const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [300, 300], pos: [700, 500], rot, masks: [
            { shape: rectShape(0, 0, 100, 100) }, { shape: rectShape(100 + gap, 0, 200 + gap, 100), mode: MaskMode.INTERSECT }, { shape: rectShape(500, 500, 600, 600) }] });
        const r = run([L], [L], "align", { mode: "left" }).r, b = outline(L, rectPts(500, 500, 600, 600));
        check("旋转 " + rot + "° 的图层：相交" + (gap ? "隔着缝" : "只碰到边") + "再相加，左对齐按后加的遮罩（左边在 x = 0）", r.ok && near(b.l, 0, 0.01), fmt([b.l, b.t]) + " " + r.msg);
    }
}
{
    // 旋转过的图层：相加 + 相交（两个矩形重叠）——按交出来的那块对齐（以前差 100–141 px）
    for (const rot of [30, 45]) {
        const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [500, 500], pos: [960, 540], rot, masks: [
            { shape: rectShape(100, 100, 600, 600) }, { shape: rectShape(400, 300, 900, 800), mode: MaskMode.INTERSECT }] });
        run([L], [L], "align", { mode: "left" });
        const b = outline(L, rectPts(400, 300, 600, 600));
        check("旋转 " + rot + "° 的图层：相加 + 相交，左对齐后交出来那块的左边在 x = 0", near(b.l, 0, 0.01), fmt([b.l]));
        run([L], [L], "align", { mode: "top" });
        const b2 = outline(L, rectPts(400, 300, 600, 600));
        check("旋转 " + rot + "° 的图层：相加 + 相交，顶对齐后交出来那块的上边在 y = 0", near(b2.t, 0, 0.01), fmt([b2.t]));
    }
    // 伸出图层边外的遮罩（裁一半）：按遮罩和图层的交集对齐（以前差 50 px）
    const L = makeLayer({ rect: [0, 0, 400, 400], anchor: [200, 200], pos: [960, 540], rot: 30, masks: [{ shape: rectShape(200, -100, 600, 300) }] });
    run([L], [L], "align", { mode: "left" });
    const b = outline(L, rectPts(200, 0, 400, 300));
    check("旋转 30° 的图层：遮罩伸出图层边外，左对齐按露出来的部分（左边在 x = 0）", near(b.l, 0, 0.01), fmt([b.l]));
}
{
    // 遮罩扩展 + 不等比缩放：横竖分开换算（以前按 √|det| 一样推，差 20 / 10 px）
    for (const ex of [40, -20]) for (const rot of [0, 30]) {
        const L = makeLayer({ rect: [0, 0, 400, 400], anchor: [200, 200], pos: [960, 540], scale: [200, 50], rot, masks: [{ shape: rectShape(100, 100, 300, 300), expansion: ex }] });
        const truth = () => ex > 0 ? outline(L, grownRect(100, 100, 300, 300, ex)) : outline(L, rectPts(100 - ex, 100 - ex, 300 + ex, 300 + ex));
        run([L], [L], "align", { mode: "left" });
        const bl = truth();
        run([L], [L], "align", { mode: "top" });
        const bt = truth();
        run([L], [L], "align", { mode: "right" });
        const br = truth();
        check("遮罩扩展 " + ex + "、缩放 200×50" + (rot ? "、旋转 " + rot + "°" : "") + "：左 / 上 / 右对齐都贴边", near(bl.l, 0, 0.2) && near(bt.t, 0, 0.2) && near(br.r, 1920, 0.2), fmt([bl.l, bt.t, br.r]));
    }
}
{
    // 3D 父级（不转）+ 它的 2D 子图层一起选中：⌥ 贴中心 / 居中，两个都到位（以前子图层先放好又被父级带走，差 386 px）
    for (const [tool, args, fx, fy] of [["anchor", { fx: 0.5, fy: 0.5, mods: { alt: true } }, 0.5, 0.5], ["anchor", { fx: 0, fy: 0, mods: { alt: true } }, 0, 0], ["centerComp", {}, 0.5, 0.5]]) {
        for (const order of ["PC", "CP"]) {
            const P = makeLayer({ name: "P", three: true, rect: [0, 0, 200, 200], anchor: [100, 100, 0], pos: [600, 400, 0] });
            const C = makeLayer({ name: "C", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [300, 50] });
            C.parent = P;
            const r = run([C, P], order === "PC" ? [P, C] : [C, P], tool, args).r;
            const target = [1920 * fx, 1080 * fy], dp = drawnOf(P, P.transform.anchorPoint.value), dc = drawnOf(C, C.transform.anchorPoint.value);
            check("3D 父级 + 2D 子级一起选中（" + tool + (args.mods && args.mods.alt ? " ⌥ " + gridNameOf(fx, fy) : "") + "，选中顺序 " + order + "）：两个的锚点都在 " + fmt(target),
                r.ok && nearV(dp, target, 0.5) && nearV(dc, target, 0.5) && /2 个图层/.test(r.msg), fmt(dp) + " " + fmt(dc) + " " + r.msg);
        }
    }
}
function gridNameOf(fx, fy) { return [["左上", "上中", "右上"], ["左中", "中心", "右中"], ["左下", "下中", "右下"]][fy * 2][fx * 2]; }
{
    // 2D 文字挂在转过 X / Y / Z 的 3D 父级下：居中、⌥ 贴左上都准（以前按两个方向各自修正，收不拢，还说没动其实动了）
    const mk = () => {
        const rig = makeLayer({ name: "rig", three: true, rect: [0, 0, 10, 10], anchor: [0, 0, 0], pos: [960, 540, 0], rotX: 30, rotY: 35, rot: 30 });
        const T = makeLayer({ name: "字", kind: "text", rect: [0, -60, 300, 80], anchor: [0, 0], pos: [150, -80] });
        T.parent = rig;
        return [T, rig];
    };
    let [T, rig] = mk();
    const r = run([T, rig], [T], "centerComp", {}).r, d = drawnOf(T, T.transform.anchorPoint.value);
    check("3D 父级（转过 X / Y / Z）下的 2D 文字：居中后锚点画在合成中心", r.ok && nearV(d, [960, 540], 0.5) && /已居中：1 个图层/.test(r.msg), fmt(d) + " " + r.msg);
    [T, rig] = mk();
    const r2 = run([T, rig], [T], "anchor", { fx: 0, fy: 0, mods: { alt: true } }).r, d2 = drawnOf(T, T.transform.anchorPoint.value);
    check("3D 父级（转过 X / Y / Z）下的 2D 文字：⌥ 贴左上，锚点画在 (0, 0)", r2.ok && nearV(d2, [0, 0], 0.5) && !/没贴上/.test(r2.msg), fmt(d2) + " " + r2.msg);
    // 父级转到侧面（Y 转 90°）：画面上移不动——不动它（画面不变），并说没居中
    const side = makeLayer({ name: "side", three: true, rect: [0, 0, 10, 10], anchor: [0, 0, 0], pos: [960, 540, 0], rotY: 90 });
    const S = makeLayer({ rect: [0, 0, 100, 100], anchor: [50, 50], pos: [0, 30] });
    S.parent = side;
    const before = snapshot(S);
    const r3 = run([S, side], [S], "centerComp", {}).r;
    check("父级转到侧面：居中不了时画面不动，并说没居中", same(before, snapshot(S)) && /没居中/.test(r3.msg), r3.msg);
}
{
    // 位置钉死（表达式不看数值）、锚点本来就在中心：居中 / ⌥ 贴中心都说「位置由表达式控制」，不再报「已居中」
    const P = makeLayer({ rect: [0, 0, 200, 100], anchor: [100, 50], pos: [300, 300], posExpr: () => [500, 500] });
    const r = run([P], [P], "centerComp", {}).r;
    check("位置钉死、锚点已在中心：居中说「位置由表达式控制」，位置没被改", !/已居中：1/.test(r.msg) && /表达式/.test(r.msg) && nearV(P.transform.position.valueAtTime(0, true), [300, 300]), JSON.stringify(r));
    const P3 = makeLayer({ three: true, rect: [0, 0, 200, 100], anchor: [100, 50, 0], pos: [800, 400, 0], posExpr: () => [500, 500, 0] });
    const r2 = run([P3], [P3], "anchor", { fx: 0.5, fy: 0.5, mods: { alt: true } }).r;
    check("3D、位置钉死、锚点已在中心：⌥ 贴中心说没贴上，藏起来的位置也没被推走", /表达式/.test(r2.msg) && nearV(P3.transform.position.valueAtTime(0, true), [800, 400, 0]), JSON.stringify(r2) + " " + fmt(P3.transform.position.valueAtTime(0, true)));
    // 锚点和位置的表达式都不看数值：改锚点什么也改不了——不改，并说明
    const B = makeLayer({ rect: [0, 0, 600, 60], anchor: [0, 0], pos: [300, 300], anchorExpr: () => [300, -30], posExpr: () => [960, 540] });
    const r3 = run([B], [B], "anchor", { fx: 0, fy: 0 }).r;
    check("锚点、位置的表达式都不看数值：锚点不改，并说明", !r3.ok && /表达式/.test(r3.msg) && nearV(B.transform.anchorPoint.valueAtTime(0, true), [0, 0]) && nearV(B.transform.position.valueAtTime(0, true), [300, 300]), JSON.stringify(r3));
    // 表达式图层 + 摄像机一起选中：两种原因都说
    const E = makeLayer({ kind: "text", rect: [0, -80, 600, 100], anchor: [0, 0], pos: [960, 540], anchorExpr: (L) => [300, -30] });
    const cam = makeLayer({ kind: "camera", name: "摄像机" });
    const r4 = run([E, cam], [E, cam], "anchor", { fx: 0, fy: 0 }).r;
    check("表达式图层 + 摄像机一起选中：失败说明里两种原因都有", !r4.ok && /表达式/.test(r4.msg) && /摄像机/.test(r4.msg), r4.msg);
    // 对齐：位置钉死的图层动不了，说明，不算进「已对齐」
    const K = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [300, 300], posExpr: () => [300, 300] });
    const r5 = run([K], [K], "align", { mode: "left" }).r;
    check("对齐：位置由表达式钉死的图层说「位置由表达式控制」，不算已对齐", /已对齐到合成：0 个图层/.test(r5.msg) && /表达式/.test(r5.msg) && nearV(K.transform.position.valueAtTime(0, true), [300, 300]), r5.msg);
}
{
    // ⌥ 空对象：没有父级、转过 Y、在 z = 1000 的卡片——空对象在卡片中心的世界坐标上（以前用透视后的位置再配上 z，又被透视一次，差 117 px）
    for (const z of [1000, -800]) {
        const L = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [200, 150, 0], pos: [1500, 300], z, rotY: 40 });
        const { comp } = run([L], [L], "nullLayer", { mods: { alt: true } });
        const nl = comp.layer(1), w = toComp(nl, nl.transform.anchorPoint.value);
        check("⌥ 空对象：转过 Y、z = " + z + " 的卡片，空对象在卡片中心的世界坐标上", nearV(w, [1500, 300, z], 0.01), fmt(w));
    }
    // 平放的 + 转过的卡片，都在 z = 1000：空对象在两张卡片世界范围的中心
    const F = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [0, 0, 0], pos: [400, 150], z: 1000 });
    const R = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [200, 150, 0], pos: [1500, 300], z: 1000, rotY: 40 });
    const pts = rectPts(0, 0, 400, 300).map(q => toComp(F, q)).concat(rectPts(0, 0, 400, 300).map(q => toComp(R, q)));
    const { comp } = run([F, R], [F, R], "nullLayer", { mods: { alt: true } });
    const nl = comp.layer(1), w = toComp(nl, nl.transform.anchorPoint.value);
    const want = [(Math.min(...pts.map(q => q[0])) + Math.max(...pts.map(q => q[0]))) / 2, (Math.min(...pts.map(q => q[1])) + Math.max(...pts.map(q => q[1]))) / 2, 1000];
    check("⌥ 空对象：平放的和转过的卡片放在一起，空对象在它们世界范围的中心", nearV(w, want, 0.01), fmt(w) + " 应为 " + fmt(want));
}
{
    // 依次排列「按位置」：3D 图层一律按透视后画出来的位置比（以前平放的按正交外框、转过的按透视点，混着比顺序会错）
    const A = makeLayer({ name: "A", three: true, rect: [0, 0, 100, 100], anchor: [50, 50, 0], pos: [1300, 540], z: 2000 });   // 画在 x ≈ 1154
    const B = makeLayer({ name: "B", three: true, rect: [0, 0, 100, 100], anchor: [50, 50, 0], pos: [1200, 540], rotY: 30 });   // 画在 x = 1200
    const C = makeLayer({ name: "C", three: true, rect: [0, 0, 100, 100], anchor: [50, 50, 0], pos: [1250, 540] });            // 画在 x = 1250
    const r = run([A, B, C], [C, B, A], "sequence", { order: "position", step: 2, num: 1, mods: {} }).r;
    check("依次排列按位置：3D 图层按画面上的位置从左到右（A、B、C）", r.ok && A.startTime < B.startTime && B.startTime < C.startTime, [A.startTime, B.startTime, C.startTime].join(", ") + " " + r.msg);
}
{
    // 滑动：2D 文字挂在转过 X 60° / Y 60° 的 3D 父级下——画面上滑的正好是合成的 1/4（以前只有 1/4 的 1/4 到 1/2）
    for (const [rx, ry, dir, want] of [[60, 0, "up", [0, -270]], [0, 60, "left", [-480, 0]], [45, 0, "down", [0, 270]], [0, 30, "right", [480, 0]]]) {
        const rig = makeLayer({ name: "rig", three: true, rect: [0, 0, 10, 10], anchor: [0, 0, 0], pos: [960, 540, 0], rotX: rx, rotY: ry });
        const T = makeLayer({ kind: "text", rect: [0, -60, 300, 80], anchor: [0, 0], pos: [0, 0] });
        T.parent = rig;
        run([T, rig], [T], "quickAnim", { kind: "slide", dir, frames: 12 });
        const k1 = T.transform.position.keyValue(1), k2 = T.transform.position.keyValue(2);
        const d1 = toComp(rig, k1), d2 = toComp(rig, k2);   // 2D 子图层画在父级里那一点压平后的位置（不透视）
        const slid = [d1[0] - d2[0], d1[1] - d2[1]];          // 起点 − 落点 = 滑动的方向和距离
        check("滑动：3D 父级（X " + rx + "° / Y " + ry + "°）下的 2D 文字，画面上滑 " + fmt(want), nearV(slid, want, 0.5), fmt(slid));
    }
}
{
    // 滑动：挂在转过的摄像机下的 HUD（3D）——沿摄像机的 x 滑，离摄像机的远近不变（以前沿世界的 x，HUD 一边滑一边变大变小）
    const cam = makeLayer({ name: "摄像机", three: true, rect: [0, 0, 1, 1], anchor: [0, 0, 0], pos: [960, 540], z: -2666.67, rotY: 30 });
    Object.setPrototypeOf(cam, CameraLayer.prototype);
    const H = makeLayer({ name: "HUD", three: true, rect: [0, 0, 200, 100], anchor: [0, 0, 0], pos: [0, 0], z: 1500 });
    H.parent = cam;
    run([H, cam], [H], "quickAnim", { kind: "slide", dir: "left", frames: 12 }, { activeCamera: cam });
    const k1 = H.transform.position.keyValue(1), k2 = H.transform.position.keyValue(2);
    check("滑动：摄像机下的 HUD 沿摄像机的 x 滑 480 px、深度不变", nearV([k2[0] - k1[0], k2[1] - k1[1], k2[2] - k1[2]], [480, 0, 0], 0.01), fmt(k1) + " → " + fmt(k2));
    // 没挂在摄像机下、但摄像机转过：也沿摄像机的 x 滑（画面上水平，离摄像机的距离不变）
    const W = makeLayer({ name: "W", three: true, rect: [0, 0, 200, 100], anchor: [0, 0, 0], pos: [960, 540], z: 0 });
    run([W, cam], [W], "quickAnim", { kind: "slide", dir: "left", frames: 12 }, { activeCamera: cam });
    const w1 = W.transform.position.keyValue(1), w2 = W.transform.position.keyValue(2);
    const camX = vecToWorld(cam, [1, 0, 0]), dw = [w2[0] - w1[0], w2[1] - w1[1], w2[2] - w1[2]];
    check("滑动：摄像机转过 Y 30° 时，3D 图层沿摄像机的 x 方向滑 480 px", nearV(dw, camX.map(v => v * 480), 0.01), fmt(dw));
}
{
    // 跳过的原因不止一种：逐条说（以前只说第一种）
    const X = makeLayer({ name: "X", three: true, rect: [0, 0, 100, 50], anchor: [0, 0, 0], pos: [100, 100], rotX: 20 });
    const cam = makeLayer({ kind: "camera", name: "摄像机" });
    const H = makeLayer({ name: "HUD", rect: [0, 0, 100, 50], anchor: [0, 0], pos: [0, 0] });
    H.parent = cam;
    const r = run([X, H, cam], [X, H], "align", { mode: "left" }).r;
    check("对齐：两种跳过原因都说（X / Y 旋转、父级是摄像机）", !r.ok && /带 X \/ Y 旋转/.test(r.msg) && /父级是摄像机或灯光/.test(r.msg), r.msg);
    const a = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] });
    const b = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [500, 0] });
    const r2 = run([X, H, cam, a, b], [X, H, a, b], "distribute", { horizontal: true }).r;
    check("分布：跳过的原因逐条说，不把一种原因套到所有跳过的图层上", !r2.ok && /1 个图层带 X \/ Y 旋转/.test(r2.msg) && /1 个图层的父级是摄像机或灯光/.test(r2.msg), r2.msg);
    // 「方向」只有 Z（0, 0, 45）：和 Z 旋转一样，照常对齐
    const O = makeLayer({ three: true, rect: [0, 0, 100, 100], anchor: [50, 50, 0], pos: [600, 400], orient: [0, 0, 45] });
    const r3 = run([O], [O], "align", { mode: "left" }).r, bo = outline(O, rectPts(0, 0, 100, 100));
    check("方向只有 Z 的 3D 图层：照常对齐（左边在 x = 0）", r3.ok && near(bo.l, 0, 0.01), fmt([bo.l]) + " " + r3.msg);
    // 「方向」带 X：说「方向带 X / Y 角度」，不说「X / Y 旋转」
    const O2 = makeLayer({ three: true, rect: [0, 0, 100, 100], anchor: [50, 50, 0], pos: [600, 400], orient: [20, 0, 0] });
    const r4 = run([O2], [O2], "align", { mode: "left" }).r;
    check("方向带 X 的 3D 图层：说「方向带 X / Y 角度」", !r4.ok && /方向带 X \/ Y 角度/.test(r4.msg), r4.msg);
}

// 21. 第四轮复核回归（3.8.0）
const circlePts = (cx, cy, r, N) => Array.from({ length: N }, (_, i) => [cx + r * Math.cos(i / N * 2 * Math.PI), cy + r * Math.sin(i / N * 2 * Math.PI)]);
const inRect = (p, R) => p[0] >= R[0] - 1e-9 && p[0] <= R[2] + 1e-9 && p[1] >= R[1] - 1e-9 && p[1] <= R[3] + 1e-9;
{
    // 遮罩按块算：伸到图层外面的相加遮罩不撑大范围
    const mk = (rot) => makeLayer({ rect: [0, 0, 1000, 1000], anchor: [500, 500], pos: [960, 540], rot, masks: [{ shape: rectShape(200, 200, 400, 400) }, { shape: rectShape(1100, 200, 1300, 400) }] });
    let L = mk(0);
    run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("遮罩按块：伸到图层外面的遮罩不算，锚点在露出来那块的中心 (300, 300)", nearV(L.transform.anchorPoint.value, [300, 300]), fmt(L.transform.anchorPoint.value));
    for (const rot of [0, 30]) {
        L = mk(rot);
        run([L], [L], "align", { mode: "right" });
        const b = outline(L, rectPts(200, 200, 400, 400));
        check("遮罩按块：旋转 " + rot + "°，伸到图层外面的遮罩不算，右对齐贴边", near(b.r, 1920, 0.01), fmt([b.r]));
    }
    // 相交遮罩夹在两个相加遮罩中间（谁也没碰到），后面再相加：只算后加的
    const G = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [
        { shape: rectShape(0, 0, 100, 100) }, { shape: rectShape(400, 0, 500, 100) }, { shape: rectShape(200, 0, 300, 100), mode: MaskMode.INTERSECT }, { shape: rectShape(700, 700, 800, 800) }] });
    run([G], [G], "anchor", { fx: 0.5, fy: 0.5 });
    check("遮罩按块：相交遮罩夹在两个相加遮罩中间，按后加的算 (750, 750)", nearV(G.transform.anchorPoint.value, [750, 750]), fmt(G.transform.anchorPoint.value));
    // 两块相加以后再相交：每块各自去交（旋转 30° / 45° 也准）
    for (const rot of [30, 45]) {
        const U = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [500, 500], pos: [960, 540], rot, masks: [
            { shape: rectShape(100, 100, 400, 400) }, { shape: rectShape(500, 500, 800, 800) }, { shape: rectShape(200, 200, 700, 700), mode: MaskMode.INTERSECT }] });
        run([U], [U], "align", { mode: "left" });
        const b = outline(U, rectPts(200, 200, 400, 400).concat(rectPts(500, 500, 700, 700)));
        check("遮罩按块：两块相加再相交，旋转 " + rot + "° 左对齐贴边", near(b.l, 0, 0.01), fmt([b.l]));
    }
}
{
    // 相减的矩形遮罩真的切掉范围；第一个遮罩是相减、反转的相交、反转的相加也一样
    const L1 = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [{ shape: rectShape(0, 0, 400, 400) }, { shape: rectShape(200, -50, 450, 450), mode: MaskMode.SUBTRACT }] });
    run([L1], [L1], "anchor", { fx: 0.5, fy: 0.5 });
    check("相减的矩形切掉右半边：锚点在剩下那块的中心 (100, 200)", nearV(L1.transform.anchorPoint.value, [100, 200]), fmt(L1.transform.anchorPoint.value));
    const L2 = makeLayer({ rect: [0, 0, 1000, 500], anchor: [0, 0], pos: [0, 0], masks: [{ shape: rectShape(0, 0, 600, 500), mode: MaskMode.SUBTRACT }] });
    run([L2], [L2], "anchor", { fx: 0.5, fy: 0.5 });
    check("第一个遮罩就是相减：从整个图层切掉，锚点在 (800, 250)", nearV(L2.transform.anchorPoint.value, [800, 250]), fmt(L2.transform.anchorPoint.value));
    const L3 = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [{ shape: rectShape(0, 0, 400, 400) }, { shape: rectShape(200, -50, 450, 450), mode: MaskMode.INTERSECT, inverted: true }] });
    run([L3], [L3], "anchor", { fx: 0.5, fy: 0.5 });
    check("反转的相交（= 切掉这个矩形）：锚点在 (100, 200)", nearV(L3.transform.anchorPoint.value, [100, 200]), fmt(L3.transform.anchorPoint.value));
    const L4 = makeLayer({ rect: [0, 0, 1000, 500], anchor: [0, 0], pos: [0, 0], masks: [{ shape: rectShape(0, 0, 600, 500), inverted: true }] });
    run([L4], [L4], "anchor", { fx: 0.5, fy: 0.5 });
    check("第一个遮罩是反转的相加（只露出外面）：锚点在 (800, 250)", nearV(L4.transform.anchorPoint.value, [800, 250]), fmt(L4.transform.anchorPoint.value));
}
{
    // 曲线遮罩被图层边裁掉：按裁剪后的形状算（缩放 50%、旋转 20° 的素材上，圆伸出右边）
    for (const rot of [20, 40, 60]) {
        const L = makeLayer({ rect: [0, 0, 1920, 1080], anchor: [960, 540], pos: [960, 540], scale: [50, 50], rot, masks: [{ shape: ellipseShape(1700, 540, 400, 400) }] });
        const pts = circlePts(1700, 540, 400, 20000).filter(q => inRect(q, [0, 0, 1920, 1080])).concat(
            Array.from({ length: 20001 }, (_, i) => [1920, i / 20000 * 1080]).filter(q => Math.hypot(q[0] - 1700, q[1] - 540) <= 400));
        run([L], [L], "align", { mode: "right" });
        const br = outline(L, pts);
        run([L], [L], "align", { mode: "bottom" });
        const bb = outline(L, pts);
        check("曲线遮罩被图层边裁掉（旋转 " + rot + "°）：右对齐、底对齐都贴边", near(br.r, 1920, 0.2) && near(bb.b, 1080, 0.2), fmt([br.r, bb.b]));
    }
    // 圆心在图层外面：锚点工具（图层坐标）也按裁剪后的形状
    const C = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [{ shape: ellipseShape(1050, 500, 200, 200) }] });
    run([C], [C], "anchor", { fx: 0.5, fy: 0.5 });
    check("圆心在图层外面的遮罩：锚点在露出来那块的中心 (925, 500)", nearV(C.transform.anchorPoint.value, [925, 500], 0.05), fmt(C.transform.anchorPoint.value));
}
{
    // ⌥ 空对象：转过 Y / Z 的 3D 卡片上的椭圆遮罩，按椭圆本身在世界里的范围（不按外框四个角，以前差 24 px）
    const A = makeLayer({ name: "A", rect: [0, 0, 200, 200], anchor: [0, 0], pos: [100, 400] });
    const B = makeLayer({ name: "B", three: true, rect: [0, 0, 1000, 1000], anchor: [500, 500, 0], pos: [1400, 540, 0], rotY: 40, rot: 45, masks: [{ shape: ellipseShape(500, 500, 400, 100) }] });
    const pts = [[0, 0], [200, 0], [0, 200], [200, 200]].map(q => toComp(A, q)).concat(circlePts(0, 0, 1, 20000).map(q => toComp(B, [500 + 400 * q[0], 500 + 100 * q[1]])));
    const want = [(Math.min(...pts.map(q => q[0])) + Math.max(...pts.map(q => q[0]))) / 2, (Math.min(...pts.map(q => q[1])) + Math.max(...pts.map(q => q[1]))) / 2];
    const { comp } = run([A, B], [A, B], "nullLayer", { mods: { alt: true } });
    const nl = comp.layer(1), w = toComp(nl, nl.transform.anchorPoint.value);
    check("⌥ 空对象：转过的卡片上的椭圆遮罩按椭圆本身的范围", nearV(w.slice(0, 2), want, 0.05), fmt(w) + " 应为 " + fmt(want));
}
{
    // 父级缩放是 0（弹出动画的第一帧）：转过 X / Y 的子图层改锚点算不出补偿——不改，并说明（以前改了锚点，等父级长大画面就跳了）
    const Pop = makeLayer({ name: "Pop", rect: [0, 0, 10, 10], anchor: [0, 0], pos: [960, 540], scale: [0, 0] });
    const Card = makeLayer({ name: "Card", three: true, rect: [0, 0, 400, 300], anchor: [0, 0, 0], pos: [-200, -150, 0], rotY: 35, rotX: 10 });
    Card.parent = Pop;
    const r = run([Card, Pop], [Card], "anchor", { fx: 0.5, fy: 0.5 }).r;
    check("父级缩放是 0：锚点不改，并说「父级缩放是 0」", !r.ok && /父级缩放是 0/.test(r.msg) && nearV(Card.transform.anchorPoint.value, [0, 0, 0]) && nearV(Card.transform.position.value, [-200, -150, 0]), JSON.stringify(r));
}
{
    // 在摄像机后面的 3D 卡片（默认摄像机在 z = -2667）：⌥ 贴不了，说明，不动它
    const L = makeLayer({ three: true, rect: [0, 0, 400, 300], anchor: [200, 150, 0], pos: [960, 540], z: -5000 });
    const bL = snapshot(L);
    const r = run([L], [L], "anchor", { fx: 0, fy: 0, mods: { alt: true } }).r;
    check("在摄像机后面的图层：⌥ 贴角说「在摄像机后面」，画面不动（只换了锚点）", /摄像机后面/.test(r.msg) && /其中 0 个贴到了合成的左上/.test(r.msg) && same(bL, snapshot(L)), JSON.stringify(r));
    // 带着摄像机的空对象（摄像机挂在它下面）：移它画面上看不出来——说明，不动它
    const N = makeLayer({ name: "N", three: true, rect: [0, 0, 100, 100], anchor: [50, 50, 0], pos: [960, 540, 0] });
    const cam = makeLayer({ name: "摄像机", three: true, rect: [0, 0, 1, 1], anchor: [0, 0, 0], pos: [0, 0], z: -2666.67 });
    Object.setPrototypeOf(cam, CameraLayer.prototype);
    cam.parent = N;
    const bN = snapshot(N);
    const r2 = run([N, cam], [N], "anchor", { fx: 0, fy: 0, mods: { alt: true } }, { activeCamera: cam }).r;
    check("带着摄像机的图层：⌥ 贴角说「带着摄像机」，画面不动（只换了锚点）", /带着摄像机/.test(r2.msg) && same(bN, snapshot(N)), JSON.stringify(r2));
}
{
    // ⌥ 空对象接在共同的父级下：深度按卡片画面所在的位置换到父级坐标（以前取锚点的 z，绕着锚点转的卡片会差 500）
    const rig = makeLayer({ name: "rig", three: true, rect: [0, 0, 10, 10], anchor: [0, 0, 0], pos: [1500, 300, 0] });
    const A = makeLayer({ name: "A", three: true, rect: [0, 0, 100, 100], anchor: [50, 50, -500], pos: [0, 0, 0] });
    const B = makeLayer({ name: "B", three: true, rect: [0, 0, 100, 100], anchor: [50, 50, -500], pos: [200, 0, 0] });
    A.parent = rig; B.parent = rig;
    const zA = toComp(A, [50, 50, 0])[2];
    const { comp } = run([A, B, rig], [A, B], "nullLayer", { mods: { alt: true } });
    const nl = comp.layer(1), w = toComp(nl, nl.transform.anchorPoint.value);
    check("⌥ 空对象接在父级下：深度是卡片画面所在的 z（" + zA + "）", near(w[2], zA, 0.01) && near(w[0], 1600, 0.01), fmt(w));
}
{
    // 快速动画从表达式之前的值出发：跟着数值走的表达式（value + [100, 0]）不再被算两遍，停下来的位置不跳
    const L = makeLayer({ rect: [0, 0, 200, 100], anchor: [0, 0], pos: [600, 400], posExpr: (L, t, v) => [v[0] + 100, v[1]] });
    const before = L.transform.position.valueAtTime(0, false);
    const { comp } = run([L], [L], "quickAnim", { kind: "slide", dir: "left", frames: 12 });
    const t1 = comp.time + 12 * comp.frameDuration, after = L.transform.position.valueAtTime(t1, false);
    check("滑动入场：位置带 value + [100, 0] 的表达式，停下来的位置和原来一样", nearV(after, before), fmt(before) + " → " + fmt(after));
    const F = makeLayer({ rect: [0, 0, 200, 100], anchor: [0, 0], pos: [600, 400] });
    F.transform.opacity = prop(100, { exprFn: (t, v) => v * 0.5 });
    run([F], [F], "quickAnim", { kind: "fade", frames: 12 });
    const o1 = F.transform.opacity.valueAtTime(12 * (1 / 25), false);
    check("淡入：透明度带 value * 0.5 的表达式，淡入后还是 50（以前变成 25）", near(o1, 50), o1);
    // 位置被表达式钉死：加的关键帧看不出来，要说
    const P = makeLayer({ rect: [0, 0, 200, 100], anchor: [0, 0], pos: [600, 400], posExpr: () => [600, 400] });
    const r = run([P], [P], "quickAnim", { kind: "slide", dir: "left", frames: 12 }).r;
    check("滑动：位置被表达式钉死时说「被表达式盖住」", r.ok && /被表达式盖住/.test(r.msg), r.msg);
}
{
    // 提示里的个数对得上
    const pin = makeLayer({ rect: [0, 0, 200, 100], anchor: [100, 50], pos: [400, 250], posExpr: () => [400, 250] });
    const r = run([pin], [pin], "anchor", { fx: 0.5, fy: 0.5, mods: { alt: true } }).r;
    check("⌥ 贴中心、位置钉死：标题说「其中 0 个贴到了合成的中心」，不说已经贴好", /其中 0 个贴到了合成的中心/.test(r.msg) && !/并贴到合成/.test(r.msg), r.msg);
    const m1 = makeLayer({ name: "m1", rect: [0, 0, 400, 400], anchor: [0, 0], pos: [100, 100], masks: [{ shape: rectShape(100, 100, 200, 200) }] });
    const m2 = makeLayer({ name: "m2", rect: [0, 0, 400, 400], anchor: [0, 0], pos: [600, 100], masks: [{ shape: rectShape(100, 100, 200, 200) }], posExpr: () => [600, 100] });
    const r2 = run([m1, m2], [m1, m2], "centerComp", {}).r;
    check("居中：一个居中了、一个位置钉死——「已居中：1 个图层」，按遮罩的说明只说居中了的那个", /已居中：1 个图层，按遮罩露出来的范围/.test(r2.msg), r2.msg);
    const K = makeLayer({ name: "参照", rect: [0, 0, 400, 400], anchor: [0, 0], pos: [500, 100], masks: [{ shape: rectShape(100, 100, 200, 200) }] });
    const M = makeLayer({ name: "M", rect: [0, 0, 400, 400], anchor: [0, 0], pos: [900, 300], masks: [{ shape: rectShape(100, 100, 200, 200) }] });
    const r3 = run([K, M], [K, M], "align", { mode: "left", mods: { shift: true } }).r;
    check("⇧ 对齐：按遮罩的个数不算参照层", /已对齐到「参照」：1 个图层（1 个按遮罩范围）/.test(r3.msg), r3.msg);
    const d1 = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] }), d2 = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [300, 0], posExpr: () => [300, 0] }), d3 = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [1000, 0] });
    const r4 = run([d1, d2, d3], [d1, d2, d3], "distribute", { horizontal: true }).r;
    check("分布：中间的图层动不了时直说「只分布了一部分」", /只分布了一部分/.test(r4.msg) && /表达式/.test(r4.msg), r4.msg);
}
{
    // 旋转跟着位置走的表达式（滚轮）：改锚点要补位置，补了旋转就变——还原，并说明
    const W = makeLayer({ rect: [0, 0, 200, 200], anchor: [0, 0], pos: [400, 300] });
    const rz = W.transform.property("ADBE Rotate Z"), base = rz.valueAtTime.bind(rz);
    rz.expression = "position[0] / 2"; rz.expressionEnabled = true;
    rz.valueAtTime = (t, pre) => (pre ? base(t, true) : W.transform.position.valueAtTime(t, false)[0] / 2);
    const before = snapshot(W);
    const r = run([W], [W], "anchor", { fx: 0.5, fy: 0.5 }).r;
    check("旋转带跟着位置的表达式：改锚点会让画面转，还原并说明", same(before, snapshot(W)) && /表达式/.test(r.msg), JSON.stringify(r));
}
{
    // 父级接近侧着（Y 转 89.95°）：2D 子图层左右方向压得只剩 0.1%——居中说转到了侧面、不动；上下照样能滑，左右不滑
    const side = makeLayer({ name: "side", three: true, rect: [0, 0, 10, 10], anchor: [0, 0, 0], pos: [960, 540, 0], rotY: 89.95 });
    const S = makeLayer({ rect: [0, 0, 100, 100], anchor: [50, 50], pos: [30, 30] });
    S.parent = side;
    const before = snapshot(S);
    const r = run([S, side], [S], "centerComp", {}).r;
    check("父级接近侧着：居中说「转到了侧面」，画面不动", /侧面/.test(r.msg) && same(before, snapshot(S)), r.msg);
    const T2 = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] });
    T2.parent = side;
    const r2 = run([T2, side], [T2], "quickAnim", { kind: "slide", dir: "up", frames: 12 }).r;
    const k1 = T2.transform.position.keyValue(1), k2 = T2.transform.position.keyValue(2);
    const d1 = toComp(side, k1), d2 = toComp(side, k2);
    check("父级接近侧着：上下方向照样滑 270 px", r2.ok && nearV([d1[0] - d2[0], d1[1] - d2[1]], [0, -270], 0.5), fmt([d1[0] - d2[0], d1[1] - d2[1]]) + " " + r2.msg);
    const T3 = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] });
    T3.parent = side;
    const r3 = run([T3, side], [T3], "quickAnim", { kind: "slide", dir: "left", frames: 12 }).r;
    check("父级接近侧着：往左滑不动，说明，不加关键帧", !r3.ok && /侧面/.test(r3.msg) && T3.transform.position.numKeys === 0, r3.msg);
}
{
    // 摄像机挂在缩放 200% 的空对象下：沿摄像机滑的距离不跟着缩放变（还是 480 px）
    const rigS = makeLayer({ name: "rig", three: true, rect: [0, 0, 10, 10], anchor: [0, 0, 0], pos: [960, 540], z: -2666.67, scale: [200, 200, 200] });
    const cam = makeLayer({ name: "摄像机", three: true, rect: [0, 0, 1, 1], anchor: [0, 0, 0], pos: [0, 0], rotY: 30 });
    Object.setPrototypeOf(cam, CameraLayer.prototype);
    cam.parent = rigS;
    const W = makeLayer({ name: "W", three: true, rect: [0, 0, 200, 100], anchor: [0, 0, 0], pos: [960, 540], z: 0 });
    run([W, cam, rigS], [W], "quickAnim", { kind: "slide", dir: "left", frames: 12 }, { activeCamera: cam });
    const w1 = W.transform.position.keyValue(1), w2 = W.transform.position.keyValue(2);
    const len = Math.hypot(w2[0] - w1[0], w2[1] - w1[1], w2[2] - w1[2]);
    check("摄像机挂在缩放过的父级下：沿摄像机滑的距离还是 480 px", near(len, 480, 0.01), len);
    // 对齐时选中了摄像机：说摄像机没动
    const a = makeLayer({ rect: [0, 0, 100, 100], anchor: [0, 0], pos: [300, 300] });
    const c2 = makeLayer({ kind: "camera", name: "摄像机2" });
    const r = run([a, c2], [a, c2], "align", { mode: "left" }).r;
    check("对齐时选中了摄像机：说「摄像机 / 灯光没动」", r.ok && /摄像机 \/ 灯光没动/.test(r.msg), r.msg);
}

{
    // 父级缩放几乎是 0（0.000001%）：也当成 0，不把子图层推到几百亿像素外
    const P = makeLayer({ name: "P", rect: [0, 0, 100, 100], anchor: [50, 50], pos: [960, 540], scale: [1e-6, 100], rot: 20 });
    const C = makeLayer({ name: "C", three: true, rect: [0, 0, 300, 200], anchor: [150, 100, 0], pos: [-150.5, -66.25], z: 24.1 });
    C.parent = P;
    const r = run([C, P], [C], "centerComp", {}).r;
    check("父级缩放几乎是 0：居中说「父级缩放是 0」，位置一点没变", /父级缩放是 0/.test(r.msg) && nearV(C.transform.position.value, [-150.5, -66.25, 24.1], 1e-9), JSON.stringify(r) + " " + fmt(C.transform.position.value));
    // 3D、位置有关键帧又被表达式钉住：量着贴贴不上，关键帧原样写回（不是加了又减）
    const K = makeLayer({ three: true, rect: [0, 0, 200, 100], anchor: [100, 50, 0], pos: [300, 300, 0], posExpr: () => [500, 400, 0] });
    K.transform.position.setValueAtTime(0, [300.123456789, 300.5, 0]); K.transform.position.setValueAtTime(1, [912345.678, -77.25, 40]);
    const r2 = run([K], [K], "anchor", { fx: 0.5, fy: 0.5, mods: { alt: true } }).r;
    check("量着贴贴不上：位置的关键帧原样写回", /表达式/.test(r2.msg) && K.transform.position.keyValue(1)[0] === 300.123456789 && K.transform.position.keyValue(2)[0] === 912345.678, r2.msg + " " + fmt(K.transform.position.keyValue(1)) + " " + fmt(K.transform.position.keyValue(2)));
}
{
    // 曲线遮罩和曲线遮罩相交：两个圆隔开（外框重叠、形状不重叠）→ 交不出东西，后面相加的才算
    const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [
        { shape: ellipseShape(200, 200, 150, 150) }, { shape: ellipseShape(430, 430, 150, 150), mode: MaskMode.INTERSECT }, { shape: rectShape(700, 700, 800, 800) }] });   // 圆心距 325 > 300：不重叠，外框重叠
    run([L], [L], "anchor", { fx: 0.5, fy: 0.5 });
    check("两个隔开的圆相交（外框重叠、形状不重叠）：按后加的遮罩算 (750, 750)", nearV(L.transform.anchorPoint.value, [750, 750], 0.05), fmt(L.transform.anchorPoint.value));
    // 两个椭圆相交（透镜形）：按交出来的形状对齐
    const E = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [500, 500], pos: [960, 540], masks: [
        { shape: ellipseShape(400, 500, 250, 200) }, { shape: ellipseShape(600, 500, 250, 200), mode: MaskMode.INTERSECT }] });
    const inBoth = q => ((q[0] - 400) / 250) ** 2 + ((q[1] - 500) / 200) ** 2 <= 1 + 1e-12 && ((q[0] - 600) / 250) ** 2 + ((q[1] - 500) / 200) ** 2 <= 1 + 1e-12;
    const lens = circlePts(0, 0, 1, 40000).map(q => [400 + 250 * q[0], 500 + 200 * q[1]]).concat(circlePts(0, 0, 1, 40000).map(q => [600 + 250 * q[0], 500 + 200 * q[1]])).filter(inBoth);
    run([E], [E], "align", { mode: "top" });
    const bt = outline(E, lens);
    run([E], [E], "align", { mode: "left" });
    const bl = outline(E, lens);
    check("两个椭圆相交（透镜形）：顶对齐、左对齐按交出来的形状（差不到 0.2 px）", near(bt.t, 0, 0.2) && near(bl.l, 0, 0.2), fmt([bt.t, bl.l]));
}

{
    // 第一个遮罩是相减、但被负的扩展收没了：它还是「第一个」——从整个图层开始，后面反转的相加不会把范围缩小
    const L = makeLayer({ rect: [0, 0, 1000, 1000], anchor: [0, 0], pos: [0, 0], masks: [
        { shape: rectShape(300, 950, 420, 1010), mode: MaskMode.SUBTRACT, expansion: -40 }, { shape: rectShape(-300, 700, 50, 1300), inverted: true }] });
    run([L], [L], "anchor", { fx: 1, fy: 1 });
    check("被收没的第一个相减遮罩还算「第一个」：范围是整个图层，锚点在右下 (1000, 1000)", nearV(L.transform.anchorPoint.value, [1000, 1000]), fmt(L.transform.anchorPoint.value));
}
{
    // 位置取整的父级，下面有贴着摄像机的 3D 子图层：改父级的锚点差 0.2 px，子图层会被透视放大——还原，并说明
    const N = makeLayer({ name: "N", rect: [0, 0, 101, 101], anchor: [0, 0], pos: [960.3, 540.4], posExpr: (L, t, v) => v.map(Math.round) });
    const C = makeLayer({ name: "C", three: true, rect: [0, 0, 50, 50], anchor: [0, 0, 0], pos: [0, 0], z: -2600 });
    C.parent = N;
    const bC = snapshot(C), dC = drawnOf(C, [0, 0, 0]);
    const r = run([N, C], [N], "anchor", { fx: 0.5, fy: 0.5 }).r;
    const dC2 = drawnOf(C, [0, 0, 0]);
    check("取整表达式的父级：子图层离摄像机很近时不改锚点（子图层画面不动），并说明", /表达式/.test(r.msg) && Math.hypot(dC2[0] - dC[0], dC2[1] - dC[1]) < 0.01, r.msg + " " + fmt(dC) + " → " + fmt(dC2));
    // 没有子图层时照常改（取整只差不到半个像素）
    const N2 = makeLayer({ name: "N2", rect: [0, 0, 101, 101], anchor: [0, 0], pos: [960.3, 540.4], posExpr: (L, t, v) => v.map(Math.round) });
    const r2 = run([N2], [N2], "anchor", { fx: 0.5, fy: 0.5 }).r;
    check("取整表达式、没有子图层：照常改锚点", r2.ok && /锚点已移到中心：1 个图层/.test(r2.msg), r2.msg);
}

console.log(failures ? "✗ 图层工具测试：" + failures + " 项没通过" : "✓ 图层工具测试全部通过");
process.exit(failures ? 1 : 0);
