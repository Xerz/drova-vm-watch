[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$BlacklistPath = 'D:\bads.txt'
$EsmeRegistryPath = 'HKLM:\SOFTWARE\ITKey\Esme'
$SessionsUri = 'https://services.drova.io/session-manager/sessions'
$LogDirectory = Join-Path -Path $env:ProgramData -ChildPath 'Drova'
$LogPath = Join-Path -Path $LogDirectory -ChildPath 'ClientBlacklistGuard.log'
$BanMessage = 'К сожалению, владелец данного сервера запретил вам доступ к режиму рабочего стола. Контакты для связи смотрите на странице сервера. Сервер будет перезагружен в течение 5 минут'

function Write-GuardLog {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    try {
        if (-not (Test-Path -LiteralPath $LogDirectory -PathType Container)) {
            New-Item -Path $LogDirectory -ItemType Directory -Force | Out-Null
        }

        $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $LogPath -Value ("{0} [{1}] {2}" -f $timestamp, $Level, $Message) -Encoding UTF8
    }
    catch {
        # Logging must never turn an API/file error into a client lockout.
    }
}

function ConvertTo-NormalizedGuid {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }

    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    $parsedGuid = [Guid]::Empty
    if (-not [Guid]::TryParse($text, [ref]$parsedGuid)) {
        return $null
    }

    return $parsedGuid.ToString('D').ToLowerInvariant()
}

function Show-BanWindow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName WindowsBase

    $window = New-Object -TypeName System.Windows.Window
    $window.Title = 'Доступ к серверу запрещён'
    $window.WindowStyle = [System.Windows.WindowStyle]::None
    $window.ResizeMode = [System.Windows.ResizeMode]::NoResize
    $window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
    $window.WindowState = [System.Windows.WindowState]::Normal
    $window.Left = 0
    $window.Top = 0
    $window.Width = [System.Windows.SystemParameters]::PrimaryScreenWidth
    $window.Height = [System.Windows.SystemParameters]::PrimaryScreenHeight
    $window.Topmost = $true
    $window.ShowInTaskbar = $false
    $window.Background = [System.Windows.Media.Brushes]::Black

    $textBlock = New-Object -TypeName System.Windows.Controls.TextBlock
    $textBlock.Text = $Message
    $textBlock.FontFamily = New-Object -TypeName System.Windows.Media.FontFamily -ArgumentList 'Segoe UI'
    $textBlock.FontSize = 42
    $textBlock.FontWeight = [System.Windows.FontWeights]::SemiBold
    $textBlock.Foreground = [System.Windows.Media.Brushes]::White
    $textBlock.TextAlignment = [System.Windows.TextAlignment]::Center
    $textBlock.TextWrapping = [System.Windows.TextWrapping]::Wrap
    $textBlock.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
    $textBlock.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $textBlock.MaxWidth = [System.Windows.SystemParameters]::PrimaryScreenWidth * 0.8
    $textBlock.Margin = New-Object -TypeName System.Windows.Thickness -ArgumentList 80

    $window.Content = $textBlock

    $window.Add_Closing({
        param($sender, $eventArgs)
        $eventArgs.Cancel = $true
    })

    $window.Add_PreviewKeyDown({
        param($sender, $eventArgs)

        $altPressed = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Alt) -ne 0
        if ($altPressed -and $eventArgs.Key -eq [System.Windows.Input.Key]::F4) {
            $eventArgs.Handled = $true
        }
    })

    $window.Add_ContentRendered({
        $window.Activate() | Out-Null
        $window.Focus() | Out-Null
    })

    $window.Add_Deactivated({
        $window.Topmost = $false
        $window.Topmost = $true
        $window.Activate() | Out-Null
    })

    [void]$window.ShowDialog()
}

