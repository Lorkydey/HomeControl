# Private stdin/stdout bridge. Load the vendor SDKs already installed on this PC.
# No driver installation, service changes, raw USB writes, or network listener.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$logiReady = $false
$logiSaved = $false
$aura = $null
$auraControl = $false
$pcDevices = @()
$discovery = $null

function Discover-Rgb {
    $script:pcDevices = @()
    $warnings = @()
    $keyboard = $null
    $dll = Join-Path $env:ProgramFiles 'LGHUB\sdks\sdk_legacy_led_x64.dll'
    if (Test-Path -LiteralPath $dll) {
        try {
            $keyboard = Get-PnpDevice -PresentOnly -Class USB | Where-Object {
                $_.FriendlyName -match '^G\d+.*(LIGHTSPEED|Keyboard|TKL)' -and $_.InstanceId -match '^USB\\VID_046D'
            } | Select-Object -First 1 -ExpandProperty FriendlyName
        } catch { $warnings += 'Détection Logitech indisponible.' }
    }
    $found = @()
    try {
        if ($null -eq $script:aura) { $script:aura = New-Object -ComObject aura.sdk.1 }
        $all = $script:aura.Enumerate(0)
        # Only physical internal PC lighting; exclude Windows Dynamic Lighting's
        # virtual aggregate, keyboards, mice, displays, and other peripherals.
        $types = @(0x10000, 0x11000, 0x20000, 0x70000, 0xB0000, 0xD1000)
        for ($i = 0; $i -lt $all.Count; $i++) {
            $device = $all.Item($i)
            if ($types -contains [int]$device.Type -and $device.Lights.Count -gt 0) {
                $script:pcDevices += $device
                $found += @{ name = [string]$device.Name; leds = [int]$device.Lights.Count }
            }
        }
    } catch { $warnings += 'Aura Sync indisponible. Vérifiez Armoury Crate et son service.' }
    return @{ keyboard = $keyboard; pc = @($found); warnings = @($warnings) }
}

function Start-Logitech {
    if ($script:logiReady) { return }
    if (-not $script:discovery.keyboard) { throw 'Clavier Logitech compatible non détecté. Branchez le clavier et ouvrez G HUB.' }
    $dll = (Join-Path $env:ProgramFiles 'LGHUB\sdks\sdk_legacy_led_x64.dll').Replace('"', '""')
    if (-not ('HomeControlLogi' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HomeControlLogi {
    [DllImport(@"$dll", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Unicode)]
    [return:MarshalAs(UnmanagedType.I1)] public static extern bool LogiLedInitWithName(string name);
    [DllImport(@"$dll", CallingConvention=CallingConvention.Cdecl)]
    [return:MarshalAs(UnmanagedType.I1)] public static extern bool LogiLedSetTargetDevice(int target);
    [DllImport(@"$dll", CallingConvention=CallingConvention.Cdecl)]
    [return:MarshalAs(UnmanagedType.I1)] public static extern bool LogiLedSaveCurrentLighting();
    [DllImport(@"$dll", CallingConvention=CallingConvention.Cdecl)]
    [return:MarshalAs(UnmanagedType.I1)] public static extern bool LogiLedRestoreLighting();
    [DllImport(@"$dll", CallingConvention=CallingConvention.Cdecl)]
    [return:MarshalAs(UnmanagedType.I1)] public static extern bool LogiLedSetLighting(int r, int g, int b);
    [DllImport(@"$dll", CallingConvention=CallingConvention.Cdecl)]
    public static extern void LogiLedShutdown();
}
"@
    }
    if (-not [HomeControlLogi]::LogiLedInitWithName('Home Control')) { throw 'G HUB refuse le contrôle RGB. Activez les intégrations dans G HUB.' }
    $script:logiReady = $true
    Start-Sleep -Milliseconds 150
    # PERKEY_RGB = 4: leave RGB mice and headsets alone.
    if (-not [HomeControlLogi]::LogiLedSetTargetDevice(4)) { throw 'Clavier RGB indisponible dans G HUB.' }
    $script:logiSaved = [HomeControlLogi]::LogiLedSaveCurrentLighting()
}

try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        $request = $null
        try {
            $request = $line | ConvertFrom-Json
            if ($null -eq $discovery -or $request.method -eq 'discover') { $discovery = Discover-Rgb }
            if ($request.method -eq 'discover') {
                $result = $discovery
            } elseif ($request.method -eq 'set') {
                $rgb = @($request.rgb)
                if ($rgb.Count -ne 3) { throw 'Couleur RGB invalide.' }
                foreach ($component in $rgb) {
                    if ($component -isnot [int] -or $component -lt 0 -or $component -gt 255) { throw 'Couleur RGB invalide.' }
                }
                if ($request.source -eq 'logitech') {
                    Start-Logitech
                    # Reassert the keyboard-only mask on every command, including
                    # after a failed initialization or a G HUB reconnection.
                    if (-not [HomeControlLogi]::LogiLedSetTargetDevice(4)) { throw 'Clavier RGB indisponible dans G HUB.' }
                    if (-not [HomeControlLogi]::LogiLedSetLighting(
                        [int][Math]::Round($rgb[0] * 100 / 255),
                        [int][Math]::Round($rgb[1] * 100 / 255),
                        [int][Math]::Round($rgb[2] * 100 / 255))) {
                        throw 'G HUB ne répond plus. Vérifiez les intégrations RGB et reconnectez le clavier.'
                    }
                } elseif ($request.source -eq 'aura') {
                    if ($pcDevices.Count -eq 0) { throw 'Aucune LED interne Aura détectée. Vérifiez Armoury Crate.' }
                    if (-not $auraControl) { [void]$aura.SwitchMode(); $auraControl = $true }
                    foreach ($device in $pcDevices) {
                        for ($i = 0; $i -lt $device.Lights.Count; $i++) {
                            $led = $device.Lights.Item($i)
                            $led.Red = [uint32]$rgb[0]
                            $led.Green = [uint32]$rgb[1]
                            $led.Blue = [uint32]$rgb[2]
                        }
                        [void]$device.Apply()
                    }
                } else { throw 'Source RGB inconnue.' }
                $result = $true
            } else { throw 'Commande RGB inconnue.' }
            [Console]::WriteLine((@{ id = $request.id; result = $result } | ConvertTo-Json -Compress -Depth 6))
        } catch {
            [Console]::WriteLine((@{ id = $request.id; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 4))
        }
    }
} finally {
    if ($logiReady) {
        if ($logiSaved -and [HomeControlLogi]::LogiLedSetTargetDevice(4)) { [void][HomeControlLogi]::LogiLedRestoreLighting() }
        [HomeControlLogi]::LogiLedShutdown()
    }
    # Aura releases control when the process exits, restoring the vendor effect.
}
