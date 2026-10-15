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

mkdir -p "$DEST"
rm -rf "$DEST/$ID"
cp -R "$ID" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/$ID" 2>/dev/null

# 允许加载未签名扩展（AE 2020 及以上对应 CSXS 9–13）
for v in 9 10 11 12 13; do
    defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

echo ""
echo "✓ 已安装到：$DEST/$ID"
echo "✓ 已开启扩展加载权限"
echo ""
echo "下一步：完全退出 After Effects（Cmd+Q）后重新打开，"
echo "在菜单「窗口 → 扩展 → MotionHub」打开面板。"
echo ""
read -n 1 -s -r -p "按任意键关闭…"
