param([ValidateSet('desktop', 'web')][string]$DshProfile = 'desktop', [switch]$Preview,
      [switch]$PreviewSleep, [switch]$PreviewSettings, [switch]$PreviewChartYear)

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$ErrorActionPreference = 'Stop'
$created = $false
$mutexName = if ($Preview) { 'Local\DshSimpleDesktopPetPreview' } else { 'Local\DshSimpleDesktopPet' }
$script:SingleInstance = New-Object Threading.Mutex($true, $mutexName, [ref]$created)
if (-not $created) { exit 0 }
$script:ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $script:ProjectRoot 'skin-catalog.ps1')
. (Join-Path $script:ProjectRoot 'card-themes.ps1')
. (Join-Path $script:ProjectRoot 'companion-view.ps1')
. (Join-Path $script:ProjectRoot 'usage-view.ps1')
$script:DataDir = Join-Path $env:LOCALAPPDATA 'DshSimpleDesktopPet'
$script:StateFile = Join-Path $script:DataDir "state-$DshProfile.json"
$script:SettingsFile = Join-Path $script:DataDir $(if ($Preview) { 'settings-preview.json' } else { 'settings.json' })
$script:PositionFile = Join-Path $script:DataDir 'position.json'
$script:LegacySettingsFile = Join-Path (Join-Path $env:LOCALAPPDATA 'DshDeepSeekPet') 'settings.json'
New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
if (-not $Preview -and -not (Test-Path -LiteralPath $script:SettingsFile)) {
  foreach ($legacySettings in @($script:LegacySettingsFile)) {
    if (Test-Path -LiteralPath $legacySettings) { Copy-Item -LiteralPath $legacySettings -Destination $script:SettingsFile; break }
  }
}

$script:Prefs = [ordered]@{ skin = 'default'; cardTheme = 'default'; unit = 'cny'; size = 'medium'; billingMode = 'deepseek'; codexUnit = 'token'; quietMode = $false; feedbackStyle = 'classic'; reduceMotion = $false; disableFlashes = $false; disableFloats = $false; codexQuotaRefreshSeconds = 5; codexWarmupDaily = $false; codexWarmupTime = '09:30'; codexWarmupReset = $false; codexWarmupStartup = $false; sleepMinutes = 10; left = $null; top = $null }
function Set-PetPreferenceValues($saved) {
  # Omitted/ill-typed fields use the same defaults at startup and on hot reload.
  $defaults = [ordered]@{ skin = 'default'; cardTheme = 'default'; unit = 'cny'; size = 'medium'; billingMode = 'deepseek'; codexUnit = 'token'; quietMode = $false; feedbackStyle = 'classic'; reduceMotion = $false; disableFlashes = $false; disableFloats = $false; codexQuotaRefreshSeconds = 5; codexWarmupDaily = $false; codexWarmupTime = '09:30'; codexWarmupReset = $false; codexWarmupStartup = $false; sleepMinutes = 10 }
  foreach ($key in $defaults.Keys) {
    # Direct assignment preserves singleton JSON arrays so typed validation rejects them.
    if ($null -ne $saved.$key) { $script:Prefs[$key] = $saved.$key }
    else { $script:Prefs[$key] = $defaults[$key] }
  }
  foreach ($key in @('quietMode', 'reduceMotion', 'disableFlashes', 'disableFloats')) {
    if ($script:Prefs[$key] -isnot [bool]) { $script:Prefs[$key] = $false }
  }
  if ($script:Prefs.feedbackStyle -isnot [string] -or $script:Prefs.feedbackStyle -cnotin @('classic', 'gentle')) { $script:Prefs.feedbackStyle = 'classic' }
  $savedWarmupTimeValid = $saved.codexWarmupTime -is [string] -and $saved.codexWarmupTime -cmatch '\A(?:[01][0-9]|2[0-3]):[0-5][0-9]\z'
  foreach ($key in @('skin', 'cardTheme', 'unit', 'size', 'billingMode', 'codexUnit')) {
    if ($script:Prefs[$key] -isnot [string]) { $script:Prefs[$key] = $defaults[$key] }
  }
  if ($script:Prefs.skin -notin @($script:SkinCatalog | ForEach-Object { $_.id })) { $script:Prefs.skin = 'default' }
  if ($script:Prefs.cardTheme -cnotin @($script:CardThemeCatalog | ForEach-Object { $_.id })) { $script:Prefs.cardTheme = 'default' }
  if ($script:Prefs.unit -notin @('cny', 'token')) { $script:Prefs.unit = 'cny' }
  if ($script:Prefs.billingMode -notin @('deepseek', 'codex')) { $script:Prefs.billingMode = 'deepseek' }
  if ($script:Prefs.codexUnit -notin @('token', 'percent')) { $script:Prefs.codexUnit = 'token' }
  if (($script:Prefs.codexQuotaRefreshSeconds -isnot [int] -and $script:Prefs.codexQuotaRefreshSeconds -isnot [long]) -or $script:Prefs.codexQuotaRefreshSeconds -lt 1 -or $script:Prefs.codexQuotaRefreshSeconds -gt 3600) { $script:Prefs.codexQuotaRefreshSeconds = 5 }
  if ($script:Prefs.codexWarmupDaily -isnot [bool] -or -not $savedWarmupTimeValid) { $script:Prefs.codexWarmupDaily = $false }
  if ($script:Prefs.codexWarmupReset -isnot [bool]) { $script:Prefs.codexWarmupReset = $false }
  if ($script:Prefs.codexWarmupStartup -isnot [bool]) { $script:Prefs.codexWarmupStartup = $false }
  if ($script:Prefs.codexWarmupTime -isnot [string] -or $script:Prefs.codexWarmupTime -cnotmatch '\A(?:[01][0-9]|2[0-3]):[0-5][0-9]\z') { $script:Prefs.codexWarmupTime = '09:30' }
  if ($script:Prefs.size -notin @('tiny', 'small', 'medium', 'large')) { $script:Prefs.size = 'medium' }
  if ($script:Prefs.sleepMinutes -isnot [int] -and $script:Prefs.sleepMinutes -isnot [long]) { $script:Prefs.sleepMinutes = 10 }
  $script:Prefs.sleepMinutes = [int][math]::Max(1, [math]::Min(240, [double]$script:Prefs.sleepMinutes))
}

