# =============================================================================
# Samsung Odyssey 3D (G90XF) - full-screen 3D page launcher
# =============================================================================
$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  SAMSUNG ODYSSEY 3D (G90XF) - 3D PAGE" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1. Start the LeiaSR hardware bridge (sr-bridge/sr_bridge.py on port 5033, starts in 2D mode).
#    The Python bridge is the reference one: it only loads the LeiaSR runtime's signed DLLs, whereas a
#    rebuilt sr-bridge.exe is unsigned and Windows Smart App Control may refuse to run it.
$BridgeDir = Join-Path $ProjectRoot "sr-bridge"
$BridgePy = Join-Path $BridgeDir "sr_bridge.py"
$BridgeExe = Join-Path $BridgeDir "sr-bridge.exe"

# Always start a fresh bridge: it reads the display geometry and the factory lens calibration once,
# at start-up, so a bridge left over from before the monitor was plugged in would serve stale data.
Get-Process -Name "sr-bridge" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*sr_bridge.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$Python = $null
$PythonArgs = ""
foreach ($Candidate in @("python", "py")) {
    $Cmd = Get-Command $Candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    # The Microsoft Store alias in WindowsApps is a stub that opens the Store, not a Python.
    if ($Cmd -and $Cmd.Source -notlike "*\WindowsApps\*") {
        $Python = $Cmd.Source
        if ($Candidate -eq "py") { $PythonArgs = "-3 " }
        break
    }
}

$BridgeStarted = $false
if ($Python -and (Test-Path $BridgePy)) {
    Write-Host "[1/3] Starting the LeiaSR bridge (sr_bridge.py) on 127.0.0.1:5033 (2D desktop mode)..." -ForegroundColor Green
    Start-Process -FilePath $Python -ArgumentList ($PythonArgs + "`"$BridgePy`" --port 5033") -WorkingDirectory $BridgeDir -WindowStyle Minimized
    $BridgeStarted = $true
} elseif (Test-Path $BridgeExe) {
    Write-Host "[1/3] Python 3 not found: starting sr-bridge.exe instead (Windows may block it)..." -ForegroundColor Yellow
    try {
        Start-Process -FilePath $BridgeExe -ArgumentList "--port 5033" -WorkingDirectory $BridgeDir -WindowStyle Minimized -ErrorAction Stop
        $BridgeStarted = $true
    } catch {
        Write-Host "      WARNING: sr-bridge.exe could not start: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "      Install Python 3 (python.org) so the launcher can use sr-bridge\sr_bridge.py." -ForegroundColor Yellow
    }
} else {
    Write-Host "[1/3] WARNING: no bridge found (sr-bridge\sr_bridge.py needs Python 3)." -ForegroundColor Yellow
}

if ($BridgeStarted) {
    $BridgeState = $null
    for ($i = 0; $i -lt 40 -and -not $BridgeState; $i++) {
        Start-Sleep -Milliseconds 300
        try { $BridgeState = Invoke-RestMethod -Uri "http://127.0.0.1:5033/state" -TimeoutSec 1 } catch {}
    }
    if (-not $BridgeState) {
        Write-Host "      WARNING: the bridge does not answer on 127.0.0.1:5033 (are the SR services running?)." -ForegroundColor Yellow
    } elseif (-not $BridgeState.weaveCorners.valid) {
        Write-Host "      WARNING: the LeiaSR runtime has not identified the monitor (no lens calibration)." -ForegroundColor Yellow
        Write-Host "      Check the monitor's USB upstream cable, then run this launcher again." -ForegroundColor Yellow
    } elseif (-not ($BridgeState.apiVersion -ge 2)) {
        Write-Host "      WARNING: outdated bridge (its weave data is wrong). Use sr-bridge\sr_bridge.py." -ForegroundColor Yellow
    } else {
        Write-Host ("      Display {0}x{1}, factory lens calibration loaded." -f $BridgeState.display.physResW, $BridgeState.display.physResH) -ForegroundColor Green
    }
}

# Ensure lens starts in 2D mode on the desktop; the viewer automatically enables 3D ONLY in Full-Screen (F)
try {
    $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:5033/lens/disable" -TimeoutSec 2 -ErrorAction SilentlyContinue
} catch {}

# 2. Start Vite Server on port 5173 if not already listening
$PortOpen = $false
try {
    $Tcp = New-Object System.Net.Sockets.TcpClient
    $Tcp.Connect("127.0.0.1", 5173)
    $Tcp.Close()
    $PortOpen = $true
} catch {
    $PortOpen = $false
}

if (-not $PortOpen) {
    if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
        Write-Host "[2/3] First run: installing npm packages..." -ForegroundColor Green
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm install" -WorkingDirectory $ProjectRoot -Wait -WindowStyle Minimized
    }
    Write-Host "[2/3] Starting the web server on http://localhost:5173 ..." -ForegroundColor Green
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" -WorkingDirectory $ProjectRoot -WindowStyle Minimized
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 300
        try {
            $Tcp = New-Object System.Net.Sockets.TcpClient
            $Tcp.Connect("127.0.0.1", 5173)
            $Tcp.Close()
            $PortOpen = $true
            break
        } catch {}
    }
} else {
    Write-Host "[2/3] WebGL2 Server is already active on http://localhost:5173" -ForegroundColor Green
}

# 3. Detect the 3840x2160 Samsung Odyssey G90XF screen bounds to position the window on that monitor
Add-Type -AssemblyName System.Windows.Forms
$TargetScreen = [System.Windows.Forms.Screen]::PrimaryScreen
foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
    if ($scr.Bounds.Width -ge 3840 -or $scr.Bounds.Height -ge 2160 -or $scr.Bounds.Width -ge 2560) {
        $TargetScreen = $scr
        break
    }
}
$WinX = $TargetScreen.Bounds.X
$WinY = $TargetScreen.Bounds.Y
$WinW = $TargetScreen.Bounds.Width
$WinH = $TargetScreen.Bounds.Height

Write-Host ("[3/3] Launching Full-Screen 3D Viewer on Monitor ({0}x{1} at {2},{3})..." -f $WinW, $WinH, $WinX, $WinY) -ForegroundColor Green

$ChromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)

$BrowserExe = $null
foreach ($p in $ChromePaths) {
    if (Test-Path $p) {
        $BrowserExe = $p
        break
    }
}

if ($BrowserExe) {
    $ProfileDir = Join-Path $env:LOCALAPPDATA "Odyssey3DStarterProfile"
    $AppArgs = @(
        "--user-data-dir=`"$ProfileDir`"",
        "--app=http://localhost:5173",
        "--window-position=$WinX,$WinY",
        "--window-size=$WinW,$WinH",
        "--start-fullscreen",
        "--no-first-run",
        "--no-default-browser-check"
    ) -join " "
    Start-Process -FilePath $BrowserExe -ArgumentList $AppArgs
} else {
    Start-Process "http://localhost:5173"
}

Write-Host ""
Write-Host "Ready. Keys in the page:" -ForegroundColor Cyan
Write-Host '  [F]      : toggle full-screen 3D (the lens is only on in full-screen weave mode)'
Write-Host '  [1]..[4] : weave | side-by-side | anaglyph | 2D'
Write-Host '  [T]      : red/cyan test pattern (left eye red, right eye cyan)'
Write-Host '  [H]      : hide the status box'
Write-Host 'Keep the minimised Python window open: it is the bridge to the monitor.'
