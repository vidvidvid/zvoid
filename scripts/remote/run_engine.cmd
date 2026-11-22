@echo off
rem Runs one of Zvoid's engine workers on the PC. Zvoid on the Mac starts this over SSH and talks to it through stdin and stdout:
rem   run_engine.cmd <engine id>      (no argument = ace_step)
set Z=%USERPROFILE%\zvoid
set E=%1
if "%E%"=="" set E=ace_step
set HF_HOME=%Z%\hf
set HF_HUB_DISABLE_XET=1
set ACESTEP_LM_BACKEND=pt
set TOKENIZERS_PARALLELISM=false
set PY=%Z%\envs\%E%\Scripts\python.exe
if "%E%"=="ace_step" set PY=%Z%\ACE-Step-1.5\.venv\Scripts\python.exe
rem models that were copied over from the Mac are used as they are, without asking the model site
if not "%E%"=="ace_step" set HF_HUB_OFFLINE=1
cd /d "%Z%\app\engines\%E%"
"%PY%" -u -X utf8 "%Z%\app\worker.py" "%Z%\app\engines\%E%" 2>>"%Z%\app\engine_err.log"
