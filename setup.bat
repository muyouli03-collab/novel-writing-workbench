@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
if not exist ".venv\Scripts\python.exe" goto find_python
".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 goto project_python
:find_python
py -3.10 -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 goto py310
py -3 -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 goto py3
python -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 goto python
 echo No usable Python 3.10+ was found through py or python.
 echo Opening the official Python download page in your browser...
 echo https://www.python.org/downloads/windows/
 start "" "https://www.python.org/downloads/windows/"
 echo Install Python 3.10 or newer using the Windows installer or install manager.
 echo With the traditional installer, enable "Add python.exe to PATH" if offered.
 echo With Python Install Manager: py install 3.10
 echo After installation, close this window and double-click setup.bat again.
 echo If the browser did not open, visit the address above manually.
 goto fail
:project_python
".venv\Scripts\python.exe" -X utf8 setup_wizard.py
goto result
:py310
py -3.10 -X utf8 setup_wizard.py
goto result
:py3
py -3 -X utf8 setup_wizard.py
goto result
:python
python -X utf8 setup_wizard.py
:result
if errorlevel 1 goto fail
if /i "%~1"=="--configure-only" goto done
call start.bat
if errorlevel 1 goto fail
:done
popd
exit /b 0
:fail
popd
pause
exit /b 1
