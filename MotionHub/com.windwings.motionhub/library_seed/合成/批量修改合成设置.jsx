/*
    @name   批量修改合成设置
    @desc   在项目面板选中多个合成，一次性修改帧率、时长、尺寸。留空表示不修改。
    @author MotionHub
*/
(function () {
    var comps = [];
    var sel = app.project.selection;
    for (var i = 0; i < sel.length; i++) if (sel[i] instanceof CompItem) comps.push(sel[i]);
    if (!comps.length && app.project.activeItem instanceof CompItem) comps.push(app.project.activeItem);
    if (!comps.length) { alert("请先在项目面板选中合成。"); return; }

    var dlg = new Window("dialog", "批量修改合成设置（" + comps.length + " 个）");
    dlg.alignChildren = ["fill", "top"];
    function field(label) {
        var g = dlg.add("group");
        var s = g.add("statictext", undefined, label);
        s.preferredSize.width = 90;
        var e = g.add("edittext", undefined, "");
        e.preferredSize.width = 120;
        return e;
    }
    var fps = field("帧率");
    var dur = field("时长（秒）");
    var w = field("宽度");
    var h = field("高度");
    var b = dlg.add("group");
    b.alignment = "right";
    b.add("button", undefined, "取消", { name: "cancel" });
    b.add("button", undefined, "应用", { name: "ok" });
    if (dlg.show() !== 1) return;

    function num(e) { var n = parseFloat(e.text); return isNaN(n) || n <= 0 ? null : n; }

    app.beginUndoGroup("批量修改合成设置");
    for (var j = 0; j < comps.length; j++) {
        var c = comps[j];
        if (num(fps)) c.frameRate = num(fps);
        if (num(dur)) c.duration = num(dur);
        if (num(w)) c.width = Math.round(num(w));
        if (num(h)) c.height = Math.round(num(h));
    }
    app.endUndoGroup();
})();
