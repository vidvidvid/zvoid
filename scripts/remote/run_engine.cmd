@echo off
rem Runs Zvoid's ACE-Step worker on the PC. Zvoid on the Mac starts this over SSH and talks to it through stdin and stdout.
set Z=%USERPROFILE%\zvoid
set HF_HOME=%Z%\hf
set HF_HUB_DISABLE_XET=1
set ACESTEP_LM_BACKEND=pt
set TOKENIZERS_PARALLELISM=false
cd /d "%Z%\app\engines\ace_step"
"%Z%\ACE-Step-1.5\.venv\Scripts\python.exe" -u -X utf8 "%Z%\app\worker.py" "%Z%\app\engines\ace_step" 2>>"%Z%\app\engine_err.log"
