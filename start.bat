@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Always cd to script directory
cd /d "%~dp0"

rem Set UTF-8 codepage for console output (may fail on some systems, that's ok)
chcp 65001 >nul 2>nul

title ZJU AutoSign Launcher (Windows)

echo ==========================================
echo        ZJU AutoSign Launcher
echo ==========================================
echo.
echo This script will automatically:
echo  - Check Node.js / npm
echo  - Install dependencies (auto-retry with China mirror if failed)
echo  - Create/complete .env (APP_SECRET / CONTROL_TOKEN)
echo  - Start service and open browser
echo.

call :ensure_node || goto :fatal
call :ensure_env || goto :fatal
call :install_deps || goto :fatal

rem Read CONTROL_PORT from .env (inline, strip comments)
set "CONTROL_PORT=3000"
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
set "CONTROL_PORT=!CONTROL_PORT:"=!"
for /f "tokens=1" %%P in ("!CONTROL_PORT!") do set "CONTROL_PORT=%%P"

echo.
echo [INFO] Starting service...
echo [TIP]  Homepage:    http://localhost:!CONTROL_PORT!/index.html
echo [TIP]  Admin Panel: http://localhost:!CONTROL_PORT!/admin.html
echo [TIP]  Admin Token (CONTROL_TOKEN): !CONTROL_TOKEN!
echo [TIP]  (Token copied to clipboard, paste it to login)
echo [TIP]  If browser shows "cannot access", wait 5 seconds and press F5.
echo.

start "" "http://localhost:!CONTROL_PORT!/admin.html"

npm start
goto :end

rem ---------------------------
rem Functions
rem ---------------------------

:ensure_node
where node >nul 2>nul && goto :node_ok

rem Try common install paths if Node is installed but PATH not configured
for %%P in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LocalAppData%\Programs\nodejs") do (
  if exist "%%~fP\node.exe" (
    set "PATH=%%~fP;!PATH!"
    goto :node_ok
  )
)

echo [ERROR] Node.js not found.
echo.
echo Solution:
echo  1^)^ Install Node.js LTS (v18+), make sure to check "Add to PATH"
echo  2^)^ After installation, run this script again (restart PC if needed)
echo.
echo Opening download page...
start "" "https://nodejs.org/zh-cn/download"
exit /b 1

:node_ok
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER set "NODE_VER=(unknown)"
echo [OK] Node.js ready: !NODE_VER!

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js found but npm is missing.
  echo Please reinstall Node.js, installer includes npm. Check "Add to PATH".
  start "" "https://nodejs.org/zh-cn/download"
  exit /b 1
)
exit /b 0

:install_deps
if exist "node_modules" (
  echo [OK] node_modules found, skipping install.
  exit /b 0
)

echo [INFO] First run: Installing dependencies (may take 1-3 minutes)...
call npm ci --no-audit --no-fund
if !ERRORLEVEL! EQU 0 (
  echo [OK] Dependencies installed.
  exit /b 0
)

echo [WARN] Install failed, retrying with China mirror...
call npm config set registry https://registry.npmmirror.com
call npm ci --no-audit --no-fund
if !ERRORLEVEL! EQU 0 (
  echo [OK] Dependencies installed (China mirror).
  exit /b 0
)

echo [ERROR] Install still failed.
echo.
echo You can try:
echo  - Change network / disable proxy or VPN
echo  - Temporarily disable antivirus or "Controlled folder access"
echo  - Right-click this script ^> "Run as administrator"
echo.
exit /b 1

:ensure_env
if not exist ".env" (
  if exist ".env.example" (
    echo [INFO] .env not found, creating from .env.example...
    copy /y ".env.example" ".env" >nul
  ) else (
    echo [WARN] .env.example not found, creating minimal .env...
    type nul > ".env"
  )
)

rem Read existing values (empty if not set)
call :get_env_value "APP_SECRET" APP_SECRET
call :get_env_value "CONTROL_TOKEN" CONTROL_TOKEN

rem APP_SECRET: auto-generate if missing
if not defined APP_SECRET (
  for /f "usebackq delims=" %%s in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)"`) do set "APP_SECRET=%%s"
  call :set_env_value_if_empty "APP_SECRET" "!APP_SECRET!" || exit /b 1
)