function Test-FinitePetCoordinate($value) {
  return (($value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [single] -or $value -is [decimal]) -and -not [double]::IsNaN([double]$value) -and -not [double]::IsInfinity([double]$value))
}

function Restore-PetPosition($saved) {
  # Position is local to WPF, never part of a live host preference reload.
  foreach ($key in @('left', 'top')) {
    $script:Prefs[$key] = if (Test-FinitePetCoordinate $saved.$key) { [double]$saved.$key } else { $null }
  }
  if ($Preview) { return }
  # A host-created sanitized global file may no longer carry legacy coordinates.
  if (($null -eq $script:Prefs.left -or $null -eq $script:Prefs.top) -and $script:LegacySettingsFile -and (Test-Path -LiteralPath $script:LegacySettingsFile)) {
    try {
      $legacy = Get-Content -LiteralPath $script:LegacySettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($key in @('left', 'top')) {
        if ($null -eq $script:Prefs[$key] -and (Test-FinitePetCoordinate $legacy.$key)) { $script:Prefs[$key] = [double]$legacy.$key }
      }
    } catch { }
  }
  if (-not (Test-Path -LiteralPath $script:PositionFile)) { return }
  try {
    $position = Get-Content -LiteralPath $script:PositionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($key in @('left', 'top')) {
      if (Test-FinitePetCoordinate $position.$key) { $script:Prefs[$key] = [double]$position.$key }
    }
  } catch { }
}

$script:NextPrefsReload = [DateTime]::MinValue
$script:PreferencesFileTicks = $null
$script:ApplyingPetPreferences = $false
function Reload-PetPreferences([switch]$Force) {
  if ($Preview) { return }
  $now = [DateTime]::UtcNow
  if (-not $Force -and $now -lt $script:NextPrefsReload) { return }
  $script:NextPrefsReload = $now.AddSeconds(1)
  try {
    $file = Get-Item -LiteralPath $script:SettingsFile -ErrorAction Stop
    if (-not $Force -and $file.LastWriteTimeUtc.Ticks -eq $script:PreferencesFileTicks) { return }
    $content = Get-Content -LiteralPath $script:SettingsFile -Raw -Encoding UTF8
    if ($null -eq $content -or -not $content.TrimStart().StartsWith('{')) { throw 'Pet preferences must be a JSON object.' }
    $saved = $content | ConvertFrom-Json
    if ($saved -isnot [pscustomobject]) { throw 'Pet preferences must be a JSON object.' }
    $oldMode = $script:Prefs.billingMode
    $oldSize = $script:Prefs.size
    $oldTheme = $script:Prefs.cardTheme
    Set-PetPreferenceValues $saved
    $script:PreferencesFileTicks = $file.LastWriteTimeUtc.Ticks
    if ($null -ne $script:Window) {
      # Refresh-BillingMode still owns queue/float/activity transitions. Its resize
      # must not clamp or save coordinates just because host settings changed.
      $script:ApplyingPetPreferences = $true
      try {
        if ($script:Prefs.billingMode -ne $oldMode) { Refresh-BillingMode }
        elseif ($script:Prefs.size -ne $oldSize) { Set-PetSize }
        Update-PetUsageCard
        if ($script:CardThemeCatalog -and $script:Prefs.cardTheme -cne $oldTheme) {
          $peak = if ((Get-BillingMode) -eq 'codex') { $false } else { Get-Peak }
          Update-PetCardTheme $peak
        }
        Sync-PetFeedbackPolicy
      } finally { $script:ApplyingPetPreferences = $false }
    }
  } catch {
    # Preserve last-known visuals on incomplete/invalid external writes, but never
    # leave any automatic warmup switch enabled after a failed preference read.
    $script:Prefs.codexWarmupDaily = $false
    $script:Prefs.codexWarmupReset = $false
    $script:Prefs.codexWarmupStartup = $false
  }
}

