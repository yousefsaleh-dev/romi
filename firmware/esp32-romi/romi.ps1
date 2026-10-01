[CmdletBinding()]
param(
    [ValidateSet('menu', 'prepare', 'configure', 'doctor', 'ports', 'build', 'flash', 'monitor', 'test')]
    [string]$Action = 'menu',
    [ValidateSet('safe', 'bench', 'demo', 'full', 'full-safe', 'audio-bench')]
    [string]$Mode = 'safe',
    [string]$Port = '',
    [switch]$InsecureTls
)

$ErrorActionPreference = 'Stop'
$script:FirmwareDirectory = $PSScriptRoot
$script:RepositoryDirectory = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$script:ToolsDirectory = Join-Path $script:RepositoryDirectory '.tools'
$script:PythonArguments = @()

function Find-Python {
    $localPython = Join-Path $script:ToolsDirectory 'platformio/Scripts/python.exe'
    if (Test-Path -LiteralPath $localPython) { return $localPython }
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) { return $pythonCommand.Source }
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        $script:PythonArguments = @('-3')
        return $launcher.Source
    }
    throw 'Python is missing. Install Python 3.11+ before the event, then run prepare.'
}

function Initialize-PlatformIO([switch]$InstallIfMissing) {
    $script:PythonExecutable = Find-Python
    & $script:PythonExecutable @script:PythonArguments -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('platformio') else 1)"
    if ($LASTEXITCODE -eq 0) { return }
    if (!$InstallIfMissing) { throw 'PlatformIO is missing. Run: .\firmware\esp32-romi\romi.ps1 prepare' }
    $venvDirectory = Join-Path $script:ToolsDirectory 'platformio'
    & $script:PythonExecutable @script:PythonArguments -m venv $venvDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the PlatformIO Python environment.' }
    $script:PythonExecutable = Join-Path $venvDirectory 'Scripts/python.exe'
    $script:PythonArguments = @()
    & $script:PythonExecutable -m pip install 'platformio==6.2.0'
    if ($LASTEXITCODE -ne 0) { throw 'PlatformIO installation failed. Check Internet access and run prepare again.' }
}

function Invoke-PlatformIO([string[]]$PioArguments) {
    & $script:PythonExecutable @script:PythonArguments -m platformio @PioArguments
    if ($LASTEXITCODE -ne 0) { throw 'PlatformIO failed. See HACKATHON.md for the error and recovery steps.' }
}

function Set-LocalMode([string]$SelectedMode, [bool]$SkipCertificateValidation) {
    if ($SkipCertificateValidation -and $SelectedMode -notin @('demo','full')) {
        throw '-InsecureTls is allowed only with demo or full hackathon modes.'
    }
    $bench = [int]($SelectedMode -in @('bench','audio-bench'))
    $demo = [int]($SelectedMode -in @('demo','full'))
    $debug = [int]($SelectedMode -notin @('safe','full-safe'))
    $audio = [int]($SelectedMode -in @('full','full-safe','audio-bench'))
    $script:BuildEnvironment = if ($audio) { 'romi-full-devkit-v1' } else { 'romi-devkit-v1' }
    $insecure = [int]$SkipCertificateValidation
    $header = @"
#pragma once
// Local launcher settings; this file is ignored by Git.
#ifndef ROMI_ENABLE_AUDIO
#define ROMI_ENABLE_AUDIO $audio
#endif
#define ROMI_BENCH_MODE $bench
#define ROMI_DEMO_ASSUME_SERVO_MOVED $demo
#define ROMI_HACKATHON_DEBUG_MODE $debug
#define ROMI_ALLOW_INSECURE_TLS_FOR_DEMO $insecure
"@
    $headerPath = Join-Path $script:FirmwareDirectory 'include/romi_local.h'
    [IO.File]::WriteAllText($headerPath, $header, [Text.UTF8Encoding]::new($false))
    Write-Host "Mode: $SelectedMode | Audio: $audio | Insecure TLS: $SkipCertificateValidation"
    if ($demo) { Write-Host 'DEMO: timed servo motion will be reported as success without a door sensor.' -ForegroundColor Yellow }
    if ($insecure) { Write-Host 'DEMO: the server certificate will not be verified.' -ForegroundColor Yellow }
}

