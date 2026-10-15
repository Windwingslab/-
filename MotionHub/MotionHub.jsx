/*
    MotionHub —— After Effects 脚本插件合集平台
    版本 1.0.0

    · 工具：锚点、缓动、对齐/分布、图层、表达式等常用基础工具
    · 脚本库：整理、搜索、收藏、一键运行你所有的 .jsx / .jsxbin 脚本和 .ffx 预设
    · 安装：把脚本导入库中分类保存，可同时安装到 AE 的 ScriptUI Panels

    安装：把 MotionHub.jsx 和 MotionHub_Library 文件夹一起放进
          AE 的 Scripts/ScriptUI Panels 目录，重启 AE，在「窗口」菜单中打开 MotionHub.jsx。
*/

(function MotionHub(thisObj) {
    var NAME = "MotionHub";
    var VERSION = "1.0.0";
    var SETTINGS = "MotionHub";
    var EXT_RE = /\.(jsx|jsxbin|ffx)$/i;
    var SCRIPT_FILE = new File($.fileName);
    var IS_WIN = $.os.indexOf("Windows") !== -1;

    // =====================================================================
    // 设置
    // =====================================================================
    function getSetting(key, def) {
        try {
            if (app.settings.haveSetting(SETTINGS, key)) return app.settings.getSetting(SETTINGS, key);
        } catch (e) {}
        return def;
    }

    function setSetting(key, val) {
        try { app.settings.saveSetting(SETTINGS, key, String(val)); } catch (e) {}
    }

    function canWriteFiles() {
        try {
            return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1;
        } catch (e) {
            return true;
        }
    }

    // =====================================================================
    // 通用工具函数
    // =====================================================================
    function activeComp() {
        var c = app.project.activeItem;
        if (!(c && c instanceof CompItem)) {
            alert("请先打开或选中一个合成。", NAME);
            return null;
        }
        return c;
    }

    function runUndo(name, fn) {
        app.beginUndoGroup(NAME + "：" + name);
        try {
            fn();
        } catch (e) {
            alert("出错了：" + e.toString() + (e.line ? "（第 " + e.line + " 行）" : ""), NAME);
        }
        app.endUndoGroup();
    }

    // 生成按钮回调：自动检查合成、选中图层数量并包上撤销组
    function compTool(name, minLayers, fn) {
        return function () {
            var comp = activeComp();
            if (!comp) return;
            var layers = comp.selectedLayers;
            if (layers.length < minLayers) {
                alert("请先选择至少 " + minLayers + " 个图层。", NAME);
                return;
            }
            runUndo(name, function () { fn(comp, layers); });
        };
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

    // 给属性整体加一个偏移量（有关键帧时偏移所有关键帧）
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

    // =====================================================================
    // 工具：锚点
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

    function anchorTool(fx, fy) {
        return compTool("设置锚点", 1, function (comp, layers) {
            for (var i = 0; i < layers.length; i++) {
                if (isTransformable(layers[i])) setAnchor(layers[i], fx, fy, comp.time);
            }
        });
    }

    var centerInComp = compTool("居中到合成", 1, function (comp, layers) {
        var skipped = 0;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (!isTransformable(L)) continue;
            if (L.parent) { skipped++; continue; }
            setAnchor(L, 0.5, 0.5, comp.time);
            var p = layerPosition(L, comp.time);
            moveLayerBy(L, comp.width / 2 - p[0], comp.height / 2 - p[1]);
        }
        if (skipped) alert(skipped + " 个带父级的图层已跳过。", NAME);
    });

    // =====================================================================
    // 工具：缓动
    // =====================================================================
    function easeDims(p) {
        var t = p.propertyValueType;
        if (t === PropertyValueType.TwoD) return 2;
        if (t === PropertyValueType.ThreeD) return 3;
        return 1;
    }

    function collectKeyedProps(comp) {
        var out = [];
        var props = comp.selectedProperties;
        for (var i = 0; i < props.length; i++) {
            var p = props[i];
            if (p.propertyType === PropertyType.PROPERTY && p.selectedKeys && p.selectedKeys.length) out.push(p);
        }
        return out;
    }

    function applyEase(mode, getInfluence) {
        return function () {
            var comp = activeComp();
            if (!comp) return;
            var props = collectKeyedProps(comp);
            if (!props.length) { alert("请先选中关键帧。", NAME); return; }
            var infl = getInfluence();
            var KIT = KeyframeInterpolationType;
            runUndo("缓动", function () {
                for (var i = 0; i < props.length; i++) {
                    var p = props[i], keys = p.selectedKeys;
                    for (var j = 0; j < keys.length; j++) {
                        var k = keys[j];
                        try {
                            if (mode === "linear") { p.setInterpolationTypeAtKey(k, KIT.LINEAR, KIT.LINEAR); continue; }
                            if (mode === "hold") { p.setInterpolationTypeAtKey(k, KIT.HOLD, KIT.HOLD); continue; }
                            var e = [];
                            for (var d = 0; d < easeDims(p); d++) e.push(new KeyframeEase(0, infl));
                            var inE = mode === "out" ? p.keyInTemporalEase(k) : e;
                            var outE = mode === "in" ? p.keyOutTemporalEase(k) : e;
                            var inT = mode === "out" ? p.keyInInterpolationType(k) : KIT.BEZIER;
                            var outT = mode === "in" ? p.keyOutInterpolationType(k) : KIT.BEZIER;
                            if (inT === KIT.HOLD) inT = KIT.BEZIER;
                            if (outT === KIT.HOLD) outT = KIT.BEZIER;
                            p.setInterpolationTypeAtKey(k, inT, outT);
                            p.setTemporalEaseAtKey(k, inE, outE);
                        } catch (err) { /* 有些属性不支持插值（如源文本），跳过 */ }
                    }
                }
            });
        };
    }

    // =====================================================================
    // 工具：对齐 / 分布
    // =====================================================================
    function alignTool(mode) {
        return compTool("对齐", 1, function (comp, layers) {
            var t = comp.time, skipped = 0;
            for (var i = 0; i < layers.length; i++) {
                var L = layers[i];
                if (!isTransformable(L)) continue;
                if (L.parent) { skipped++; continue; }
                var b = layerBounds(L, t), dx = 0, dy = 0;
                if (mode === "left") dx = -b.l;
                else if (mode === "hcenter") dx = comp.width / 2 - (b.l + b.r) / 2;
                else if (mode === "right") dx = comp.width - b.r;
                else if (mode === "top") dy = -b.t;
                else if (mode === "vcenter") dy = comp.height / 2 - (b.t + b.b) / 2;
                else if (mode === "bottom") dy = comp.height - b.b;
                moveLayerBy(L, dx, dy);
            }
            if (skipped) alert(skipped + " 个带父级的图层已跳过。", NAME);
        });
    }

    function distributeTool(horizontal) {
        return compTool("分布", 3, function (comp, layers) {
            var t = comp.time, list = [];
            for (var i = 0; i < layers.length; i++) {
                var L = layers[i];
                if (!isTransformable(L) || L.parent) continue;
                var b = layerBounds(L, t);
                list.push({ layer: L, c: horizontal ? (b.l + b.r) / 2 : (b.t + b.b) / 2 });
            }
            if (list.length < 3) { alert("需要至少 3 个无父级的图层。", NAME); return; }
            list.sort(function (a, b) { return a.c - b.c; });
            var first = list[0].c, step = (list[list.length - 1].c - first) / (list.length - 1);
            for (var j = 1; j < list.length - 1; j++) {
                var d = first + step * j - list[j].c;
                moveLayerBy(list[j].layer, horizontal ? d : 0, horizontal ? 0 : d);
            }
        });
    }

    // =====================================================================
    // 工具：图层
    // =====================================================================
    var nullParent = compTool("空对象父级", 1, function (comp, layers) {
        var sx = 0, sy = 0, n = 0, any3D = false, top = layers[0];
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            if (L.index < top.index) top = L;
            if (L.threeDLayer) any3D = true;
            if (!L.parent) {
                var p = layerPosition(L, comp.time);
                sx += p[0]; sy += p[1]; n++;
            }
        }
        var nl = comp.layers.addNull();
        nl.name = "控制器";
        nl.label = 2;
        if (any3D) nl.threeDLayer = true;
        if (n) {
            var pos = [sx / n, sy / n];
            if (any3D) pos.push(0);
            nl.transform.position.setValue(pos);
        }
        nl.moveBefore(top);
        for (var j = 0; j < layers.length; j++) {
            if (layers[j] !== nl && !layers[j].parent) layers[j].parent = nl;
        }
    });

    function addLayerTool(kind) {
        return compTool("新建图层", 0, function (comp) {
            var sel = comp.selectedLayers, L;
            if (kind === "adjust") {
                L = comp.layers.addSolid([1, 1, 1], "调整图层", comp.width, comp.height, comp.pixelAspect, comp.duration);
                L.adjustmentLayer = true;
            } else if (kind === "solid") {
                L = comp.layers.addSolid([0.1, 0.1, 0.1], "纯色", comp.width, comp.height, comp.pixelAspect, comp.duration);
            } else if (kind === "camera") {
                L = comp.layers.addCamera("摄像机", [comp.width / 2, comp.height / 2]);
            } else {
                L = comp.layers.addNull();
            }
            if (sel.length) {
                var top = sel[0];
                for (var i = 1; i < sel.length; i++) if (sel[i].index < top.index) top = sel[i];
                L.moveBefore(top);
            }
        });
    }

    function sequenceTool(getFrames) {
        return compTool("依次排列", 2, function (comp, layers) {
            var step = getFrames() * comp.frameDuration;
            var base = layers[0].inPoint;
            for (var i = 0; i < layers.length; i++) {
                var L = layers[i];
                L.startTime += (base + step * i) - L.inPoint;
            }
        });
    }

    var trimToWorkArea = compTool("剪切到工作区", 1, function (comp, layers) {
        var a = comp.workAreaStart, b = comp.workAreaStart + comp.workAreaDuration;
        for (var i = 0; i < layers.length; i++) {
            try {
                layers[i].inPoint = a;
                layers[i].outPoint = b;
            } catch (e) {}
        }
    });

    var precomposeEach = compTool("逐个预合成", 1, function (comp, layers) {
        var idx = [];
        for (var i = 0; i < layers.length; i++) idx.push(layers[i].index);
        idx.sort(function (a, b) { return b - a; });
        for (var j = 0; j < idx.length; j++) {
            var L = comp.layer(idx[j]);
            comp.layers.precompose([idx[j]], L.name + "_预合成", true);
        }
    });

    var reverseOrder = compTool("反转图层顺序", 2, function (comp, layers) {
        var list = [];
        for (var i = 0; i < layers.length; i++) list.push(layers[i]);
        list.sort(function (a, b) { return a.index - b.index; });
        for (var j = 1; j < list.length; j++) list[j].moveBefore(list[j - 1]);
    });

    var batchRename = compTool("批量重命名", 1, function (comp, layers) {
        var base = prompt("新名称（会自动加上 _01、_02 …）", layers[0].name, NAME);
        if (base === null || base === "") return;
        var pad = layers.length >= 100 ? 3 : 2;
        for (var i = 0; i < layers.length; i++) {
            var num = String(i + 1);
            while (num.length < pad) num = "0" + num;
            layers[i].name = base + "_" + num;
        }
    });

    // =====================================================================
    // 工具：表达式
    // =====================================================================
    var EXPRESSIONS = [
        { label: "抖动", tip: "wiggle(频率, 幅度)", code: "freq = 3;\namp = 30;\nwiggle(freq, amp);" },
        { label: "循环", tip: "loopOut(\"cycle\") 关键帧无限循环", code: "loopOut(\"cycle\");" },
        { label: "往返", tip: "loopOut(\"pingpong\") 关键帧来回播放", code: "loopOut(\"pingpong\");" },
        { label: "弹性", tip: "在最后一个关键帧后产生惯性回弹", code:
            "amp = 0.06; freq = 2.5; decay = 6;\n" +
            "n = 0;\n" +
            "if (numKeys > 0) { n = nearestKey(time).index; if (key(n).time > time) n--; }\n" +
            "t = (n == 0) ? 0 : time - key(n).time;\n" +
            "if (n > 0 && t < 1) {\n" +
            "  v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);\n" +
            "  value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);\n" +
            "} else { value; }" },
        { label: "清除", tip: "清除选中属性上的表达式", code: "" }
    ];

    function expressionTool(expr) {
        return function () {
            var comp = activeComp();
            if (!comp) return;
            var props = comp.selectedProperties, count = 0;
            runUndo("表达式", function () {
                for (var i = 0; i < props.length; i++) {
                    var p = props[i];
                    if (p.propertyType === PropertyType.PROPERTY && p.canSetExpression) {
                        p.expression = expr.code;
                        count++;
                    }
                }
            });
            if (!count) alert("请先在时间轴上选中要添加表达式的属性（如位置、旋转）。", NAME);
        };
    }

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
        var def = Folder.myDocuments.fsName + "/MotionHub/Library";
        return ensureFolder(new Folder(getSetting("libPath", def)));
    }

    function copyFolder(src, dst) {
        ensureFolder(dst);
        var items = src.getFiles();
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var target = dst.fsName + "/" + File.decode(it.name);
            if (it instanceof Folder) copyFolder(it, new Folder(target));
            else if (!new File(target).exists) it.copy(target);
        }
    }

    // 第一次运行时，把随插件附带的示例脚本复制到库中
    function seedLibrary() {
        if (getSetting("seeded", "0") === "1") return;
        var src = new Folder(SCRIPT_FILE.parent.fsName + "/MotionHub_Library");
        if (src.exists) {
            try { copyFolder(src, libRoot()); } catch (e) {}
        }
        setSetting("seeded", "1");
    }

    function readMeta(file, cat, root) {
        var base = File.decode(file.name);
        var ext = base.substring(base.lastIndexOf(".") + 1).toLowerCase();
        var it = {
            file: file,
            name: base.substring(0, base.lastIndexOf(".")),
            cat: cat,
            ext: ext,
            desc: "",
            author: "",
            key: file.fsName.substring(root.fsName.length).replace(/\\/g, "/"),
            type: ext === "ffx" ? "预设" : (ext === "jsxbin" ? "脚本(加密)" : "脚本")
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
            var f = items[i];
            var nm = File.decode(f.name);
            if (f instanceof Folder) {
                if (depth < 3 && nm.charAt(0) !== "_" && nm.charAt(0) !== ".") {
                    scanDir(f, depth === 0 ? nm : cat, out, depth + 1, root);
                }
            } else if (EXT_RE.test(nm)) {
                out.push(readMeta(f, cat, root));
            }
        }
    }

    function scanLibrary() {
        var root = libRoot(), out = [];
        scanDir(root, "未分类", out, 0, root);
        out.sort(function (a, b) {
            if (a.cat !== b.cat) return a.cat < b.cat ? -1 : 1;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        return out;
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

    function loadFavs() {
        var s = getSetting("favs", ""), map = {};
        if (s) {
            var parts = s.split("|");
            for (var i = 0; i < parts.length; i++) if (parts[i]) map[parts[i]] = true;
        }
        return map;
    }

    function saveFavs(map) {
        var parts = [];
        for (var k in map) if (map.hasOwnProperty(k) && map[k]) parts.push(k);
        setSetting("favs", parts.join("|"));
    }

    function runItem(it) {
        if (!it.file.exists) { alert("文件不存在，请刷新脚本库。", NAME); return; }
        if (it.ext === "ffx") {
            var comp = activeComp();
            if (!comp) return;
            var layers = comp.selectedLayers;
            if (!layers.length) { alert("请先选择要应用预设的图层。", NAME); return; }
            runUndo("应用预设 " + it.name, function () {
                for (var i = 0; i < layers.length; i++) layers[i].applyPreset(it.file);
            });
            return;
        }
        try {
            $.evalFile(it.file);
        } catch (e) {
            alert("运行「" + it.name + "」出错：\n" + e.toString() + (e.line ? "（第 " + e.line + " 行）" : ""), NAME);
        }
    }

    function userPanelsFolder() {
        var v = app.version.split(".");
        var ver = v[0] + "." + parseInt(v[1], 10);
        var base = IS_WIN
            ? Folder.userData.fsName + "/Adobe/After Effects/"
            : Folder("~/Library/Preferences/Adobe/After Effects/").fsName + "/";
        return new Folder(base + ver + "/Scripts/ScriptUI Panels");
    }

    function copyInto(file, folder) {
        ensureFolder(folder);
        var dest = new File(folder.fsName + "/" + File.decode(file.name));
        if (dest.exists && !confirm("「" + File.decode(file.name) + "」已存在，是否覆盖？", false, NAME)) return false;
        if (!file.copy(dest.fsName)) {
            alert("复制失败：" + File.decode(file.name) + "\n" + file.error, NAME);
            return false;
        }
        return true;
    }

    // 安装对话框：选择文件 → 选择分类 → 复制到库（可选同时安装到 ScriptUI Panels）
    function installDialog(onDone) {
        if (!canWriteFiles()) {
            alert("请先在 AE「首选项 → 脚本和表达式」中勾选「允许脚本写入文件和访问网络」。", NAME);
            return;
        }
        var filter = IS_WIN
            ? "AE 脚本和预设:*.jsx;*.jsxbin;*.ffx,所有文件:*.*"
            : function (f) { return f instanceof Folder || EXT_RE.test(File.decode(f.name)); };
        var files = File.openDialog("选择要安装的脚本 / 预设（可多选）", filter, true);
        if (!files) return;
        if (!(files instanceof Array)) files = [files];

        var cats = categories();
        var dlg = new Window("dialog", "安装到 " + NAME);
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];
        dlg.add("statictext", undefined, "已选择 " + files.length + " 个文件");

        var g1 = dlg.add("group");
        g1.add("statictext", undefined, "分类：");
        var dd = g1.add("dropdownlist", undefined, ["（根目录 / 未分类）"].concat(cats));
        dd.selection = 0;
        dd.preferredSize.width = 180;

        var g2 = dlg.add("group");
        g2.add("statictext", undefined, "或新建：");
        var newCat = g2.add("edittext", undefined, "");
        newCat.preferredSize.width = 180;

        var toPanels = dlg.add("checkbox", undefined, "同时安装到 AE 的 ScriptUI Panels（需重启 AE）");

        var btns = dlg.add("group");
        btns.alignment = "right";
        btns.add("button", undefined, "取消", { name: "cancel" });
        btns.add("button", undefined, "安装", { name: "ok" });

        if (dlg.show() !== 1) return;

        var root = libRoot(), target = root;
        var nc = newCat.text.replace(/^\s+|\s+$/g, "").replace(/[\\\/:*?"<>|]/g, "_");
        if (nc) target = new Folder(root.fsName + "/" + nc);
        else if (dd.selection && dd.selection.index > 0) target = new Folder(root.fsName + "/" + dd.selection.text);

        var ok = 0, panelOk = 0;
        for (var i = 0; i < files.length; i++) {
            if (copyInto(files[i], target)) ok++;
            if (toPanels.value && /\.(jsx|jsxbin)$/i.test(files[i].name)) {
                if (copyInto(files[i], userPanelsFolder())) panelOk++;
            }
        }
        var msg = "已安装 " + ok + " 个文件到脚本库。";
        if (toPanels.value) msg += "\n已复制 " + panelOk + " 个到 ScriptUI Panels，重启 AE 后在「窗口」菜单中可见。";
        alert(msg, NAME);
        if (onDone) onDone();
    }

    function removeItem(it) {
        if (!confirm("从脚本库移除「" + it.name + "」？\n文件会移到库中的 _已移除 文件夹，可手动恢复。", false, NAME)) return false;
        var trash = ensureFolder(new Folder(libRoot().fsName + "/_已移除"));
        var dest = trash.fsName + "/" + File.decode(it.file.name);
        if (new File(dest).exists) new File(dest).remove();
        if (it.file.copy(dest) && it.file.remove()) return true;
        alert("移除失败：" + it.file.error, NAME);
        return false;
    }

    // =====================================================================
    // 界面
    // =====================================================================
    function btn(parent, text, tip, fn, w) {
        var b = parent.add("button", undefined, text);
        if (tip) b.helpTip = tip;
        if (w) b.preferredSize.width = w;
        b.preferredSize.height = 22;
        b.onClick = fn;
        return b;
    }

    function row(parent) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["fill", "center"];
        g.alignment = ["fill", "top"];
        g.spacing = 3;
        return g;
    }

    function section(parent, title) {
        var p = parent.add("panel", undefined, title);
        p.orientation = "column";
        p.alignChildren = ["fill", "top"];
        p.alignment = ["fill", "top"];
        p.margins = [6, 12, 6, 6];
        p.spacing = 3;
        return p;
    }

    function numField(parent, value, w) {
        var e = parent.add("edittext", undefined, String(value));
        e.preferredSize.width = w || 36;
        e.getNum = function (def) {
            var n = parseFloat(e.text);
            return isNaN(n) ? def : n;
        };
        return e;
    }

    function buildToolsTab(tab) {
        // —— 锚点 ——
        var pA = section(tab, "锚点");
        var gA = row(pA);
        var grid = gA.add("group");
        grid.orientation = "column";
        grid.spacing = 2;
        var arrows = [["↖", "↑", "↗"], ["←", "●", "→"], ["↙", "↓", "↘"]];
        for (var y = 0; y < 3; y++) {
            var r = grid.add("group");
            r.spacing = 2;
            for (var x = 0; x < 3; x++) {
                var b = r.add("button", undefined, arrows[y][x]);
                b.preferredSize = [26, 22];
                b.helpTip = "把锚点移到图层的这个位置（图层不会移动）";
                b.onClick = anchorTool(x / 2, y / 2);
            }
        }
        var aSide = gA.add("group");
        aSide.orientation = "column";
        aSide.alignChildren = ["fill", "top"];
        aSide.spacing = 3;
        btn(aSide, "居中到合成", "锚点居中，并把图层移动到合成中心", centerInComp);
        btn(aSide, "空对象父级", "新建空对象，放在选中图层中心并设为它们的父级", nullParent);

        // —— 缓动 ——
        var pE = section(tab, "缓动（先选中关键帧）");
        var gE2 = row(pE);
        gE2.add("statictext", undefined, "影响%");
        var sl = gE2.add("slider", undefined, 33, 0.1, 100);
        sl.alignment = ["fill", "center"];
        var slVal = numField(gE2, 33, 34);
        sl.onChanging = function () { slVal.text = String(Math.round(sl.value)); };
        slVal.onChange = function () { sl.value = Math.max(0.1, Math.min(100, slVal.getNum(33))); };
        var infl = function () { return Math.max(0.1, Math.min(100, sl.value)); };
        var gE = row(pE);
        btn(gE, "缓入缓出", "Easy Ease（F9）", applyEase("both", infl));
        btn(gE, "缓入", "只对进入关键帧做缓动", applyEase("in", infl));
        btn(gE, "缓出", "只对离开关键帧做缓动", applyEase("out", infl));
        var gE3 = row(pE);
        btn(gE3, "线性", "设为线性插值", applyEase("linear", infl));
        btn(gE3, "定格", "设为定格关键帧", applyEase("hold", infl));

        // —— 对齐 ——
        var pAl = section(tab, "对齐到合成");
        var gAl = row(pAl);
        btn(gAl, "左", "左对齐", alignTool("left"));
        btn(gAl, "水平中", "水平居中", alignTool("hcenter"));
        btn(gAl, "右", "右对齐", alignTool("right"));
        btn(gAl, "上", "顶部对齐", alignTool("top"));
        btn(gAl, "垂直中", "垂直居中", alignTool("vcenter"));
        btn(gAl, "下", "底部对齐", alignTool("bottom"));
        var gDi = row(pAl);
        btn(gDi, "水平分布", "按中心点水平均匀分布（≥3 个图层）", distributeTool(true));
        btn(gDi, "垂直分布", "按中心点垂直均匀分布（≥3 个图层）", distributeTool(false));

        // —— 图层 ——
        var pL = section(tab, "图层");
        var gL1 = row(pL);
        btn(gL1, "空对象", "新建空对象", addLayerTool("null"));
        btn(gL1, "调整层", "新建调整图层", addLayerTool("adjust"));
        btn(gL1, "纯色", "新建合成大小的纯色层", addLayerTool("solid"));
        btn(gL1, "摄像机", "新建摄像机", addLayerTool("camera"));
        var gL2 = row(pL);
        var frames = numField(gL2, 2, 30);
        frames.helpTip = "每层错开的帧数";
        btn(gL2, "帧 依次排列", "按选择顺序把图层依次错开", sequenceTool(function () { return frames.getNum(2); }));
        btn(gL2, "剪到工作区", "把选中图层的入出点剪到工作区", trimToWorkArea);
        var gL3 = row(pL);
        btn(gL3, "逐个预合成", "每个选中图层各自预合成", precomposeEach);
        btn(gL3, "反转顺序", "反转选中图层的上下顺序", reverseOrder);
        btn(gL3, "批量重命名", "按 名称_01、名称_02 … 重命名", batchRename);

        // —— 表达式 ——
        var pX = section(tab, "表达式（先选中属性）");
        var gX = row(pX);
        for (var i = 0; i < EXPRESSIONS.length; i++) {
            btn(gX, EXPRESSIONS[i].label, EXPRESSIONS[i].tip, expressionTool(EXPRESSIONS[i]));
        }
    }

    function buildLibraryTab(tab) {
        var items = [], shown = [], favs = loadFavs();

        var gTop = row(tab);
        var dd = gTop.add("dropdownlist", undefined, []);
        dd.preferredSize.width = 100;
        var search = gTop.add("edittext", undefined, "");
        search.alignment = ["fill", "center"];
        search.helpTip = "搜索名称 / 描述 / 分类";

        var list = tab.add("listbox", undefined, [], {
            numberOfColumns: 3,
            showHeaders: true,
            columnTitles: ["名称", "分类", "类型"],
            columnWidths: [150, 70, 60]
        });
        list.alignment = ["fill", "fill"];
        list.preferredSize = [280, 220];

        var info = tab.add("statictext", undefined, "选择一个脚本查看说明。双击即可运行。", { multiline: true });
        info.alignment = ["fill", "bottom"];
        info.preferredSize.height = 44;

        var g1 = row(tab);
        g1.alignment = ["fill", "bottom"];
        var bRun = btn(g1, "▶ 运行", "运行脚本 / 对选中图层应用预设", null);
        var bFav = btn(g1, "★ 收藏", "收藏 / 取消收藏", null);
        var bInst = btn(g1, "安装…", "把新的脚本或预设导入脚本库", null);
        var g2 = row(tab);
        g2.alignment = ["fill", "bottom"];
        var bRefresh = btn(g2, "刷新", "重新扫描脚本库文件夹", null);
        var bReveal = btn(g2, "定位", "在文件管理器中显示", null);
        var bRemove = btn(g2, "移除", "从脚本库移除（移到 _已移除 文件夹）", null);

        function current() {
            return list.selection ? shown[list.selection.index] : null;
        }

        function fillCats() {
            var keep = dd.selection ? dd.selection.text : "全部";
            dd.removeAll();
            var cats = ["全部", "★ 收藏"].concat(categories());
            var hasUncat = false;
            for (var i = 0; i < items.length; i++) if (items[i].cat === "未分类") hasUncat = true;
            if (hasUncat) cats.push("未分类");
            var sel = 0;
            for (var j = 0; j < cats.length; j++) {
                dd.add("item", cats[j]);
                if (cats[j] === keep) sel = j;
            }
            dd.selection = sel;
        }

        function fillList() {
            list.removeAll();
            shown = [];
            var cat = dd.selection ? dd.selection.text : "全部";
            var q = search.text.toLowerCase();
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (cat === "★ 收藏" && !favs[it.key]) continue;
                if (cat !== "全部" && cat !== "★ 收藏" && it.cat !== cat) continue;
                if (q && (it.name + " " + it.desc + " " + it.cat).toLowerCase().indexOf(q) === -1) continue;
                var li = list.add("item", (favs[it.key] ? "★ " : "") + it.name);
                li.subItems[0].text = it.cat;
                li.subItems[1].text = it.type;
                shown.push(it);
            }
            info.text = shown.length ? "共 " + shown.length + " 项。双击即可运行。" : "没有找到脚本。点「安装…」导入，或在「设置」中更换库文件夹。";
        }

        function refresh() {
            items = scanLibrary();
            fillCats();
            fillList();
        }

        dd.onChange = fillList;
        search.onChanging = fillList;

        list.onChange = function () {
            var it = current();
            if (!it) return;
            var t = it.name + "  ·  " + it.type + (it.author ? "  ·  作者：" + it.author : "");
            info.text = t + "\n" + (it.desc || File.decode(it.file.name));
        };
        list.onDoubleClick = function () { var it = current(); if (it) runItem(it); };

        bRun.onClick = function () {
            var it = current();
            if (!it) { alert("请先在列表中选择一个脚本。", NAME); return; }
            runItem(it);
        };
        bFav.onClick = function () {
            var it = current();
            if (!it) return;
            favs[it.key] = !favs[it.key];
            saveFavs(favs);
            fillList();
        };
        bInst.onClick = function () { installDialog(refresh); };
        bRefresh.onClick = refresh;
        bReveal.onClick = function () {
            var it = current();
            (it ? it.file.parent : libRoot()).execute();
        };
        bRemove.onClick = function () {
            var it = current();
            if (it && removeItem(it)) refresh();
        };

        tab.refreshLibrary = refresh;
        refresh();
    }

    function buildSettingsTab(tab, onLibChange) {
        var pLib = section(tab, "脚本库文件夹");
        var path = pLib.add("statictext", undefined, libRoot().fsName, { truncate: "middle" });
        path.alignment = ["fill", "top"];
        var g = row(pLib);
        btn(g, "更换…", "选择另一个文件夹作为脚本库（例如网盘同步文件夹）", function () {
            var f = Folder.selectDialog("选择脚本库文件夹");
            if (!f) return;
            setSetting("libPath", f.fsName);
            path.text = f.fsName;
            onLibChange();
        });
        btn(g, "打开", "在文件管理器中打开脚本库", function () { libRoot().execute(); });
        btn(g, "导入示例", "把插件附带的示例脚本复制到当前库", function () {
            var src = new Folder(SCRIPT_FILE.parent.fsName + "/MotionHub_Library");
            if (!src.exists) { alert("没有找到 MotionHub_Library 文件夹。", NAME); return; }
            copyFolder(src, libRoot());
            onLibChange();
            alert("示例脚本已导入。", NAME);
        });

        var pAE = section(tab, "After Effects");
        var perm = pAE.add("statictext", undefined, "", { multiline: true });
        perm.alignment = ["fill", "top"];
        perm.preferredSize.height = 32;
        function updatePerm() {
            perm.text = canWriteFiles()
                ? "✓ 已允许脚本写入文件，可以正常安装。"
                : "✗ 未允许脚本写入文件：请到「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」。";
        }
        updatePerm();
        var g2 = row(pAE);
        btn(g2, "重新检查", "", updatePerm);
        btn(g2, "打开 ScriptUI Panels", "打开当前 AE 版本的用户面板文件夹", function () {
            var f = userPanelsFolder();
            if (!f.exists && canWriteFiles()) ensureFolder(f);
            if (f.exists) f.execute(); else alert("文件夹不存在：\n" + f.fsName, NAME);
        });

        var pAbout = section(tab, "关于");
        pAbout.add("statictext", undefined, NAME + " v" + VERSION + "  ·  AE " + app.version);
        pAbout.add("statictext", undefined, "脚本头部写 @name / @desc / @author 可在库中显示说明。");
    }

    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", NAME, undefined, { resizeable: true });
        win.orientation = "column";
        win.alignChildren = ["fill", "fill"];
        win.margins = 6;

        var tabs = win.add("tabbedpanel");
        tabs.alignment = ["fill", "fill"];
        tabs.alignChildren = ["fill", "fill"];

        function addTab(title) {
            var t = tabs.add("tab", undefined, title);
            t.orientation = "column";
            t.alignChildren = ["fill", "top"];
            t.margins = [4, 8, 4, 4];
            t.spacing = 4;
            return t;
        }

        var tTools = addTab("工具");
        var tLib = addTab("脚本库");
        var tSet = addTab("设置");
        tLib.alignChildren = ["fill", "fill"];

        buildToolsTab(tTools);
        buildLibraryTab(tLib);
        buildSettingsTab(tSet, function () { tLib.refreshLibrary(); });

        var last = parseInt(getSetting("tab", "0"), 10) || 0;
        tabs.selection = tabs.children[Math.min(last, tabs.children.length - 1)];
        tabs.onChange = function () {
            for (var i = 0; i < tabs.children.length; i++) {
                if (tabs.children[i] === tabs.selection) setSetting("tab", i);
            }
        };

        win.onResizing = win.onResize = function () { this.layout.resize(); };
        win.layout.layout(true);
        if (win instanceof Window) {
            win.center();
            win.show();
        }
        return win;
    }

    seedLibrary();
    buildUI(thisObj);
})(this);
