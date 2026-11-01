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

rem AE 开着时装新版不会生效
:checkae
tasklist /FI "IMAGENAME eq AfterFX.exe" 2>nul | find /I "AfterFX.exe" >nul
if errorlevel 1 goto aeclosed
echo 注意：After Effects 正在运行。请先完全关闭 AE。
choice /c CQ /n /m "关闭 AE 后按 C 继续，按 Q 放弃安装："
if errorlevel 2 goto giveup
goto checkae
:giveup
echo 已放弃安装，什么都没有改动。
pause
exit /b 0
:aeclosed

if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%\" /E /I /Y /Q >nul

rem 只清扩展的网页缓存（Cache / Code Cache / GPUCache），避免继续用旧的界面和脚本。
rem 保留 Local Storage：Studio 的设置、面板布局的离线备份都在里面
for %%r in ("%TEMP%\cep_cache" "%LOCALAPPDATA%\Temp\cep_cache") do (
    for /d %%d in ("%%~r\*motionhub*") do (
        for /f "delims=" %%x in ('dir /s /b /ad "%%~d" 2^>nul') do (
            if /i "%%~nxx"=="Cache" rmdir /s /q "%%x" 2>nul
            if /i "%%~nxx"=="Code Cache" rmdir /s /q "%%x" 2>nul
            if /i "%%~nxx"=="GPUCache" rmdir /s /q "%%x" 2>nul
        )
    )
)

rem 系统级目录里如果有旧版，AE 可能优先加载它（删除需要管理员权限，这里只提醒）
set "SYS1=%ProgramFiles%\Common Files\Adobe\CEP\extensions\%ID%"
set "SYS2=%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\%ID%"
if exist "%SYS1%" echo 注意：系统目录里还有一份旧版，AE 可能一直加载它。请以管理员身份删除这个文件夹：%SYS1%
if exist "%SYS2%" echo 注意：系统目录里还有一份旧版，AE 可能一直加载它。请以管理员身份删除这个文件夹：%SYS2%

rem 允许加载未签名扩展（AE 2020 及以上对应 CSXS 9-16）
for %%v in (9 10 11 12 13 14 15 16) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

echo.
echo 已安装到：%DEST%
echo 已清除扩展的网页缓存（面板布局、Studio 设置都保留）
echo 已开启扩展加载权限
echo.
echo 下一步：完全关闭 After Effects 后重新打开，
echo 在菜单「窗口 - 扩展 - MotionHub」打开面板。
echo 面板设置页的「关于」和 Studio 左上角都会显示版本号，可以用来确认装的是新版。
echo.
pause
