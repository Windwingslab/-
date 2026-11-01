#!/bin/bash
# MotionHub 一键安装（macOS）
cd "$(dirname "$0")"
ID="com.windwings.motionhub"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions"

echo "== MotionHub 安装 =="
if [ ! -d "$ID" ]; then
    echo "找不到 $ID 文件夹，请把本文件和它放在同一个目录里再运行。"
    read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi

# AE 开着时装新版不会生效。-x 只认进程名正好是「After Effects」的，不会把路径里带这几个字的别的程序当成 AE
while pgrep -x "After Effects" >/dev/null 2>&1; do
    echo "⚠ After Effects 正在运行。请先完全退出 AE（Cmd+Q），退出后按任意键继续；按 Q 放弃安装。"
    read -n 1 -s -r KEY
    if [ "$KEY" = "q" ] || [ "$KEY" = "Q" ]; then
        echo "已放弃安装，什么都没有改动。"
        exit 0
    fi
done

# 系统级目录里如果有旧版，AE 可能优先加载它
SYS="/Library/Application Support/Adobe/CEP/extensions/$ID"
if [ -d "$SYS" ]; then
    echo "发现系统目录里有旧版：$SYS"
    echo "需要输入电脑密码把它删掉（否则 AE 可能一直加载旧版）"
    sudo rm -rf "$SYS"
fi

mkdir -p "$DEST"
rm -rf "$DEST/$ID"
cp -R "$ID" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/$ID" 2>/dev/null

# 只清扩展的网页缓存（Cache / Code Cache / GPUCache），避免继续用旧的界面和脚本。
# 保留 Local Storage：Studio 的设置、面板布局的离线备份都在里面
CACHE="$HOME/Library/Caches/CSXS/cep_cache"
shopt -s nullglob nocaseglob
for d in "$CACHE"/*motionhub*; do
    [ -d "$d" ] || continue
    find "$d" -type d \( -name "Cache" -o -name "Code Cache" -o -name "GPUCache" \) -prune -exec rm -rf {} + 2>/dev/null
done
shopt -u nullglob nocaseglob
VER=$(grep -o 'ExtensionBundleVersion="[^"]*"' "$DEST/$ID/CSXS/manifest.xml" | cut -d'"' -f2)

# 允许加载未签名扩展（AE 2020 及以上对应 CSXS 9–16）
for v in 9 10 11 12 13 14 15 16; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

echo ""
echo "✓ 已安装 v$VER 到：$DEST/$ID"
echo "✓ 已清除扩展的网页缓存（面板布局、Studio 设置都保留）"
echo "✓ 已开启扩展加载权限"
echo ""
echo "下一步：完全退出 After Effects（Cmd+Q）后重新打开，"
echo "在菜单「窗口 → 扩展 → MotionHub」打开面板。"
echo "Studio 左上角会显示版本号 v$VER，看到它就说明装的是新版。"
echo ""
read -n 1 -s -r -p "按任意键关闭…"
