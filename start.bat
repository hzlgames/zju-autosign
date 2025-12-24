@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
chcp 65001 >nul 2>nul

title ZJU AutoSign Launcher (Windows)

echo "============================================================"
echo "       		浙大自动签到启动器"
echo "项目地址：https://github.com/hzlgames/zju-autosign"
echo "有帮助的话麻烦点个小星星谢谢喵"
echo "============================================================"
echo.
echo "脚本将自动执行以下流程："
echo "  [1] 环境检测 (Node.js/npm)"
echo "  [2] 安装项目依赖库"
echo "  [3] 补全配置文件 (.env)"
echo "  [4] 启动控制台服务"
echo.

call :ensure_node || goto :fatal
call :ensure_env || goto :fatal
call :install_deps || goto :fatal

set "CONTROL_PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1* delims==" %%A in (".env") do (
    set "k=%%A"
    for /f "tokens=* delims= " %%K in ("!k!") do set "k=%%K"
    if /i "!k!"=="CONTROL_PORT" (
      set "v=%%B"
      for /f "tokens=1 delims=#" %%V in ("!v!") do set "v=%%V"
      for /f "tokens=* delims= " %%V in ("!v!") do set "v=%%V"
      if not "!v!"=="" set "CONTROL_PORT=!v!"
    )
  )
)
set "CONTROL_PORT=!CONTROL_PORT:"=!"
for /f "tokens=1" %%P in ("!CONTROL_PORT!") do set "CONTROL_PORT=%%P"

echo.
echo "[信息] 正在启动服务..."
echo "[提示] 首页地址:    http://localhost:!CONTROL_PORT!/index.html"
echo "[提示] 管理后台:    http://localhost:!CONTROL_PORT!/admin.html"
echo "[提示] 管理口令 (CONTROL_TOKEN): !CONTROL_TOKEN!"
echo "[提示] (口令已复制到剪贴板，请直接粘贴登录)"
echo "[提示] 如果浏览器显示“无法访问”，请等待 5 秒后按 F5 刷新。"
echo.

start "" "http://localhost:!CONTROL_PORT!/admin.html"

npm start
goto :end

:ensure_node
where node >nul 2>nul && goto :node_ok
for %%P in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LocalAppData%\Programs\nodejs") do (
  if exist "%%~fP\node.exe" (
    set "PATH=%%~fP;!PATH!"
    goto :node_ok
  )
)
echo "[错误] 未检测到 Node.js 环境。"
start "" "https://nodejs.org/zh-cn/download"
exit /b 1

:node_ok
echo "[成功] Node.js 环境已就绪。"
exit /b 0

:install_deps
if exist "node_modules" exit /b 0
echo "[信息] 正在安装依赖库..."
call npm ci --no-audit --no-fund
if !ERRORLEVEL! EQU 0 exit /b 0
echo "[警告] 尝试使用国内镜像..."
call npm config set registry https://registry.npmmirror.com
call npm ci --no-audit --no-fund
exit /b %ERRORLEVEL%

:ensure_env
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
  ) else (
    type nul > ".env"
  )
)
call :get_env_value "APP_SECRET" APP_SECRET
call :get_env_value "CONTROL_TOKEN" CONTROL_TOKEN
if not defined APP_SECRET (
  for /f "usebackq delims=" %%s in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)"`) do set "APP_SECRET=%%s"
  call :set_env_value_if_empty "APP_SECRET" "!APP_SECRET!"
)
if not defined CONTROL_TOKEN (
  for /f "usebackq delims=" %%t in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[guid]::NewGuid().ToString('N').Substring(0,24)"`) do set "CONTROL_TOKEN=%%t"
  call :set_env_value "CONTROL_TOKEN" "!CONTROL_TOKEN!"
)
echo !CONTROL_TOKEN!| clip >nul 2>nul
exit /b 0

:get_env_value
set "%~2="
for /f "usebackq tokens=1* delims==" %%A in (".env") do (
  set "k=%%A"
  for /f "tokens=* delims= " %%K in ("!k!") do set "k=%%K"
  if /i "!k!"=="%~1" (
    set "v=%%B"
    for /f "tokens=1 delims=#" %%V in ("!v!") do set "v=%%V"
    for /f "tokens=1" %%V in ("!v!") do set "v=%%V"
    set "v=!v:"=!"
    set "%~2=!v!"
    goto :get_env_value_done
  )
)
:get_env_value_done
exit /b 0

:set_env_value_if_empty
findstr /B /C:"%~1=" ".env" >nul 2>nul
if errorlevel 1 echo %~1=%~2>> ".env"
exit /b 0

:set_env_value
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='.env'; $k='%~1'; $v='%~2'; $lines=@(); if(Test-Path $p){$lines=Get-Content $p}; $found=$false; $out=@(); foreach($l in $lines){if($l -match ('^'+[regex]::Escape($k)+'=')){$out+=($k+'='+$v);$found=$true}else{$out+=$l}}; if(-not $found){$out+=($k+'='+$v)}; $out | Set-Content $p -Encoding ASCII"
exit /b 0

:fatal
echo.
echo "[错误] 启动失败。"
pause
exit /b 1

:end
endlocal
pause