$saved = $null
if ($Preview) {
  try { $saved = Get-Content -LiteralPath $script:SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  Set-PetPreferenceValues $saved
} else {
  Reload-PetPreferences -Force
  # Read legacy coordinates only at startup; subsequent reloads never move WPF.
  try { $saved = Get-Content -LiteralPath $script:SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}
Restore-PetPosition $saved

function Save-Prefs {
  $script:Prefs.left = [math]::Round($script:Window.Left, 0)
  $script:Prefs.top = [math]::Round($script:Window.Top, 0)
  $destination = if ($Preview) { $script:SettingsFile } else { $script:PositionFile }
  $payload = if ($Preview) { $script:Prefs } else { [ordered]@{ left = $script:Prefs.left; top = $script:Prefs.top } }
  $temporary = $destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
    if (Test-Path -LiteralPath $destination) {
      # PS5.1 binds ordinary $null to an empty string here, which is an invalid
      # backup path. NullString passes a real null while keeping atomic replace.
      [System.IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value)
    } else {
      [System.IO.File]::Move($temporary, $destination)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DeepSeek 米饭桌宠" Width="272" Height="296"
        WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="False"
        SnapsToDevicePixels="True">
  <Viewbox Stretch="Fill">
  <Canvas Name="Root" Width="272" Height="296" Background="Transparent">
    <Border Name="Card" Canvas.Left="5" Canvas.Top="199" Width="262" Height="92"
            CornerRadius="17" BorderThickness="1" BorderBrush="#91DFFA" Background="#0C3D64"
            Canvas.ZIndex="1" Cursor="SizeAll">
      <Border.Effect>
        <DropShadowEffect Color="#092A46" BlurRadius="15" ShadowDepth="5" Opacity="0.32"/>
      </Border.Effect>
      <Canvas Width="260" Height="154">
      <Canvas Name="DeepSeekPanel" Width="260" Height="90">
        <TextBlock Name="CardHeader" Canvas.Left="13" Canvas.Top="26" Text="DEEPSEEK · API 余额"
                   FontFamily="Microsoft YaHei" FontSize="10" FontWeight="SemiBold" Foreground="#C8EFFF"/>
        <Border Name="PriceBadge" Canvas.Left="175" Canvas.Top="24" Width="78" Height="20"
                CornerRadius="8" Background="#1D5B75">
          <TextBlock Name="Mode" TextAlignment="Center" VerticalAlignment="Center"
                     FontFamily="Microsoft YaHei" FontSize="9.5" FontWeight="Bold" Foreground="#D8F7FF"/>
        </Border>
        <TextBlock Name="Balance" Canvas.Left="13" Canvas.Top="49" Width="150"
                   Text="查询中…" FontFamily="Microsoft YaHei" FontSize="26" FontWeight="Bold" Foreground="White"/>
        <Border Name="BalanceDivider" Canvas.Left="165" Canvas.Top="58" Width="1" Height="20" Background="#458BAC"/>
        <TextBlock Name="Rate" Canvas.Left="174" Canvas.Top="66" Width="80" TextAlignment="Right"
                   Text="缓存命中 —" FontFamily="Microsoft YaHei" FontSize="10" Foreground="#A8EEFF"/>
      </Canvas>
      <Canvas Name="CodexPanel" Width="260" Height="154" Visibility="Collapsed">
        <TextBlock Name="CodexHeader" Canvas.Left="13" Canvas.Top="25" Text="CODEX · 订阅额度" FontFamily="Microsoft YaHei" FontSize="10" FontWeight="SemiBold" Foreground="#C8EFFF"/>
        <TextBlock Name="QuotaStatus" Canvas.Left="122" Canvas.Top="26" Width="125" TextAlignment="Right" Text="等待 DSH 数据" FontFamily="Microsoft YaHei" FontSize="9" Foreground="#ABD2E3" TextTrimming="CharacterEllipsis"/>
        <TextBlock Name="FiveHourLabel" Canvas.Left="13" Canvas.Top="51" Text="5 小时剩余" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#C8EFFF"/>
        <TextBlock Name="FiveHourValue" Canvas.Left="147" Canvas.Top="42" Width="100" TextAlignment="Right" Text="—" FontFamily="Segoe UI" FontSize="23" FontWeight="Bold" Foreground="#7DE9FF"/>
        <ProgressBar Name="FiveHourBar" Canvas.Left="13" Canvas.Top="71" Width="234" Height="5" Minimum="0" Maximum="100" Value="0" Foreground="#7DE9FF" Background="#234B66" BorderThickness="0"/>
        <TextBlock Name="FiveHourReset" Canvas.Left="13" Canvas.Top="80" Width="234" Text="重置时间未知" FontFamily="Microsoft YaHei" FontSize="9" Foreground="#A9CEE2"/>
        <TextBlock Name="WeeklyLabel" Canvas.Left="13" Canvas.Top="108" Text="周额度剩余" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#C8EFFF"/>
        <TextBlock Name="WeeklyValue" Canvas.Left="147" Canvas.Top="99" Width="100" TextAlignment="Right" Text="—" FontFamily="Segoe UI" FontSize="23" FontWeight="Bold" Foreground="#B7ABFF"/>
        <ProgressBar Name="WeeklyBar" Canvas.Left="13" Canvas.Top="128" Width="234" Height="5" Minimum="0" Maximum="100" Value="0" Foreground="#B7ABFF" Background="#234B66" BorderThickness="0"/>
        <TextBlock Name="WeeklyReset" Canvas.Left="13" Canvas.Top="137" Width="234" Text="重置时间未知" FontFamily="Microsoft YaHei" FontSize="9" Foreground="#A9CEE2"/>
      </Canvas>
      </Canvas>
    </Border>
    <Grid Name="SpriteLayer" Canvas.Left="17" Canvas.Top="-15" Width="238" Height="238"
          Canvas.ZIndex="2" Cursor="SizeAll" RenderTransformOrigin="0.5,0.8">
      <Grid.CacheMode><BitmapCache RenderAtScale="1.25"/></Grid.CacheMode>
      <Image Name="Sprite" Stretch="Fill"/>
      <Image Name="OldSprite" Stretch="Fill" Opacity="0" IsHitTestVisible="False"/>
    </Grid>
    <Path Name="CriticalMark" Canvas.Left="19" Canvas.Top="91" Canvas.ZIndex="3"
          Data="M 17,0 L 5,10 L 13,13 L 0,29 M 28,3 L 20,13 L 27,17 L 16,31"
          Stroke="#FF595F" StrokeThickness="3" StrokeStartLineCap="Round"
          StrokeEndLineCap="Round" StrokeLineJoin="Round" Visibility="Collapsed"/>
    <TextBlock Name="SleepMark" Canvas.Left="190" Canvas.Top="39" Canvas.ZIndex="3"
               Text="Zzz" FontFamily="Segoe UI" FontSize="22" FontWeight="Bold"
               Foreground="#A8F2FF" Visibility="Collapsed" IsHitTestVisible="False">
      <TextBlock.Effect><DropShadowEffect Color="#16374C" BlurRadius="5" ShadowDepth="2" Opacity="0.9"/></TextBlock.Effect>
    </TextBlock>
  </Canvas>
  </Viewbox>
</Window>
'@

$script:Window = [Windows.Markup.XamlReader]::Parse($xaml)
$script:Root = $script:Window.FindName('Root')
$script:Card = $script:Window.FindName('Card')
$script:CardHeader = $script:Window.FindName('CardHeader')
$script:SpriteLayer = $script:Window.FindName('SpriteLayer')
$script:Sprite = $script:Window.FindName('Sprite')
$script:OldSprite = $script:Window.FindName('OldSprite')
$script:Balance = $script:Window.FindName('Balance')
$script:Rate = $script:Window.FindName('Rate')
$script:ModeLabel = $script:Window.FindName('Mode')
$script:PriceBadge = $script:Window.FindName('PriceBadge')
$script:DeepSeekPanel = $script:Window.FindName('DeepSeekPanel')
$script:CodexPanel = $script:Window.FindName('CodexPanel')
$script:QuotaStatus = $script:Window.FindName('QuotaStatus')
$script:CriticalMark = $script:Window.FindName('CriticalMark')
$script:SleepMark = $script:Window.FindName('SleepMark')
foreach ($name in @('Root', 'Card', 'CardHeader', 'SpriteLayer', 'Sprite', 'OldSprite', 'Balance', 'Rate', 'ModeLabel', 'PriceBadge', 'CriticalMark', 'SleepMark')) {
  if ($null -eq (Get-Variable -Name $name -Scope Script -ValueOnly)) { throw "XAML element missing: $name" }
}

$script:Scale = New-Object Windows.Media.ScaleTransform
$script:Rotate = New-Object Windows.Media.RotateTransform
$script:Move = New-Object Windows.Media.TranslateTransform
$script:SpriteTransform = New-Object Windows.Media.TransformGroup
[void]$script:SpriteTransform.Children.Add($script:Scale)
[void]$script:SpriteTransform.Children.Add($script:Rotate)
[void]$script:SpriteTransform.Children.Add($script:Move)
$script:SpriteLayer.RenderTransform = $script:SpriteTransform
$script:BalanceScale = New-Object Windows.Media.ScaleTransform
$script:Balance.RenderTransformOrigin = [Windows.Point]::new(0, 0.5)
$script:Balance.RenderTransform = $script:BalanceScale
# Tiny is 73.5% of small; the shared Viewbox scales sprites, cards, and floats together.
$script:Sizes = @{ tiny = 0.625; small = 0.85; medium = 1.0; large = 1.25 }
function Set-PetSize {
  $scale = [double]$script:Sizes[$script:Prefs.size]
  $script:Window.Width = 272 * $scale
  $script:Window.Height = $(if ((Get-BillingMode) -eq 'codex') { 360 } else { 296 }) * $scale
  if (-not $script:ApplyingPetPreferences) {
    $area = [Windows.SystemParameters]::WorkArea
    # Keep startup/preview resizing in bounds, but never move on host changes.
    $script:Window.Left = [math]::Max($area.Left, [math]::Min($area.Right - $script:Window.Width, $script:Window.Left))
    $script:Window.Top = [math]::Max($area.Top, [math]::Min($area.Bottom - $script:Window.Height, $script:Window.Top))
    Save-Prefs
  }
}

$area = [Windows.SystemParameters]::WorkArea
$script:Window.Left = if ($null -ne $script:Prefs.left) { [double]$script:Prefs.left } else { $area.Right - 292 }
$script:Window.Top = if ($null -ne $script:Prefs.top) { [double]$script:Prefs.top } else { $area.Bottom - 316 }
if ($Preview -and $null -eq $script:Prefs.left) { $script:Window.Left = $area.Right - 600 }
Update-PetUsageCard
Set-PetSize

$script:Atlases = @{}
$script:Frames = @{}
foreach ($entry in $script:SkinCatalog) {
  $skin = [string]$entry.id
  foreach ($mode in @('valley', 'peak')) {
    $path = Join-Path $script:ProjectRoot "assets\$skin-$mode.png"
    $bitmap = New-Object Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit()
    $bitmap.UriSource = [uri]$path
    $bitmap.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bitmap.EndInit()
    $bitmap.Freeze()
    $script:Atlases["$skin-$mode"] = $bitmap
  }
}
$script:Cells = @{ idle = 0; blink = 1; sleep = 1; hit = 2; miss = 3; output = 7; combo = 5; depleted = 6; recharge = 4; quota = 7 }
function Get-Frame([string]$skin, [string]$mode, [string]$action) {
  $key = "$skin-$mode-$action"
  if ($script:Frames.ContainsKey($key)) { return $script:Frames[$key] }
  $bitmap = $script:Atlases["$skin-$mode"]
  $cell = [int]$script:Cells[$action]
  $col = $cell % 4
  $row = [math]::Floor($cell / 4)
  $x = [int][math]::Floor($col * $bitmap.PixelWidth / 4)
  $x2 = [int][math]::Floor(($col + 1) * $bitmap.PixelWidth / 4)
  $y = [int][math]::Floor($row * $bitmap.PixelHeight / 2)
  $y2 = [int][math]::Floor(($row + 1) * $bitmap.PixelHeight / 2)
  $rect = New-Object Windows.Int32Rect($x, $y, ($x2 - $x), ($y2 - $y))
  $crop = New-Object Windows.Media.Imaging.CroppedBitmap($bitmap, $rect)
  $crop.Freeze()
  $script:Frames[$key] = $crop
  return $crop
}

function Get-Peak {
  $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
  $china = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone)
  if ($china.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) { return $false }
  $minute = $china.Hour * 60 + $china.Minute
  return (($minute -ge 540 -and $minute -lt 720) -or ($minute -ge 840 -and $minute -lt 1080))
}

$script:Queue = New-Object 'System.Collections.Generic.Queue[object]'
$script:ActiveFloats = New-Object System.Collections.ArrayList
$script:Instance = $null
$script:Cursor = 0
$script:FileTicks = 0L
$script:Current = 'idle'
$script:ActionStart = [DateTime]::UtcNow
$script:ActionEnd = [DateTime]::UtcNow
$script:NextEventAt = [DateTime]::UtcNow
$script:LastBlink = [DateTime]::UtcNow
$script:LastFrameKey = ''
$script:LastPeak = $null
$script:LastUpdate = [DateTime]::MinValue
$script:LastActivityAt = [DateTime]::UtcNow
$script:Stats = $null
if ($Preview) {
  $script:CardHeader.Text = 'DEEPSEEK · 动效预览'
  $script:Balance.Text = '¥4.29'
  $script:Rate.Text = '缓存命中 84%'
  $script:PreviewIndex = 0
  $script:PreviewPeak = $false
  $script:NextPreviewAt = [DateTime]::UtcNow.AddMilliseconds(700)
  $script:PreviewEvents = @(
    [pscustomobject]@{ kind='hit'; tokens=6200; cny=.000124 },
    [pscustomobject]@{ kind='miss'; tokens=7000; cny=.007 },
    [pscustomobject]@{ kind='output'; tokens=380; cny=.00152 },
    [pscustomobject]@{ kind='combo'; tokens=0; cny=$null },
    [pscustomobject]@{ kind='depleted'; tokens=0; cny=$null },
    [pscustomobject]@{ kind='recharge'; tokens=0; cny=$null }
  )
  $day = [DateTime]::Today
  $days = @{}
  for ($i = 0; $i -lt 7; $i++) {
    $date = $day.AddDays(-$i).ToString('yyyy-MM-dd')
    $days[$date] = @{ tokens = (8000 - $i * 740); inputTokens = (1800 - $i * 120);
      cacheReadTokens = (5700 - $i * 590); outputTokens = 500; cny = (.013 - $i * .0013); unpricedTokens = 0 }
  }
  $script:Stats = (@{ version = 1; activityAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); days = $days } | ConvertTo-Json -Depth 5 | ConvertFrom-Json)
  if ($PreviewSleep) {
    $script:NextPreviewAt = [DateTime]::MaxValue
    $script:LastActivityAt = [DateTime]::UtcNow.AddMinutes(-30)
    $script:NextPreviewModeAt = [DateTime]::UtcNow.AddSeconds(6)
  }
}

function Format-Cost($item) {
  if ($item.billingMode -eq 'codex') {
    if ($item.kind -eq 'quota') {
      $label = if ($item.window -eq 'fiveHour') { '5h' } else { '周' }
      return ('{0} 实测 −{1:0.###}%' -f $label, [double]$item.percent)
    }
    return ('−{0:N0} token' -f [double]$item.tokens)
  }
  if ($item.kind -eq 'recharge') { return '余额恢复' }
  if ($item.kind -eq 'depleted') { return '余额耗尽' }
  if ($script:Prefs.unit -eq 'token' -or $null -eq $item.cny) { return ('−{0:N0} token' -f [double]$item.tokens) }
  $amount = [double]$item.cny
  if ($amount -lt 0.01) { return ('−¥' + $amount.ToString('0.########')) }
  return ('−¥' + $amount.ToString('0.###'))
}

function Read-PetState {
  if (-not (Test-Path -LiteralPath $script:StateFile)) { return }
  try {
    $file = Get-Item -LiteralPath $script:StateFile
    if ($file.LastWriteTimeUtc.Ticks -eq $script:FileTicks) { return }
    $snapshot = [IO.File]::ReadAllText($script:StateFile) | ConvertFrom-Json
    $script:FileTicks = $file.LastWriteTimeUtc.Ticks
    $script:LastSnapshot = $snapshot
    if ($null -ne $snapshot.updatedAt) { $script:LastUpdate = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$snapshot.updatedAt).UtcDateTime }
    if ($null -ne $snapshot.stats) {
      $script:Stats = if ((Get-BillingMode) -eq 'codex') { $snapshot.codexStats } else { $snapshot.stats }
      if ($null -ne $script:Stats.activityAt) {
        $script:LastActivityAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$script:Stats.activityAt).UtcDateTime
      }
      if ($script:SettingsWindow -and $script:SettingsWindow.IsVisible) { Update-SettingsStats }
    }
    if ($script:Instance -ne $snapshot.instance) {
      $script:Instance = $snapshot.instance
      $script:Cursor = [int64]$snapshot.seq
      $script:Queue.Clear()
    } elseif (-not $script:SkipPresentationSnapshot -and -not (Get-PetFeedbackPolicy).Static) {
      $policy = Get-PetFeedbackPolicy
      foreach ($item in $snapshot.events) {
        if ([int64]$item.seq -gt $script:Cursor -and (Test-PetEventVisible $item)) {
          if ($policy.Gentle -and $item.kind -in @('combo', 'depleted', 'recharge')) { continue }
          # Coalesce presentation only; ledger/snapshot/activity remain untouched.
          if ($policy.Gentle) { $script:Queue.Clear() }
          $script:Queue.Enqueue($item)
        }
      }
    }
    $script:Cursor = [int64]$snapshot.seq
    $script:SkipPresentationSnapshot = $false
    Update-PetUsageCard
  } catch { }
}