function Invoke-DrovaBlacklistGuard {
    Write-GuardLog -Level 'INFO' -Message 'Connection check started.'

    try {
        $esmeProperties = Get-ItemProperty -LiteralPath $EsmeRegistryPath -ErrorAction Stop
        $serverId = ConvertTo-NormalizedGuid -Value $esmeProperties.last_server
        if ($null -eq $serverId) {
            Write-GuardLog -Level 'ERROR' -Message 'Registry value last_server is missing or is not a valid UUID. Access was allowed.'
            return
        }

        $serversRegistryPath = Join-Path -Path $EsmeRegistryPath -ChildPath 'servers'
        $serverRegistryPath = Join-Path -Path $serversRegistryPath -ChildPath $serverId
        $serverProperties = Get-ItemProperty -LiteralPath $serverRegistryPath -ErrorAction Stop
        $authToken = ([string]$serverProperties.auth_token).Trim()
        if ([string]::IsNullOrWhiteSpace($authToken)) {
            Write-GuardLog -Level 'ERROR' -Message 'Registry value auth_token is missing or empty. Access was allowed.'
            return
        }
    }
    catch {
        Write-GuardLog -Level 'ERROR' -Message ("Could not read Drova registry values: {0}. Access was allowed." -f $_.Exception.Message)
        return
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $response = Invoke-RestMethod -Method Get -Uri $SessionsUri -Headers @{ 'X-Auth-Token' = $authToken } -TimeoutSec 15 -ErrorAction Stop
    }
    catch {
        Write-GuardLog -Level 'ERROR' -Message ("Sessions GET failed: {0}. Access was allowed." -f $_.Exception.Message)
        return
    }
    finally {
        $authToken = $null
    }

    if ($null -eq $response -or $null -eq $response.sessions) {
        Write-GuardLog -Level 'WARN' -Message 'Sessions GET returned no sessions array. Access was allowed.'
        return
    }

    $sessions = @($response.sessions)
    if ($sessions.Count -eq 0 -or $null -eq $sessions[0]) {
        Write-GuardLog -Level 'WARN' -Message 'Sessions GET returned an empty sessions array. Access was allowed.'
        return
    }

    $clientId = ConvertTo-NormalizedGuid -Value $sessions[0].client_id
    if ($null -eq $clientId) {
        Write-GuardLog -Level 'WARN' -Message 'The first session has no valid client_id. Access was allowed.'
        return
    }

    if (-not (Test-Path -LiteralPath $BlacklistPath -PathType Leaf)) {
        Write-GuardLog -Level 'ERROR' -Message ("Blacklist file {0} does not exist. Access was allowed." -f $BlacklistPath)
        return
    }

    try {
        $blockedClientIds = @()
        $invalidLineCount = 0

        foreach ($line in (Get-Content -LiteralPath $BlacklistPath -ErrorAction Stop)) {
            $trimmedLine = ([string]$line).Trim()
            if ([string]::IsNullOrWhiteSpace($trimmedLine)) {
                continue
            }

            $normalizedId = ConvertTo-NormalizedGuid -Value $trimmedLine
            if ($null -eq $normalizedId) {
                $invalidLineCount++
                continue
            }

            $blockedClientIds += $normalizedId
        }

        if ($invalidLineCount -gt 0) {
            Write-GuardLog -Level 'WARN' -Message ("Ignored {0} invalid non-empty line(s) in the blacklist." -f $invalidLineCount)
        }
    }
    catch {
        Write-GuardLog -Level 'ERROR' -Message ("Could not read blacklist file: {0}. Access was allowed." -f $_.Exception.Message)
        return
    }

    if ($blockedClientIds -notcontains $clientId) {
        Write-GuardLog -Level 'INFO' -Message ("Client {0} is not blocked." -f $clientId)
        return
    }

    Write-GuardLog -Level 'WARN' -Message ("Blocked client {0} connected. Scheduling a restart in 300 seconds." -f $clientId)

    $shutdownPath = Join-Path -Path $env:SystemRoot -ChildPath 'System32\shutdown.exe'
    try {
        & $shutdownPath /r /f /t 300 /c $BanMessage | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-GuardLog -Level 'ERROR' -Message ("shutdown.exe returned exit code {0}." -f $LASTEXITCODE)
        }
    }
    catch {
        Write-GuardLog -Level 'ERROR' -Message ("Could not schedule the restart: {0}" -f $_.Exception.Message)
    }

    try {
        Show-BanWindow -Message $BanMessage
    }
    catch {
        Write-GuardLog -Level 'ERROR' -Message ("Could not display the ban window: {0}" -f $_.Exception.Message)
    }
}

try {
    Invoke-DrovaBlacklistGuard
}
catch {
    Write-GuardLog -Level 'ERROR' -Message ("Unexpected guard error: {0}. Access was allowed." -f $_.Exception.Message)
}
