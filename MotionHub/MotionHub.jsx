/*
    MotionHub —— After Effects 脚本插件合集平台
    版本 1.1.1

    · 工具：锚点、缓动、对齐/分布、图层、表达式等常用基础工具
    · 脚本库：整理、搜索、收藏、一键运行你所有的 .jsx / .jsxbin 脚本和 .ffx 预设
    · 安装：把脚本导入库中分类保存，可同时安装到 AE 的 ScriptUI Panels

    安装：把 MotionHub.jsx 和 MotionHub_Library 文件夹一起放进
          AE 的 Scripts/ScriptUI Panels 目录，重启 AE，在「窗口」菜单中打开 MotionHub.jsx。
*/

(function MotionHub(thisObj) {
    var NAME = "MotionHub";
    var VERSION = "1.1.1";
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
    // 品牌视觉 · 风翮 windwings
    // 四色：ink #171819 / brand #FF5900 / deep #26110A / white
    // 橙底上一律用近黑字（白字对比度不足），分隔只用 1px 线，不用阴影
    // =====================================================================
    function hex(h) {
        var n = parseInt(h.replace("#", ""), 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    }

    var C = {
        ink: hex("#171819"),
        raise: hex("#1D1E1F"),
        line: hex("#343536"),      // rgba(244,244,242,.13) 叠在 ink 上
        brand: hex("#FF5900"),
        deep: hex("#26110A"),
        text: hex("#F4F4F2"),
        muted: hex("#8A8C8E")
    };

    function makeFont(family, style, size) {
        try { return ScriptUI.newFont(family, style, size); } catch (e) {}
        return ScriptUI.newFont("dialog", style, size);
    }

    var F = {
        mono: makeFont("Geist Mono", "REGULAR", 9),
        ui: makeFont("dialog", "REGULAR", 11),
        uiBold: makeFont("dialog", "BOLD", 11),
        brand: makeFont("Geist Mono", "BOLD", 11)
    };

    function pen(g, color, w) { return g.newPen(g.PenType.SOLID_COLOR, color, w || 1); }
    function brush(g, color) { return g.newBrush(g.BrushType.SOLID_COLOR, color); }

    function paintBg(el, color) {
        try { el.graphics.backgroundColor = brush(el.graphics, color); } catch (e) {}
    }

    function setText(el, color, font) {
        try {
            el.graphics.foregroundColor = pen(el.graphics, color);
            if (font) el.graphics.font = font;
        } catch (e) {}
        return el;
    }

    // <icons>
    // 图标：16×16 网格的矢量指令
    //   ["l", x,y, x,y …] 折线描边    ["p", x,y …] 填充多边形
    //   ["r", x,y,w,h] 矩形描边       ["R", x,y,w,h] 矩形填充
    //   ["c", cx,cy,r] 圆描边         ["C", cx,cy,r] 圆填充
    function iconCurve(fn, x0, y0, x1, y1, n) {
        var pts = ["l"];
        for (var i = 0; i <= n; i++) {
            var t = i / n;
            pts.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * fn(t));
        }
        return pts;
    }

    function iconArc(cx, cy, r, a0, a1, n) {
        var pts = ["l"];
        for (var i = 0; i <= n; i++) {
            var a = (a0 + (a1 - a0) * i / n) * Math.PI / 180;
            pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        return pts;
    }

    function iconKey(x, y) { return ["p", x, y - 2, x + 2, y, x, y + 2, x - 2, y]; }

    var ICONS = {
        // —— 锚点 ——
        center: [["r", 2, 2, 12, 12], ["l", 8, 0.5, 8, 4.5], ["l", 8, 11.5, 8, 15.5], ["l", 0.5, 8, 4.5, 8], ["l", 11.5, 8, 15.5, 8], ["C", 8, 8, 1.8]],
        nullParent: [["r", 1.5, 1.5, 6, 6], ["l", 4.5, 7.5, 4.5, 12, 8.5, 12], ["R", 8.5, 8.5, 7, 7]],
        // —— 缓动 ——
        easeBoth: [iconCurve(function (t) { return t * t * (3 - 2 * t); }, 2, 14, 14, 2, 16), iconKey(2, 14), iconKey(14, 2)],
        easeIn: [iconCurve(function (t) { return 1 - (1 - t) * (1 - t); }, 2, 14, 14, 2, 16), iconKey(2, 14), iconKey(14, 2)],
        easeOut: [iconCurve(function (t) { return t * t; }, 2, 14, 14, 2, 16), iconKey(2, 14), iconKey(14, 2)],
        linear: [["l", 2, 14, 14, 2], iconKey(2, 14), iconKey(14, 2)],
        hold: [["l", 2, 14, 9, 14, 9, 2, 14, 2], iconKey(2, 14), iconKey(14, 2)],
        // —— 对齐 ——
        alignLeft: [["l", 1.5, 1, 1.5, 15], ["R", 4, 3, 10, 4], ["R", 4, 9, 6, 4]],
        alignHCenter: [["l", 8, 1, 8, 15], ["R", 3, 3, 10, 4], ["R", 5, 9, 6, 4]],
        alignRight: [["l", 14.5, 1, 14.5, 15], ["R", 2, 3, 10, 4], ["R", 6, 9, 6, 4]],
        alignTop: [["l", 1, 1.5, 15, 1.5], ["R", 3, 4, 4, 10], ["R", 9, 4, 4, 6]],
        alignVCenter: [["l", 1, 8, 15, 8], ["R", 3, 3, 4, 10], ["R", 9, 5, 4, 6]],
        alignBottom: [["l", 1, 14.5, 15, 14.5], ["R", 3, 2, 4, 10], ["R", 9, 6, 4, 6]],
        distH: [["R", 1.5, 4, 3, 8], ["R", 6.5, 4, 3, 8], ["R", 11.5, 4, 3, 8], ["l", 1, 14.5, 15, 14.5]],
        distV: [["R", 4, 1.5, 8, 3], ["R", 4, 6.5, 8, 3], ["R", 4, 11.5, 8, 3], ["l", 14.5, 1, 14.5, 15]],
        // —— 图层 ——
        nullLayer: [["r", 2.5, 2.5, 11, 11], ["l", 2.5, 2.5, 13.5, 13.5], ["l", 13.5, 2.5, 2.5, 13.5]],
        adjust: [["c", 8, 8, 6], ["p", 8, 2, 8, 14, 5, 13.2, 2.8, 11, 2, 8, 2.8, 5, 5, 2.8]],
        solid: [["R", 2.5, 2.5, 11, 11]],
        camera: [["r", 1.5, 4.5, 9, 7], ["p", 11, 7, 15, 4.5, 15, 11.5, 11, 9]],
        sequence: [["R", 1.5, 2, 7, 2.5], ["R", 4.5, 6.75, 7, 2.5], ["R", 7.5, 11.5, 7, 2.5]],
        trim: [["l", 4.5, 1.5, 1.5, 1.5, 1.5, 14.5, 4.5, 14.5], ["l", 11.5, 1.5, 14.5, 1.5, 14.5, 14.5, 11.5, 14.5], ["R", 5, 6.5, 6, 3]],
        precomp: [["r", 1.5, 5.5, 9, 9], ["R", 5.5, 1.5, 9, 9]],
        reverse: [["l", 5, 14, 5, 2.5], ["l", 2, 5.5, 5, 2.5, 8, 5.5], ["l", 11, 2, 11, 13.5], ["l", 8, 10.5, 11, 13.5, 14, 10.5]],
        rename: [["l", 1.5, 3, 9.5, 3], ["l", 5.5, 3, 5.5, 13.5], ["l", 12.5, 2.5, 12.5, 14], ["l", 11, 2.5, 14, 2.5], ["l", 11, 14, 14, 14]],
        // —— 表达式 ——
        wiggle: [iconCurve(function (t) { return 0.5 + 0.38 * Math.sin(t * Math.PI * 5) * (0.6 + 0.4 * Math.sin(t * 7)); }, 1, 8 + 7, 15, 8 - 7, 40)],
        loop: [iconArc(8, 8, 5.5, -60, 230, 24), ["p", 12.5, 0.8, 12.6, 5.6, 8.2, 4]],
        pingpong: [["l", 2, 8, 14, 8], ["l", 5, 5, 2, 8, 5, 11], ["l", 11, 5, 14, 8, 11, 11]],
        bounce: [iconCurve(function (t) { return Math.abs(Math.cos(t * Math.PI * 2.5)) * Math.exp(-t * 1.6); }, 1, 13.5, 15, 1.5, 40), ["l", 0.5, 14.5, 15.5, 14.5]],
        clear: [["l", 4, 1.5, 2.5, 1.5, 2.5, 7, 1, 8, 2.5, 9, 2.5, 14.5, 4, 14.5], ["l", 12, 1.5, 13.5, 1.5, 13.5, 7, 15, 8, 13.5, 9, 13.5, 14.5, 12, 14.5], ["l", 5.5, 5.5, 10.5, 10.5], ["l", 10.5, 5.5, 5.5, 10.5]],
        // —— 脚本库 ——
        play: [["p", 4, 2, 13.5, 8, 4, 14]],
        star: [["p", 8, 1, 9.9, 5.6, 14.7, 5.8, 11, 8.9, 12.2, 13.7, 8, 11, 3.8, 13.7, 5, 8.9, 1.3, 5.8, 6.1, 5.6]],
        plus: [["l", 8, 2, 8, 14], ["l", 2, 8, 14, 8]],
        refresh: [iconArc(8, 8, 5.5, -30, 250, 24), ["p", 13.8, 1.8, 13.4, 6.9, 9, 4.6]],
        folder: [["l", 1.5, 3, 6, 3, 7.5, 5, 14.5, 5, 14.5, 13.5, 1.5, 13.5, 1.5, 3]],
        trash: [["l", 1.5, 3.5, 14.5, 3.5], ["l", 6, 3.5, 6, 1.5, 10, 1.5, 10, 3.5], ["l", 3, 3.5, 4, 14.5, 12, 14.5, 13, 3.5], ["l", 6.5, 6, 6.5, 12], ["l", 9.5, 6, 9.5, 12]],
        gear: [["c", 8, 8, 2.2], iconArc(8, 8, 5.2, 0, 360, 24), ["l", 8, 0.8, 8, 2.8], ["l", 8, 13.2, 8, 15.2], ["l", 0.8, 8, 2.8, 8], ["l", 13.2, 8, 15.2, 8]],
        check: [["l", 2, 8.5, 6, 12.5, 14, 3.5]],
        swap: [["l", 2, 5, 13.5, 5], ["l", 10.5, 2, 13.5, 5, 10.5, 8], ["l", 14, 11, 2.5, 11], ["l", 5.5, 8, 2.5, 11, 5.5, 14]]
    };

    // 九宫格锚点：外框 + 目标位置的实心方块
    (function () {
        for (var y = 0; y < 3; y++) {
            for (var x = 0; x < 3; x++) {
                var cx = 3 + x * 5, cy = 3 + y * 5;
                ICONS["anchor" + x + y] = [["r", 3, 3, 10, 10], ["R", cx - 2.25, cy - 2.25, 4.5, 4.5]];
            }
        }
    })();
    // </icons>

    function drawIcon(g, cmds, ox, oy, s, color) {
        var p = pen(g, color, Math.max(1, Math.round(s * 1.4 * 10) / 10));
        var b = brush(g, color);
        for (var i = 0; i < cmds.length; i++) {
            var c = cmds[i], op = c[0];
            g.newPath();
            if (op === "l" || op === "p") {
                g.moveTo(ox + c[1] * s, oy + c[2] * s);
                for (var j = 3; j < c.length; j += 2) g.lineTo(ox + c[j] * s, oy + c[j + 1] * s);
                if (op === "p") { g.closePath(); g.fillPath(b); } else { g.strokePath(p); }
            } else if (op === "r" || op === "R") {
                g.rectPath(ox + c[1] * s, oy + c[2] * s, c[3] * s, c[4] * s);
                if (op === "R") g.fillPath(b); else g.strokePath(p);
            } else if (op === "c" || op === "C") {
                g.ellipsePath(ox + (c[1] - c[3]) * s, oy + (c[2] - c[3]) * s, c[3] * 2 * s, c[3] * 2 * s);
                if (op === "C") g.fillPath(b); else g.strokePath(p);
            }
        }
    }

    // =====================================================================
    // 品牌组件
    // =====================================================================

    // 图标方块按钮：抬升面 + 浅色图标；accent 为橙色实心块 + 近黑图标
    // 不读取 drawState 的悬停/按下状态：macOS 上它会在鼠标划过后卡在“按下”，导致按钮一直高亮
    function drawTile() {
        var g = this.graphics, w = this.size[0], h = this.size[1];
        var bg = this.accent_ ? C.brand : C.raise;
        var fg = this.accent_ ? C.ink : C.text;
        var border = this.accent_ ? C.brand : C.line;
        g.newPath();
        g.rectPath(0, 0, w, h);
        g.fillPath(brush(g, bg));
        g.newPath();
        g.rectPath(0.5, 0.5, w - 1, h - 1);
        g.strokePath(pen(g, border));

        var font = this.accent_ ? F.uiBold : F.ui;
        var size = this.text_ ? 13 : Math.min(18, Math.min(w, h) - 12);
        var tw = this.text_ ? g.measureString(this.text_, font)[0] : 0;
        var gap = (this.icon_ && this.text_) ? 6 : 0;
        var x = (w - ((this.icon_ ? size : 0) + gap + tw)) / 2;
        if (this.icon_) {
            drawIcon(g, this.icon_, Math.round(x), Math.round((h - size) / 2), size / 16, fg);
            x += size + gap;
        }
        if (this.text_) {
            var th = g.measureString(this.text_, font)[1];
            g.drawString(this.text_, pen(g, fg), x, (h - th) / 2, font);
        }
    }

    function tile(parent, o) {
        var b = parent.add("iconbutton", undefined, undefined, { style: "toolbutton" });
        b.preferredSize = [o.w || 34, o.h || 30];
        if (o.fill) b.alignment = ["fill", "center"];
        if (o.tip) b.helpTip = o.tip;
        b.icon_ = o.icon ? ICONS[o.icon] : null;
        b.text_ = o.text || "";
        b.accent_ = !!o.accent;
        b.onDraw = drawTile;
        if (o.onClick) b.onClick = o.onClick;
        return b;
    }

    function row(parent, spacing) {
        var g = parent.add("group");
        g.orientation = "row";
        g.alignChildren = ["left", "center"];
        g.alignment = ["fill", "top"];
        g.spacing = spacing === undefined ? 4 : spacing;
        g.margins = 0;
        return g;
    }

    function column(parent, spacing) {
        var g = parent.add("group");
        g.orientation = "column";
        g.alignChildren = ["fill", "top"];
        g.alignment = ["fill", "top"];
        g.spacing = spacing === undefined ? 4 : spacing;
        g.margins = 0;
        return g;
    }

    function hRule(parent) {
        var r = parent.add("group");
        r.alignment = ["fill", "top"];
        r.preferredSize = [10, 1];
        r.maximumSize.height = 1;
        paintBg(r, C.line);
        return r;
    }

    // 章节头：(01) — ANCHOR ············ 锚点
    function sectionHead(parent, num, en, zh) {
        var first = parent.children.length === 0;
        var wrap = column(parent, 6);
        wrap.margins = [0, first ? 2 : 6, 0, 0];
        if (!first) hRule(wrap);
        var g = row(wrap, 6);
        setText(g.add("statictext", undefined, "(" + num + ") — " + en), C.brand, F.mono);
        var z = setText(g.add("statictext", undefined, zh), C.muted, F.mono);
        z.alignment = ["right", "center"];
        return wrap;
    }

    function label(parent, text, color) {
        return setText(parent.add("statictext", undefined, text), color || C.muted, F.ui);
    }

    function numField(parent, value, w) {
        var e = parent.add("edittext", undefined, String(value));
        e.preferredSize = [w || 36, 22];
        e.maximumSize = [w || 36, 22];
        e.getNum = function (def) {
            var n = parseFloat(e.text);
            return isNaN(n) ? def : n;
        };
        return e;
    }

    // =====================================================================
    // 页面：工具
    // =====================================================================
    function buildToolsPage(page) {
        // (01) 锚点 —— 橙色九宫格 + 两个常用操作
        sectionHead(page, "01", "ANCHOR", "锚点");
        var gA = row(page, 6);
        gA.alignChildren = ["left", "top"];
        var grid = column(gA, 3);
        grid.alignment = ["left", "top"];
        for (var y = 0; y < 3; y++) {
            var r = row(grid, 3);
            for (var x = 0; x < 3; x++) {
                tile(r, {
                    icon: "anchor" + x + y, accent: true, w: 30, h: 28,
                    tip: "把锚点移到图层的这个位置（图层不会移动）",
                    onClick: anchorTool(x / 2, y / 2)
                });
            }
        }
        var aSide = column(gA, 3);
        aSide.alignment = ["fill", "top"];
        tile(aSide, { icon: "center", text: "居中到合成", h: 28, fill: true, tip: "锚点居中，并把图层移到合成中心", onClick: centerInComp });
        tile(aSide, { icon: "nullParent", text: "空对象父级", h: 28, fill: true, tip: "新建空对象放在选中图层中心，并设为它们的父级", onClick: nullParent });
        tile(aSide, { icon: "nullLayer", text: "新建空对象", h: 28, fill: true, tip: "新建空对象图层", onClick: addLayerTool("null") });

        // (02) 缓动
        sectionHead(page, "02", "EASE", "缓动 · 先选关键帧");
        var gS = row(page, 6);
        label(gS, "影响 %");
        var sl = gS.add("slider", undefined, 33, 0.1, 100);
        sl.alignment = ["fill", "center"];
        var slVal = numField(gS, 33, 36);
        sl.onChanging = function () { slVal.text = String(Math.round(sl.value)); };
        slVal.onChange = function () { sl.value = Math.max(0.1, Math.min(100, slVal.getNum(33))); };
        var infl = function () { return Math.max(0.1, Math.min(100, sl.value)); };
        var gE = row(page);
        tile(gE, { icon: "easeBoth", tip: "缓入缓出（F9）", onClick: applyEase("both", infl) });
        tile(gE, { icon: "easeIn", tip: "缓入：进入关键帧时减速", onClick: applyEase("in", infl) });
        tile(gE, { icon: "easeOut", tip: "缓出：离开关键帧时由慢到快", onClick: applyEase("out", infl) });
        tile(gE, { icon: "linear", tip: "线性", onClick: applyEase("linear", infl) });
        tile(gE, { icon: "hold", tip: "定格关键帧", onClick: applyEase("hold", infl) });

        // (03) 对齐
        sectionHead(page, "03", "ALIGN", "对齐到合成");
        var gAl = row(page);
        tile(gAl, { icon: "alignLeft", tip: "左对齐", onClick: alignTool("left") });
        tile(gAl, { icon: "alignHCenter", tip: "水平居中", onClick: alignTool("hcenter") });
        tile(gAl, { icon: "alignRight", tip: "右对齐", onClick: alignTool("right") });
        tile(gAl, { icon: "alignTop", tip: "顶部对齐", onClick: alignTool("top") });
        tile(gAl, { icon: "alignVCenter", tip: "垂直居中", onClick: alignTool("vcenter") });
        tile(gAl, { icon: "alignBottom", tip: "底部对齐", onClick: alignTool("bottom") });
        var gDi = row(page);
        tile(gDi, { icon: "distH", tip: "水平均匀分布（≥3 个图层）", onClick: distributeTool(true) });
        tile(gDi, { icon: "distV", tip: "垂直均匀分布（≥3 个图层）", onClick: distributeTool(false) });

        // (04) 图层
        sectionHead(page, "04", "LAYER", "图层");
        var gL1 = row(page);
        tile(gL1, { icon: "adjust", tip: "新建调整图层", onClick: addLayerTool("adjust") });
        tile(gL1, { icon: "solid", tip: "新建合成大小的纯色层", onClick: addLayerTool("solid") });
        tile(gL1, { icon: "camera", tip: "新建摄像机", onClick: addLayerTool("camera") });
        tile(gL1, { icon: "precomp", tip: "逐个预合成：每个选中图层各自预合成", onClick: precomposeEach });
        tile(gL1, { icon: "trim", tip: "把选中图层的入出点剪到工作区", onClick: trimToWorkArea });
        tile(gL1, { icon: "reverse", tip: "反转选中图层的上下顺序", onClick: reverseOrder });
        var gL2 = row(page);
        var frames = numField(gL2, 2, 36);
        frames.helpTip = "每层错开的帧数";
        label(gL2, "帧");
        tile(gL2, { icon: "sequence", text: "依次排列", h: 28, fill: true, tip: "按选择顺序把图层依次错开", onClick: sequenceTool(function () { return frames.getNum(2); }) });
        tile(gL2, { icon: "rename", text: "重命名", h: 28, fill: true, tip: "按 名称_01、名称_02 … 批量重命名", onClick: batchRename });

        // (05) 表达式
        sectionHead(page, "05", "EXPRESSION", "表达式 · 先选属性");
        var gX = row(page);
        var exprIcons = ["wiggle", "loop", "pingpong", "bounce", "clear"];
        for (var i = 0; i < EXPRESSIONS.length; i++) {
            tile(gX, { icon: exprIcons[i], tip: EXPRESSIONS[i].label + "：" + EXPRESSIONS[i].tip, onClick: expressionTool(EXPRESSIONS[i]) });
        }
    }

    // =====================================================================
    // 页面：脚本库
    // =====================================================================
    function buildLibraryPage(page) {
        var items = [], shown = [], favs = loadFavs();

        sectionHead(page, "01", "LIBRARY", "脚本库");
        var gTop = row(page, 4);
        var dd = gTop.add("dropdownlist", undefined, []);
        dd.preferredSize.width = 96;
        var search = gTop.add("edittext", undefined, "");
        search.alignment = ["fill", "center"];
        search.helpTip = "搜索名称 / 描述 / 分类";

        var list = page.add("listbox", undefined, [], {
            numberOfColumns: 3,
            showHeaders: true,
            columnTitles: ["名称", "分类", "类型"],
            columnWidths: [140, 64, 60]
        });
        list.alignment = ["fill", "fill"];
        list.preferredSize = [264, 220];

        var info = setText(page.add("statictext", undefined, "", { multiline: true }), C.muted, F.ui);
        info.alignment = ["fill", "bottom"];
        info.preferredSize.height = 34;

        var gBtn = row(page, 4);
        gBtn.alignment = ["fill", "bottom"];
        var bRun = tile(gBtn, { icon: "play", text: "运行", accent: true, fill: true, tip: "运行脚本 / 对选中图层应用预设（也可以双击列表）" });
        var bFav = tile(gBtn, { icon: "star", tip: "收藏 / 取消收藏" });
        var bInst = tile(gBtn, { icon: "plus", tip: "安装：把新的脚本或预设导入脚本库" });
        var bRefresh = tile(gBtn, { icon: "refresh", tip: "刷新：重新扫描脚本库文件夹" });
        var bReveal = tile(gBtn, { icon: "folder", tip: "在文件管理器中显示" });
        var bRemove = tile(gBtn, { icon: "trash", tip: "移除（移到库中的 _已移除 文件夹）" });

        function current() {
            return list.selection ? shown[list.selection.index] : null;
        }

        function fillCats() {
            var keep = dd.selection ? dd.selection.text : "全部";
            dd.removeAll();
            var cats = ["全部", "★ 收藏"].concat(categories());
            for (var i = 0; i < items.length; i++) {
                if (items[i].cat === "未分类") { cats.push("未分类"); break; }
            }
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
            info.text = shown.length
                ? shown.length + " 项 · 双击运行"
                : "没有找到脚本。点 ＋ 导入，或在「设置」中更换库文件夹。";
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
            info.text = it.name + " · " + it.type + (it.author ? " · " + it.author : "") +
                "\n" + (it.desc || File.decode(it.file.name));
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

        page.refreshLibrary = refresh;
        refresh();
    }

    // =====================================================================
    // 页面：设置
    // =====================================================================
    function buildSettingsPage(page, onLibChange) {
        sectionHead(page, "01", "LIBRARY PATH", "脚本库文件夹");
        var path = setText(page.add("statictext", undefined, libRoot().fsName, { truncate: "middle" }), C.text, F.ui);
        path.alignment = ["fill", "top"];
        var g = row(page);
        tile(g, {
            icon: "swap", text: "更换", h: 28, fill: true, tip: "选择另一个文件夹作为脚本库（例如网盘同步文件夹）",
            onClick: function () {
                var f = Folder.selectDialog("选择脚本库文件夹");
                if (!f) return;
                setSetting("libPath", f.fsName);
                path.text = f.fsName;
                onLibChange();
            }
        });
        tile(g, { icon: "folder", text: "打开", h: 28, fill: true, tip: "在文件管理器中打开脚本库", onClick: function () { libRoot().execute(); } });
        tile(g, {
            icon: "plus", text: "导入示例", h: 28, fill: true, tip: "把插件附带的示例脚本复制到当前库",
            onClick: function () {
                var src = new Folder(SCRIPT_FILE.parent.fsName + "/MotionHub_Library");
                if (!src.exists) { alert("没有找到 MotionHub_Library 文件夹。", NAME); return; }
                copyFolder(src, libRoot());
                onLibChange();
                alert("示例脚本已导入。", NAME);
            }
        });

        sectionHead(page, "02", "AFTER EFFECTS", "权限与面板");
        var perm = page.add("statictext", undefined, "", { multiline: true });
        perm.alignment = ["fill", "top"];
        perm.preferredSize.height = 32;
        function updatePerm() {
            var ok = canWriteFiles();
            perm.text = ok
                ? "✓ 已允许脚本写入文件，可以正常安装。"
                : "✗ 未允许脚本写入文件：请到「首选项 → 脚本和表达式」勾选「允许脚本写入文件和访问网络」。";
            setText(perm, ok ? C.text : C.brand, F.ui);
        }
        updatePerm();
        var g2 = row(page);
        tile(g2, { icon: "refresh", text: "重新检查", h: 28, fill: true, onClick: updatePerm });
        tile(g2, {
            icon: "folder", text: "ScriptUI Panels", h: 28, fill: true, tip: "打开当前 AE 版本的用户面板文件夹",
            onClick: function () {
                var f = userPanelsFolder();
                if (!f.exists && canWriteFiles()) ensureFolder(f);
                if (f.exists) f.execute(); else alert("文件夹不存在：\n" + f.fsName, NAME);
            }
        });

        sectionHead(page, "03", "ABOUT", "关于");
        setText(page.add("statictext", undefined, NAME.toUpperCase() + " v" + VERSION + "  ·  AE " + app.version), C.muted, F.mono);
        var tipText = setText(page.add("statictext", undefined, "脚本头部写 @name / @desc / @author，库里就会显示说明。", { multiline: true }), C.muted, F.ui);
        tipText.alignment = ["fill", "top"];
        tipText.preferredSize.height = 30;
    }

    // =====================================================================
    // 外壳：品牌顶栏 + 文字标签页
    // =====================================================================
    function drawTab() {
        var g = this.graphics, w = this.size[0], h = this.size[1];
        g.newPath();
        g.rectPath(0, 0, w, h);
        g.fillPath(brush(g, C.ink));
        var col = this.active_ ? C.text : C.muted;
        var m = g.measureString(this.text_, F.uiBold);
        var x = (w - m[0]) / 2;
        g.drawString(this.text_, pen(g, col), x, (h - m[1]) / 2 - 2, F.uiBold);
        if (this.active_) {
            g.newPath();
            g.rectPath(x, h - 2, m[0], 2);
            g.fillPath(brush(g, C.brand));
        }
    }

    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", NAME, undefined, { resizeable: true });
        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.margins = [10, 8, 10, 10];
        win.spacing = 6;
        paintBg(win, C.ink);

        // 顶栏：橙色方块字标 + 版本
        var head = row(win, 6);
        var mark = head.add("group");
        mark.preferredSize = [8, 8];
        mark.alignment = ["left", "center"];
        paintBg(mark, C.brand);
        setText(head.add("statictext", undefined, "MOTIONHUB"), C.text, F.brand);
        var ver = setText(head.add("statictext", undefined, "WINDWINGS · V" + VERSION), C.muted, F.mono);
        ver.alignment = ["right", "center"];

        // 标签栏
        var tabBar = row(win, 0);
        hRule(win);
        var stack = win.add("group");
        stack.orientation = "stack";
        stack.alignment = ["fill", "fill"];
        stack.alignChildren = ["fill", "fill"];

        var titles = ["工具", "脚本库", "设置"];
        var tabs = [], pages = [];

        function select(idx) {
            for (var i = 0; i < pages.length; i++) {
                pages[i].visible = (i === idx);
                tabs[i].active_ = (i === idx);
                tabs[i].hide();
                tabs[i].show();
            }
            setSetting("tab", idx);
            win.layout.layout(true);
        }

        for (var i = 0; i < titles.length; i++) {
            var t = tabBar.add("iconbutton", undefined, undefined, { style: "toolbutton" });
            t.text_ = titles[i];
            t.preferredSize = [58, 26];
            t.onDraw = drawTab;
            t.onClick = (function (n) { return function () { select(n); }; })(i);
            tabs.push(t);
            var p = column(stack, 5);
            p.alignment = ["fill", "fill"];
            pages.push(p);
        }
        pages[1].alignChildren = ["fill", "fill"];

        buildToolsPage(pages[0]);
        buildLibraryPage(pages[1]);
        buildSettingsPage(pages[2], function () { pages[1].refreshLibrary(); });


        var last = parseInt(getSetting("tab", "0"), 10) || 0;
        select(Math.min(Math.max(last, 0), titles.length - 1));

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