function Start-Track($target, [Windows.DependencyProperty]$property, [double]$duration,
                     [double[]]$times, [double[]]$values) {
  if ((Get-PetFeedbackPolicy).Static) { return }
  $animation = New-Object Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $animation.Duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds($duration))
  $animation.FillBehavior = [Windows.Media.Animation.FillBehavior]::Stop
  for ($i = 0; $i -lt $times.Length; $i++) {
    $frame = New-Object Windows.Media.Animation.EasingDoubleKeyFrame
    $frame.Value = $values[$i]
    $frame.KeyTime = [Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds($duration * $times[$i]))
    if ($i -gt 0) {
      $ease = New-Object Windows.Media.Animation.CubicEase
      $ease.EasingMode = [Windows.Media.Animation.EasingMode]::EaseOut
      $frame.EasingFunction = $ease
    }
    [void]$animation.KeyFrames.Add($frame)
  }
  $target.BeginAnimation($property, $animation, [Windows.Media.Animation.HandoffBehavior]::SnapshotAndReplace)
}

function Start-Event($item, [DateTime]$now) {
  $policy = Get-PetFeedbackPolicy
  if ($policy.Static) { return }
  # These extra semantic events never become another gentle performance.
  if ($policy.Gentle -and $item.kind -in @('combo', 'depleted', 'recharge')) { return }
  $script:Current = [string]$item.kind
  $script:ActionStart = $now
  $pace = if ($script:LastPeak) { 0.88 } else { 1.08 }
  $duration = switch ($script:Current) {
    'hit' { 580 } 'miss' { 830 } 'output' { 1050 } 'combo' { 820 }
    'depleted' { 1250 } 'recharge' { 1050 } default { 580 }
  }
  $script:ActionEnd = $now.AddMilliseconds($duration * $pace)
  if ($policy.Gentle) { $duration = 450; $pace = 1; $script:ActionEnd = $now.AddMilliseconds(450) }
  $script:NextEventAt = $now.AddMilliseconds(560)
  Start-EventMotion ($duration * $pace) $script:LastPeak
  if ($script:Current -eq 'combo' -or -not $policy.Floats) { return }
  if ($policy.Gentle) {
    foreach ($entry in $script:ActiveFloats) { $script:Root.Children.Remove($entry.control) }
    $script:ActiveFloats.Clear()
  }
  $float = New-Object Windows.Controls.TextBlock
  $float.Text = Format-Cost $item
  $float.FontFamily = New-Object Windows.Media.FontFamily('Microsoft YaHei')
  $float.FontWeight = [Windows.FontWeights]::ExtraBold
  $float.FontSize = if (-not $policy.Gentle -and $script:Current -eq 'miss') { 20 } else { 17 }
  $float.Foreground = if ($policy.Gentle) { [Windows.Media.Brushes]::LightCyan } else {
    switch ($script:Current) {
      'miss' { [Windows.Media.Brushes]::Tomato }
      'output' { [Windows.Media.Brushes]::LightGoldenrodYellow }
      'recharge' { [Windows.Media.Brushes]::PaleGreen }
      default { [Windows.Media.Brushes]::LightCyan }
    }
  }
  $float.Effect = New-Object Windows.Media.Effects.DropShadowEffect
  $float.Effect.Color = [Windows.Media.Colors]::DarkSlateGray
  $float.Effect.BlurRadius = 5
  $float.Effect.ShadowDepth = 2
  $float.Effect.Opacity = 0.7
  $float.Measure([Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity))
  [Windows.Controls.Canvas]::SetLeft($float, (272 - $float.DesiredSize.Width) / 2)
  [Windows.Controls.Canvas]::SetTop($float, 101)
  [Windows.Controls.Canvas]::SetZIndex($float, 4)
  [void]$script:Root.Children.Add($float)
  [void]$script:ActiveFloats.Add([pscustomobject]@{ control = $float; start = $now; kind = $script:Current })
  Start-Track $float ([Windows.Controls.Canvas]::TopProperty) 1250 @(0,.08,.64,.82,1) @(101,96,64,53,40)
  Start-Track $float ([Windows.UIElement]::OpacityProperty) 1250 @(0,.08,.64,.82,1) @(0,1,1,.76,0)
}

