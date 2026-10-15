/*
    @name   随机错开时间
    @desc   把选中图层在指定帧数范围内随机前后错开，适合做杂乱入场。
    @author MotionHub
*/
(function () {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem) || !comp.selectedLayers.length) { alert("请先在合成中选中图层。"); return; }
    var input = prompt("最大随机偏移（帧）", "10", "随机错开时间");
    if (input === null) return;
    var maxF = parseInt(input, 10);
    if (isNaN(maxF) || maxF <= 0) return;

    var layers = comp.selectedLayers;
    app.beginUndoGroup("随机错开时间");
    for (var i = 0; i < layers.length; i++) {
        var off = Math.round(Math.random() * maxF);
        layers[i].startTime += off * comp.frameDuration;
    }
    app.endUndoGroup();
})();
