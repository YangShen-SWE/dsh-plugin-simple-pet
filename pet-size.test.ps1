# Run independently: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\pet-size.test.ps1
# Extract only literal initialization, XAML, and selected functions; never source pet.ps1.
# No windows are shown, no models/DSH are started, and real user preferences are untouched.
param([string]$ProjectRoot = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) {
  throw 'WPF regression tests require Windows PowerShell with -STA.'
}
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:Assertions = 0
$Preview = $true # Isolated Save-Prefs intentionally exercises full preview persistence.
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
  $script:Assertions++
}
function Assert-Equal($actual, $expected, [string]$message) {
  Assert-True ($actual -ceq $expected) "$message (expected '$expected', actual '$actual')"
}
function Assert-Near([double]$actual, [double]$expected, [string]$message) {
  Assert-True ([math]::Abs($actual - $expected) -lt 0.000001) "$message (expected '$expected', actual '$actual')"
}
function Get-FunctionText($ast, [string]$name) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if ($null -eq $node) { throw "Missing production function: $name" }
  return $node.Extent.Text
}

$petPath = Join-Path $ProjectRoot 'pet.ps1'
. (Join-Path $ProjectRoot 'companion-view.ps1')
foreach ($path in @($petPath, $PSCommandPath)) {
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) 'PowerShell source preserves UTF-8 BOM'
}
$tokens = $null; $errors = $null
$petAst = [Management.Automation.Language.Parser]::ParseFile($petPath, [ref]$tokens, [ref]$errors)
Assert-Equal $errors.Count 0 'pet source parses in Windows PowerShell 5.1'
$usageAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'usage-view.ps1'), [ref]$tokens, [ref]$errors)
Assert-Equal $errors.Count 0 'usage presentation source parses'
foreach ($variable in @('script:Prefs', 'script:Sizes')) {
  $node = $petAst.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq ('$' + $variable) }, $true)
  if ($null -eq $node) { throw "Missing literal initializer: $variable" }
  Invoke-Expression $node.Extent.Text
}
$sizeValidation = $petAst.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($script:Prefs.size -notin ') }, $true)
if ($null -eq $sizeValidation) { throw 'Missing production size preference validation' }
foreach ($size in @('tiny', 'small', 'medium', 'large')) {
  $script:Prefs.size = $size
  Invoke-Expression $sizeValidation.Extent.Text
  Assert-Equal $script:Prefs.size $size "saved $size preference remains valid"
}
foreach ($invalid in @('unknown', '', $null, 42)) {
  $script:Prefs.size = $invalid
  Invoke-Expression $sizeValidation.Extent.Text
  Assert-Equal $script:Prefs.size 'medium' 'invalid saved size falls back to medium'
}
Assert-Equal $script:Sizes.Count 4 'exactly four size scales exist'
Assert-Near $script:Sizes.tiny 0.625 'tiny uses the intended scale'
Assert-Near $script:Sizes.small 0.85 'old small scale is unchanged'
Assert-Near $script:Sizes.medium 1.0 'old medium scale is unchanged'
Assert-Near $script:Sizes.large 1.25 'old large scale is unchanged'
Assert-True ($script:Sizes.tiny / $script:Sizes.small -ge 0.70 -and $script:Sizes.tiny / $script:Sizes.small -le 0.75) 'tiny is 70-75 percent of old small'
foreach ($name in @('Save-Prefs', 'Set-PetSize', 'Format-Cost', 'Start-Event')) {
  Invoke-Expression (Get-FunctionText $petAst $name)
}
foreach ($name in @('Get-BillingMode', 'Format-QuotaPercent', 'Format-QuotaReset', 'Test-QuotaFresh', 'Get-QuotaStatus', 'Update-PetUsageCard', 'Refresh-BillingMode')) {
  Invoke-Expression (Get-FunctionText $usageAst $name)
}
# Motion is irrelevant to sizing; real Start-Event still creates and attaches its float.
function Start-EventMotion([double]$duration, [bool]$peak) { }
function Start-Track($target, $property, $duration, $times, $values) { }

$literal = $petAst.Find({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('<Window') }, $true)
if ($null -eq $literal) { throw 'Missing pet XAML literal' }
$script:Window = [Windows.Markup.XamlReader]::Parse($literal.Value)
foreach ($name in @('Root', 'Card', 'SpriteLayer', 'DeepSeekPanel', 'CodexPanel', 'QuotaStatus', 'Balance', 'Rate')) {
  Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name)
}
$viewbox = $script:Window.Content
Assert-True ($viewbox -is [Windows.Controls.Viewbox]) 'one Viewbox owns overall sizing'
Assert-True ([object]::ReferenceEquals($viewbox.Child, $script:Root)) 'shared Root is the Viewbox child'
Assert-Equal ([string]$viewbox.Stretch) 'Fill' 'shared Viewbox fills scaled window'
$script:Queue = New-Object 'System.Collections.Generic.Queue[object]'
$script:ActiveFloats = New-Object Collections.ArrayList
$script:LastPeak = $false
$script:LastSnapshot = [pscustomobject]@{
  balance = 12.34; balanceStatus = 'ready'; cacheHitRate = 0.5
  stats = [pscustomobject]@{ activityAt = 0 }
  codexStats = [pscustomobject]@{ activityAt = 0 }
  codex = [pscustomobject]@{ status = 'unsupported'; fiveHour = $null; weekly = $null }
}
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('DshPetSizeTest-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporaryDirectory)
$script:SettingsFile = Join-Path $temporaryDirectory 'settings.json'
$area = [Windows.SystemParameters]::WorkArea
function Assert-Persisted([string]$message) {
  $saved = Get-Content -LiteralPath $script:SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-Equal $saved.size $script:Prefs.size "$message saves size"
  Assert-Equal $saved.billingMode $script:Prefs.billingMode "$message saves billing mode"
  Assert-Near $saved.left ([math]::Round($script:Window.Left, 0)) "$message saves left"
  Assert-Near $saved.top ([math]::Round($script:Window.Top, 0)) "$message saves top"
  Assert-Equal @(Get-ChildItem -LiteralPath $temporaryDirectory -Filter '*.tmp').Count 0 "$message leaves no atomic-save temporary files"
}
function Assert-SharedScale([double]$scale) {
  $viewbox.Measure([Windows.Size]::new($script:Window.Width, $script:Window.Height))
  $viewbox.Arrange([Windows.Rect]::new(0, 0, $script:Window.Width, $script:Window.Height))
  $viewbox.UpdateLayout()
  foreach ($control in @($script:SpriteLayer, $script:Card, $script:ActiveFloats[0].control)) {
    Assert-True ($script:Root.Children.Contains($control)) 'sprite, card, and real float share Root'
    $transform = $control.TransformToAncestor($viewbox)
    $origin = $transform.Transform([Windows.Point]::new(0, 0))
    $unit = $transform.Transform([Windows.Point]::new(1, 1))
    Assert-Near ($unit.X - $origin.X) $scale 'shared horizontal scale applies to each element'
    Assert-Near ($unit.Y - $origin.Y) $scale 'shared vertical scale applies to each element'
  }
}
try {
  foreach ($mode in @('deepseek', 'codex')) {
    $script:Prefs.billingMode = $mode
    foreach ($size in @('tiny', 'small', 'medium', 'large')) {
      $script:Prefs.size = $size
      $script:Window.Left = $area.Left + 10
      $script:Window.Top = $area.Top + 10
      Update-PetUsageCard
      Set-PetSize
      $expectedScale = @{ tiny = 0.625; small = 0.85; medium = 1.0; large = 1.25 }[$size]
      $baseHeight = if ($mode -eq 'codex') { 360 } else { 296 }
      Assert-Near $script:Window.Width (272 * $expectedScale) "$mode/$size width"
      Assert-Near $script:Window.Height ($baseHeight * $expectedScale) "$mode/$size height"
      Assert-Near $script:Root.Width 272 'logical canvas width is unchanged'
      Assert-Near $script:Root.Height $baseHeight 'logical canvas height matches billing mode'
      Assert-Near $script:Card.Height $(if ($mode -eq 'codex') { 156 } else { 92 }) 'mode card height remains correct'
      Assert-Persisted "$mode/$size create-or-replace"
      foreach ($entry in $script:ActiveFloats) { $script:Root.Children.Remove($entry.control) }
      $script:ActiveFloats.Clear()
      Start-Event ([pscustomobject]@{ kind = 'output'; tokens = 100; cny = 0.001; billingMode = $mode }) ([DateTime]::UtcNow)
      Assert-Equal $script:ActiveFloats.Count 1 'real event creates a float without timers or model calls'
      Assert-SharedScale $expectedScale

      $script:Window.Left = $area.Left - 1000
      $script:Window.Top = $area.Top - 1000
      Set-PetSize
      Assert-Near $script:Window.Left $area.Left "$mode/$size clamps left edge"
      Assert-Near $script:Window.Top $area.Top "$mode/$size clamps top edge"
      Assert-Persisted "$mode/$size upper-left clamp"
      $script:Window.Left = $area.Right + 1000
      $script:Window.Top = $area.Bottom + 1000
      Set-PetSize
      Assert-Near $script:Window.Left ([math]::Max($area.Left, $area.Right - $script:Window.Width)) "$mode/$size clamps right edge"
      Assert-Near $script:Window.Top ([math]::Max($area.Top, $area.Bottom - $script:Window.Height)) "$mode/$size clamps bottom edge"
      Assert-Persisted "$mode/$size lower-right clamp"
    }
  }
  foreach ($size in @('tiny', 'small', 'medium', 'large')) {
    $script:Prefs.size = $size
    foreach ($mode in @('deepseek', 'codex', 'deepseek')) {
      $script:Prefs.billingMode = $mode
      $script:Window.Left = $area.Right - $script:Window.Width
      $script:Window.Top = $area.Bottom - $script:Window.Height
      Refresh-BillingMode
      $baseHeight = if ($mode -eq 'codex') { 360 } else { 296 }
      Assert-Near $script:Window.Width (272 * $script:Sizes[$size]) "$size switch to $mode preserves width"
      Assert-Near $script:Window.Height ($baseHeight * $script:Sizes[$size]) "$size switch to $mode resizes height"
      Assert-Equal ([string]$script:CodexPanel.Visibility) $(if ($mode -eq 'codex') { 'Visible' } else { 'Collapsed' }) 'mode switch updates panel'
      Assert-True ($script:Window.Left -ge $area.Left -and $script:Window.Top -ge $area.Top) 'mode switch respects left/top boundaries'
      Assert-True ($script:Window.Left + $script:Window.Width -le $area.Right -or $script:Window.Width -gt $area.Width) 'mode switch respects right boundary when window fits'
      Assert-True ($script:Window.Top + $script:Window.Height -le $area.Bottom -or $script:Window.Height -gt $area.Height) 'mode switch respects bottom boundary when window fits'
      Assert-Equal $script:ActiveFloats.Count 0 'mode switch clears previous floats'
      Assert-Persisted "$size real mode switch to $mode"
    }
  }
  Assert-True (-not $script:Window.IsVisible) 'isolated tests never show the pet window'
  Write-Host "PASS: $($script:Assertions) isolated native pet-size assertions (tiny/small/medium/large, both modes, shared scaling, all edges, atomic saves)."
  Write-Host 'Tiny: scale=0.625; old-small ratio=73.53%; DeepSeek=170x185; Codex=170x225.'
} finally {
  $script:Window.Close()
  # Resolve and verify the exact test-owned directory before removing it.
  $resolved = (Resolve-Path -LiteralPath $temporaryDirectory).Path
  if ($resolved -cne [IO.Path]::GetFullPath($temporaryDirectory) -or (Split-Path -Leaf $resolved) -notmatch '^DshPetSizeTest-[0-9a-f]{32}$') {
    throw 'Refusing cleanup outside the exact test-owned temporary directory.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
