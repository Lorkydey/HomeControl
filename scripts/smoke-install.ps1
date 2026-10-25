$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem -LiteralPath 'src-tauri/target/release/bundle/nsis' -Filter '*-setup.exe' | Select-Object -First 1
if (-not $installer) { throw 'Installer missing' }
$installDirectory = Join-Path $env:RUNNER_TEMP 'HomeControlSmoke'
$installerProcess = Start-Process -FilePath $installer.FullName -ArgumentList '/S', "/D=$installDirectory" -Wait -PassThru -WindowStyle Hidden
if ($installerProcess.ExitCode -ne 0) { throw "Installer failed: $($installerProcess.ExitCode)" }
$binary = Join-Path $installDirectory 'homecontrol.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw 'Installed executable missing' }
$appProcess = Start-Process -FilePath $binary -WorkingDirectory $installDirectory -PassThru -WindowStyle Hidden
try {
    Start-Sleep -Seconds 8
    if ($appProcess.HasExited) { throw 'Installed application exited prematurely' }
    $engine = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ParentProcessId -eq $appProcess.Id })
    if ($engine.Count -ne 1) { throw 'Bundled Matter engine did not start' }
    $configuration = Join-Path $env:LOCALAPPDATA 'fr.lorkydey.homecontrol/config.json'
    $config = Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json
    if ($config.version -ne 1 -or $config.lights.Count -ne 3) { throw 'Fresh configuration was not created' }
} finally {
    Stop-Process -Id $appProcess.Id -ErrorAction SilentlyContinue
    foreach ($child in $engine) { Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue }
}
$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $($installer.Name)" | Set-Content -LiteralPath (Join-Path $installer.DirectoryName 'SHA256SUMS.txt') -Encoding utf8NoBOM
Write-Output 'Installation, generated configuration and bundled engine verified.'
