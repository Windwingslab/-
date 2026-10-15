/*
    @name   整理项目面板
    @desc   把根目录下的素材按类型归入「合成 / 视频 / 图片 / 音频 / 纯色」文件夹。
    @author MotionHub
*/
(function () {
    var proj = app.project;
    if (!proj) return;

    function getFolder(name) {
        for (var i = 1; i <= proj.numItems; i++) {
            var it = proj.item(i);
            if (it instanceof FolderItem && it.name === name && it.parentFolder === proj.rootFolder) return it;
        }
        return proj.items.addFolder(name);
    }

    function kind(it) {
        if (it instanceof CompItem) return "合成";
        if (!(it instanceof FootageItem)) return null;
        if (it.mainSource instanceof SolidSource) return "纯色";
        if (!it.hasVideo && it.hasAudio) return "音频";
        if (it.mainSource.isStill) return "图片";
        return "视频";
    }

    var items = [];
    for (var i = 1; i <= proj.numItems; i++) {
        var it = proj.item(i);
        if (it.parentFolder === proj.rootFolder && !(it instanceof FolderItem)) items.push(it);
    }
    if (!items.length) { alert("根目录下没有需要整理的素材。"); return; }

    app.beginUndoGroup("整理项目面板");
    var moved = 0;
    for (var j = 0; j < items.length; j++) {
        var k = kind(items[j]);
        if (!k) continue;
        items[j].parentFolder = getFolder(k);
        moved++;
    }
    app.endUndoGroup();
    alert("已整理 " + moved + " 个项目。");
})();
