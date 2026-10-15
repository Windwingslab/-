/*
    @name   文本查找替换
    @desc   在当前合成（或选中图层）的所有文字图层中查找并替换文本内容。
    @author MotionHub
*/
(function () {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) { alert("请先打开一个合成。"); return; }

    var dlg = new Window("dialog", "文本查找替换");
    dlg.alignChildren = ["fill", "top"];
    var g1 = dlg.add("group");
    g1.add("statictext", undefined, "查找：").preferredSize.width = 50;
    var find = g1.add("edittext", undefined, "");
    find.preferredSize.width = 200;
    var g2 = dlg.add("group");
    g2.add("statictext", undefined, "替换为：").preferredSize.width = 50;
    var repl = g2.add("edittext", undefined, "");
    repl.preferredSize.width = 200;
    var onlySel = dlg.add("checkbox", undefined, "只处理选中的图层");
    onlySel.value = comp.selectedLayers.length > 0;
    var b = dlg.add("group");
    b.alignment = "right";
    b.add("button", undefined, "取消", { name: "cancel" });
    b.add("button", undefined, "替换", { name: "ok" });
    if (dlg.show() !== 1 || find.text === "") return;

    var layers = [];
    if (onlySel.value) layers = comp.selectedLayers;
    else for (var i = 1; i <= comp.numLayers; i++) layers.push(comp.layer(i));

    var count = 0;
    app.beginUndoGroup("文本查找替换");
    for (var j = 0; j < layers.length; j++) {
        var L = layers[j];
        if (!(L instanceof TextLayer)) continue;
        var src = L.property("ADBE Text Properties").property("ADBE Text Document");
        if (src.numKeys > 0) continue;
        var doc = src.value;
        var t = doc.text;
        if (t.indexOf(find.text) === -1) continue;
        doc.text = t.split(find.text).join(repl.text);
        src.setValue(doc);
        count++;
    }
    app.endUndoGroup();
    alert("已修改 " + count + " 个文字图层。");
})();
