@echo off
chcp 65001 >nul
rem MotionHub 一键安装（Windows）
set "ID=com.windwings.motionhub"
set "SRC=%~dp0%ID%"
set "DEST=%APPDATA%\Adobe\CEP\extensions\%ID%"

echo == MotionHub 安装 ==
if not exist "%SRC%" (
    echo 找不到 %ID% 文件夹，请把本文件和它放在同一个目录里再运行。
    pause
    exit /b 1
)

if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%\" /E /I /Y /Q >nul

rem 允许加载未签名扩展（AE 2020 及以上对应 CSXS 9-13）
for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

echo.
echo 已安装到：%DEST%
echo 已开启扩展加载权限
echo.
echo 下一步：完全关闭 After Effects 后重新打开，
echo 在菜单「窗口 - 扩展 - MotionHub」打开面板。
echo.
pause
