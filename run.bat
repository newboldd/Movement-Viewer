@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

:: ── First-run: create a "Movement Viewer.lnk" shortcut so users see
::    the hand icon (icon.ico) instead of the generic .bat icon.
if exist "icon.ico" if not exist "Movement Viewer.lnk" (
    powershell -NoProfile -Command ^
        "$ws = New-Object -ComObject WScript.Shell;" ^
        "$sc = $ws.CreateShortcut((Join-Path (Get-Location) 'Movement Viewer.lnk'));" ^
        "$sc.TargetPath = (Join-Path (Get-Location) 'run.bat');" ^
        "$sc.WorkingDirectory = (Get-Location).Path;" ^
        "$sc.IconLocation = (Join-Path (Get-Location) 'icon.ico');" ^
        "$sc.Description = 'Movement Viewer';" ^
        "$sc.Save()" >nul 2>&1
)

:: ── Find Python ────────────────────────────────────────────────
:: Priority: .venv > active conda env > portable Python > system python > auto-install
set "PYTHON="

:: 1. Local .venv from a previous run
if exist ".venv\Scripts\python.exe" (
    set "PYTHON=.venv\Scripts\python.exe"
    goto :found
)

:: 1b. Portable Python in AppData (from a previous locked-down install)
if exist "%LOCALAPPDATA%\MovementViewer\python\python.exe" (
    "%LOCALAPPDATA%\MovementViewer\python\python.exe" -c "print('ok')" >nul 2>nul
    if not errorlevel 1 (
        set "PYTHON=%LOCALAPPDATA%\MovementViewer\python\python.exe"
        goto :found
    )
)

:: 2. Already in a conda env with uvicorn?
if defined CONDA_PREFIX (
    "%CONDA_PREFIX%\python.exe" -c "import uvicorn" 2>nul && (
        set "PYTHON=%CONDA_PREFIX%\python.exe"
        goto :found
    )
)

:: 3. Try standard conda installations
set "CONDA_BAT="
where conda >nul 2>nul && (
    for /f "delims=" %%C in ('where conda') do set "CONDA_BAT=%%~dpCactivate.bat"
)
if not defined CONDA_BAT (
    for %%D in (
        "%USERPROFILE%\anaconda3\Scripts\activate.bat"
        "%USERPROFILE%\miniconda3\Scripts\activate.bat"
        "C:\ProgramData\anaconda3\Scripts\activate.bat"
        "C:\ProgramData\miniconda3\Scripts\activate.bat"
    ) do (
        if exist %%D set "CONDA_BAT=%%~D"
    )
)
if defined CONDA_BAT (
    call "%CONDA_BAT%" 2>nul
    if defined CONDA_PREFIX (
        set "PYTHON=%CONDA_PREFIX%\python.exe"
        if exist "!PYTHON!" goto :found
    )
)

:: 4. System python (but skip Windows Store alias)
where python >nul 2>nul && (
    for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)" 2^>nul') do (
        echo %%P | findstr /i "WindowsApps" >nul
        if errorlevel 1 (
            set "PYTHON=python"
            goto :found
        )
    )
)

:: 5. Auto-install portable Python
echo.
echo Python not found. Attempting automatic install...
echo.

set "PY_ZIP=%TEMP%\python-3.11-embed.zip"
set "PORTABLE_DIR_APPDATA=%LOCALAPPDATA%\MovementViewer\python"
set "PORTABLE_DIR_LOCAL=%~dp0.python"

if exist "!PORTABLE_DIR_APPDATA!\python.exe" (
    "!PORTABLE_DIR_APPDATA!\python.exe" -c "print('ok')" >nul 2>nul
    if not errorlevel 1 (
        set "PORTABLE_DIR=!PORTABLE_DIR_APPDATA!"
        goto :portable_ready
    )
)
if exist "!PORTABLE_DIR_LOCAL!\python.exe" (
    "!PORTABLE_DIR_LOCAL!\python.exe" -c "print('ok')" >nul 2>nul
    if not errorlevel 1 (
        set "PORTABLE_DIR=!PORTABLE_DIR_LOCAL!"
        goto :portable_ready
    )
)

:: 0) If the user pre-placed a python-embed.zip next to run.bat
::    (downloaded on another machine), use that and skip the network.
if exist "%~dp0python-embed.zip" (
    echo Using pre-downloaded python-embed.zip from the script folder.
    copy /y "%~dp0python-embed.zip" "!PY_ZIP!" >nul
    goto :py_zip_ready
)

echo Downloading portable Python 3.11...
set "PY_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"

:: 1) curl (built into Windows 10/11; honors corporate proxies; shows progress)
where curl >nul 2>nul
if not errorlevel 1 (
    echo   trying curl...
    curl -L --connect-timeout 15 --retry 2 -o "!PY_ZIP!" "!PY_URL!"
    if exist "!PY_ZIP!" goto :py_zip_ready
)

:: 2) PowerShell with progress bar disabled (much faster, doesn't appear hung)
echo   trying PowerShell...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri '!PY_URL!' -OutFile '!PY_ZIP!' } catch { exit 1 }"
if exist "!PY_ZIP!" goto :py_zip_ready

