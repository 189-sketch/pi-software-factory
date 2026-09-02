@echo off
REM bootstrap-factory.cmd — single-command factory setup on Windows.
REM
REM Usage:
REM   bootstrap-factory.cmd                          (interactive)
REM   bootstrap-factory.cmd ^<target^> --mode local --repo owner/name
REM
REM Equivalent to bootstrap-factory.sh but for Windows cmd.

setlocal EnableExtensions EnableDelayedExpansion
set "FACTORY_REPO=189-sketch/pi-software-factory"
set "FACTORY_BRANCH=main"
set "INSTALL_URL=https://raw.githubusercontent.com/%FACTORY_REPO%/%FACTORY_BRANCH%/scripts/install-factory.mjs"

set "TARGET="
set "MODE="
set "REPO="
set "START=0"
set "YES=0"

:parse_args
if "%~1"=="" goto after_args
if /i "%~1"=="--mode" (set "MODE=%~2"& shift& shift& goto parse_args)
if /i "%~1"=="--repo" (set "REPO=%~2"& shift& shift& goto parse_args)
if /i "%~1"=="--start" (set "START=1"& shift& goto parse_args)
if /i "%~1"=="-y" (set "YES=1"& shift& goto parse_args)
if /i "%~1"=="--non-interactive" (set "YES=1"& shift& goto parse_args)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
if "%~1:~0,1%"=="-" (
  echo Unknown option: %~1
  goto usage
)
if "%TARGET%"=="" (set "TARGET=%~1"& shift& goto parse_args)
goto parse_args

:usage
echo Usage: %~nx0 [target-path] [--mode cloud^|local^|both] [--repo OWNER/NAME] [--start]
echo.
echo Examples:
echo   %~nx0                          (interactive)
echo   %~nx0 . --mode local --repo me/my-app --start
exit /b 0

:after_args

REM --- prereqs ---
where curl >nul 2>nul
if errorlevel 1 (
  echo curl is required. Install from https://curl.se/windows/.
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo git is required. Install Git for Windows.
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo node is required. Install Node.js 20+ from https://nodejs.org/.
  exit /b 1
)

REM --- pick target ---
if "%TARGET%"=="" (
  set /p "TARGET=Target repo path (current dir if empty): "
  if "!TARGET!"=="" set "TARGET=."
)
if not exist "%TARGET%" (
  echo %TARGET% does not exist.
  exit /b 1
)
for %%I in ("%TARGET%") do set "TARGET=%%~fI"

REM --- pick mode ---
if "%MODE%"=="" (
  if "%YES%"=="1" (
    echo --mode required in non-interactive mode.
    exit /b 1
  )
  echo.
  echo Which mode do you want to enable?
  echo   1. cloud  - GitHub Actions runs the factory in ephemeral VMs ^(keys as repo secrets^)
  echo   2. local  - Local daemon polls GitHub + processes on this machine ^(keys stay local^)
  echo   3. both   - Install both; switch at runtime
  echo.
  set /p "CHOICE=Choose [1-3] (default 2): "
  if "!CHOICE!"=="" set "CHOICE=2"
  if "!CHOICE!"=="1" set "MODE=cloud"
  if "!CHOICE!"=="2" set "MODE=local"
  if "!CHOICE!"=="3" set "MODE=both"
)

REM --- pick repo ---
if "%REPO%"=="" (
  if "%YES%"=="1" (
    echo --repo required in non-interactive mode.
    exit /b 1
  )
  set /p "REPO=GitHub repo the factory should drive (owner/name): "
  if "!REPO!"=="" (
    echo repo required.
    exit /b 1
  )
)

echo.
echo ================================================================
echo  Software Factory - bootstrap
echo ================================================================
echo  Target:        %TARGET%
echo  Mode:          %MODE%
echo  Driven repo:   %REPO%
echo ================================================================
echo.

REM --- clone factory repo (we need the skills/, factory/, scripts/ files
REM     the installer references — the installer resolves paths relative
REM     to its own location, so we keep them together).
set "WORK=%TEMP%\factory-bootstrap-%RANDOM%"
git clone --depth 1 --branch %FACTORY_BRANCH% ^
  "https://github.com/%FACTORY_REPO%.git" "%WORK%\factory" >nul 2>nul
