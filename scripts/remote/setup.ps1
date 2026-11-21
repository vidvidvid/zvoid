# One-time setup of a Windows PC with an Nvidia card as Zvoid's training machine.
# Everything goes into %USERPROFILE%\zvoid (about 25 GB); nothing else on the PC is touched.
# Copy this folder to the PC and run:  powershell -ExecutionPolicy Bypass -File setup.ps1
$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'
$Z = "$env:USERPROFILE\zvoid"; $C = 'ca1e85fe9430179831e6bc6be790c332190a3866'   # the ACE-Step 1.5 commit Zvoid is tested with
New-Item -ItemType Directory -Force -Path "$Z\bin", "$Z\app\engines\ace_step", "$Z\app\creatures" | Out-Null
$env:UV_CACHE_DIR = "$Z\cache"; $env:UV_PYTHON_INSTALL_DIR = "$Z\python"; $env:UV_LINK_MODE = 'copy'; $env:PYTHONUTF8 = '1'; $env:HF_HOME = "$Z\hf"
if (-not (Test-Path "$Z\bin\uv.exe")) { $env:UV_UNMANAGED_INSTALL = "$Z\bin"; Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression }
if (-not (Test-Path "$Z\ACE-Step-1.5\pyproject.toml")) {
  Invoke-WebRequest "https://github.com/ace-step/ACE-Step-1.5/archive/$C.zip" -OutFile "$Z\ace.zip" -UseBasicParsing
  Expand-Archive -Force "$Z\ace.zip" -DestinationPath $Z
  Rename-Item "$Z\ACE-Step-1.5-$C" "ACE-Step-1.5"; Remove-Item "$Z\ace.zip"
}
Set-Location "$Z\ACE-Step-1.5"
& "$Z\bin\uv.exe" sync --python 3.11
& "$Z\bin\uv.exe" run --no-sync python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
Copy-Item -Force "$PSScriptRoot\models.py" "$Z\app\models.py"
& "$Z\bin\uv.exe" run --no-sync python "$Z\app\models.py"
'ready. free space on C: ' + [math]::Round((Get-PSDrive C).Free / 1GB) + ' GB'
