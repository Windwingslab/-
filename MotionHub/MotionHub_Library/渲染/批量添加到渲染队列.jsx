/*
    @name   批量添加到渲染队列
    @desc   把项目面板中选中的所有合成加入渲染队列，可选统一输出文件夹。
    @author MotionHub
*/
(function () {
    var comps = [];
    var sel = app.project.selection;
    for (var i = 0; i < sel.length; i++) if (sel[i] instanceof CompItem) comps.push(sel[i]);
    if (!comps.length) { alert("请先在项目面板选中要渲染的合成。"); return; }

    var outDir = null;
    if (confirm("是否为这 " + comps.length + " 个合成统一选择输出文件夹？\n选「否」则使用默认路径。")) {
        outDir = Folder.selectDialog("选择输出文件夹");
        if (!outDir) return;
    }

    app.beginUndoGroup("批量添加到渲染队列");
    for (var j = 0; j < comps.length; j++) {
        var rq = app.project.renderQueue.items.add(comps[j]);
        if (outDir) {
            var om = rq.outputModule(1);
            var old = om.file;
            var ext = old ? File.decode(old.name).replace(/^.*(\.[^.]+)$/, "$1") : "";
            var safe = comps[j].name.replace(/[\\\/:*?"<>|]/g, "_");
            om.file = new File(outDir.fsName + "/" + safe + ext);
        }
    }
    app.endUndoGroup();
    alert("已添加 " + comps.length + " 个合成到渲染队列。");
})();
