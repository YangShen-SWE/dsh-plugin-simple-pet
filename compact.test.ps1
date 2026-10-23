# Focused compact-mode fixture. Actual production AST/XAML, never starts the pet or reads user data.
param([string]$ProjectRoot = $PSScriptRoot, [string]$CapturePath = '')
$requestedCapture = $CapturePath
$fixture = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'companion.test.ps1'))
$start = $fixture.IndexOf("`$ErrorActionPreference =")
$end = $fixture.IndexOf('$baseActivity =')
if ($start -lt 0 -or $end -lt $start) { throw 'Missing isolated WPF bootstrap boundary' }
# Bootstrap imports helpers and fixtures ONLY; no legacy policy matrix is executed.
Invoke-Expression $fixture.Substring($start, $end - $start)
$temp = Join-Path ([IO.Path]::GetTempPath()) ('DshCompact-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
$script:DataDir = $temp; $script:SettingsFile = Join-Path $temp 'settings.json'; $script:StateFile = Join-Path $temp 'state.json'
$script:PositionFile = Join-Path $temp 'position.json'; $script:Preview = $false; $DshProfile = 'desktop'; $PetRunId = [guid]::NewGuid().ToString()
$script:ApplyingPetPreferences = $true; $script:SaveCalls = 0
function Save-Prefs { $script:SaveCalls++ }
$timerNode = $petAst.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -eq 'Add_Tick' }, $true)
$tick = [scriptblock]::Create($timerNode.Arguments[0].ScriptBlock.Extent.Text.TrimStart('{').TrimEnd('}'))
$script:Cases = 0
try {
  Set-PetPreferenceValues ([pscustomobject]@{})
  Assert-Equal $script:Prefs.compactMode $false 'old preferences default to full character'
  foreach ($invalid in @('true', 1, @(,$true), [pscustomobject]@{})) {
    Set-PetPreferenceValues ([pscustomobject]@{ compactMode = $invalid })
    Assert-Equal $script:Prefs.compactMode $false 'compact strictly rejects non-booleans'
  }
  foreach ($mode in @('deepseek','codex')) { foreach ($size in @('tiny','small','medium','large')) { foreach ($theme in $script:CardThemeCatalog.id) {
    Set-PetPreferenceValues ([pscustomobject]@{ compactMode = $true; billingMode = $mode; size = $size; cardTheme = $theme; codexWarmupDaily = $true; codexWarmupTime = '08:15' })
    $script:ApplyingPetPreferences = $true
    $script:Queue.Enqueue([pscustomobject]@{ kind = 'hit'; tokens = 1 })
    $anim = [Windows.Media.Animation.DoubleAnimation]::new(1, 1.1, [Windows.Duration]::new([TimeSpan]::FromSeconds(4)))
    $anim.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
    $script:BalanceScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $anim)
    $script:AppliedFeedbackKey = $null
    Update-PetUsageCard; Set-PetSize; Update-PetCardTheme $false; Sync-PetFeedbackPolicy
    $policy = Get-PetFeedbackPolicy
    Assert-Equal $policy.Static $true 'compact forces static policy'
    Assert-Equal $policy.Flash $false 'compact disables flashes'
    Assert-Equal $policy.Floats $false 'compact disables floats'
    Assert-Equal $script:SpriteLayer.Visibility 'Collapsed' 'character does not occupy render or hit-testing space'
    Assert-Equal ([Windows.Controls.Canvas]::GetTop($script:Card)) 5 'card moves into former character space'
    $height = if ($mode -eq 'codex') { 194 } else { 102 }
    Assert-Equal $script:Root.Height $height 'root contains only card plus padding'
    Assert-Equal $script:Window.Height ($height * $script:Sizes[$size]) 'window shrinks, no invisible character area'
    Assert-Equal $script:Window.Width (272 * $script:Sizes[$size]) 'four widths preserved'
    Assert-Equal $script:Window.Left 123 'host change preserves left'
    Assert-Equal $script:Window.Top 234 'host change preserves top'
    Assert-Equal $script:Prefs.quietMode $false 'does not rewrite quiet preference'
    Assert-Equal $script:Prefs.reduceMotion $false 'does not rewrite motion preference'
    Assert-Equal $script:Prefs.codexWarmupDaily $true 'does not change existing automation preference'
    Assert-Equal (Get-PetAppliedPreferenceValues).compactMode $true 'receipt reports actual compact preference'
    foreach ($barName in @('FiveHourBar','WeeklyBar')) {
      $bar = $script:Window.FindName($barName)
      Assert-True ($bar.Template -eq $script:CompactQuotaBarTemplate) 'quota uses compact animation-free template'
      Assert-Equal $bar.Template.Triggers.Count 0 'no animated theme triggers in compact bars'
      [void]$bar.ApplyTemplate()
      Assert-True ($null -ne $bar.Template.FindName('PART_Indicator', $bar)) 'native bar indicator exists'
    }
    Assert-NoMotion
    foreach ($kind in @('hit','combo','depleted','recharge','quota')) {
      Start-Event ([pscustomobject]@{ kind = $kind; tokens = 500; cost = .1; billingMode = $mode }) ([DateTime]::UtcNow)
      Start-IdleMotion $false; Start-SleepMotion $false; Update-PetSpriteFrame $false
      Assert-NoMotion
      Assert-Equal $script:SleepMark.Visibility 'Collapsed' 'no sleep overlay while compact'
    }
    Assert-Equal $script:SaveCalls 0 'no settings or coordinates saved by layout'
    $script:Cases++
  } } }
  # Full real dispatcher tick, backed only by private synthetic snapshots/settings.
  Set-PetPreferenceValues ([pscustomobject]@{ compactMode = $true; billingMode = 'deepseek'; size = 'medium' })
  Initialize-PetPreferencesReceipt
  $script:Prefs | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:SettingsFile -Encoding UTF8
  $snapshot = $script:LastSnapshot | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($script:StateFile, $snapshot)
  Reload-PetPreferences -Force
  & $tick
  Assert-Equal $script:PetPreferencesDirty $false 'real full compact tick succeeds'
  Assert-Equal $script:Balance.Text '¥12.34' 'live data rendering continues'
  Assert-Equal $script:SpriteLayer.Visibility 'Collapsed' 'full tick cannot reveal character'
  Assert-NoMotion
  # Compact -> full while quiet remains true must also restore layout/frame (same Static value).
  $saved = [pscustomobject]@{ compactMode = $true; quietMode = $true; billingMode = 'codex'; size = 'small'; skin = 'night'; cardTheme = 'forest' }
  $saved | ConvertTo-Json | Set-Content -LiteralPath $script:SettingsFile -Encoding UTF8
  Reload-PetPreferences -Force
  Assert-Equal $script:Window.Height (194 * .85) 'same-size compact toggle shrinks after hot reload'
  $saved.compactMode = $false
  $saved | ConvertTo-Json | Set-Content -LiteralPath $script:SettingsFile -Encoding UTF8
  Reload-PetPreferences -Force
  Assert-Equal $script:SpriteLayer.Visibility 'Visible' 'exit compact restores character even while quiet'
  Assert-Equal ([Windows.Controls.Canvas]::GetTop($script:Card)) 199 'full card position restored'
  Assert-Equal $script:Window.Height (388 * .85) 'full Codex height restored'
  Assert-True ($script:Window.FindName('FiveHourBar').Template -ne $script:CompactQuotaBarTemplate) 'exit restores original native progress style'
  Assert-Equal $script:Prefs.skin 'night' 'exit preserves character selection'
  Assert-Equal $script:Prefs.cardTheme 'forest' 'exit preserves theme'
  Assert-Equal $script:Prefs.quietMode $true 'exit preserves prior quiet preference'
  Assert-True ($null -ne $script:Sprite.Source) 'returning to full mode loads actual character frame'
  Assert-Equal $script:Window.Left 123 'hot reload does not move window'
  Assert-Equal $script:Window.Top 234 'hot reload does not move window'
  Assert-Equal $script:SaveCalls 0 'hot reload never saves coordinates'
  $saved.quietMode = $false
  $saved | ConvertTo-Json | Set-Content -LiteralPath $script:SettingsFile -Encoding UTF8
  Reload-PetPreferences -Force
  Assert-Equal (Get-PetFeedbackPolicy).Static $false 'exit restores enabled effects from original choices'
  Assert-True $script:SkipPresentationSnapshot 'no presentation backlog replay on exit'
  if ($requestedCapture) {
    $sheet = [Windows.Media.DrawingVisual]::new(); $dc = $sheet.RenderOpen()
    $dc.DrawRectangle([Windows.Media.Brushes]::White, $null, [Windows.Rect]::new(0,0,600,440))
    $x = 20
    foreach ($mode in @('deepseek','codex')) {
      Set-PetPreferenceValues ([pscustomobject]@{ compactMode = $true; billingMode = $mode; size = 'medium'; cardTheme = 'default' })
      $script:ApplyingPetPreferences = $true
      Update-PetUsageCard; Set-PetSize; Update-PetCardTheme $false; Sync-PetFeedbackPolicy
      $script:Root.Measure([Windows.Size]::new(272,$script:Root.Height)); $script:Root.Arrange([Windows.Rect]::new(0,0,272,$script:Root.Height)); $script:Root.UpdateLayout()
      $image = [Windows.Media.Imaging.RenderTargetBitmap]::new(272,[int]$script:Root.Height,96,96,[Windows.Media.PixelFormats]::Pbgra32)
      $image.Render($script:Root)
      $dc.DrawImage($image,[Windows.Rect]::new($x,20,272,$script:Root.Height)); $x += 288
    }
    $dc.Close(); $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(600,210,96,96,[Windows.Media.PixelFormats]::Pbgra32); $bitmap.Render($sheet)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new(); $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create($requestedCapture); try { $encoder.Save($stream) } finally { $stream.Dispose() }
  }
  Write-Output "PASS: $script:Assertions compact assertions; $script:Cases layout/theme/size cases; private WPF only"
} finally {
  $script:Window.Close()
  # Verified absolute private fixture directory, never application data.
  if (([IO.Path]::GetFullPath($temp)).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) -and (Split-Path $temp -Leaf).StartsWith('DshCompact-')) { [IO.Directory]::Delete($temp, $true) }
}