function Set-ModeVisual([bool]$peak) {
  $script:ModeLabel.Text = if ($peak) { '☀ 峰值价' } else { '☾ 谷时价' }
  Update-PetCardTheme $peak
}

function Start-IdleMotion([bool]$peak) {
  if ((Get-PetFeedbackPolicy).Static) { $script:NextIdlePulse = [DateTime]::MaxValue; return }
  $script:SleepMark.BeginAnimation([Windows.UIElement]::OpacityProperty, $null)
  $script:SleepMark.Visibility = 'Collapsed'
  $script:Rotate.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, $null)
  $script:Rotate.Angle = 0
  $amplitude = if ($peak) { 1.8 } else { 1.15 }
  $halfCycle = if ($peak) { 750 } else { 1100 }
  $drift = New-Object Windows.Media.Animation.DoubleAnimation
  $drift.From = 0; $drift.To = -$amplitude
  $drift.Duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds($halfCycle))
  $drift.AutoReverse = $true
  $drift.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::new(1.0)
  $drift.FillBehavior = [Windows.Media.Animation.FillBehavior]::Stop
  $script:Move.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, $drift)
  $breath = New-Object Windows.Media.Animation.DoubleAnimation
  $breath.From = 1; $breath.To = 1.006
  $breath.Duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds($halfCycle))
  $breath.AutoReverse = $true
  $breath.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::new(1.0)
  $breath.FillBehavior = [Windows.Media.Animation.FillBehavior]::Stop
  $script:Scale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $breath)
  $script:IdleMotionActive = $true
  $script:NextIdlePulse = [DateTime]::UtcNow.AddSeconds(4)
}

