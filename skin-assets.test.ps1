# Native integration of actual bundled assets; never source pet.ps1 or user data.
param([string]$CaptureDirectory = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:ProjectRoot = $PSScriptRoot
. (Join-Path $PSScriptRoot 'skin-catalog.ps1')
$script:Assertions = 0
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
  $script:Assertions++
}
# Execute only the bounded atlas initialization and pure Get-Frame function.
# Everything that creates windows, loads preferences or starts timers is excluded.
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pet.ps1') -Raw -Encoding UTF8
$start = $source.IndexOf('$script:Atlases = @{}')
$end = $source.IndexOf('function Get-Peak', $start)
Assert-True ($start -ge 0 -and $end -gt $start) 'safe atlas-only initialization bounds exist'
. ([scriptblock]::Create($source.Substring($start, $end - $start)))
Assert-True ($script:SkinCatalog.Count -eq 6) 'all six skins are registered'
Assert-True ($script:Atlases.Count -eq 12) 'twelve local peak/valley atlases load'
foreach ($skin in $script:SkinCatalog) {
  foreach ($mode in @('peak', 'valley')) {
    foreach ($action in @('idle', 'blink', 'sleep', 'hit', 'miss', 'output', 'combo', 'depleted', 'recharge')) {
      $frame = Get-Frame $skin.id $mode $action
      Assert-True ($frame -is [Windows.Media.Imaging.CroppedBitmap]) "$($skin.id)/$mode/$action is a real cropped frame"
      Assert-True $frame.IsFrozen "$($skin.id)/$mode/$action is frozen for cache reuse"
      Assert-True ($frame.PixelWidth -gt 100 -and $frame.PixelHeight -gt 100) 'frame has usable resolution'
      Assert-True ([object]::ReferenceEquals($frame, (Get-Frame $skin.id $mode $action))) 'frame cache reuses the same object'
    }
  }
}
$script:Prefs = @{ skin = 'snow'; unit = 'cny'; size = 'medium'; sleepMinutes = 10 }
$script:Stats = $null
$script:SettingsWindow = $null
$script:SaveCount = 0
function Save-Prefs { $script:SaveCount++ }
function Set-PetSize { Save-Prefs }
$script:Window = New-Object Windows.Window
$script:Window.Width = 272; $script:Window.Height = 296
$script:Window.Left = -10000; $script:Window.Top = -10000
$script:Window.ShowActivated = $false; $script:Window.ShowInTaskbar = $false
try {
  . (Join-Path $PSScriptRoot 'settings-window.ps1')
  $script:Window.Show()
  Show-PetSettings
  [void][Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Windows.Threading.DispatcherPriority]::Background, [Action]{})
  Assert-True ($script:SaveCount -eq 0) 'opening actual-image gallery does not write preferences'
  foreach ($skin in $script:SkinCatalog) {
    foreach ($mode in @('peak', 'valley')) {
      $image = $script:SettingsWindow.FindName("SkinPreview_$($skin.id)_$mode")
      Assert-True ([object]::ReferenceEquals($image.Source, (Get-Frame $skin.id $mode 'idle'))) 'gallery displays the actual runtime idle frame'
    }
    $script:SkinButtons[$skin.id].RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    Assert-True ($script:Prefs.skin -eq $skin.id) 'actual gallery selects every bundled skin'
  }
  if ($CaptureDirectory) {
    [void](New-Item -ItemType Directory -Path $CaptureDirectory -Force)
    # Select the snow card as an example, but persist nowhere (Save-Prefs is a stub).
    $script:SkinButtons['snow'].RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    $script:SettingsWindow.UpdateLayout()
    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new([int]$script:SettingsWindow.ActualWidth, [int]$script:SettingsWindow.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($script:SettingsWindow)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create((Join-Path $CaptureDirectory 'skin-gallery.png'))
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
  }
} finally {
  if ($script:SettingsWindow) { $script:SettingsWindow.Close() }
  $script:Window.Close()
}
Write-Host "PASS: $script:Assertions native actual-asset integration assertions."
