# Run independently: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\settings-window.test.ps1
# Does not source pet.ps1, start DSH, touch user preferences, or require a test framework.
# Runs the real Save-Prefs function only against an isolated temporary directory.
param([string]$CaptureDirectory = '',
      [string]$SettingsScript = (Join-Path $PSScriptRoot 'settings-window.ps1'))

$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) {
  throw 'WPF regression tests require Windows PowerShell with -STA.'
}
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$script:Assertions = 0
$script:SaveCount = 0
$script:SizeCount = 0
$script:OwnerCloseCount = 0
$script:Stats = $null
$script:SettingsWindow = $null
$script:Prefs = @{ skin = 'default'; unit = 'cny'; size = 'medium'; sleepMinutes = 10 }
$script:SkinCatalog = @(
  @{ id = 'default'; name = '海蓝鲸鱼娘' }, @{ id = 'night'; name = '夜航科技娘' },
  @{ id = 'snow'; name = '雪绒鲸娘' }, @{ id = 'mint'; name = '薄荷茶娘' },
  @{ id = 'cherry'; name = '樱桃汽水娘' }, @{ id = 'star'; name = '星砂魔法娘' }
)
$script:FrameCalls = New-Object Collections.ArrayList
$script:TestFrames = @{}

# Isolated local image provider: no assets, user state, network, timers, or real balances.
# Match the production Get-Frame contract, including a frozen CroppedBitmap.
function Get-Frame([string]$skin, [string]$mode, [string]$action) {
  $key = "$skin/$mode/$action"
  [void]$script:FrameCalls.Add($key)
  $pixels = New-Object byte[] (48 * 64 * 4)
  $palette = @{ default = 70; night = 100; snow = 130; mint = 160; cherry = 190; star = 220 }
  for ($i = 0; $i -lt $pixels.Length; $i += 4) {
    $pixels[$i] = $palette[$skin]
    $pixels[$i + 1] = if ($mode -eq 'peak') { 210 } else { 110 }
    $pixels[$i + 2] = 90
    $pixels[$i + 3] = 255
  }
  $bitmap = [Windows.Media.Imaging.BitmapSource]::Create(48, 64, 96, 96, [Windows.Media.PixelFormats]::Bgra32, $null, $pixels, 192)
  $bitmap.Freeze()
  $frame = [Windows.Media.Imaging.CroppedBitmap]::new($bitmap, [Windows.Int32Rect]::new(0, 0, 48, 64))
  $frame.Freeze()
  $script:TestFrames[$key] = $frame
  return $frame
}

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
  $script:Assertions++
}
function Assert-Equal($actual, $expected, [string]$message) {
  Assert-True ($actual -ceq $expected) "$message (expected '$expected', actual '$actual')"
}
function Save-Prefs { $script:SaveCount++ }
function Set-PetSize {
  $script:SizeCount++
  $dimensions = @{ small = 100; medium = 160; large = 220 }
  Assert-True ($dimensions.ContainsKey([string]$script:Prefs.size)) 'size handler updates preferences before resizing'
  $script:Window.Width = $dimensions[[string]$script:Prefs.size]
  $script:Window.Height = $dimensions[[string]$script:Prefs.size]
  Save-Prefs # The real Set-PetSize owns persistence; mimic that contract without disk writes.
}
function Get-Control([string]$name, [type]$type) {
  $control = $script:SettingsWindow.FindName($name)
  Assert-True ($null -ne $control) "$name is present"
  Assert-True ($control -is $type) "$name has type $($type.Name)"
  return $control
}
function Assert-Choices($combo, [string[]]$tags, [string]$name) {
  Assert-Equal $combo.Items.Count $tags.Count "$name has exactly the expected choices"
  for ($i = 0; $i -lt $tags.Count; $i++) {
    Assert-True ($combo.Items[$i] -is [Windows.Controls.ComboBoxItem]) "$name choice $i is a ComboBoxItem"
    Assert-Equal ([string]$combo.Items[$i].Tag) $tags[$i] "$name choice $i has a stable tag"
  }
}
function Select-Tag($combo, [string]$tag) {
  foreach ($item in $combo.Items) {
    if ([string]$item.Tag -ceq $tag) { $combo.SelectedItem = $item; return }
  }
  throw "Missing ComboBox tag '$tag'"
}
function Click-Button($button) {
  $button.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
}
function Press-SkinKey($button, [Windows.Input.Key]$key) {
  [void]$script:SettingsWindow.Activate()
  [void]$button.Focus()
  Flush-Dispatcher
  Assert-True $button.IsKeyboardFocused 'skin button can receive keyboard focus'
  $source = [Windows.PresentationSource]::FromVisual($button)
  $preview = [Windows.Input.KeyEventArgs]::new([Windows.Input.Keyboard]::PrimaryDevice, $source, 0, $key)
  $preview.RoutedEvent = [Windows.Input.Keyboard]::PreviewKeyDownEvent
  $button.RaiseEvent($preview)
  if (-not $preview.Handled) {
    $down = [Windows.Input.KeyEventArgs]::new([Windows.Input.Keyboard]::PrimaryDevice, $source, 0, $key)
    $down.RoutedEvent = [Windows.Input.Keyboard]::KeyDownEvent
    $button.RaiseEvent($down)
    $up = [Windows.Input.KeyEventArgs]::new([Windows.Input.Keyboard]::PrimaryDevice, $source, 0, $key)
    $up.RoutedEvent = [Windows.Input.Keyboard]::KeyUpEvent
    $button.RaiseEvent($up)
  }
}
function Assert-SkinSelection([string]$selected) {
  foreach ($skin in $script:SkinCatalog) {
    $expected = if ($skin.id -eq $selected) { 'Visible' } else { 'Hidden' }
    Assert-Equal ([string]$script:SkinSelectionLabels[$skin.id].Visibility) $expected "selection badge for $($skin.id)"
    $status = [Windows.Automation.AutomationProperties]::GetItemStatus($script:SkinButtons[$skin.id])
    Assert-Equal $status $(if ($skin.id -eq $selected) { '已选择' } else { '未选择' }) "accessible selection status for $($skin.id)"
  }
}
function Flush-Dispatcher {
  [void][Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke(
    [Windows.Threading.DispatcherPriority]::Background, [Action]{})
}
function Save-SettingsCapture([string]$name) {
  if (-not $CaptureDirectory) { return }
  [void](New-Item -ItemType Directory -Path $CaptureDirectory -Force)
  $script:SettingsWindow.UpdateLayout()
  Flush-Dispatcher
  $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(
    [int]$script:SettingsWindow.ActualWidth, [int]$script:SettingsWindow.ActualHeight,
    96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($script:SettingsWindow)
  $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $path = Join-Path $CaptureDirectory $name
  $stream = [IO.File]::Create($path)
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
  Write-Host "Captured $path"
}

# Read/parse scripts only. Execute ONLY the bounded preference initialization block,
# with in-memory path/content stubs; never dot-source pet.ps1 or access user settings.
$petPath = Join-Path $PSScriptRoot 'pet.ps1'
foreach ($path in @($petPath, $SettingsScript, (Join-Path $PSScriptRoot 'usage-view.ps1'), $PSCommandPath)) {
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) "$path retains UTF-8 BOM for native PS5.1"
  $parseTokens = $null; $parseErrors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$parseTokens, [ref]$parseErrors)
  Assert-Equal @($parseErrors).Count 0 "$path parses in native Windows PowerShell"
}
$petSource = [IO.File]::ReadAllText($petPath)

