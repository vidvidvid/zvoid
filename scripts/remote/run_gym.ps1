# Runs one training session on the PC. Zvoid on the Mac starts this over SSH and reads the JSON lines it prints.
param([Parameter(Mandatory = $true)][string]$Slug)
$Z = Split-Path -Parent $PSScriptRoot
$env:UV_CACHE_DIR = "$Z\cache"; $env:UV_PYTHON_INSTALL_DIR = "$Z\python"; $env:PYTHONUTF8 = '1'; $env:HF_HOME = "$Z\hf"
$C = "$Z\app\creatures\$Slug"
Set-Location "$Z\app"
& "$Z\bin\uv.exe" run --no-sync --project "$Z\ACE-Step-1.5" python -u "$Z\app\engines\ace_step\gym.py" $C "@$C\opt.json" 2>"$C\train_err.log"
exit $LASTEXITCODE