function Get-SerialPorts {
    $portsJson = & $script:PythonExecutable @script:PythonArguments -m platformio device list --json-output
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate serial ports.' }
    # Windows PowerShell 5.1 does not enumerate JSON arrays like PowerShell 7.
    $serialPorts = ConvertFrom-Json -InputObject ($portsJson -join "`n")
    foreach ($serialPort in $serialPorts) { Write-Output $serialPort }
}

function Get-UsbSerialPorts {
    return @(Get-SerialPorts | Where-Object {
        $_.hwid -match 'USB|VID:PID' -or $_.description -match 'CP210|CH340|CH341|CH910|FTDI|USB.*Serial|USB.*UART'
    })
}

function Select-UploadPort {
    if ($Port) { return $Port }
    $usbPorts = @(Get-UsbSerialPorts)
    if ($usbPorts.Count -eq 0) {
        throw 'No USB serial board found. Connect a data USB cable. Use ports to inspect; Intel SOL is not an ESP32.'
    }
    if ($usbPorts.Count -eq 1) { return $usbPorts[0].port }
    for ($index = 0; $index -lt $usbPorts.Count; $index++) {
        Write-Host "$($index + 1): $($usbPorts[$index].port) - $($usbPorts[$index].description)"
    }
    $selection = Read-Host 'Select board number'
    $selectedIndex = 0
    if (![int]::TryParse($selection, [ref]$selectedIndex) -or $selectedIndex -lt 1 -or $selectedIndex -gt $usbPorts.Count) {
        throw 'Invalid board selection. Run again with -Port COMx.'
    }
    return $usbPorts[$selectedIndex - 1].port
}

