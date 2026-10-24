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

tasklist /FI "IMAGENAME eq AfterFX.exe" 2>nul | find /I "AfterFX.exe" >nul
if not errorlevel 1 (
    echo 注意：After Effects 正在运行。请先完全关闭 AE，然后按任意键继续安装。
    pause >nul
)

if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%\" /E /I /Y /Q >nul

rem 清掉扩展缓存，避免继续用旧的界面和脚本
for /d %%d in ("%TEMP%\cep_cache\*motionhub*") do rmdir /s /q "%%d" 2>nul
for /d %%d in ("%LOCALAPPDATA%\Temp\cep_cache\*motionhub*") do rmdir /s /q "%%d" 2>nul
if exist "%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\%ID%" echo 注意：系统目录里还有一份旧版，请手动删除：%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\%ID%

rem 允许加载未签名扩展（AE 2020 及以上对应 CSXS 9-13）
for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

echo.
echo 已安装到：%DEST%
echo 已开启扩展加载权限
echo 已清除扩展缓存
echo.
echo 下一步：完全关闭 After Effects 后重新打开，
echo 在菜单「窗口 - 扩展 - MotionHub」打开面板。
echo.
pause
