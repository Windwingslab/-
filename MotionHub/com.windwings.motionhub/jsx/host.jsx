/*
    MotionHub 后台（ExtendScript）
    由 CEP 面板通过 evalScript 调用：MH.call("工具名", {参数})，返回 JSON 字符串 {ok, msg, data}
*/

var MH = (function () {
    var VERSION = "2.0.0";
    var EXT_RE = /\.(jsx|jsxbin|ffx)$/i;
    var IS_WIN = $.os.indexOf("Windows") !== -1;
    var EXT_ROOT = null;
    try { EXT_ROOT = new File($.fileName).parent.parent; } catch (e) {}

    var state = { libPath: null };

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
        }
        if (sel.length && L) L.moveBefore(topmost(sel));
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

    T.sequence = function (a) {
        var comp = activeComp(), sel = needLayers(comp, 2), layers = [], i;
        for (i = 0; i < sel.length; i++) layers.push(sel[i]);
        if (a.mods.alt) layers.reverse();
        if (a.mods.shift) {
            for (i = layers.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1)), tmp = layers[i];
                layers[i] = layers[j]; layers[j] = tmp;
            }
        }
        var step = a.frames * comp.frameDuration, base = Infinity;
        for (i = 0; i < layers.length; i++) base = Math.min(base, layers[i].inPoint);
        for (i = 0; i < layers.length; i++) layers[i].startTime += (base + step * i) - layers[i].inPoint;
        return "已依次排列 " + layers.length + " 个图层，间隔 " + a.frames + " 帧" +
            (a.mods.alt ? "（倒序）" : a.mods.shift ? "（随机）" : "");
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
    T.cloneKeys = function (a) {
        var comp = activeComp(), props = selectedKeyedProps(comp), total = 0;
        if (!props.length) fail("请先选中要克隆的关键帧");
        var reverse = !!a.mods.shift, KIT = KeyframeInterpolationType;
        for (var i = 0; i < props.length; i++) {
            var p = props[i], ks = p.selectedKeys, data = [], t0 = Infinity, t1 = -Infinity, j, d;
            for (j = 0; j < ks.length; j++) {
                var k = ks[j];
                d = {
                    t: p.keyTime(k), v: p.keyValue(k),
                    inI: p.keyInInterpolationType(k), outI: p.keyOutInterpolationType(k),
                    inE: null, outE: null, inS: null, outS: null
                };
                try { d.inE = p.keyInTemporalEase(k); d.outE = p.keyOutTemporalEase(k); } catch (e1) {}
                if (p.isSpatial) {
                    try { d.inS = p.keyInSpatialTangent(k); d.outS = p.keyOutSpatialTangent(k); } catch (e2) {}
                }
                t0 = Math.min(t0, d.t); t1 = Math.max(t1, d.t);
                data.push(d);
            }
            var newTimes = [];
            for (j = 0; j < data.length; j++) {
                d = data[j];
                var nt = reverse ? comp.time + (t1 - d.t) : comp.time + (d.t - t0);
                try {
                    p.setValueAtTime(nt, d.v);
                    var idx = p.nearestKeyIndex(nt);
                    p.setInterpolationTypeAtKey(idx, reverse ? d.outI : d.inI, reverse ? d.inI : d.outI);
                    if (d.inE && d.inI !== KIT.HOLD && d.outI !== KIT.HOLD) {
                        p.setTemporalEaseAtKey(idx, reverse ? d.outE : d.inE, reverse ? d.inE : d.outE);
                    }
                    if (d.inS) p.setSpatialTangentsAtKey(idx, reverse ? d.outS : d.inS, reverse ? d.inS : d.outS);
                    newTimes.push(nt);
                    total++;
                } catch (e3) {}
            }
            if (a.mods.alt) {
                for (j = 1; j <= p.numKeys; j++) p.setSelectedAtKey(j, false);
                for (j = 0; j < newTimes.length; j++) p.setSelectedAtKey(p.nearestKeyIndex(newTimes[j]), true);
            }
        }
        return "已从播放头" + (reverse ? "反向" : "") + "克隆 " + total + " 个关键帧" + (a.mods.alt ? "并选中" : "");
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
        if (a.libPath) state.libPath = a.libPath;
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
        return { libPath: f.fsName };
    };

    LIB.openPanelsFolder = function () {
        var f = userPanelsFolder();
        if (!f.exists && canWriteFiles()) ensureFolder(f);
        if (!f.exists) fail("文件夹不存在：" + f.fsName);
        f.execute();
        return "";
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
        bounce: "弹性", clearExpr: "清除表达式", dupComp: "复制合成", collectColors: "收集颜色"
    };

    function call(name, args) {
        args = args || {};
        if (!args.mods) args.mods = {};
        try {
            if (T[name]) {
                app.beginUndoGroup("MotionHub：" + (UNDO_NAMES[name] || name));
                var msg;
                try { msg = T[name](args); } finally { app.endUndoGroup(); }
                return stringify({ ok: true, msg: msg || "" });
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
