@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto path_error
if exist ".venv\Scripts\python.exe" goto verify_env
call setup.bat --configure-only
if errorlevel 1 goto fail
:verify_env
".venv\Scripts\python.exe" -c "import sys; print('Python:', sys.version.split()[0]); print('Interpreter:', sys.executable); sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)"
if errorlevel 1 goto old_python
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, httpx, numpy, multipart"
if errorlevel 1 goto missing_deps
".venv\Scripts\python.exe" -X utf8 setup_wizard.py --needs-setup
if not errorlevel 1 goto ready
".venv\Scripts\python.exe" -X utf8 setup_wizard.py
if errorlevel 1 goto fail
:ready
echo.
echo Starting the local server. Keep this window open.
echo Your browser will open when ready. If needed, open http://127.0.0.1:8000
echo Press Ctrl+C to stop.
".venv\Scripts\python.exe" -X utf8 launch_web.py
if errorlevel 1 goto server_error
popd
exit /b 0

:missing_env
echo ERROR: The project Python environment does not exist.
echo First install Python 3.10 or newer, then follow README.md.
echo Example with Python 3.10 and the Windows Python launcher:
echo   py -3.10 -m venv .venv
echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
goto fail

:old_python
echo ERROR: Python 3.10 or newer is required, or this environment is broken.
echo Installing dependencies again will not upgrade the environment's Python.
echo Recreate .venv using a supported interpreter. See README.md, then run setup.bat.
goto fail

:missing_deps
call setup.bat --configure-only
if errorlevel 1 goto fail
goto verify_env

:server_error
echo ERROR: The server stopped with an error. Please keep the traceback above.
goto fail

:path_error
echo ERROR: Cannot open the project directory.
pause
exit /b 1

:fail
popd
pause
exit /b 1