function Start-SleepLoop($target, [Windows.DependencyProperty]$property,
                         [double]$from, [double]$to, [double]$halfCycle) {
  if ((Get-PetFeedbackPolicy).Static) { return }
  $animation = New-Object Windows.Media.Animation.DoubleAnimation
  $animation.From = $from; $animation.To = $to
  $animation.Duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds($halfCycle))
  $animation.AutoReverse = $true
  $animation.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
  $target.BeginAnimation($property, $animation)
}

function Start-SleepMotion([bool]$peak) {
  $script:Current = 'sleep'
  if ((Get-PetFeedbackPolicy).Static) { $script:SleepMark.Visibility = 'Collapsed'; return }
  $script:SleepMark.Visibility = 'Visible'
  [Windows.Controls.Canvas]::SetTop($script:SleepMark, $(if ($peak) { 42 } else { 39 }))
  $script:SleepMark.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString($(if ($peak) { '#FFAB62' } else { '#528BE8' }))
  $script:Move.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $null)
  $script:Move.X = 0
  Start-SleepLoop $script:Move ([Windows.Media.TranslateTransform]::YProperty) $(if ($peak) { 4 } else { 2 }) $(if ($peak) { 8 } else { 5 }) $(if ($peak) { 1150 } else { 1700 })
  Start-SleepLoop $script:Rotate ([Windows.Media.RotateTransform]::AngleProperty) $(if ($peak) { -3 } else { 1 }) $(if ($peak) { -7 } else { 3 }) $(if ($peak) { 1150 } else { 1700 })
  Start-SleepLoop $script:Scale ([Windows.Media.ScaleTransform]::ScaleYProperty) 1 $(if ($peak) { .978 } else { .988 }) $(if ($peak) { 1150 } else { 1700 })
  Start-SleepLoop $script:SleepMark ([Windows.UIElement]::OpacityProperty) .55 1 1250
}

