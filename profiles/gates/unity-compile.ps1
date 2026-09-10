# Unity batchmode C# compile gate. Portable across machines:
#   - Unity editor from $env:UNITY_EXE (falls back to the Unity 6 Hub path).
#   - Project path from the first argument.
#   - Log to the OS temp dir (outside any repo, so `git add -A` never grabs it).
# Fails (non-zero exit) if Unity exits non-zero OR the log contains a C# compile error.
$ErrorActionPreference = 'Stop'

$proj = $args[0]
if (-not $proj) { Write-Host 'usage: unity-compile.ps1 <projectPath>'; exit 2 }

$exe = if ($env:UNITY_EXE) { $env:UNITY_EXE } else { 'C:\Program Files\Unity\Hub\Editor\6000.3.10f1\Editor\Unity.exe' }
if (-not (Test-Path $exe)) { Write-Host "Unity editor not found at $exe (set UNITY_EXE)"; exit 3 }

$log = Join-Path ([System.IO.Path]::GetTempPath()) ("unity-compile-" + $PID + ".log")
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host "Unity batchmode compile: $proj"
& $exe -batchmode -quit -nographics -projectPath $proj -logFile $log
$u = $LASTEXITCODE

if ($u -ne 0) {
    Write-Host "Unity exited with code $u"
    if (Test-Path $log) { Get-Content $log -Tail 80 }
    exit $u
}
if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'error CS' -Quiet)) {
    Write-Host 'C# compile errors:'
    Select-String -Path $log -Pattern 'error CS' | ForEach-Object { $_.Line }
    exit 1
}
Write-Host 'Unity compile OK (no error CS, exit 0)'
exit 0
