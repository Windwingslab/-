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
        _v: value, _keys: [], expression: "", expressionError: "", dimensionsSeparated: !!o.separated, name: o.name || "",
        get numKeys() { return this._keys.length; },
        get value() { return this.valueAtTime(0, false); },
        valueAtTime(t, pre) {
            if (this.expression && o.evalExpr && !pre) return o.evalExpr(this.expression, t);
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
        anchorPoint: prop(vec(o.anchor || [0, 0])),
        position: prop(pos, { separated: sep }),
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
        property(n) { return n === "ADBE Mask Shape" ? this._shape : n === "ADBE Mask Expansion" ? this._exp : null; }
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
        moveBefore() {}, _masks: masks, _effects: effects
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
    let v = [(p[0] - A[0]) * S[0] / 100, (p[1] - A[1]) * S[1] / 100, L.threeDLayer ? ((p[2] || 0) - (A[2] || 0)) * (S[2] || 100) / 100 : 0];
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
function evalProbe(L, expr, t) {
    const m = /toWorldVec\(\[([^\]]+)\],\s*([^)]+)\)/.exec(expr);
    if (!m || !/hasParent \? thisLayer\.parent\.fromWorldVec\(v, /.test(expr)) throw new Error("看不懂的表达式：" + expr);
    const v = m[1].split(",").map(Number), tt = Number(m[2]);
    const w = vecToWorld(L, v, tt);
    return L.parent ? vecFromWorld(L.parent, w, tt) : w;
}

function makeComp(layers, o) {
    o = o || {};
    const comp = Object.assign(Object.create(CompItem.prototype), {
        name: "合成", width: o.width || 1920, height: o.height || 1080, time: o.time || 0, frameDuration: 1 / 25,
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
    const P = makeLayer({ name: "总控", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [200, 100], scale: [50, 50] });
    const A = makeLayer({ name: "A", rect: [0, 0, 100, 100], anchor: [0, 0], pos: [0, 0] });
    const Bm = makeLayer({ name: "B", rect: [0, 0, 400, 400], anchor: [0, 0], pos: [600, 200], masks: [{ shape: rectShape(0, 0, 200, 200) }] });
    A.parent = P; Bm.parent = P;
    const { r, comp } = run([A, Bm, P], [A, Bm], "nullLayer", { mods: { alt: true } });
    const nl = comp.layer(1);
    // A 在合成里：200..250 × 100..150；B 的遮罩部分：200+300=500..600 × 100+100=200..300 → 外框 200..600 × 100..300 → 中心 (400, 200)
    check("⌥ 空对象：放在选中图层（按遮罩）的中心 (400, 200)", r.ok && nl._posWhenParented && nearV(nl._posWhenParented, [400, 200]), JSON.stringify(r) + " " + (nl._posWhenParented && fmt(nl._posWhenParented)));
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

console.log(failures ? "✗ 图层工具测试：" + failures + " 项没通过" : "✓ 图层工具测试全部通过");
process.exit(failures ? 1 : 0);
