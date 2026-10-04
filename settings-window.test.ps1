# Run independently: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\settings-window.test.ps1
# Does not source pet.ps1, start DSH, touch preferences, or require a test framework.
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
  $script:Window.Show()
  Show-PetSettings
  Flush-Dispatcher
  Assert-True $script:SettingsWindow.IsVisible 'settings window opens non-modally'
  Assert-True ([object]::ReferenceEquals($script:SettingsWindow.Owner, $script:Window)) 'settings has the stub owner'
  $tabs = Get-Control 'SettingsTabs' ([Windows.Controls.TabControl])
  $skin = Get-Control 'SkinChoice' ([Windows.Controls.ComboBox])
  $size = Get-Control 'SizeChoice' ([Windows.Controls.ComboBox])
  $unit = Get-Control 'UnitChoice' ([Windows.Controls.ComboBox])
  $sleep = Get-Control 'SleepInput' ([Windows.Controls.TextBox])
  $saveSleep = Get-Control 'SaveSleep' ([Windows.Controls.Button])
  $close = Get-Control 'CloseSettings' ([Windows.Controls.Button])
  $exit = Get-Control 'ExitPet' ([Windows.Controls.Button])
  $drag = Get-Control 'SettingsDragHandle' ([Windows.Controls.Grid])
  $chartUnit = Get-Control 'ChartUnit' ([Windows.Controls.ComboBox])
  $chartRange = Get-Control 'ChartRange' ([Windows.Controls.ComboBox])
  Assert-Choices $skin @('default', 'night') 'skin'
  Assert-Choices $size @('small', 'medium', 'large') 'size'
  Assert-Choices $unit @('cny', 'token') 'floating unit'
  Assert-Equal $tabs.SelectedIndex 0 'initial tab is settings'
  $settingsLabel = [string][char]0x8BBE + [char]0x7F6E
  $statisticsLabel = [string][char]0x7EDF + [char]0x8BA1
  Assert-Equal ([string]$tabs.Items[0].Header) $settingsLabel 'native dot-source preserves the Chinese settings label'
  Assert-Equal ([string]$tabs.Items[1].Header) $statisticsLabel 'native dot-source preserves the Chinese statistics label'
  Assert-True ($script:SettingsWindow.Title.EndsWith($settingsLabel)) 'native dot-source preserves the Chinese window title'
  Assert-Equal ([string]$skin.SelectedItem.Tag) 'default' 'initial skin is restored'
  Assert-Equal ([string]$size.SelectedItem.Tag) 'medium' 'initial size is restored'
  Assert-Equal ([string]$unit.SelectedItem.Tag) 'cny' 'initial floating unit is restored'
  Assert-Equal $sleep.Text '10' 'initial sleep setting is restored'
  Assert-Equal $script:SaveCount 0 'initial render does not write preferences'
  Assert-Equal $script:SizeCount 0 'initial selections do not spuriously resize the pet'
  Assert-True $skin.IsVisible 'custom TabControl template displays settings content'
  Assert-True (-not $chartUnit.IsVisible) 'statistics content starts hidden'
  Save-SettingsCapture 'settings-test.png'

  foreach ($tag in @('night', 'default', 'night')) {
    $before = $script:SaveCount
    Select-Tag $skin $tag
    Assert-Equal $script:Prefs.skin $tag 'skin selection updates preferences'
    Assert-Equal $script:SaveCount ($before + 1) 'skin selection saves exactly once'
  }
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
  Assert-True (-not $skin.IsVisible) 'settings content hides when statistics is selected'
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
  Assert-Equal ([string]($script:SettingsWindow.FindName('SkinChoice')).SelectedItem.Tag) 'night' 'reopen restores skin'
  Assert-Equal ([string]($script:SettingsWindow.FindName('SizeChoice')).SelectedItem.Tag) 'large' 'reopen restores size'
  Assert-Equal ([string]($script:SettingsWindow.FindName('UnitChoice')).SelectedItem.Tag) 'token' 'reopen restores floating unit'
  Assert-Equal ($script:SettingsWindow.FindName('SleepInput')).Text '10' 'reopen restores sleep'
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