function Start-EventMotion([double]$duration, [bool]$peak) {
  $policy = Get-PetFeedbackPolicy
  if ($policy.Static) { return }
  if ($policy.Gentle) {
    # Reuse the neutral idle frame; acknowledge gently, independent of cost/peak.
    $script:SleepMark.BeginAnimation([Windows.UIElement]::OpacityProperty, $null)
    $script:SleepMark.Visibility = 'Collapsed'
    $script:CriticalMark.Visibility = 'Collapsed'
    foreach ($entry in @(
      @{ target = $script:Move; property = [Windows.Media.TranslateTransform]::XProperty; value = 0.0 },
      @{ target = $script:Move; property = [Windows.Media.TranslateTransform]::YProperty; value = 0.0 },
      @{ target = $script:Scale; property = [Windows.Media.ScaleTransform]::ScaleXProperty; value = 1.0 },
      @{ target = $script:Scale; property = [Windows.Media.ScaleTransform]::ScaleYProperty; value = 1.0 },
      @{ target = $script:Rotate; property = [Windows.Media.RotateTransform]::AngleProperty; value = 0.0 },
      @{ target = $script:BalanceScale; property = [Windows.Media.ScaleTransform]::ScaleXProperty; value = 1.0 },
      @{ target = $script:BalanceScale; property = [Windows.Media.ScaleTransform]::ScaleYProperty; value = 1.0 }
    )) { $entry.target.BeginAnimation($entry.property, $null); $entry.target.SetValue($entry.property, $entry.value) }
    $script:Card.BorderBrush = $script:CardBaseBorder
    $script:FlashEnd = [DateTime]::MaxValue; $script:MarkEnd = [DateTime]::MaxValue
    Start-Track $script:Move ([Windows.Media.TranslateTransform]::YProperty) 450 @(0,.5,1) @(0,1.0,0)
    $script:IdleMotionActive = $false
    return
  }
  $script:SleepMark.BeginAnimation([Windows.UIElement]::OpacityProperty, $null)
  $script:SleepMark.Visibility = 'Collapsed'
  $a = if ($peak) { 1.22 } else { 0.78 }
  $t = @(0,1)
  $x = @(0,0); $y = @(0,0); $sx = @(1,1); $sy = @(1,1); $angle = @(0,0); $balance = @(1,1)
  $script:CriticalMark.Visibility = 'Collapsed'
  $script:FlashEnd = [DateTime]::UtcNow.AddMilliseconds(250)
  switch ($script:Current) {
    'hit' {
      $t = @(0,.16,.42,1)
      $x = @(0,(-3*$a),(2*$a),0); $y = @(0,(2*$a),(-2*$a),0)
      $sx = @(1,.97,1.015,1); $sy = @(1,.985,1.012,1)
      $balance = @(1,.978,1.012,1)
      $script:Card.BorderBrush = [Windows.Media.Brushes]::LightSkyBlue
    }
    'miss' {
      $t = @(0,.10,.23,.38,.55,.78,1)
      $x = @(0,(-10*$a),(7*$a),(-5*$a),(3*$a),(-1*$a),0)
      $y = @(0,(6*$a),(-4*$a),(2*$a),0,0,0)
      $sx = @(1,.91,1.055,.985,1,1,1)
      $sy = @(1,.94,1.04,.99,1,1,1)
      $angle = @(0,(-4*$a),(3*$a),(-1*$a),0,0,0)
      $balance = @(1,.95,1.025,1,1,1,1)
      $script:CriticalMark.Visibility = 'Visible'
      $script:MarkEnd = [DateTime]::UtcNow.AddMilliseconds(390)
      $script:FlashEnd = [DateTime]::UtcNow.AddMilliseconds(390)
      $script:Card.BorderBrush = [Windows.Media.Brushes]::Salmon
    }
    'output' {
      $t = @(0,.24,.45,.66,.82,1)
      $y = @(0,(-12*$a),(2*$a),(-6*$a),(1*$a),0)
      $sx = @(1,1.075,.975,1.015,1,1)
      $sy = @(1,1.075,.975,1.015,1,1)
      $balance = @(1,1.012,.99,1.01,1,1)
      $script:Card.BorderBrush = [Windows.Media.Brushes]::LightGoldenrodYellow
    }
    'combo' {
      $t = @(0,.10,.21,.43,.54,.72,1)
      $x = @(0,(-7*$a),(4*$a),0,(-9*$a),(5*$a),0)
      $y = @(0,(4*$a),(-3*$a),0,(5*$a),(-2*$a),0)
      $sx = @(1,.95,1.03,1,.94,1.03,1)
      $sy = @(1,.97,1.02,1,.96,1.02,1)
      $script:CriticalMark.Visibility = 'Visible'
      $script:MarkEnd = [DateTime]::UtcNow.AddMilliseconds(480)
      $script:FlashEnd = [DateTime]::UtcNow.AddMilliseconds(480)
      $script:Card.BorderBrush = [Windows.Media.Brushes]::Salmon
    }
    'depleted' {
      $t = @(0,.3,.7,1)
      $y = @(0,(4*$a),(9*$a),(8*$a))
      $sx = @(1,.97,.97,.97); $sy = @(1,.94,.94,.94)
      $angle = @(0,-1,-2,-2)
    }
    'recharge' {
      $t = @(0,.16,.33,.5,.66,.83,1)
      $y = @(0,(-4*$a),0,(-4*$a),0,(-4*$a),0)
      $sx = @(1,1.025,1,1.025,1,1.025,1)
      $sy = @(1,.978,1,.978,1,.978,1)
      $angle = @(0,(1.5*$a),0,(-1.5*$a),0,(1.5*$a),0)
      $script:Card.BorderBrush = [Windows.Media.Brushes]::PaleGreen
    }
  }
  if (-not $policy.Flash) {
    $script:CriticalMark.Visibility = 'Collapsed'
    $script:Card.BorderBrush = $script:CardBaseBorder
    $script:FlashEnd = [DateTime]::MaxValue; $script:MarkEnd = [DateTime]::MaxValue
  }
  if ($x.Count -ne $t.Count) { $x = @($t | ForEach-Object { 0.0 }) }
  if ($y.Count -ne $t.Count) { $y = @($t | ForEach-Object { 0.0 }) }
  if ($sx.Count -ne $t.Count) { $sx = @($t | ForEach-Object { 1.0 }) }
  if ($sy.Count -ne $t.Count) { $sy = @($t | ForEach-Object { 1.0 }) }
  if ($angle.Count -ne $t.Count) { $angle = @($t | ForEach-Object { 0.0 }) }
  if ($balance.Count -ne $t.Count) { $balance = @($t | ForEach-Object { 1.0 }) }
  Start-Track $script:Move ([Windows.Media.TranslateTransform]::XProperty) $duration $t $x
  Start-Track $script:Move ([Windows.Media.TranslateTransform]::YProperty) $duration $t $y
  Start-Track $script:Scale ([Windows.Media.ScaleTransform]::ScaleXProperty) $duration $t $sx
  Start-Track $script:Scale ([Windows.Media.ScaleTransform]::ScaleYProperty) $duration $t $sy
  Start-Track $script:Rotate ([Windows.Media.RotateTransform]::AngleProperty) $duration $t $angle
  Start-Track $script:BalanceScale ([Windows.Media.ScaleTransform]::ScaleXProperty) $duration $t $balance
  Start-Track $script:BalanceScale ([Windows.Media.ScaleTransform]::ScaleYProperty) $duration $t $balance
  $script:IdleMotionActive = $false
}

function Clear-ExpiredFloats([DateTime]$now) {
  for ($i = $script:ActiveFloats.Count - 1; $i -ge 0; $i--) {
    $entry = $script:ActiveFloats[$i]
    if (($now - $entry.start).TotalMilliseconds -ge 1300) {
      $script:Root.Children.Remove($entry.control)
      $script:ActiveFloats.RemoveAt($i)
    }
  }
}