function Read-PrivateValue([string]$Prompt) {
    $privateInput = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($privateInput)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function ConvertTo-CppLiteral([string]$Text) {
    $escaped = $Text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n')
    return '"' + $escaped + '"'
}

function Get-TrustedRootCa([Uri]$DeploymentUri) {
    $connection = [Net.Sockets.TcpClient]::new()
    $tls = $null
    $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        if (!$connection.ConnectAsync($DeploymentUri.DnsSafeHost, $DeploymentUri.Port).Wait(5000)) {
            throw 'Timed out connecting to deployment for certificate discovery.'
        }
        $tls = [Net.Security.SslStream]::new($connection.GetStream(), $false)
        $tls.ReadTimeout = 5000
        $tls.WriteTimeout = 5000
        # No validation callback: Windows must validate both certificate trust and host name.
        $tls.AuthenticateAsClient($DeploymentUri.DnsSafeHost)
        if (!$tls.IsEncrypted -or !$tls.IsSigned) { throw 'Deployment TLS is not authenticated.' }
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($tls.RemoteCertificate)
        try {
            $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
            $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(5)
            if (!$chain.Build($certificate)) { throw 'Could not build a trusted deployment certificate chain.' }
            $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
            $base64 = [Convert]::ToBase64String($root.RawData)
            $pemLines = [regex]::Matches($base64, '.{1,64}') | ForEach-Object Value
            return "-----BEGIN CERTIFICATE-----`n$($pemLines -join "`n")`n-----END CERTIFICATE-----`n"
        } finally { $certificate.Dispose() }
    } finally {
        $chain.Dispose()
        if ($tls) { $tls.Dispose() }
        $connection.Dispose()
    }
}

function Configure-Device {
    Write-Host 'Device settings: include/romi_secrets.h. Do not paste provider or database keys.'
    $ssid = Read-Host 'WiFi SSID (2.4 GHz)'
    $wifiPassword = Read-PrivateValue 'WiFi password (blank for an open network)'
    $baseUrl = (Read-Host 'ROMI HTTPS URL, e.g. https://romi.vercel.app').Trim().TrimEnd('/')
    $deviceToken = Read-PrivateValue 'ROMI_DEVICE_TOKEN (the same value configured on Vercel)'
    $deploymentUri = $null
    if (!$ssid -or !$deviceToken -or ![Uri]::TryCreate($baseUrl, [UriKind]::Absolute, [ref]$deploymentUri) -or
        $deploymentUri.Scheme -ne 'https' -or $deploymentUri.UserInfo -or $deploymentUri.Query -or
        $deploymentUri.Fragment -or $deploymentUri.AbsolutePath -ne '/') {
        throw 'SSID, token and an HTTPS origin URL are required. Nothing has been saved.'
    }
    $caPath = Read-Host 'Root CA PEM path (Enter = discover trusted root automatically; SKIP = demo only)'
    $certificate = ''
    if (!$caPath) {
        Write-Host 'Discovering root CA through a Windows-validated TLS connection...'
        $certificate = Get-TrustedRootCa $deploymentUri
    } elseif ($caPath -ne 'SKIP') {
        $certificate = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $caPath).Path)
        if ($certificate -notmatch '-----BEGIN CERTIFICATE-----') { throw 'This is not a PEM certificate file.' }
    }
    $header = @"
#pragma once
static constexpr char ROMI_WIFI_SSID[] = $(ConvertTo-CppLiteral $ssid);
static constexpr char ROMI_WIFI_PASSWORD[] = $(ConvertTo-CppLiteral $wifiPassword);
static constexpr char ROMI_API_BASE_URL[] = $(ConvertTo-CppLiteral $baseUrl);
static constexpr char ROMI_DEVICE_TOKEN[] = $(ConvertTo-CppLiteral $deviceToken);
static constexpr char ROMI_ROOT_CA_BUNDLE[] = $(ConvertTo-CppLiteral $certificate);
"@
    [IO.File]::WriteAllText((Join-Path $script:FirmwareDirectory 'include/romi_secrets.h'), $header, [Text.UTF8Encoding]::new($false))
    Write-Host 'Device settings saved. Password and token were not printed.' -ForegroundColor Green
    if (!$certificate) { Write-Host 'CA is missing: safe network mode cannot run. Demo can use explicit -InsecureTls.' -ForegroundColor Yellow }
}

function Assert-DeviceSettings {
    if ($Mode -in @('bench','audio-bench')) { return }
    $secretsPath = Join-Path $script:FirmwareDirectory 'include/romi_secrets.h'
    if (!(Test-Path -LiteralPath $secretsPath)) { throw 'Run configure first, or use -Mode bench for offline hardware tests.' }
    $secretsHeader = [IO.File]::ReadAllText($secretsPath)
    if ($secretsHeader -match 'REPLACE_WITH|YOUR_DEPLOYED_HOST') { throw 'Device settings still contain placeholders. Run configure.' }
    if (!$InsecureTls -and $secretsHeader -notmatch '-----BEGIN CERTIFICATE-----') {
        throw 'Trusted CA missing. Configure a PEM certificate, or explicitly use -Mode demo -InsecureTls for the demo.'
    }
}

function Build-Core([string]$SelectedMode, [bool]$SkipCertificateValidation) {
    Set-LocalMode $SelectedMode $SkipCertificateValidation
    Invoke-PlatformIO -PioArguments @('run', '-d', $script:FirmwareDirectory, '-e', $script:BuildEnvironment)
}

function Show-Doctor {
    Write-Host "Firmware directory: $script:FirmwareDirectory"
    Write-Host 'Supported target: classic ESP32 / ESP-WROOM-32. S3/C3 need a different board configuration and pin map.'
    Invoke-PlatformIO -PioArguments @('--version')
    $serialPorts = @(Get-SerialPorts)
    $serialPorts | Select-Object port, description, hwid | Format-Table -AutoSize
    if (@(Get-UsbSerialPorts).Count -eq 0) { Write-Host 'No ESP32 USB serial candidate detected. This is normal before you have the board.' -ForegroundColor Yellow }
    $secretsPath = Join-Path $script:FirmwareDirectory 'include/romi_secrets.h'
    if (!(Test-Path -LiteralPath $secretsPath)) {
        Write-Host 'Device settings: missing. Bench works; network demo needs configure.' -ForegroundColor Yellow
    } else {
        $secretsHeader = [IO.File]::ReadAllText($secretsPath)
        Write-Host "Device settings: present | CA PEM present: $($secretsHeader -match '-----BEGIN CERTIFICATE-----')"
    }
    Write-Host 'Pins: servo=23 button=33 red=25 green=26. Change only include/romi_config.h if wiring differs.'
    Write-Host 'No hardware test is claimed by this diagnostic.'
}

function Show-Menu {
    Write-Host 'ROMI ESP32 launcher'
    Write-Host '1 prepare  : install/cache tools and compile modes before the event'
    Write-Host '2 configure: enter WiFi, URL and device token privately'
    Write-Host '3 doctor   : inspect tools, settings and USB ports'
    Write-Host '4 test     : flash offline bench mode and open logs (O/C/T/S)'
    Write-Host '5 flash    : flash standalone voice + door (mic/amplifier required)'
    Write-Host '6 monitor  : open live logs'
    Write-Host '7 audio test: flash offline mic/speaker diagnostics (M/A)'
    Write-Host '8 phone fallback: flash door controller; phone provides voice'
    $choice = Read-Host 'Choose 1-8'
    switch ($choice) {
        '1' { $script:Action = 'prepare' }
        '2' { $script:Action = 'configure' }
        '3' { $script:Action = 'doctor' }
        '4' { $script:Action = 'test' }
        '5' { $script:Action = 'flash'; $script:Mode = 'full' }
        '6' { $script:Action = 'monitor' }
        '7' { $script:Action = 'test'; $script:Mode = 'audio-bench' }
        '8' { $script:Action = 'flash'; $script:Mode = 'demo' }
        default { throw 'Invalid menu choice.' }
    }
}

try {
    if ($Action -eq 'menu') { Show-Menu }
    if ($Action -eq 'configure') { Configure-Device; return }
    Initialize-PlatformIO -InstallIfMissing:($Action -eq 'prepare')
    switch ($Action) {
        'prepare' {
            Build-Core 'bench' $false
            Build-Core 'demo' $false
            Build-Core 'audio-bench' $false
            Build-Core 'full' $false
            Build-Core 'safe' $false
            New-Item -ItemType Directory -Path $script:ToolsDirectory -Force | Out-Null
            $report = 'Core and standalone audio builds passed. Hardware and deployed ROMI API remain unverified.'
            [IO.File]::WriteAllText((Join-Path $script:ToolsDirectory 'prepare-report.txt'), $report)
            Write-Host 'Prepared. Keep this repo folder AND this Windows user profile on the competition laptop.' -ForegroundColor Green
            Write-Host 'A new clone alone does not include private device settings or cached tools.'
        }
        'doctor' { Show-Doctor }
        'ports' { Get-SerialPorts | Select-Object port, description, hwid | Format-Table -AutoSize }
        'build' { Build-Core $Mode ([bool]$InsecureTls) }
        'flash' {
            Assert-DeviceSettings
            Set-LocalMode $Mode ([bool]$InsecureTls)
            $selectedPort = Select-UploadPort
            Write-Host "Uploading to $selectedPort. Close other Serial Monitor windows first."
            Invoke-PlatformIO -PioArguments @('run', '-d', $script:FirmwareDirectory, '-e', $script:BuildEnvironment, '-t', 'upload', '--upload-port', $selectedPort)
        }
        'monitor' {
            $selectedPort = Select-UploadPort
            Write-Host 'Ctrl+C closes the monitor. Debug: O=open C=close T=cycle S=status P=poll. Audio: M=mic levels A=test tone.'
            Invoke-PlatformIO -PioArguments @('device', 'monitor', '-p', $selectedPort, '-b', '115200')
        }
        'test' {
            $testMode = if ($Mode -eq 'audio-bench') { 'audio-bench' } else { 'bench' }
            Set-LocalMode $testMode $false
            $selectedPort = Select-UploadPort
            Invoke-PlatformIO -PioArguments @('run', '-d', $script:FirmwareDirectory, '-e', $script:BuildEnvironment, '-t', 'upload', '--upload-port', $selectedPort)
            Write-Host 'Offline bench: type T to run one servo cycle; S to print state. Ctrl+C to exit.'
            if ($testMode -eq 'audio-bench') { Write-Host 'Audio bench: M=show mic peaks (speak, then M again); A=short speaker tone. No API/session calls.' }
            Invoke-PlatformIO -PioArguments @('device', 'monitor', '-p', $selectedPort, '-b', '115200')
        }
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