# The UI tests stub Save-Prefs, so separately exercise the actual production
# persistence function. In PS5.1 an ordinary $null string argument can become
# an empty path; an existing settings file must be tested, not just first save.
function Test-RealPrefsPersistence {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseInput($petSource, [ref]$tokens, [ref]$errors)
  $saveFunctions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Save-Prefs'
  }, $false))
  Assert-Equal $saveFunctions.Count 1 'production Save-Prefs is extracted without starting the pet'
  . ([scriptblock]::Create($saveFunctions[0].Extent.Text))
  $originalPrefs = $script:Prefs
  $originalWindow = $script:Window
  $originalSettingsFile = $script:SettingsFile
  $directory = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('dsh-pet-prefs-' + [guid]::NewGuid().ToString('N'))))
  [void](New-Item -ItemType Directory -Path $directory)
  try {
    $script:SettingsFile = Join-Path $directory 'settings-test.json'
    $script:Window = [pscustomobject]@{ Left = 123.4; Top = 56.6 }
    $script:Prefs = [ordered]@{
      skin = 'mint'; unit = 'token'; size = 'small'; billingMode = 'codex'; codexUnit = 'percent'
      codexQuotaRefreshSeconds = 5; codexWarmupDaily = $true; codexWarmupTime = '09:30'
      codexWarmupReset = $false; codexWarmupStartup = $true; sleepMinutes = 23
      left = $null; top = $null; unicodeProbe = '中文 "引号" \\路径'
    }
    foreach ($interval in @(1, 17, 3600)) {
      foreach ($flag in @($true, $false)) {
        $script:Prefs.codexQuotaRefreshSeconds = $interval
        $script:Prefs.codexWarmupDaily = $flag
        $script:Prefs.codexWarmupReset = -not $flag
        $script:Prefs.codexWarmupStartup = $flag
        Save-Prefs # First iteration creates; every later call atomically replaces.
        Save-Prefs # Repeated save must also work with an existing destination.
        $saved = Get-Content -LiteralPath $script:SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($key in $script:Prefs.Keys) {
          Assert-Equal $saved.$key $script:Prefs[$key] "real persistence preserves $key"
        }
        foreach ($key in @('codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup')) {
          Assert-True ($saved.$key -is [bool]) "real persistence preserves Boolean $key"
        }
        Assert-True ($saved.codexQuotaRefreshSeconds -is [int] -or $saved.codexQuotaRefreshSeconds -is [long]) 'real persistence preserves integer interval'
        Assert-Equal $saved.left 123 'real persistence rounds left coordinate'
        Assert-Equal $saved.top 57 'real persistence rounds top coordinate'
        Assert-Equal @(Get-ChildItem -LiteralPath $directory -Force).Count 1 'successful saves leave no temporary or backup file'
      }
    }
    $before = (Get-FileHash -LiteralPath $script:SettingsFile).Hash
    $lock = [IO.File]::Open($script:SettingsFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $failed = $false
    try {
      $script:Prefs.unicodeProbe = '不得写入'
      try { Save-Prefs } catch { $failed = $true }
    } finally { $lock.Dispose() }
    Assert-True $failed 'locked replacement reports failure'
    Assert-Equal (Get-FileHash -LiteralPath $script:SettingsFile).Hash $before 'failed replacement preserves existing settings'
    Assert-Equal @(Get-ChildItem -LiteralPath $directory -Force).Count 1 'failed replacement cleans up its temporary file'
  } finally {
    $script:Prefs = $originalPrefs
    $script:Window = $originalWindow
    $script:SettingsFile = $originalSettingsFile
    $resolved = (Resolve-Path -LiteralPath $directory).ProviderPath
    if ($resolved -ne $directory -or (Split-Path -Leaf $resolved) -notmatch '\Adsh-pet-prefs-[0-9a-f]{32}\z') { throw 'Unexpected regression cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
Test-RealPrefsPersistence
$prefMatch = [regex]::Match($petSource, '(?ms)^\$script:Prefs = \[ordered\]@\{.*?(?=^function Save-Prefs)')
Assert-True $prefMatch.Success 'preference initializer has a bounded standalone block'
$prefBlock = [scriptblock]::Create($prefMatch.Value)
function Initialize-TestPrefs($savedPrefs) {
  $json = if ($null -ne $savedPrefs) { $savedPrefs | ConvertTo-Json -Compress } else { $null }
  function Test-Path { param($LiteralPath) return $null -ne $json }
  function Get-Content { param($LiteralPath, [switch]$Raw, $Encoding) return $json }
  & $prefBlock
}
Initialize-TestPrefs $null
Assert-True ($script:Prefs.codexWarmupDaily -is [bool] -and -not $script:Prefs.codexWarmupDaily) 'daily warm-up defaults strictly false'
Assert-True ($script:Prefs.codexWarmupReset -is [bool] -and -not $script:Prefs.codexWarmupReset) 'reset warm-up defaults strictly false'
Assert-Equal $script:Prefs.codexWarmupTime '09:30' 'default daily time is 09:30'
Assert-True ($script:Prefs.codexWarmupStartup -is [bool] -and -not $script:Prefs.codexWarmupStartup) 'startup warm-up defaults strictly false'
Assert-Equal $script:Prefs.codexQuotaRefreshSeconds 5 'quota polling defaults to five seconds'
foreach ($validSeconds in @(1, 5, 12, 60, 3600)) {
  Initialize-TestPrefs @{ codexQuotaRefreshSeconds = $validSeconds }
  Assert-Equal $script:Prefs.codexQuotaRefreshSeconds $validSeconds 'valid saved integer interval restores'
}
foreach ($invalidSeconds in @($null, $true, $false, '5', 0, -1, 1.5, 3601, @{})) {
  Initialize-TestPrefs @{ codexQuotaRefreshSeconds = $invalidSeconds }
  Assert-Equal $script:Prefs.codexQuotaRefreshSeconds 5 'invalid persisted interval returns to safe default'
}
Initialize-TestPrefs @{ codexWarmupStartup = $true }
Assert-True $script:Prefs.codexWarmupStartup 'startup preference restores independently'
Initialize-TestPrefs @{ codexWarmupStartup = 'true' }
Assert-True (-not $script:Prefs.codexWarmupStartup) 'startup preference rejects nonboolean values'
Initialize-TestPrefs @{ skin = 'mint'; unit = 'token'; size = 'large'; sleepMinutes = 23; billingMode = 'codex'; codexUnit = 'percent'; left = 55; top = 66; codexWarmupDaily = $true; codexWarmupReset = $true; codexWarmupTime = '23:59' }
foreach ($entry in @(@('skin', 'mint'), @('unit', 'token'), @('size', 'large'), @('sleepMinutes', 23), @('billingMode', 'codex'), @('codexUnit', 'percent'), @('left', 55), @('top', 66), @('codexWarmupTime', '23:59'))) {
  Assert-Equal $script:Prefs[$entry[0]] $entry[1] "existing preference $($entry[0]) is restored"
}
Assert-True ($script:Prefs.codexWarmupDaily -and $script:Prefs.codexWarmupReset) 'saved independent boolean switches restore'
foreach ($invalidBool in @('true', 'false', 1, 0, @(), @{ value = $true })) {
  Initialize-TestPrefs @{ codexWarmupDaily = $invalidBool; codexWarmupReset = $invalidBool }
  Assert-True ($script:Prefs.codexWarmupDaily -is [bool] -and -not $script:Prefs.codexWarmupDaily) 'nonboolean daily preference resets safely'
  Assert-True ($script:Prefs.codexWarmupReset -is [bool] -and -not $script:Prefs.codexWarmupReset) 'nonboolean reset preference resets safely'
}
foreach ($invalidTime in @('', '9:30', '24:00', '12:60', "09:30`n", ' 09:30', 930, $null)) {
  Initialize-TestPrefs @{ codexWarmupTime = $invalidTime; codexWarmupDaily = $true; codexWarmupReset = $true }
  Assert-Equal $script:Prefs.codexWarmupTime '09:30' 'invalid persisted time gets safe display default'
  Assert-True (-not $script:Prefs.codexWarmupDaily) 'invalid saved time cannot enable daily via unrelated preference saves'
  Assert-True $script:Prefs.codexWarmupReset 'invalid daily time leaves independent reset switch unchanged'
}
Initialize-TestPrefs @{ codexWarmupDaily = $true; codexWarmupReset = $true }
Assert-True (-not $script:Prefs.codexWarmupDaily) 'missing saved time disables daily execution'
Assert-True $script:Prefs.codexWarmupReset 'missing daily time does not disable reset execution'
Initialize-TestPrefs $null

$script:Window = New-Object Windows.Window
$script:Window.Title = 'Desktop pet regression test owner'
$script:Window.WindowStyle = 'None'
$script:Window.ResizeMode = 'NoResize'
$script:Window.Width = 160
$script:Window.Height = 160
$script:Window.Left = -10000
$script:Window.Top = -10000
$script:Window.ShowActivated = $false
$script:Window.ShowInTaskbar = $false
$script:Window.Add_Closed({ $script:OwnerCloseCount++ })

try {
  # Only load the UI functions; all persistence and pet behavior are isolated stubs.
  . $SettingsScript
  # Isolate mode changes from the production pet queue and persistence.
  function Refresh-BillingMode {
    $script:Stats = if ((Get-BillingMode) -eq 'codex') { $script:LastSnapshot.codexStats } else { $script:LastSnapshot.stats }
    Save-Prefs
  }
  $script:Prefs.billingMode = 'deepseek'
  $script:Prefs.codexUnit = 'token'
  $script:Window.Show()
  Show-PetSettings
  Flush-Dispatcher
  Assert-True $script:SettingsWindow.IsVisible 'settings window opens non-modally'
  Assert-True ([object]::ReferenceEquals($script:SettingsWindow.Owner, $script:Window)) 'settings has the stub owner'
  $tabs = Get-Control 'SettingsTabs' ([Windows.Controls.TabControl])
  $gallery = Get-Control 'SkinGallery' ([Windows.Controls.Primitives.UniformGrid])
  $settingsScroll = Get-Control 'SettingsScroll' ([Windows.Controls.ScrollViewer])
  $statsScroll = Get-Control 'StatsScroll' ([Windows.Controls.ScrollViewer])
  Assert-True ($null -eq $script:SettingsWindow.FindName('SkinChoice')) 'skin dropdown has been removed'
  Assert-Equal $gallery.Columns 3 'gallery has three columns'
  Assert-Equal $gallery.Rows 2 'gallery has two rows'
  Assert-Equal $gallery.Children.Count 6 'gallery displays all six local skins'
  Assert-Equal $script:SkinButtons.Count 6 'skin dictionary includes exactly six buttons'
  Assert-Equal $script:FrameCalls.Count 12 'initial previews load exactly two frames per skin'
  for ($i = 0; $i -lt $script:SkinCatalog.Count; $i++) {
    $skin = $script:SkinCatalog[$i]
    $button = Get-Control "SkinCard_$($skin.id)" ([Windows.Controls.Button])
    Assert-True ([object]::ReferenceEquals($button, $gallery.Children[$i])) 'gallery preserves catalog order'
    Assert-Equal ([string]$button.Tag) $skin.id "stable skin tag $($skin.id)"
    Assert-True ([object]::ReferenceEquals($button, $script:SkinButtons[$skin.id])) 'named button matches dictionary'
    Assert-True ($button.Focusable -and $button.IsTabStop) 'skin button supports keyboard tab focus'
    Assert-True (([Windows.Automation.AutomationProperties]::GetName($button)).StartsWith($skin.name)) 'accessible name includes Chinese skin name'
    foreach ($mode in @('peak', 'valley')) {
      $image = Get-Control "SkinPreview_$($skin.id)_$mode" ([Windows.Controls.Image])
      Assert-True ($null -ne $image.Source) 'preview Image.Source is non-null'
      Assert-True ($image.Source -is [Windows.Media.Imaging.CroppedBitmap]) 'preview uses local Get-Frame CroppedBitmap'
      Assert-True $image.Source.IsFrozen 'preview source is frozen'
      Assert-True ([object]::ReferenceEquals($image.Source, $script:TestFrames["$($skin.id)/$mode/idle"])) "preview requests $mode idle pose for its own skin"
      Assert-Equal @($script:FrameCalls | Where-Object { $_ -ceq "$($skin.id)/$mode/idle" }).Count 1 'each pose is fetched once'
    }
  }
  $size = Get-Control 'SizeChoice' ([Windows.Controls.ComboBox])
  $unit = Get-Control 'UnitChoice' ([Windows.Controls.ComboBox])
  $sleep = Get-Control 'SleepInput' ([Windows.Controls.TextBox])
  $saveSleep = Get-Control 'SaveSleep' ([Windows.Controls.Button])
  $close = Get-Control 'CloseSettings' ([Windows.Controls.Button])
  $exit = Get-Control 'ExitPet' ([Windows.Controls.Button])
  $drag = Get-Control 'SettingsDragHandle' ([Windows.Controls.Grid])
  $chartUnit = Get-Control 'ChartUnit' ([Windows.Controls.ComboBox])
  $chartRange = Get-Control 'ChartRange' ([Windows.Controls.ComboBox])
  Assert-Choices $size @('small', 'medium', 'large') 'size'
  Assert-Choices $unit @('cny', 'token') 'floating unit'
  Assert-Equal $tabs.SelectedIndex 0 'initial tab is settings'
  $settingsLabel = [string][char]0x8BBE + [char]0x7F6E
  $statisticsLabel = [string][char]0x7EDF + [char]0x8BA1
  Assert-Equal ([string]$tabs.Items[0].Header) $settingsLabel 'native dot-source preserves the Chinese settings label'
  Assert-Equal ([string]$tabs.Items[1].Header) $statisticsLabel 'native dot-source preserves the Chinese statistics label'
  Assert-True ($script:SettingsWindow.Title.EndsWith($settingsLabel)) 'native dot-source preserves the Chinese window title'
  Assert-Equal $script:Prefs.skin 'default' 'initial skin is restored'
  Assert-SkinSelection 'default'
  Assert-Equal ([string]$size.SelectedItem.Tag) 'medium' 'initial size is restored'
  Assert-Equal ([string]$unit.SelectedItem.Tag) 'cny' 'initial floating unit is restored'
  Assert-Equal $sleep.Text '10' 'initial sleep setting is restored'
  Assert-Equal $script:SaveCount 0 'initial render does not write preferences'
  Assert-Equal $script:SizeCount 0 'initial selections do not spuriously resize the pet'
  Assert-True $gallery.IsVisible 'custom TabControl template displays settings content'
  Assert-True ($settingsScroll.ScrollableHeight -gt 0) 'settings content scrolls rather than clipping the lower controls'
  $workArea = [Windows.SystemParameters]::WorkArea
  Assert-True ($script:SettingsWindow.Width -le $workArea.Width - 20) 'settings width fits work area'
  Assert-True ($script:SettingsWindow.Height -le $workArea.Height - 20) 'settings height fits work area'
  $exitPoint = $exit.TranslatePoint([Windows.Point]::new(0, 0), $script:SettingsWindow)
  Assert-True ($exitPoint.Y + $exit.ActualHeight -le $script:SettingsWindow.ActualHeight) 'exit footer stays inside window'
  $settingsScroll.ScrollToBottom()
  Flush-Dispatcher
  $sleepPoint = $sleep.TranslatePoint([Windows.Point]::new(0, 0), $settingsScroll)
  Assert-True ($sleepPoint.Y -ge 0 -and $sleepPoint.Y + $sleep.ActualHeight -le $settingsScroll.ActualHeight) 'sleep controls are reachable at bottom of scroll view'
  $settingsScroll.ScrollToTop()
  Flush-Dispatcher
  Assert-True (-not $chartUnit.IsVisible) 'statistics content starts hidden'
  Save-SettingsCapture 'settings-test.png'

  $refreshSeconds = Get-Control 'CodexQuotaRefreshSeconds' ([Windows.Controls.TextBox])
  $saveRefresh = Get-Control 'SaveCodexQuotaRefreshSeconds' ([Windows.Controls.Button])
  Assert-Equal $refreshSeconds.Text '5' 'quota interval input defaults to five seconds'
  foreach ($invalidSeconds in @('', '0', '-1', '1.5', '3601', 'abc', ' 5 ', '5e1')) {
    $before = $script:SaveCount
    $refreshSeconds.Text = $invalidSeconds
    Click-Button $saveRefresh
    Assert-Equal $script:SaveCount $before 'invalid interval never saves'
    Assert-Equal $script:Prefs.codexQuotaRefreshSeconds 5 'invalid interval keeps saved value'
    Assert-True (($script:SettingsWindow.FindName('CodexQuotaRefreshValidation')).Text.Contains('1–3600')) 'invalid interval displays range hint'
  }
  foreach ($validSeconds in @(1, 3600, 12)) {
    $before = $script:SaveCount
    $refreshSeconds.Text = [string]$validSeconds
    Click-Button $saveRefresh
    Assert-Equal $script:Prefs.codexQuotaRefreshSeconds $validSeconds 'valid interval saves as integer'
    Assert-Equal $script:SaveCount ($before + 1) 'changed interval saves exactly once'
    Click-Button $saveRefresh
    Assert-Equal $script:SaveCount ($before + 1) 'unchanged interval does not save again'
    Assert-True (-not $script:Prefs.codexWarmupStartup -and -not $script:Prefs.codexWarmupDaily -and -not $script:Prefs.codexWarmupReset) 'saving polling interval never enables automatic warm-up'
  }
  $daily = Get-Control 'CodexWarmupDaily' ([Windows.Controls.CheckBox])
  $reset = Get-Control 'CodexWarmupReset' ([Windows.Controls.CheckBox])
  $startup = Get-Control 'CodexWarmupStartup' ([Windows.Controls.CheckBox])
  Assert-True (-not $startup.IsChecked) 'startup control initially off'
  $warmupTime = Get-Control 'CodexWarmupTime' ([Windows.Controls.TextBox])
  $saveTime = Get-Control 'SaveCodexWarmupTime' ([Windows.Controls.Button])
  $warmupStatus = Get-Control 'CodexWarmupStatus' ([Windows.Controls.TextBlock])
  $warmupPanel = Get-Control 'CodexWarmupPanel' ([Windows.Controls.Border])
  Assert-True (-not $daily.IsChecked -and -not $reset.IsChecked) 'both automatic controls are initially off'
  Assert-Equal $warmupTime.Text '09:30' 'time input restores default'
  Assert-Equal ([string]$saveTime.Content) '保存时间' 'only action button saves time, never warms up'
  $panelButtons = @($warmupPanel.Child.Children | Where-Object { $_ -is [Windows.Controls.StackPanel] } | ForEach-Object { $_.Children } | Where-Object { $_ -is [Windows.Controls.Button] })
  Assert-Equal $panelButtons.Count 1 'warm-up panel contains only one button'
  Assert-True ([object]::ReferenceEquals($panelButtons[0], $saveTime)) 'no manual warm-up button exists'
  Assert-True (($script:SettingsWindow.FindName('CodexWarmupTimezone')).Text.Contains([TimeZoneInfo]::Local.DisplayName)) 'timezone uses readable PC local DisplayName'
  $explanation = ($script:SettingsWindow.FindName('CodexWarmupExplanation')).Text
  Assert-True ($explanation.Contains('dsh-codex-subscription') -and $explanation.Contains('当前活动账号') -and $explanation.Contains('可用 Codex 模型') -and $explanation.Contains('否则目录首项') -and $explanation.Contains('消耗订阅额度') -and $explanation.Contains('默认关闭')) 'scope, account/model, quota cost and opt-in are explicit'
  $scheduleNote = ($script:SettingsWindow.FindName('CodexWarmupScheduleNote')).Text
  Assert-True ($scheduleNote.Contains('无需重启') -and $scheduleNote.Contains('切换显示模式不会停止') -and $scheduleNote.Contains('桌宠窗口也不会停止') -and $scheduleNote.Contains('不会唤醒电脑') -and $scheduleNote.Contains('不会补执行')) 'backend lifecycle and no wake/catch-up limitations are explicit'
  $warmupTime.BringIntoView()
  Flush-Dispatcher
  $warmupPoint = $warmupTime.TranslatePoint([Windows.Point]::new(0, 0), $settingsScroll)
  Assert-True ($warmupPoint.Y -ge 0 -and $warmupPoint.Y + $warmupTime.ActualHeight -le $settingsScroll.ActualHeight) 'warm-up controls remain reachable through SettingsScroll'
  $settingsScroll.ScrollToTop()
  Flush-Dispatcher
  Assert-True ($warmupStatus.Text.Contains('已关闭') -and -not $warmupStatus.Text.Contains('重启')) 'old backend with disabled preferences does not advise restart'
  $startup.IsChecked = $true
  Click-Button $startup
  Assert-True ($script:Prefs.codexWarmupStartup -and -not $script:Prefs.codexWarmupDaily -and -not $script:Prefs.codexWarmupReset) 'startup switch enables independently'
  Assert-True ($warmupStatus.Text.Contains('重启 DSH')) 'startup switch on old backend gives restart hint'
  $startup.IsChecked = $false
  Click-Button $startup
  $before = $script:SaveCount
  $daily.IsChecked = $true
  Click-Button $daily
  Assert-True ($script:Prefs.codexWarmupDaily -is [bool] -and $script:Prefs.codexWarmupDaily) 'daily switch saves strict boolean true'
  Assert-True (-not $script:Prefs.codexWarmupReset) 'daily switch never changes reset switch'
  Assert-Equal $script:SaveCount ($before + 1) 'daily switch saves exactly once'
  Click-Button $daily
  Assert-Equal $script:SaveCount ($before + 1) 'unchanged switch does not save again'
  Assert-True ($warmupStatus.Text.Contains('完全退出并重启 DSH')) 'enabled preferences on old backend advise full DSH restart'
  $reset.IsChecked = $true
  Click-Button $reset
  Assert-Equal $script:SaveCount ($before + 2) 'reset switch saves exactly once independently'
  $daily.IsChecked = $false
  Click-Button $daily
  Assert-True (-not $script:Prefs.codexWarmupDaily -and $script:Prefs.codexWarmupReset) 'reset stays enabled when daily is disabled'
  Assert-Equal $script:SaveCount ($before + 3) 'daily disable saves once'
  $reset.IsChecked = $false
  Click-Button $reset
  Assert-Equal $script:SaveCount ($before + 4) 'reset disable saves once'
  foreach ($invalidTime in @('', '9:30', '24:00', '12:60', 'aa:bb', '09:300', "09:30`n", ' 9:30')) {
    $before = $script:SaveCount
    $warmupTime.Text = $invalidTime
    Click-Button $saveTime
    Assert-Equal $script:Prefs.codexWarmupTime '09:30' 'invalid time leaves saved preference intact'
    Assert-Equal $script:SaveCount $before 'invalid time never saves'
    Assert-True (($script:SettingsWindow.FindName('CodexWarmupTimeValidation')).Text.Contains('请输入有效时间')) 'invalid time gets inline validation'
  }
  foreach ($validTime in @('00:00', '23:59', '07:05')) {
    $before = $script:SaveCount
    $warmupTime.Text = $validTime
    Click-Button $saveTime
    Assert-Equal $script:Prefs.codexWarmupTime $validTime 'valid HH:mm saves'
    Assert-Equal $script:SaveCount ($before + 1) 'changed valid time saves exactly once'
    Click-Button $saveTime
    Assert-Equal $script:SaveCount ($before + 1) 'unchanged valid time does not save again'
    Assert-True (-not $script:Prefs.codexWarmupDaily -and -not $script:Prefs.codexWarmupReset) 'saving time does not enable schedules'
  }
  $sampleTime = 1800000000000L
  $script:LastSnapshot = [pscustomobject]@{ codexWarmup = [pscustomobject]@{ status = 'succeeded'; detail = '自动预热已完成'; lastAttemptAt = $sampleTime; lastSuccessAt = $sampleTime; lastReason = 'reset'; nextDailyAt = $sampleTime + 86400000L; timezone = 'test'; model = 'gpt-test'; rawError = 'SECRET-MUST-NOT-APPEAR' } }
  Update-SettingsCodexWarmup
  $expectedLocal = [DateTimeOffset]::FromUnixTimeMilliseconds($sampleTime).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
  Assert-True ($warmupStatus.Text.Contains('预热成功') -and $warmupStatus.Text.Contains('自动预热已完成')) 'backend status and safe detail render'
  Assert-True ($warmupStatus.Text.Contains($expectedLocal) -and $warmupStatus.Text.Contains('上次成功（本地）') -and $warmupStatus.Text.Contains('下次每日预热（本地）')) 'last and next epoch timestamps render in local time'
  Assert-True ($warmupStatus.Text.Contains('5h 额度窗口重置') -and $warmupStatus.Text.Contains('gpt-test')) 'reason and model render'
  Assert-True (-not $warmupStatus.Text.Contains('SECRET')) 'raw backend errors never render'
  foreach ($entry in @(@('disabled', '已关闭'), @('idle', '等待计划'), @('running', '正在预热'), @('failed', '预热失败'), @('skipped', '已跳过'))) {
    $script:LastSnapshot.codexWarmup.status = $entry[0]
    Update-SettingsCodexWarmup
    Assert-True ($warmupStatus.Text.Contains($entry[1])) "status $($entry[0]) renders"
  }
  $realSettings = $script:SettingsWindow
  try {
    $script:SettingsWindow = [pscustomobject]@{ IsVisible = $false }
    Update-SettingsCodexWarmup
    $script:SettingsWindow = New-Object Windows.Window
    $script:SettingsWindow.ShowInTaskbar = $false
    $script:SettingsWindow.Left = -10000
    $script:SettingsWindow.Show()
    Update-SettingsCodexWarmup # Visible window without the status control safely no-ops.
    $script:SettingsWindow.Close()
    $script:SettingsWindow = $null
    Update-SettingsCodexWarmup
  } finally { $script:SettingsWindow = $realSettings }
  $script:LastSnapshot = $null
  Update-SettingsCodexWarmup

  foreach ($tag in @('night', 'snow', 'mint', 'cherry', 'star', 'default', 'night')) {
    $before = $script:SaveCount
    Click-Button $script:SkinButtons[$tag]
    Assert-Equal $script:Prefs.skin $tag 'skin selection updates preferences via its own Tag'
    Assert-Equal $script:SaveCount ($before + 1) 'skin selection saves exactly once'
    Assert-SkinSelection $tag
    Click-Button $script:SkinButtons[$tag]
    Assert-Equal $script:SaveCount ($before + 1) 'repeat click on selected skin does not save'
  }
  $before = $script:SaveCount
  Press-SkinKey $script:SkinButtons['snow'] ([Windows.Input.Key]::Space)
  Assert-Equal $script:Prefs.skin 'snow' 'Space selects a focused skin card'
  Assert-Equal $script:SaveCount ($before + 1) 'Space saves exactly once'
  Press-SkinKey $script:SkinButtons['mint'] ([Windows.Input.Key]::Enter)
  Assert-Equal $script:Prefs.skin 'mint' 'Enter selects a focused skin card'
  Assert-Equal $script:SaveCount ($before + 2) 'Enter saves exactly once'
  Press-SkinKey $script:SkinButtons['mint'] ([Windows.Input.Key]::Enter)
  Assert-Equal $script:SaveCount ($before + 2) 'repeat Enter on selected skin does not save'
  Click-Button $script:SkinButtons['star']
  Assert-SkinSelection 'star'
  Assert-Equal $script:FrameCalls.Count 12 'click and keyboard selection never reload previews'
  foreach ($tag in @('small', 'medium', 'large')) {
    $before = $script:SaveCount
    $beforeSize = $script:SizeCount
    Select-Tag $size $tag
    Assert-Equal $script:Prefs.size $tag 'size selection updates preferences'
    Assert-Equal $script:SaveCount ($before + 1) 'size selection saves exactly once'
    Assert-Equal $script:SizeCount ($beforeSize + 1) 'size selection applies pet dimensions exactly once'
    Assert-Equal $script:Window.Width (@{ small = 100; medium = 160; large = 220 }[$tag]) 'size stub changes pet dimensions'
  }
  foreach ($tag in @('token', 'cny', 'token')) {
    $before = $script:SaveCount
    Select-Tag $unit $tag
    Assert-Equal $script:Prefs.unit $tag 'floating unit selection updates preferences'
    Assert-Equal $script:SaveCount ($before + 1) 'floating unit selection saves exactly once'
  }

  $before = $script:SaveCount
  $beforeSize = $script:SizeCount
  $tabs.SelectedIndex = 1
  foreach ($index in @(1, 0, 1)) { $chartUnit.SelectedIndex = $index }
  foreach ($index in @(1, 2, 0)) { $chartRange.SelectedIndex = $index }
  Flush-Dispatcher
  Assert-True $chartUnit.IsVisible 'custom TabControl template displays statistics content'
  Assert-True (-not $gallery.IsVisible) 'settings content hides when statistics is selected'
  Assert-Equal ($script:SettingsWindow.FindName('ChartCanvas')).Width 600 'statistics preserves its readable 600-wide canvas'
  Assert-Equal ([string]$statsScroll.HorizontalScrollBarVisibility) 'Auto' 'statistics can scroll horizontally in small work areas'
  Assert-True (($script:SettingsWindow.FindName('ChartCanvas')).Children.Count -gt 0) 'statistics chart renders with null stats'
  Save-SettingsCapture 'statistics-test.png'
  Assert-Equal $script:Prefs.unit 'token' 'chart unit is independent of floating unit'
  Assert-Equal ([string]$unit.SelectedItem.Tag) 'token' 'chart unit leaves the settings selection alone'
  Assert-Equal $script:SaveCount $before 'chart and tab changes do not save preferences'
  Assert-Equal $script:SizeCount $beforeSize 'chart and tab changes do not resize the pet'

  $existing = $script:SettingsWindow
  Show-PetSettings
  Assert-True ([object]::ReferenceEquals($script:SettingsWindow, $existing)) 're-entry reuses the visible settings window'
  Assert-Equal $tabs.SelectedIndex 0 're-entry returns from stats to settings'
  Assert-Equal $script:SaveCount $before 're-entry does not save preferences'

  foreach ($minutes in @(1, 240, 10)) {
    $before = $script:SaveCount
    $sleep.Text = [string]$minutes
    Click-Button $saveSleep
    Assert-Equal $script:Prefs.sleepMinutes $minutes 'valid sleep value is accepted'
    Assert-Equal $script:SaveCount ($before + 1) 'valid sleep value saves exactly once'
  }
  foreach ($invalid in @('', '0', '241', '-1', '1.5', 'not-a-number')) {
    $before = $script:SaveCount
    $sleep.Text = $invalid
    Click-Button $saveSleep
    Assert-Equal $script:Prefs.sleepMinutes 10 "invalid sleep '$invalid' leaves preferences alone"
    Assert-Equal $script:SaveCount $before "invalid sleep '$invalid' does not save"
  }

  # Mode selection keeps DeepSeek preferences and uses independent Codex counters.
  $modeChoice = Get-Control 'BillingModeChoice' ([Windows.Controls.ComboBox])
  $codexUnit = Get-Control 'CodexUnitChoice' ([Windows.Controls.ComboBox])
  Assert-Choices $modeChoice @('deepseek', 'codex') 'billing mode'
  Assert-Choices $codexUnit @('token', 'percent') 'Codex floating unit'
  $script:LastSnapshot = [pscustomobject]@{
    stats = $script:Stats
    codexStats = [pscustomobject]@{ days = @{}; activityAt = 0 }
    codex = [pscustomobject]@{ status = 'ready'; fiveHour = [pscustomobject]@{ remainingPercent = 0; resetAt = 1800000000000 }; weekly = [pscustomobject]@{ remainingPercent = 87.5; resetAt = 1800600000000 } }
  }
  $before = $script:SaveCount
  Select-Tag $modeChoice 'codex'
  Flush-Dispatcher
  Assert-Equal $script:Prefs.billingMode 'codex' 'switch to Codex persists mode'
  Assert-Equal $script:SaveCount ($before + 1) 'mode switch saves once'
  Assert-Equal ([string]($script:SettingsWindow.FindName('DeepSeekUnitPanel')).Visibility) 'Collapsed' 'money floating choice hidden in Codex'
  Assert-Equal ([string]($script:SettingsWindow.FindName('CodexUnitPanel')).Visibility) 'Visible' 'Codex floating choice shown'
  Assert-Equal ([string]$warmupPanel.Visibility) 'Visible' 'warm-up panel remains available in Codex display mode'
  Assert-Equal $script:Prefs.codexWarmupTime '07:05' 'display mode does not change schedule preferences'
  Assert-True (-not $chartUnit.IsEnabled) 'Codex graph cannot switch to currency'
  Assert-Equal $script:SettingsCost.Text '0%' 'exhausted quota is a genuine zero'
  Assert-Equal $script:SettingsHitRate.Text '87.5%' 'weekly quota is separate from cache-hit rate'
  foreach ($skin in $script:SkinCatalog) {
    Assert-Equal ([string]($script:SkinButtons[$skin.id].FindName("SkinPreview_$($skin.id)_peak")).Visibility) 'Collapsed' 'peak preview hidden in Codex'
    Assert-Equal ($script:SkinButtons[$skin.id].FindName("SkinLabelValley_$($skin.id)")).Text '形象预览' 'Codex gallery has no valley-price label'
  }
  Select-Tag $codexUnit 'percent'
  Assert-Equal $script:Prefs.codexUnit 'percent' 'Codex percentage unit persists separately'
  Assert-Equal $script:Prefs.unit 'token' 'Codex unit does not replace DeepSeek unit'
  Save-SettingsCapture 'codex-settings-test.png'
  $tabs.SelectedIndex = 1
  Flush-Dispatcher
  Save-SettingsCapture 'codex-statistics-test.png'
  $tabs.SelectedIndex = 0
  Select-Tag $modeChoice 'deepseek'
  Flush-Dispatcher
  Assert-True $chartUnit.IsEnabled 'currency chart choice restored in DeepSeek'
  Assert-Equal ([string]($script:SettingsWindow.FindName('DeepSeekUnitPanel')).Visibility) 'Visible' 'DeepSeek controls restored'
  Assert-Equal ($script:SkinButtons['default'].FindName('SkinLabelValley_default')).Text '谷时' 'DeepSeek gallery labels restored'
  Assert-Equal $script:FrameCalls.Count 12 'switching mode does not reload gallery assets'

  Assert-Equal ([string]$warmupPanel.Visibility) 'Visible' 'warm-up panel remains available in DeepSeek display mode'
  $daily.IsChecked = $true
  Click-Button $daily
  $reset.IsChecked = $true
  Click-Button $reset
  $before = $script:SaveCount
  $beforeSize = $script:SizeCount
  Click-Button $close
  Flush-Dispatcher
  Assert-True (-not $existing.IsVisible) 'close button closes settings'
  Assert-True ($null -eq $script:SettingsWindow) 'closing clears the settings window reference'
  Assert-Equal $script:OwnerCloseCount 0 'close settings does not exit the pet'
  Assert-True $script:Window.IsVisible 'owner remains open after closing settings'
  Show-PetSettings
  Flush-Dispatcher
  Assert-True (-not [object]::ReferenceEquals($script:SettingsWindow, $existing)) 'reopening creates a fresh WPF window'
  Assert-Equal ($script:SettingsWindow.FindName('SettingsTabs')).SelectedIndex 0 'reopening starts on settings'
  Assert-Equal $script:Prefs.skin 'star' 'reopen restores skin'
  Assert-SkinSelection 'star'
  Assert-Equal $script:SkinButtons.Count 6 'reopen reconstructs all six buttons'
  Assert-Equal $script:FrameCalls.Count 12 'reopen reuses all frozen preview frames'
  foreach ($skin in $script:SkinCatalog) {
    foreach ($mode in @('peak', 'valley')) {
      $image = $script:SettingsWindow.FindName("SkinPreview_$($skin.id)_$mode")
      Assert-True ([object]::ReferenceEquals($image.Source, $script:TestFrames["$($skin.id)/$mode/idle"])) 'reopen keeps the cached local image source'
    }
  }
  Assert-Equal ([string]($script:SettingsWindow.FindName('SizeChoice')).SelectedItem.Tag) 'large' 'reopen restores size'
  Assert-Equal ([string]($script:SettingsWindow.FindName('UnitChoice')).SelectedItem.Tag) 'token' 'reopen restores floating unit'
  Assert-Equal ($script:SettingsWindow.FindName('SleepInput')).Text '10' 'reopen restores sleep'
  Assert-True ($script:SettingsWindow.FindName('CodexWarmupDaily').IsChecked -and $script:SettingsWindow.FindName('CodexWarmupReset').IsChecked) 'reopen restores preexisting enabled switches without saving'
  Assert-Equal ($script:SettingsWindow.FindName('CodexWarmupTime')).Text '07:05' 'reopen restores saved custom time'
  Assert-Equal ($script:SettingsWindow.FindName('CodexQuotaRefreshSeconds')).Text '12' 'reopen restores saved custom polling interval'
  Assert-True ($script:SettingsWindow.FindName('CodexWarmupStatus').Text.Contains('重启 DSH')) 'reopen refreshes old-backend hint'
  Assert-Equal $script:SaveCount $before 'reopening does not save preferences'
  Assert-Equal $script:SizeCount $beforeSize 'reopening does not trigger size handlers'

  $lastSettings = $script:SettingsWindow
  Click-Button ($script:SettingsWindow.FindName('ExitPet'))
  Flush-Dispatcher
  Assert-Equal $script:OwnerCloseCount 1 'exit closes the pet owner'
  Assert-True (-not $script:Window.IsVisible) 'exit leaves no visible pet owner'
  Assert-True (-not $lastSettings.IsVisible) 'exit also closes owned settings'
  Assert-Equal $script:SaveCount $before 'exit does not change preferences'
  Write-Host "PASS: $($script:Assertions) WPF settings regression assertions."
} finally {
  # Always close windows, including after a failed assertion; never leave a test pet running.
  if ($script:SettingsWindow) { $script:SettingsWindow.Close() }
  if ($script:Window -and $script:OwnerCloseCount -eq 0) { $script:Window.Close() }
}