$script:LastWarmupAlert = $null
$script:IdleMotionActive = $false
$script:NextIdlePulse = [DateTime]::UtcNow
$script:FlashEnd = [DateTime]::MinValue
$script:MarkEnd = [DateTime]::MinValue
$script:Timer = New-Object Windows.Threading.DispatcherTimer
$script:Timer.Interval = [TimeSpan]::FromMilliseconds(100)
$script:Timer.Add_Tick({
  $now = [DateTime]::UtcNow
  Sync-PetFeedbackPolicy
  if ($Preview) {
    if ($PreviewSleep -and $now -ge $script:NextPreviewModeAt) {
      $script:PreviewPeak = -not $script:PreviewPeak
      $script:NextPreviewModeAt = $now.AddSeconds(6)
    }
    if ($now -ge $script:NextPreviewAt) {
      $script:Queue.Enqueue($script:PreviewEvents[$script:PreviewIndex])
      $script:PreviewIndex = ($script:PreviewIndex + 1) % $script:PreviewEvents.Count
      if ($script:PreviewIndex -eq 0) { $script:PreviewPeak = -not $script:PreviewPeak }
      $script:NextPreviewAt = $now.AddMilliseconds(900)
    }
  } else {
    Reload-PetPreferences
    Read-PetState
    if ($script:LastUpdate -eq [DateTime]::MinValue -or ($now - $script:LastUpdate).TotalSeconds -gt 90) {
      $script:Balance.Text = '等待 DSH…'
      $script:Rate.Text = '缓存命中 —'
      $script:QuotaStatus.Text = '等待 DSH…'
    }
  }
  $peak = if ((Get-BillingMode) -eq 'codex') { $false } elseif ($Preview) { $script:PreviewPeak } else { Get-Peak }
  if ((Get-BillingMode) -eq 'codex') { Update-PetUsageCard; Update-SettingsCodexQuota }
  Update-SettingsCodexWarmup
  $warmupAlert = $script:LastSnapshot.codexWarmup
  if (-not $Preview -and $warmupAlert.status -eq 'failed' -and $warmupAlert.alertId -is [string] -and $warmupAlert.alertId -and $warmupAlert.alertId -ne $script:LastWarmupAlert) {
    $script:LastWarmupAlert = $warmupAlert.alertId
    [Windows.MessageBox]::Show('自动预热已停止。' + "`n" + [string]$warmupAlert.detail + "`n请检查 Codex 登录、网络和额度；发送后结果不明时不会自动重试。", 'Codex 自动预热', [Windows.MessageBoxButton]::OK, [Windows.MessageBoxImage]::Warning) | Out-Null
  }
  $modeChanged = $script:LastPeak -ne $peak
  if ($modeChanged) {
    Set-ModeVisual $peak
    $script:LastPeak = $peak
    if ($script:Current -in @('idle','blink')) { Start-IdleMotion $peak }
    if ($script:Current -eq 'sleep') { Start-SleepMotion $peak }
  }
  $policy = Get-PetFeedbackPolicy
  if ($policy.Static) { $script:Queue.Clear() }
  if (-not $policy.Static -and $now -ge $script:NextEventAt -and $script:Queue.Count -gt 0) {
    $item = $script:Queue.Dequeue()
    if ($Preview -or (Test-PetEventVisible $item)) { Start-Event $item $now }
  }
  if ($now -ge $script:ActionEnd -and $script:Current -notin @('idle','blink','sleep')) {
    $script:Current = 'idle'
    Start-IdleMotion $peak
  }
  if ($now -ge $script:ActionEnd -and $script:Current -eq 'blink') { $script:Current = 'idle' }
  $shouldSleep = ($now - $script:LastActivityAt).TotalMinutes -ge [double]$script:Prefs.sleepMinutes
  if ($script:Current -eq 'sleep' -and -not $shouldSleep) {
    $script:Current = 'idle'
    Start-IdleMotion $peak
  }
  if ($script:Current -in @('idle','blink') -and $script:Queue.Count -eq 0 -and $shouldSleep) { Start-SleepMotion $peak }
  if ($script:Current -eq 'idle' -and $script:Queue.Count -eq 0 -and $now -ge $script:NextIdlePulse) { Start-IdleMotion $peak }
  if (-not $policy.Static -and $script:Current -eq 'idle' -and $script:Queue.Count -eq 0 -and ($now - $script:LastBlink).TotalSeconds -ge 6) {
    $script:Current = 'blink'; $script:ActionStart = $now; $script:ActionEnd = $now.AddMilliseconds(300); $script:LastBlink = $now
  }
  Update-PetSpriteFrame $peak
  if ($now -ge $script:FlashEnd) { $script:Card.BorderBrush = $script:CardBaseBorder; $script:FlashEnd = [DateTime]::MaxValue }
  if ($now -ge $script:MarkEnd) { $script:CriticalMark.Visibility = 'Collapsed'; $script:MarkEnd = [DateTime]::MaxValue }
  Clear-ExpiredFloats $now
})

# Right-click intentionally has no action, context menu, or settings popup.
# The legacy settings UI is loaded only for an explicit developer preview.
if ($Preview -and $PreviewSettings) {
  . (Join-Path $script:ProjectRoot 'settings-window.ps1')
}

$dragHandler = [Windows.Input.MouseButtonEventHandler]{
  param($sender, $eventArgs)
  if ($eventArgs.LeftButton -ne [Windows.Input.MouseButtonState]::Pressed) { return }
  try { $script:Window.DragMove(); Save-Prefs } catch { }
}
$script:Card.Add_MouseLeftButtonDown($dragHandler)
$script:SpriteLayer.Add_MouseLeftButtonDown($dragHandler)
$script:Window.Add_Closed({ $script:Timer.Stop(); $script:SingleInstance.ReleaseMutex(); $script:SingleInstance.Dispose() })

if (-not $Preview) { Read-PetState }
if ($Preview -and $PreviewSettings) {
  $script:Window.Add_Loaded({
    Show-PetSettings
    if ($PreviewChartYear) {
      $script:ChartUnit.SelectedIndex = 1
      $script:ChartRange.SelectedIndex = 2
      $script:SettingsWindow.FindName('SettingsTabs').SelectedIndex = 1
    }
  })
}
$script:Timer.Start()
try { [void]$script:Window.ShowDialog() }
catch { throw ($_.Exception.ToString()) }