rem CONTROL_TOKEN: prompt if missing or too short
set "TOKEN_NEEDS_UPDATE=0"
:token_prompt
if defined CONTROL_TOKEN (
  call :strlen CONTROL_TOKEN TOKEN_LEN
  if !TOKEN_LEN! GEQ 16 goto :token_ok
)

set "TOKEN_NEEDS_UPDATE=1"
echo.
echo [SETUP] CONTROL_TOKEN required (at least 16 chars, for admin login)
echo         Use letters/numbers/underscore/hyphen only.
set "CONTROL_TOKEN="
set /p CONTROL_TOKEN=Enter admin token (press Enter to auto-generate): 

if not defined CONTROL_TOKEN (
  for /f "usebackq delims=" %%t in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[guid]::NewGuid().ToString('N').Substring(0,24)"`) do set "CONTROL_TOKEN=%%t"
  echo [OK] Token generated: !CONTROL_TOKEN!
)

rem Length check (>=16)
call :strlen CONTROL_TOKEN TOKEN_LEN
if !TOKEN_LEN! LSS 16 (
  echo [ERROR] Token too short, current length: !TOKEN_LEN!. Re-enter.
  goto :token_prompt
)

rem Character check: only [0-9A-Za-z_-]
echo(!CONTROL_TOKEN!| findstr /r "[^0-9A-Za-z_-]" >nul
if !ERRORLEVEL! EQU 0 (
  echo [ERROR] Token contains invalid characters, use letters/numbers/underscore/hyphen only.
  goto :token_prompt
)

rem If token was newly entered/generated, force update .env
if "!TOKEN_NEEDS_UPDATE!"=="1" (
  call :set_env_value "CONTROL_TOKEN" "!CONTROL_TOKEN!" || exit /b 1
)

:token_ok
rem Copy token to clipboard for easy paste
echo !CONTROL_TOKEN!| clip >nul 2>nul
exit /b 0

rem Read KEY value from .env (first match, strips comments and spaces)
rem usage: call :get_env_value "KEY" OUTVAR
:get_env_value
set "%~2="
for /f "usebackq tokens=1* delims==" %%A in (".env") do (
  set "k=%%A"
  for /f "tokens=* delims= " %%K in ("!k!") do set "k=%%K"
  if /i "!k!"=="%~1" (
    set "v=%%B"
    rem Strip inline comment (everything after #)
    for /f "tokens=1 delims=#" %%V in ("!v!") do set "v=%%V"
    rem Trim spaces
    for /f "tokens=1" %%V in ("!v!") do set "v=%%V"
    rem Remove quotes
    set "v=!v:"=!"
    set "%~2=!v!"
    goto :get_env_value_done
  )
)
:get_env_value_done
exit /b 0

rem Write KEY=VALUE if KEY missing; keep existing value
rem usage: call :set_env_value_if_empty "KEY" "VALUE"
:set_env_value_if_empty
findstr /B /C:"%~1=" ".env" >nul 2>nul
if errorlevel 1 (
  echo %~1=%~2>> ".env"
)
exit /b 0

rem Write KEY=VALUE, overwriting existing value if present
rem usage: call :set_env_value "KEY" "VALUE"
:set_env_value
rem Use PowerShell to reliably update or add the key
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='.env'; $k='%~1'; $v='%~2';" ^
  "$lines=@(); if(Test-Path $p){$lines=Get-Content $p};" ^
  "$found=$false; $out=@();" ^
  "foreach($l in $lines){" ^
  "  if($l -match ('^'+[regex]::Escape($k)+'=')){$out+=($k+'='+$v);$found=$true}" ^
  "  else{$out+=$l}" ^
  "};" ^
  "if(-not $found){$out+=($k+'='+$v)};" ^
  "$out | Set-Content $p -Encoding ASCII"
if errorlevel 1 exit /b 1
exit /b 0

rem Calculate string length
rem usage: call :strlen VAR_NAME OUTVAR
:strlen
set "s=!%~1!"
set "len=0"
if defined s (
  :strlen_loop
  if not "!s!"=="" (
    set "s=!s:~1!"
    set /a len+=1
    goto :strlen_loop
  )
)
set "%~2=!len!"
exit /b 0

:fatal
echo.
echo [FATAL] Startup failed. Please check messages above and retry.
echo.
pause
exit /b 1

:end
endlocal
pause
