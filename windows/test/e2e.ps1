# End-to-end test of Slovo.exe on Windows, run by GitHub Actions (.github/workflows/windows.yml). The data folder and
# the sample have Cyrillic letters and spaces in their paths, as with a Russian user name. Results go to the run page as
# annotations, a screenshot of the window to windows/dist/window.png.
$ErrorActionPreference = "Stop"
$exe = (Resolve-Path "windows/dist/Slovo.exe").Path
$userHome = "C:\Тест Пользователь"
$env:LOCALAPPDATA = "$userHome\AppData\Local"
$data = "$env:LOCALAPPDATA\Slovo"
$sample = "$userHome\Запись речи.wav"
New-Item -ItemType Directory -Force $userHome | Out-Null
Invoke-WebRequest "https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav" -OutFile $sample

function Annotate([string]$Level, [string]$Title, [string]$Message) {
    Write-Output "::$Level title=$Title::$($Message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A'))"
}

function Connect {
    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Test-Path "$data\instance.json")) {
        if ((Get-Date) -gt $deadline) { throw "Slovo did not start" }
        Start-Sleep -Milliseconds 300
    }
    Start-Sleep -Milliseconds 300
    $instance = Get-Content "$data\instance.json" -Raw | ConvertFrom-Json
    $script:Base = "http://$($instance.address)"
    $script:Headers = @{ "X-Slovo-Token" = $instance.token }
}

function Get-State { Invoke-RestMethod -Uri "$script:Base/api/state" -TimeoutSec 15 }

function Send([string]$Path, $Body = @{}) {
    $json = ConvertTo-Json $Body -Compress
    Invoke-RestMethod -Method Post -Uri "$script:Base$Path" -Headers $script:Headers -TimeoutSec 30 `
        -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
}

function Await-Transcript([string]$What) {
    $deadline = (Get-Date).AddMinutes(5)
    do {
        Start-Sleep -Milliseconds 700
        $job = (Get-State).job
    } while ($job -and $job.status -eq "working" -and (Get-Date) -lt $deadline)
    if (-not $job -or $job.status -ne "done") { throw "$What ended as '$($job.status)': $($job.error)" }
    $text = ($job.segments | ForEach-Object { $_.text }) -join " "
    if ($text -notmatch "ask not what your country") { throw "$What gave unexpected text: $text" }
    Annotate notice $What ("{0:N1} s, {1}: {2}" -f $job.elapsed, $job.fileName, $text)
    return $job
}

function Stop-Window {
    Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like "*Slovo\browser*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

try {
    # 1. The server alone: model download, a file by path, an uploaded file, another pass.
    $server = Start-Process -FilePath $exe -ArgumentList "--no-window" -PassThru
    try {
        Connect
        if ((Invoke-WebRequest "$Base/" -UseBasicParsing).Content -notmatch "<title>Slovo</title>") { throw "the page is not served" }

        Send "/api/models/download" @{ id = "base" }
        $deadline = (Get-Date).AddMinutes(10)
        do {
            Start-Sleep 2
            $model = (Get-State).models | Where-Object id -eq "base"
        } until ($model.downloaded -or $model.error -or (Get-Date) -gt $deadline)
        if (-not $model.downloaded) { throw "model download failed: $($model.error)" }

        Send "/api/settings" @{ model = "base"; language = "en"; prompt = "Кеннеди, американцы"; skipSilence = $true; accurate = $true }
        Send "/api/open" @{ path = $sample }
        Await-Transcript "Cyrillic path, VAD, beam search, Russian prompt" | Out-Null
        $arguments = Get-Content "$data\work\whisper-arguments.txt" -Raw -Encoding utf8
        if ($arguments -notmatch "Кеннеди, американцы") { throw "the prompt is not in the arguments file: $arguments" }

        $name = [uri]::EscapeDataString("Речь.wav")
        Invoke-RestMethod -Method Post -Uri "$Base/api/upload?name=$name" -Headers $Headers -InFile $sample `
            -ContentType "application/octet-stream" | Out-Null
        $job = Await-Transcript "Uploaded file"
        if ($job.fileName -ne "Речь.wav") { throw "the upload lost its name: '$($job.fileName)'" }

        Send "/api/settings" @{ skipSilence = $false; accurate = $false }
        Send "/api/rerun" @{ model = "base"; language = "auto" }
        Await-Transcript "Another pass: greedy, no VAD, language detection" | Out-Null
    } finally {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }

    # 2. The app as the user starts it: the Edge window, a second launch with a file, closing the window.
    Remove-Item "$data\instance.json" -ErrorAction SilentlyContinue
    $app = Start-Process -FilePath $exe -PassThru
    try {
        Connect
        $deadline = (Get-Date).AddSeconds(60)
        do {
            Start-Sleep 1
            $edge = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like "*--app=$Base/*" }
        } until ($edge -or (Get-Date) -gt $deadline)
        if (-not $edge) { throw "Edge did not open the window" }
        Start-Sleep 6

        $second = Start-Process -FilePath $exe -ArgumentList "`"$sample`"" -PassThru
        if (-not $second.WaitForExit(20000)) { throw "the second launch did not hand the file over" }
        Await-Transcript "Second launch with a file" | Out-Null
        Start-Sleep 2

        try {
            Add-Type -AssemblyName System.Windows.Forms, System.Drawing
            $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
            [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
            $bitmap.Save((Join-Path (Resolve-Path "windows/dist") "window.png"))
        } catch {
            Annotate warning "Screenshot" $_.Exception.Message
        }
        $titles = (Get-Process msedge -ErrorAction SilentlyContinue | Where-Object MainWindowTitle | ForEach-Object MainWindowTitle) -join ", "
        Annotate notice "Window" "Edge windows: $titles"

        Stop-Window
        if (-not $app.WaitForExit(30000)) { throw "Slovo kept running after its window closed" }
        Annotate notice "Closing" "Slovo ended after its window closed"
    } finally {
        Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
        Stop-Window
    }
} catch {
    $details = ($_ | Out-String)
    if ($script:Base) {
        try { $details += "`n" + ((Get-State).job | ConvertTo-Json -Depth 4) } catch {}
    }
    Annotate error "End-to-end test" $details
    exit 1
}
