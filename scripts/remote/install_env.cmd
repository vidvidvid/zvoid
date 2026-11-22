@echo off
rem Makes the Python environment of one Zvoid engine on the PC. Zvoid on the Mac sends this over and runs it:
rem   install_env.cmd <engine id>      (the list of packages is in app\reqs_<engine id>.txt)
set Z=%USERPROFILE%\zvoid
set UV_CACHE_DIR=%Z%\cache\uv
set UV_PYTHON_INSTALL_DIR=%Z%\python
"%Z%\bin\uv.exe" venv --allow-existing --python 3.11 "%Z%\envs\%1"
if errorlevel 1 exit /b 1
"%Z%\bin\uv.exe" pip install --python "%Z%\envs\%1\Scripts\python.exe" --index-url https://download.pytorch.org/whl/cu128 torch torchaudio
if errorlevel 1 exit /b 1
"%Z%\bin\uv.exe" pip install --python "%Z%\envs\%1\Scripts\python.exe" -r "%Z%\app\reqs_%1.txt"
if errorlevel 1 exit /b 1
"%Z%\envs\%1\Scripts\python.exe" -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
if errorlevel 1 exit /b 1
echo ok> "%Z%\envs\%1\.zvoid-installed"