if errorlevel 1 (
  echo Failed to clone %FACTORY_REPO%
  exit /b 1
)

REM --- run installer from inside the cloned repo ---
set "INSTALLER=%WORK%\factory\scripts\install-factory.mjs"
set "INSTALL_FLAGS=--mode %MODE% --repo %REPO%"
if "%YES%"=="1" set "INSTALL_FLAGS=%INSTALL_FLAGS% --non-interactive"
node "%INSTALLER%" "%TARGET%" %INSTALL_FLAGS%
set "INSTALL_RC=%ERRORLEVEL%"
if not "%INSTALL_RC%"=="0" (
  echo Installer exited %INSTALL_RC%
  exit /b %INSTALL_RC%
)

REM --- cloud-mode tail ---
if /i "%MODE%"=="cloud" goto cloud_tail
if /i "%MODE%"=="both" goto cloud_tail
goto local_tail

:cloud_tail
echo.
echo  Cloud mode - set these secrets on the target repo:
echo.
echo    gh secret set ANTHROPIC_AUTH_TOKEN --repo %REPO%
echo    gh secret set ANTHROPIC_BASE_URL   --repo %REPO%   (optional)
echo    gh secret set ANTHROPIC_MODEL      --repo %REPO%   (optional)
echo.
echo  Then open a test issue:
echo    gh issue create --repo %REPO% ^
echo      --title "Test: factory should triage + implement" ^
echo      --body "Acceptance criteria: ..."
echo.

:local_tail
REM --- local-mode tail: prompt for secrets ---
if /i "%MODE%"=="local" goto local_secrets
if /i "%MODE%"=="both" goto local_secrets
goto done

:local_secrets
set "ENV_FILE=%TARGET%\.factory-daemon\.env"
findstr /C:"REPLACE_ME" "%ENV_FILE%" >nul 2>nul
if errorlevel 1 goto local_start_check
echo.
echo Local mode - fill in credentials:
set /p "GH_TOKEN_VAL=  GH_TOKEN (paste): "
set /p "ANTHROPIC_VAL=  ANTHROPIC_AUTH_TOKEN: "
set /p "BASE_VAL=       ANTHROPIC_BASE_URL [https://api.minimaxi.com/anthropic]: "
if "%BASE_VAL%"=="" set "BASE_VAL=https://api.minimaxi.com/anthropic"
set /p "MODEL_VAL=      ANTHROPIC_MODEL [MiniMax-M3]: "
if "%MODEL_VAL%"=="" set "MODEL_VAL=MiniMax-M3"
(
  echo GH_TOKEN=%GH_TOKEN_VAL%
  echo ANTHROPIC_AUTH_TOKEN=%ANTHROPIC_VAL%
  echo ANTHROPIC_BASE_URL=%BASE_VAL%
  echo ANTHROPIC_MODEL=%MODEL_VAL%
  echo FACTORY_GH_REPO=%REPO%
  echo FACTORY_POLL_INTERVAL=30
) > "%ENV_FILE%"
echo Wrote %ENV_FILE%

:local_start_check
if "%START%"=="1" (
  echo.
  echo Starting daemon in background...
  start /B "" "%TARGET%\.factory-daemon\start.cmd"
  timeout /t 3 /nobreak >nul
  tasklist /FI "IMAGENAME eq node.exe" 2>nul | findstr /I "node.exe" >nul
  if not errorlevel 1 (
    echo Daemon started.
  ) else (
    echo Daemon may have failed to start. Check %TARGET%\.factory-daemon\daemon.out
  )
) else (
  echo.
  echo  Next: start the daemon
  echo    %TARGET%\.factory-daemon\start.cmd
  echo  Or as a Windows Service ^(PowerShell as Administrator^):
  echo    %TARGET%\.factory-daemon\install-windows-service.ps1 -RepoPath "%TARGET%"
  echo    net start FactoryDaemon
)

:done
echo.
echo Factory ready in %MODE% mode.
endlocal
exit /b 0