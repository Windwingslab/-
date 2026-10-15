/*
    MotionHub 后台（ExtendScript）
    由 CEP 面板通过 evalScript 调用：MH.call("工具名", {参数})，返回 JSON 字符串 {ok, msg, data}
*/

var MH = (function () {
    var VERSION = "3.1.0";
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
    function q(s) {
        return '"' + String(s)
            .replace(/\\/g, "\\\\").replace(/"/g, '\\"')
            .replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
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
            prop.setValue(addVec(prop.value, d));
        } else {
            for (var k = 1; k <= prop.numKeys; k++) prop.setValueAtKey(k, addVec(prop.keyValue(k), d));
        }
    }

    function moveLayerBy(layer, dx, dy) {
        var tr = layer.transform;
        if (tr.position.dimensionsSeparated) {
            offsetProp(tr.property("ADBE Position_0"), [dx]);
            offsetProp(tr.property("ADBE Position_1"), [dy]);
        } else {
            offsetProp(tr.position, [dx, dy]);
        }
    }

    function layerPosition(layer, t) {
        var tr = layer.transform;
        if (tr.position.dimensionsSeparated) {
            return [tr.property("ADBE Position_0").valueAtTime(t, false),
                    tr.property("ADBE Position_1").valueAtTime(t, false)];
        }
        return tr.position.valueAtTime(t, false);
    }

    // 图层在父空间中的包围盒（不考虑父级，2D）
    function layerBounds(layer, t) {
        var r = layer.sourceRectAtTime(t, false);
        var tr = layer.transform;
        var a = tr.anchorPoint.valueAtTime(t, false);
        var s = tr.scale.valueAtTime(t, false);
        var p = layerPosition(layer, t);
        var rot = tr.property("ADBE Rotate Z").valueAtTime(t, false) * Math.PI / 180;
        var cs = Math.cos(rot), sn = Math.sin(rot);
        var pts = [[r.left, r.top], [r.left + r.width, r.top],
                   [r.left, r.top + r.height], [r.left + r.width, r.top + r.height]];
        var b = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
        for (var i = 0; i < 4; i++) {
            var x = (pts[i][0] - a[0]) * s[0] / 100;
            var y = (pts[i][1] - a[1]) * s[1] / 100;
            var cx = p[0] + x * cs - y * sn;
            var cy = p[1] + x * sn + y * cs;
            if (cx < b.l) b.l = cx;
            if (cx > b.r) b.r = cx;
            if (cy < b.t) b.t = cy;
            if (cy > b.b) b.b = cy;
        }
        return b;
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
    function setAnchor(layer, fx, fy, t) {
        var r = layer.sourceRectAtTime(t, false);
        var tr = layer.transform;
        var a = tr.anchorPoint.valueAtTime(t, false);
        var dx = r.left + r.width * fx - a[0];
        var dy = r.top + r.height * fy - a[1];
        if (dx === 0 && dy === 0) return;
        var s = tr.scale.valueAtTime(t, false);
        var rot = tr.property("ADBE Rotate Z").valueAtTime(t, false) * Math.PI / 180;
        var sx = dx * s[0] / 100, sy = dy * s[1] / 100;
        offsetProp(tr.anchorPoint, [dx, dy]);
        moveLayerBy(layer, sx * Math.cos(rot) - sy * Math.sin(rot), sx * Math.sin(rot) + sy * Math.cos(rot));
    }

    var T = {};

    T.anchor = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), n = 0, skipped = 0;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) continue;
            setAnchor(L, a.fx, a.fy, comp.time);
            if (a.mods.alt) {
                if (L.parent) { skipped++; } else {
                    var p = layerPosition(L, comp.time);
                    moveLayerBy(L, comp.width * a.fx - p[0], comp.height * a.fy - p[1]);
                }
            }
            n++;
        }
        return (a.mods.alt ? "锚点已设置并贴到合成对应位置：" : "锚点已设置：") + n + " 个图层" +
            (skipped ? "（" + skipped + " 个带父级的图层未移动）" : "");
    };

    T.centerComp = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), skipped = 0;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) continue;
            if (L.parent) { skipped++; continue; }
            if (!a.mods.alt) setAnchor(L, 0.5, 0.5, comp.time);
            var p = layerPosition(L, comp.time);
            if (a.mods.alt) {
                var b = layerBounds(L, comp.time);
                moveLayerBy(L, comp.width / 2 - (b.l + b.r) / 2, comp.height / 2 - (b.t + b.b) / 2);
            } else {
                moveLayerBy(L, comp.width / 2 - p[0], comp.height / 2 - p[1]);
            }
        }
        return "已居中" + (skipped ? "（跳过 " + skipped + " 个带父级的图层）" : "");
    };

    T.nullLayer = function (a) {
        var comp = activeComp(), sel = comp.selectedLayers;
        var nl = comp.layers.addNull();
        nl.name = uniqueLayerName(comp, "控制器");
        nl.label = 2;
        if (!sel.length) return "已新建空对象";
        nl.moveBefore(topmost(sel));
        if (!a.mods.alt) return "已新建空对象";
        // Alt：放到选中图层中心并设为父级
        var sx = 0, sy = 0, n = 0, any3D = false;
        for (var i = 0; i < sel.length; i++) {
            if (sel[i].threeDLayer) any3D = true;
            if (!sel[i].parent) {
                var p = layerPosition(sel[i], comp.time);
                sx += p[0]; sy += p[1]; n++;
            }
        }
        if (any3D) nl.threeDLayer = true;
        if (n) {
            var pos = [sx / n, sy / n];
            if (any3D) pos.push(0);
            nl.transform.position.setValue(pos);
        }
        for (var j = 0; j < sel.length; j++) if (!sel[j].parent) sel[j].parent = nl;
        return "已新建空对象并设为 " + sel.length + " 个图层的父级";
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

    T.align = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), t = comp.time, list = [], skipped = 0, i;
        for (i = 0; i < layers.length; i++) {
            if (!isTransformable(layers[i])) continue;
            if (layers[i].parent) { skipped++; continue; }
            list.push({ L: layers[i], b: layerBounds(layers[i], t) });
        }
        // 默认对齐到合成；Alt 对齐到选区（所有选中图层的整体包围盒）
        var ref = { l: 0, t: 0, r: comp.width, b: comp.height };
        if (a.mods.alt) {
            if (list.length < 2) fail("对齐到选区需要至少 2 个图层");
            ref = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
            for (i = 0; i < list.length; i++) {
                ref.l = Math.min(ref.l, list[i].b.l); ref.t = Math.min(ref.t, list[i].b.t);
                ref.r = Math.max(ref.r, list[i].b.r); ref.b = Math.max(ref.b, list[i].b.b);
            }
        }
        for (i = 0; i < list.length; i++) {
            var b = list[i].b, dx = 0, dy = 0;
            if (a.mode === "left") dx = ref.l - b.l;
            else if (a.mode === "hcenter") dx = (ref.l + ref.r) / 2 - (b.l + b.r) / 2;
            else if (a.mode === "right") dx = ref.r - b.r;
            else if (a.mode === "top") dy = ref.t - b.t;
            else if (a.mode === "vcenter") dy = (ref.t + ref.b) / 2 - (b.t + b.b) / 2;
            else if (a.mode === "bottom") dy = ref.b - b.b;
            moveLayerBy(list[i].L, dx, dy);
        }
        return "已对齐到" + (a.mods.alt ? "选区" : "合成") + (skipped ? "（跳过 " + skipped + " 个带父级的图层）" : "");
    };

    T.distribute = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 3), t = comp.time, list = [];
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L) || L.parent) continue;
            var b = layerBounds(L, t);
            list.push({ L: L, c: a.horizontal ? (b.l + b.r) / 2 : (b.t + b.b) / 2 });
        }
        if (list.length < 3) fail("需要至少 3 个无父级的图层");
        list.sort(function (x, y) { return x.c - y.c; });
        var first = list[0].c, step = (list[list.length - 1].c - first) / (list.length - 1);
        for (var j = 1; j < list.length - 1; j++) {
            var d = first + step * j - list[j].c;
            moveLayerBy(list[j].L, a.horizontal ? d : 0, a.horizontal ? 0 : d);
        }
        return "已均匀分布 " + list.length + " 个图层";
    };

    // 依次排列：每 num 个图层一组，组与组之间错开 step 帧
    // order：forward 正序 / reverse 倒序 / center 从中间向两边 / random 随机；Alt 倒序、Shift 随机
    T.sequence = function (a) {
        var comp = activeComp(), sel = needLayers(comp, 2), layers = [], i;
        for (i = 0; i < sel.length; i++) layers.push(sel[i]);
        var order = a.order || "forward";
        if (a.mods.alt) order = "reverse";
        if (a.mods.shift) order = "random";
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
        }
        var base = Infinity;
        for (i = 0; i < layers.length; i++) base = Math.min(base, layers[i].inPoint);
        for (i = 0; i < rank.length; i++) {
            var L = layers[rank[i]], g = Math.floor(i / num);
            L.startTime += (base + g * step * comp.frameDuration) - L.inPoint;
        }
        var names = { forward: "正序", reverse: "倒序", center: "从中间", random: "随机" };
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

    T.quickAnim = function (a) {
        var comp = activeComp(), layers = needLayers(comp, 1), out = !!a.mods.alt, n = 0;
        var dur = Math.max(1, a.frames || 12) * comp.frameDuration;
        var t0 = out ? comp.time - dur : comp.time, t1 = t0 + dur;
        var tRest = out ? t0 : t1, b = out ? EASE_IN : EASE_OUT;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) continue;
            var tr = L.transform, p, base;
            if (a.kind === "fade") {
                p = tr.opacity; base = p.valueAtTime(tRest, false);
                keySegments(p, [t0, t1], out ? [base, 0] : [0, base], b);
            } else if (a.kind === "scale") {
                p = tr.scale; base = p.valueAtTime(tRest, false);
                var t2 = t0 + dur * (out ? 0.4 : 0.6);
                keySegments(p, [t0, t2, t1], out ? [base, scaleVec(base, 1.1), scaleVec(base, 0)] : [scaleVec(base, 0), scaleVec(base, 1.1), base], [0.33, 0, 0.2, 1]);
            } else if (a.kind === "slide") {
                var dist = (a.dir === "left" || a.dir === "right") ? comp.width * 0.25 : comp.height * 0.25;
                var dx = a.dir === "left" ? -dist : a.dir === "right" ? dist : 0;
                var dy = a.dir === "up" ? -dist : a.dir === "down" ? dist : 0;
                if (tr.position.dimensionsSeparated) {
                    var px = tr.property("ADBE Position_0"), py = tr.property("ADBE Position_1");
                    var bx = px.valueAtTime(tRest, false), by = py.valueAtTime(tRest, false);
                    if (dx) keySegments(px, [t0, t1], out ? [bx, bx + dx] : [bx + dx, bx], b);
                    if (dy) keySegments(py, [t0, t1], out ? [by, by + dy] : [by + dy, by], b);
                } else {
                    p = tr.position; base = p.valueAtTime(tRest, false);
                    var moved = addVec(base, [dx, dy]);
                    keySegments(p, [t0, t1], out ? [base, moved] : [moved, base], b);
                }
            } else if (a.kind === "rotate") {
                p = tr.property("ADBE Rotate Z"); base = p.valueAtTime(tRest, false);
                keySegments(p, [t0, t1], out ? [base, base + 90] : [base - 90, base], b);
            } else if (a.kind === "blur") {
                var fxs = L.property("ADBE Effect Parade");
                if (!fxs) continue;
                var blur = fxs.property("MH 模糊") || fxs.addProperty("ADBE Gaussian Blur 2");
                blur.name = "MH 模糊";
                p = fxs.property("MH 模糊").property(1);
                keySegments(p, [t0, t1], out ? [0, 40] : [40, 0], b);
            }
            n++;
        }
        var names = { fade: "透明度", scale: "缩放", slide: "滑动", rotate: "旋转", blur: "模糊" };
        return "已添加" + names[a.kind] + (out ? "出场" : "入场") + "动画：" + n + " 个图层，" + (a.frames || 12) + " 帧";
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
        return "已添加" + label + " loopOut(\"" + type + "\")：" + setExpr(props, 'loopOut("' + type + '");') + " 个属性";
    };

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
        return "已添加" + (a.mods.alt ? "强" : "") + "弹性：" + setExpr(props, code) + " 个属性";
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
    function ensureFolder(f) {
        if (!f.exists) {
            if (f.parent && !f.parent.exists) ensureFolder(f.parent);
            f.create();
        }
        return f;
    }

    function libRoot() {
        var p = state.libPath || (Folder.myDocuments.fsName + "/MotionHub/Library");
        return ensureFolder(new Folder(p));
    }

    function copyFolder(src, dst) {
        ensureFolder(dst);
        var items = src.getFiles();
        for (var i = 0; i < items.length; i++) {
            var target = dst.fsName + "/" + File.decode(items[i].name);
            if (items[i] instanceof Folder) copyFolder(items[i], new Folder(target));
            else if (!new File(target).exists) items[i].copy(target);
        }
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
        var items = dir.getFiles();
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
        var list = [], dirs = libRoot().getFiles();
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
        return { libPath: libRoot().fsName, version: VERSION, ae: app.version, canWrite: canWriteFiles(), os: IS_WIN ? "win" : "mac" };
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

    LIB.importSamples = function () {
        if (!EXT_ROOT) fail("找不到插件目录");
        var src = new Folder(EXT_ROOT.fsName + "/library_seed");
        if (!src.exists) fail("没有找到示例脚本文件夹");
        copyFolder(src, libRoot());
        return "示例脚本已导入";
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
        if (cat && cat !== "未分类") target = ensureFolder(new Folder(root.fsName + "/" + cat));
        var keys = [], panels = 0;
        for (var i = 0; i < a.paths.length; i++) {
            var f = new File(a.paths[i]);
            if (!f.exists) continue;
            var dest = new File(target.fsName + "/" + File.decode(f.name));
            if (dest.fsName !== f.fsName) {
                if (dest.exists) dest.remove();
                if (!f.copy(dest.fsName)) fail("复制失败：" + File.decode(f.name));
            }
            keys.push(dest.fsName.substring(root.fsName.length).replace(/\\/g, "/"));
            if (a.toPanels && /\.(jsx|jsxbin)$/i.test(f.name)) {
                var pf = ensureFolder(userPanelsFolder());
                if (f.copy(pf.fsName + "/" + File.decode(f.name))) panels++;
            }
        }
        return { keys: keys, msg: "已添加 " + keys.length + " 个文件" + (a.toPanels ? "，" + panels + " 个已装到 ScriptUI Panels（重启 AE 生效）" : "") };
    };

    LIB.run = function (a) {
        var f = new File(a.path);
        if (!f.exists) fail("文件不存在，请刷新脚本库");
        if (/\.ffx$/i.test(f.name)) {
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
    };

    LIB.reveal = function (a) {
        var f = a.path ? new File(a.path) : null;
        (f && f.exists ? f.parent : libRoot()).execute();
        return "";
    };

    LIB.remove = function (a) {
        var f = new File(a.path);
        if (!f.exists) fail("文件不存在");
        var trash = ensureFolder(new Folder(libRoot().fsName + "/_已移除"));
        var dest = new File(trash.fsName + "/" + File.decode(f.name));
        if (dest.exists) dest.remove();
        if (!(f.copy(dest.fsName) && f.remove())) fail("移除失败：" + f.error);
        return "已移到 _已移除 文件夹";
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
    function configFile(name) {
        var dir = ensureFolder(new Folder(Folder.userData.fsName + "/MotionHub"));
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
    LIB.saveConfig = function (a) { writeText(configFile(a.name), a.text); return { saved: true }; };

    // 代码片段存在脚本库根目录，跟着脚本库一起同步
    LIB.loadSnippets = function () { return { text: readText(new File(libRoot().fsName + "/_snippets.json")) }; };
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
        if (cat && cat !== "未分类") target = ensureFolder(new Folder(root.fsName + "/" + cat));
        var f = new File(target.fsName + "/" + a.name.replace(/[\\\/:*?"<>|]/g, "_"));
        f.encoding = "BINARY";
        if (!f.open("w")) fail("无法写入：" + f.fsName);
        f.write(b64decode(a.b64));
        f.close();
        return { key: f.fsName.substring(root.fsName.length).replace(/\\/g, "/") };
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

    LIB.status = function () {
        return { canWrite: canWriteFiles() };
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
        stylePaste: "粘贴样式", applyEffect: "添加效果"
    };

    function call(name, args) {
        args = args || {};
        if (!args.mods) args.mods = {};
        try {
            if (T[name]) {
                app.beginUndoGroup("MotionHub：" + (UNDO_NAMES[name] || name));
                var res;
                try { res = T[name](args); } finally { app.endUndoGroup(); }
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
