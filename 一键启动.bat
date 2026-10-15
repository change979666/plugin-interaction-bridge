@echo off
chcp 65001
title 插件互通服务端
echo ==========================================
echo       正在启动 Python 服务端...
echo ==========================================
echo.

cd /d "%~dp0\plugin_interaction_demo"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
if exist "%VENV_PY%" (
	echo 使用虚拟环境解释器: %VENV_PY%
	"%VENV_PY%" -c "import sys; print('Python:', sys.version); print('Exe:', sys.executable)"
	"%VENV_PY%" -m python_app.main
) else (
	echo 未找到虚拟环境解释器，回退使用系统 python
	python -c "import sys; print('Python:', sys.version); print('Exe:', sys.executable)"
	python -m python_app.main
)
pause