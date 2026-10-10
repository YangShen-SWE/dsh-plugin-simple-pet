# Isolated feature tests: production AST + hidden WPF. No live pet, settings, accounts or requests.
param([string]$ProjectRoot = $PSScriptRoot, [string]$CapturePath = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:Assertions = 0
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
  $script:Assertions++
}
function Assert-Equal($actual, $expected, [string]$message) { Assert-True ($actual -ceq $expected) "$message (expected '$expected', actual '$actual')" }
function Get-FunctionText($ast, [string]$name) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if ($null -eq $node) { throw "Missing production function: $name" }
  return $node.Extent.Text
}
$asts = @{}
foreach ($name in @('pet.ps1', 'companion-view.ps1', 'companion.test.ps1')) {
  $bytes = [IO.File]::ReadAllBytes((Join-Path $ProjectRoot $name))
  Assert-True ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) "$name has PS5.1 UTF-8 BOM"
  $tokens = $null; $errors = $null
  $asts[$name] = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot $name), [ref]$tokens, [ref]$errors)
  Assert-Equal $errors.Count 0 "$name parses"
}
$petAst = $asts['pet.ps1']
. (Join-Path $ProjectRoot 'skin-catalog.ps1')
. (Join-Path $ProjectRoot 'card-themes.ps1')
. (Join-Path $ProjectRoot 'companion-view.ps1')
. (Join-Path $ProjectRoot 'usage-view.ps1')
foreach ($name in @('Prefs', 'Sizes', 'Cells')) {
  $node = $petAst.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq ('$script:' + $name) }, $true)
  Invoke-Expression $node.Extent.Text
}
foreach ($name in @('Set-PetPreferenceValues', 'Reload-PetPreferences', 'Get-Frame', 'Read-PetState', 'Set-PetSize', 'Set-ModeVisual', 'Format-Cost', 'Start-Event', 'Start-Track', 'Start-IdleMotion', 'Start-SleepLoop', 'Start-SleepMotion', 'Start-EventMotion', 'Clear-ExpiredFloats')) {
  Invoke-Expression (Get-FunctionText $petAst $name)
}
$literal = $petAst.Find({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('<Window') }, $true)
$script:Window = [Windows.Markup.XamlReader]::Parse($literal.Value)
foreach ($name in @('Root', 'Card', 'Sprite', 'OldSprite', 'SpriteLayer', 'DeepSeekPanel', 'CodexPanel', 'Balance', 'Rate', 'QuotaStatus', 'CriticalMark', 'SleepMark')) {
  Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name)
}
$script:ModeLabel = $script:Window.FindName('Mode')
$script:Move = [Windows.Media.TranslateTransform]::new()
$script:Rotate = [Windows.Media.RotateTransform]::new()
$script:Scale = [Windows.Media.ScaleTransform]::new()
$script:BalanceScale = [Windows.Media.ScaleTransform]::new()
$transforms = [Windows.Media.TransformGroup]::new()
$transforms.Children.Add($script:Scale); $transforms.Children.Add($script:Rotate); $transforms.Children.Add($script:Move)
$script:SpriteLayer.RenderTransform = $transforms
$script:SpriteLayer.RenderTransformOrigin = [Windows.Point]::new(.5,1)
$script:Balance.RenderTransform = $script:BalanceScale
$script:Queue = New-Object 'Collections.Generic.Queue[object]'
$script:ActiveFloats = New-Object Collections.ArrayList
$script:Atlases = @{}; $script:Frames = @{}
foreach ($skin in $script:SkinCatalog.id) { foreach ($mode in @('valley', 'peak')) {
  $bitmap = [Windows.Media.Imaging.BitmapImage]::new(); $bitmap.BeginInit()
  $bitmap.UriSource = [uri](Join-Path $ProjectRoot "assets/$skin-$mode.png")
  $bitmap.CacheOption = 'OnLoad'; $bitmap.EndInit(); $bitmap.Freeze()
  $script:Atlases["$skin-$mode"] = $bitmap
} }
$script:Preview = $false
$script:LastActivityAt = [DateTime]::UtcNow
$script:Window.Left = 123; $script:Window.Top = 234
$script:LastFrameKey = ''; $script:LastPeak = $false
$script:LastUpdate = [DateTime]::UtcNow
$script:LastBlink = [DateTime]::UtcNow
$script:ActionEnd = [DateTime]::UtcNow
$script:FlashEnd = [DateTime]::MaxValue; $script:MarkEnd = [DateTime]::MaxValue
$script:Current = 'idle'
function Get-Peak { return $false }
function Update-SettingsCodexQuota { }
function Update-SettingsCodexWarmup { }
function Update-SettingsStats { }
$script:SettingsWindow = $null
$script:LastWarmupAlert = $null
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:LastSnapshot = [pscustomobject]@{
 balance = 12.34; balanceStatus = 'ready'; cacheHitRate = .8
 stats = [pscustomobject]@{ activityAt = $nowMs; days = @{} }; codexStats = [pscustomobject]@{ activityAt = $nowMs; days = @{} }
 codexWarmup = [pscustomobject]@{ status = 'disabled' }
 codex = [pscustomobject]@{ status = 'ready'; observedAt = $nowMs; accountKey = 'fixture'; fiveHour = [pscustomobject]@{ remainingPercent = 68; resetAt = $nowMs + 18000000 }; weekly = [pscustomobject]@{ remainingPercent = 82; resetAt = $nowMs + 604800000 } }
}
Update-PetUsageCard; Update-PetCardTheme $false
function Assert-NoMotion {
  foreach ($target in @($script:Move, $script:Scale, $script:Rotate, $script:BalanceScale, $script:OldSprite, $script:SleepMark)) {
    Assert-True (-not $target.HasAnimatedProperties) 'all transform/overlay/sleep clocks removed'
  }
  Assert-Equal $script:Move.X 0 'translation X reset'; Assert-Equal $script:Move.Y 0 'translation Y reset'
  Assert-Equal $script:Scale.ScaleX 1 'scale X reset'; Assert-Equal $script:Scale.ScaleY 1 'scale Y reset'
  Assert-Equal $script:Rotate.Angle 0 'rotation reset'
  Assert-Equal $script:BalanceScale.ScaleX 1 'balance X scale reset'; Assert-Equal $script:BalanceScale.ScaleY 1 'balance Y scale reset'
  Assert-Equal $script:CriticalMark.Visibility 'Collapsed' 'critical marker hidden'
  Assert-Equal $script:ActiveFloats.Count 0 'floats cleared'
  Assert-True ($script:Card.BorderBrush -eq $script:CardBaseBorder) 'base theme border restored'
}
function Set-Policy([int]$n) {
  $script:Prefs.quietMode = [bool]($n -band 1); $script:Prefs.reduceMotion = [bool]($n -band 2)
  $script:Prefs.disableFlashes = [bool]($n -band 4); $script:Prefs.disableFloats = [bool]($n -band 8)
  $script:Prefs.feedbackStyle = if ($n -band 16) { 'gentle' } else { 'classic' }
  Sync-PetFeedbackPolicy
}
$baseActivity = $script:LastActivityAt
Set-PetPreferenceValues ([pscustomobject]@{})
foreach ($key in @('quietMode','reduceMotion','disableFlashes','disableFloats')) { Assert-Equal $script:Prefs[$key] $false 'legacy default preserves effects' }
Assert-Equal $script:Prefs.feedbackStyle 'classic' 'legacy defaults classic'
foreach ($key in @('quietMode','reduceMotion','disableFlashes','disableFloats')) {
  foreach ($value in @('true', 1, @(,$true))) {
    $saved = [pscustomobject]@{}; $saved | Add-Member -NotePropertyName $key -NotePropertyValue $value
    Set-PetPreferenceValues $saved; Assert-Equal $script:Prefs[$key] $false 'strict native boolean rejection'
  }
}
foreach ($value in @('Gentle','gentle ',@(,'gentle'))) {
 Set-PetPreferenceValues ([pscustomobject]@{ feedbackStyle = $value }); Assert-Equal $script:Prefs.feedbackStyle 'classic' 'strict native style rejection'
}
$script:Queue.Enqueue([pscustomobject]@{ kind = 'hit'; tokens = 1 })
$script:SkipPresentationSnapshot = $false
Sync-PetFeedbackPolicy
Assert-Equal $script:Queue.Count 1 'first active tick preserves legacy queue'
Assert-Equal $script:SkipPresentationSnapshot $false 'first active tick does not discard new events'
$script:Queue.Clear()
$cases = 0
foreach ($mode in @('deepseek','codex')) { foreach ($n in 0..31) {
  $script:Prefs.billingMode = $mode; $script:Prefs.codexUnit = 'token'
  Set-Policy $n; $policy = Get-PetFeedbackPolicy
  Assert-Equal $policy.Static ([bool](($n -band 1) -or ($n -band 2))) 'static policy matrix'
  Assert-Equal $policy.Flash (-not ($policy.Static -or ($n -band 4) -or ($n -band 16))) 'flash policy matrix'
  Assert-Equal $policy.Floats (-not ($policy.Static -or ($n -band 8))) 'float policy matrix'
  foreach ($kind in @('hit','miss','output','combo','depleted','recharge','quota')) {
    $script:Current = 'idle'
    Reset-PetFeedbackEffects ([DateTime]::UtcNow)
    Start-Event ([pscustomobject]@{ kind = $kind; billingMode = $mode; tokens = 10; cny = .01; percent = 1 }) ([DateTime]::UtcNow)
    Update-PetSpriteFrame $false
    if ($policy.Static) { Assert-NoMotion; Assert-Equal $script:LastFrameKey "$($script:Prefs.skin)-valley-idle" 'static pose never wounded' }
    elseif ($policy.Gentle) {
      Assert-Equal (Get-PetVisualAction $kind) 'idle' 'gentle uses neutral pose'
      Assert-Equal $script:CriticalMark.Visibility 'Collapsed' 'gentle no critical marker'
      Assert-True ($script:Card.BorderBrush -eq $script:CardBaseBorder) 'gentle no flash'
      Assert-True ($script:ActiveFloats.Count -le 1) 'gentle float never stacks'
      if ($kind -in @('combo','depleted','recharge')) { Assert-Equal $script:ActiveFloats.Count 0 'extra semantic events suppressed' }
    }
    if (-not $policy.Floats) { Assert-Equal $script:ActiveFloats.Count 0 'disabled floats never created' }
    if (-not $policy.Flash) { Assert-Equal $script:CriticalMark.Visibility 'Collapsed' 'disabled critical marker' }
    $cases++
  }
  Assert-Equal $script:LastActivityAt $baseActivity 'presentation never changes activity'
  Assert-Equal $script:Window.Left 123 'presentation never moves left'; Assert-Equal $script:Window.Top 234 'presentation never moves top'
} }
# Test cancellation of actual in-flight hit/miss/sleep/float/old-sprite clocks.
foreach ($kind in @('hit','miss','output','sleep')) {
 Set-Policy 0
 if ($kind -eq 'sleep') { Start-SleepMotion $true } else { Start-Event ([pscustomobject]@{ kind=$kind; tokens=10; cny=.01 }) ([DateTime]::UtcNow) }
 Start-Track $script:OldSprite ([Windows.UIElement]::OpacityProperty) 1000 @(0,1) @(1,0)
 Assert-True ($script:Move.HasAnimatedProperties) 'fixture has live WPF motion clocks'
 Set-Policy 1; Assert-NoMotion
 Set-Policy 2; Start-IdleMotion $true; Start-SleepMotion $true; Assert-NoMotion
}
# Real timer script block, not a duplicate implementation.
$timerAst = $petAst.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Extent.Text.StartsWith('$script:Timer.Add_Tick(') }, $true)
$tick = $timerAst.Arguments[0].ScriptBlock.GetScriptBlock()
$temp = Join-Path ([IO.Path]::GetTempPath()) ('DshCompanionNative-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
try {
 $script:StateFile = Join-Path $temp 'state.json'; $script:SettingsFile = Join-Path $temp 'settings.json'
 $script:PositionFile = Join-Path $temp 'position.json'
 [IO.File]::WriteAllText($script:PositionFile, '{"left":123,"top":234}')
 $positionBytes = [IO.File]::ReadAllText($script:PositionFile)
 $script:Prefs.billingMode = 'deepseek'; Set-Policy 0
 $script:Instance = 'fixture'; $script:Cursor = 0; $script:FileTicks = $null
 function Write-State([int]$seq, [double]$balance) {
  $s = [ordered]@{ instance='fixture'; seq=$seq; updatedAt=$nowMs; balance=$balance; balanceStatus='ready'; cacheHitRate=.9; stats=@{activityAt=$nowMs;days=@{ '2026-10-10'=@{tokens=($seq*100)} }}; codexStats=@{activityAt=$nowMs;days=@{ '2026-10-10'=@{tokens=($seq*200)} }}; codexWarmup=@{status='disabled'}; codex=$script:LastSnapshot.codex; events=@() }
  foreach ($i in 1..$seq) { $s.events += @{ seq=$i; kind='miss'; billingMode='deepseek'; tokens=100; cny=.01 } }
  [IO.File]::WriteAllText($script:StateFile, ($s | ConvertTo-Json -Depth 8))
  $script:FileTicks = $null
 }
 Write-State 1 12; Read-PetState
 Set-Policy 1; Write-State 5 9; Read-PetState
 Assert-Equal $script:Cursor 5 'quiet advances cursor'
 Assert-Equal $script:Queue.Count 0 'quiet does not enqueue'
 Assert-Equal $script:Balance.Text '¥9.00' 'quiet updates real balance'
 Assert-Equal $script:Stats.days.'2026-10-10'.tokens 500 'quiet updates DeepSeek statistics'
 Set-Policy 0; Read-PetState
 Assert-Equal $script:Queue.Count 0 'exit consumes boundary snapshot without replay'
 Write-State 6 8; Read-PetState
 Assert-Equal $script:Queue.Count 1 'post-exit new event eligible'
 Set-Policy 16; Write-State 10 7; Read-PetState
 Assert-Equal $script:Queue.Count 1 'gentle coalesces multiple presentation events'
 Assert-Equal $script:Cursor 10 'gentle does not drop ledger cursor'
 Assert-Equal $script:LastSnapshot.events.Count 10 'gentle keeps source events intact'
 $script:Prefs.billingMode = 'codex'; Set-Policy 1
 $script:LastSnapshot.codex.fiveHour.remainingPercent = 41
 Write-State 11 6; Read-PetState
 Assert-Equal $script:Cursor 11 'quiet Codex advances cursor'
 Assert-Equal $script:Queue.Count 0 'quiet Codex does not enqueue'
 Assert-Equal ($script:Window.FindName('FiveHourValue').Text) '41%' 'quiet updates Codex quota'
 Assert-Equal $script:Stats.days.'2026-10-10'.tokens 2200 'quiet updates Codex statistics'
 $script:Prefs.billingMode = 'deepseek'
 # Hot reload is genuine production code, with all storage in this private fixture.
 [IO.File]::WriteAllText($script:SettingsFile, '{"quietMode":true,"feedbackStyle":"gentle","disableFlashes":true,"sleepMinutes":10}')
 $settingsBefore = [IO.File]::ReadAllText($script:SettingsFile)
 $script:NextPrefsReload = [DateTime]::MinValue; $script:PreferencesFileTicks = $null
 Reload-PetPreferences -Force; Assert-NoMotion
 Assert-Equal $script:Prefs.quietMode $true 'hot reload applies quiet immediately'
 Assert-Equal $script:Prefs.disableFlashes $true 'quiet does not overwrite child preference'
 & $tick; Assert-NoMotion
 Assert-Equal ([IO.File]::ReadAllText($script:SettingsFile)) $settingsBefore 'timer never saves global preferences'
 Assert-Equal ([IO.File]::ReadAllText($script:PositionFile)) $positionBytes 'timer never saves position'
 # Static sleep persists without changing the actual activity timestamp.
 $script:LastActivityAt = [DateTime]::UtcNow.AddMinutes(-30)
 $script:Current = 'idle'; $sleepActivity = $script:LastActivityAt
 & $tick; Assert-NoMotion
 Assert-Equal $script:Current 'sleep' 'static mode keeps genuine sleep state'
 Assert-Equal $script:LastActivityAt $sleepActivity 'static sleep does not wake or reset activity'
 # All skins, theme palettes, sizes and modes retain neutral / genuine sleep frames.
 foreach ($skin in $script:SkinCatalog.id) { foreach ($billing in @('deepseek','codex')) { foreach ($theme in $script:CardThemeCatalog.id) { foreach ($size in @('tiny','small','medium','large')) {
  $script:Prefs.skin=$skin; $script:Prefs.billingMode=$billing; $script:Prefs.cardTheme=$theme; $script:Prefs.size=$size
  $script:ApplyingPetPreferences=$true; Set-PetSize; $script:ApplyingPetPreferences=$false
  Update-PetUsageCard; Update-PetCardTheme $false
  foreach ($peak in @($false,$true)) {
   $script:Prefs.quietMode=$false; $script:Prefs.reduceMotion=$false; $script:Prefs.feedbackStyle='gentle'
   $script:Current='recharge'; $script:LastFrameKey=''; Update-PetSpriteFrame $peak
   Assert-True ($script:Sprite.Source -eq (Get-Frame $skin $(if($peak){'peak'}else{'valley'}) 'idle')) 'all variants use verified neutral source frame'
   $script:Prefs.reduceMotion=$true; $script:Current='sleep'; $script:LastFrameKey=''; Update-PetSpriteFrame $peak
   Assert-True ($script:Sprite.Source -eq (Get-Frame $skin $(if($peak){'peak'}else{'valley'}) 'sleep')) 'all variants retain static sleep frame'
  }
 } } } }
 if ($CapturePath) {
  # Native WPF neutral-pose contact sheet: six skins x two atlas modes, not a browser mock.
  $sheet = [Windows.Controls.WrapPanel]::new(); $sheet.Width=1632
  foreach ($skin in $script:SkinCatalog.id) { foreach ($peak in @($false,$true)) {
   $script:Prefs.skin=$skin; $script:Prefs.cardTheme='default'; $script:Prefs.billingMode='deepseek'; $script:Prefs.reduceMotion=$true
   $script:Current='idle'; $script:LastFrameKey=''; Update-PetSpriteFrame $peak; Update-PetUsageCard; Update-PetCardTheme $peak
   $script:Root.Measure([Windows.Size]::new(272,296)); $script:Root.Arrange([Windows.Rect]::new(0,0,272,296)); $script:Root.UpdateLayout()
   $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(272,296,96,96,[Windows.Media.PixelFormats]::Pbgra32); $bitmap.Render($script:Root)
   $panel = [Windows.Controls.StackPanel]::new(); $label=[Windows.Controls.TextBlock]::new(); $label.Text="$skin / $(if($peak){'peak'}else{'valley'}) neutral"; $label.Foreground=[Windows.Media.Brushes]::White
   $image=[Windows.Controls.Image]::new(); $image.Source=$bitmap; $image.Width=272; $image.Height=296
   $panel.Children.Add($label)|Out-Null; $panel.Children.Add($image)|Out-Null; $sheet.Children.Add($panel)|Out-Null
  } }
  $sheet.Measure([Windows.Size]::new(1632,640)); $sheet.Arrange([Windows.Rect]::new(0,0,1632,640)); $sheet.UpdateLayout()
  $result=[Windows.Media.Imaging.RenderTargetBitmap]::new(1632,640,96,96,[Windows.Media.PixelFormats]::Pbgra32); $result.Render($sheet)
  $encoder=[Windows.Media.Imaging.PngBitmapEncoder]::new(); $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($result))
  $stream=[IO.File]::Create($CapturePath); try { $encoder.Save($stream) } finally { $stream.Dispose() }
 }
 Assert-True ($petAst.Extent.Text -notmatch 'Add_MouseRightButton|New-Object Windows.Controls.ContextMenu') 'right-click remains inert'
} finally {
 $script:Window.Close()
 $resolved = [IO.Path]::GetFullPath($temp)
 if (-not $resolved.StartsWith([IO.Path]::GetTempPath()) -or -not ([IO.Path]::GetFileName($resolved)).StartsWith('DshCompanionNative-')) { throw 'Unsafe fixture cleanup path' }
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host "PASS: $script:Assertions companion native assertions; $cases mode/policy/event cases; no live requests, user data, or host restart."