:: 3) bitsadmin (older Windows; survives some Group Policies that block PS)
where bitsadmin >nul 2>nul
if not errorlevel 1 (
    echo   trying bitsadmin...
    bitsadmin /transfer "MovementViewerPy" "!PY_URL!" "!PY_ZIP!" >nul
    if exist "!PY_ZIP!" goto :py_zip_ready
)

if not exist "!PY_ZIP!" (
    echo.
    echo ============================================================
    echo  Could not download Python.  Likely causes:
    echo    - NYU/hospital firewall blocking python.org
    echo    - PowerShell/curl/bitsadmin all restricted by Group Policy
    echo.
    echo  Workaround:  on an unrestricted machine, download
    echo    !PY_URL!
    echo  save it as:
    echo    "%~dp0python-embed.zip"
    echo  then re-run this script.
    echo ============================================================
    pause
    exit /b 1
)
:py_zip_ready

set "PORTABLE_DIR=!PORTABLE_DIR_APPDATA!"
echo Extracting to %LOCALAPPDATA%\MovementViewer\...
mkdir "!PORTABLE_DIR!" 2>nul
powershell -Command "Expand-Archive -Path '!PY_ZIP!' -DestinationPath '!PORTABLE_DIR!' -Force" 2>nul
powershell -Command "(Get-Content '!PORTABLE_DIR!\python311._pth') -replace '^#import site','import site' | Set-Content '!PORTABLE_DIR!\python311._pth'" 2>nul

"!PORTABLE_DIR!\python.exe" -c "print('ok')" >nul 2>nul
if errorlevel 1 (
    echo AppData blocked by Group Policy, trying local folder...
    rmdir /s /q "!PORTABLE_DIR!" 2>nul
    set "PORTABLE_DIR=!PORTABLE_DIR_LOCAL!"
    mkdir "!PORTABLE_DIR!" 2>nul
    powershell -Command "Expand-Archive -Path '!PY_ZIP!' -DestinationPath '!PORTABLE_DIR!' -Force" 2>nul
    powershell -Command "(Get-Content '!PORTABLE_DIR!\python311._pth') -replace '^#import site','import site' | Set-Content '!PORTABLE_DIR!\python311._pth'" 2>nul
    "!PORTABLE_DIR!\python.exe" -c "print('ok')" >nul 2>nul
    if errorlevel 1 (
        echo.
        echo ============================================================
        echo  Python is blocked by Group Policy in both locations.
        echo  Ask IT to install Python 3.11 system-wide, or whitelist:
        echo    %LOCALAPPDATA%\MovementViewer\
        echo ============================================================
        del "!PY_ZIP!" 2>nul
        pause
        exit /b 1
    )
)
del "!PY_ZIP!" 2>nul

:portable_ready
:: Bootstrap pip via pip.pyz (no .exe — avoids Group Policy blocks)
set "PIP_PYZ=!PORTABLE_DIR!\pip.pyz"
if not exist "!PIP_PYZ!" (
    echo Downloading pip...
    powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/pip/pip.pyz' -OutFile '!PIP_PYZ!' }" 2>nul
)
set "PYTHON=!PORTABLE_DIR!\python.exe"
goto :found

:found
echo Using Python: %PYTHON%

:: ── Determine pip command ───────────────────────────────────────
set "PIP_CMD="
set "PIP_PYZ="
if exist "%LOCALAPPDATA%\MovementViewer\python\pip.pyz" set "PIP_PYZ=%LOCALAPPDATA%\MovementViewer\python\pip.pyz"
if exist "%~dp0.python\pip.pyz" set "PIP_PYZ=%~dp0.python\pip.pyz"
if defined PIP_PYZ (
    set "PIP_CMD=%PYTHON% "%PIP_PYZ%""
) else (
    set "PIP_CMD=%PYTHON% -m pip"
)

:: ── Check dependencies ─────────────────────────────────────────
echo Checking dependencies...
%PYTHON% -c "import uvicorn, fastapi, imageio_ffmpeg" 2>nul
if errorlevel 1 (
    echo Installing dependencies...
    if exist "%~dp0wheels" (
        %PIP_CMD% install --no-index --find-links "%~dp0wheels" -r requirements.txt --no-build-isolation
        if not errorlevel 1 goto :deps_ok
    )
    if defined PIP_PYZ (
        %PYTHON% "%PIP_PYZ%" install --only-binary :all: --no-cache-dir -r requirements.txt
        if not errorlevel 1 goto :deps_ok
        %PYTHON% "%PIP_PYZ%" install --no-cache-dir -r requirements.txt
        if not errorlevel 1 goto :deps_ok
    )
    %PYTHON% -m pip install --only-binary :all: -r requirements.txt
    if not errorlevel 1 goto :deps_ok
    %PYTHON% -m pip install -r requirements.txt
    if not errorlevel 1 goto :deps_ok
    echo.
    echo Failed to install dependencies. See README.md for offline-wheels instructions.
    pause
    exit /b 1
)
:deps_ok

:: ── Launch ─────────────────────────────────────────────────────
echo.
echo Starting Movement Viewer at http://localhost:8090
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8090"

%PYTHON% -m uvicorn viewer.app:app --host 127.0.0.1 --port 8090 --timeout-graceful-shutdown 3

pause
