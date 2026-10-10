# powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\pet-preferences.test.ps1
# AST-extracted production functions only: never launch pet, host, models, or accounts.
# All persistence is in one verified test-owned temporary directory; no real user data.
param([string]$ProjectRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) {
  throw 'WPF regression tests require Windows PowerShell with -STA.'
}
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:Assertions = 0
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
  $script:Assertions++
}
function Assert-Equal($actual, $expected, [string]$message) {
  Assert-True ($actual -ceq $expected) "$message (expected '$expected', actual '$actual')"
}
function Get-FunctionText($ast, [string]$name) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if ($null -eq $node) { throw "Missing production function: $name" }
  return $node.Extent.Text
}
$petPath = Join-Path $ProjectRoot 'pet.ps1'
. (Join-Path $ProjectRoot 'skin-catalog.ps1')
. (Join-Path $ProjectRoot 'card-themes.ps1')
. (Join-Path $ProjectRoot 'companion-view.ps1')
foreach ($path in @($petPath, $PSCommandPath)) {
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) 'owned PowerShell source preserves UTF-8 BOM'
}
$tokens = $null; $errors = $null
$petAst = [Management.Automation.Language.Parser]::ParseFile($petPath, [ref]$tokens, [ref]$errors)
Assert-Equal $errors.Count 0 'production source parses under Windows PowerShell 5.1'
$usageAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'usage-view.ps1'), [ref]$tokens, [ref]$errors)
Assert-Equal $errors.Count 0 'usage source parses'
foreach ($variable in @('script:Prefs', 'script:Sizes')) {
  $node = $petAst.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq ('$' + $variable) }, $true)
  Invoke-Expression $node.Extent.Text
}
foreach ($name in @('Set-PetPreferenceValues', 'Test-FinitePetCoordinate', 'Restore-PetPosition', 'Reload-PetPreferences', 'Save-Prefs', 'Set-PetSize')) {
  Invoke-Expression (Get-FunctionText $petAst $name)
}
foreach ($name in @('Get-BillingMode', 'Format-QuotaPercent', 'Format-QuotaReset', 'Test-QuotaFresh', 'Get-QuotaStatus', 'Update-PetUsageCard', 'Refresh-BillingMode')) {
  Invoke-Expression (Get-FunctionText $usageAst $name)
}
$script:ProductionRefresh = ${function:Refresh-BillingMode}
$script:RefreshCount = 0
function Refresh-BillingMode { $script:RefreshCount++; & $script:ProductionRefresh }
$script:ReadCount = 0
function Get-Content([string]$LiteralPath, [switch]$Raw, [string]$Encoding) {
  $script:ReadCount++
  Microsoft.PowerShell.Management\Get-Content -LiteralPath $LiteralPath -Raw:$Raw -Encoding $Encoding
}
$literal = $petAst.Find({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('<Window') }, $true)
$script:Window = [Windows.Markup.XamlReader]::Parse($literal.Value)
foreach ($name in @('Root', 'Card', 'SpriteLayer', 'DeepSeekPanel', 'CodexPanel', 'QuotaStatus', 'Balance', 'Rate')) {
  Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name)
}
$script:SkinCatalog = @([pscustomobject]@{ id = 'default' }, [pscustomobject]@{ id = 'test-skin' })
$script:Queue = New-Object 'System.Collections.Generic.Queue[object]'
$script:ActiveFloats = New-Object Collections.ArrayList
$script:LastSnapshot = [pscustomobject]@{
  balance = 12.34; balanceStatus = 'ready'; cacheHitRate = 0.5
  stats = [pscustomobject]@{ activityAt = 0 }; codexStats = [pscustomobject]@{ activityAt = 0 }
  codex = [pscustomobject]@{ status = 'unsupported'; fiveHour = $null; weekly = $null }
}
$script:ApplyingPetPreferences = $false
$script:NextPrefsReload = [DateTime]::MinValue
$script:PreferencesFileTicks = $null
$Preview = $false
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('DshPetPreferencesTest-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporaryDirectory)
$script:SettingsFile = Join-Path $temporaryDirectory 'settings.json'
$script:PositionFile = Join-Path $temporaryDirectory 'position.json'
$script:WriteCount = 0
function Write-External([string]$content) {
  [IO.File]::WriteAllText($script:SettingsFile, $content, [Text.UTF8Encoding]::new($false))
  $script:WriteCount++
  [IO.File]::SetLastWriteTimeUtc($script:SettingsFile, [DateTime]::UtcNow.AddSeconds($script:WriteCount))
}
function Assert-NoTemps([string]$message) {
  Assert-Equal @(Get-ChildItem -LiteralPath $temporaryDirectory -Filter '*.tmp').Count 0 $message
}
try {
  $script:Window.Left = 123.25; $script:Window.Top = 234.75
  $valid = '{"skin":"test-skin","unit":"token","size":"tiny","billingMode":"codex","codexUnit":"percent","codexQuotaRefreshSeconds":12,"sleepMinutes":25,"codexWarmupDaily":true,"codexWarmupTime":"07:05","codexWarmupReset":true,"codexWarmupStartup":true,"left":999,"top":888}'
  Write-External $valid
  $script:Queue.Enqueue([pscustomobject]@{ kind = 'output' })
  $float = New-Object Windows.Controls.TextBlock
  [void]$script:Root.Children.Add($float)
  [void]$script:ActiveFloats.Add([pscustomobject]@{ control = $float })
  Reload-PetPreferences -Force
  foreach ($pair in @(@('skin', 'test-skin'), @('unit', 'token'), @('size', 'tiny'), @('billingMode', 'codex'), @('codexUnit', 'percent'), @('codexQuotaRefreshSeconds', 12), @('sleepMinutes', 25), @('codexWarmupDaily', $true), @('codexWarmupTime', '07:05'), @('codexWarmupReset', $true), @('codexWarmupStartup', $true))) {
    Assert-Equal $script:Prefs[$pair[0]] $pair[1] "external $($pair[0]) applies"
  }
  Assert-Equal $script:RefreshCount 1 'billing mode uses production Refresh-BillingMode exactly once'
  Assert-Equal $script:Queue.Count 0 'mode transition clears queued events'
  Assert-Equal $script:ActiveFloats.Count 0 'mode transition clears old floats'
  Assert-True (-not $script:Root.Children.Contains($float)) 'mode transition detaches old float'
  Assert-Equal $script:Window.Width 170.0 'native tiny width applies'
  Assert-Equal $script:Window.Height 225.0 'native Codex tiny height applies'
  Assert-Equal $script:Window.Left 123.25 'mode and size change do not move left'
  Assert-Equal $script:Window.Top 234.75 'mode and size change do not move top'
  Assert-True (-not (Test-Path -LiteralPath $script:PositionFile)) 'reload does not save position'
  Assert-True (-not $script:ApplyingPetPreferences) 'resize suppression resets after refresh'
  Assert-Equal ([IO.File]::ReadAllText($script:SettingsFile)) $valid 'reload never rewrites host preferences'

  $reads = $script:ReadCount
  for ($i = 0; $i -lt 15; $i++) { Reload-PetPreferences }
  Assert-Equal $script:ReadCount $reads 'animation-frequency calls are throttled'
  $script:NextPrefsReload = [DateTime]::MinValue
  Reload-PetPreferences
  Assert-Equal $script:ReadCount $reads 'unchanged last-write ticks skip even an eligible read'
  Write-External ($valid.Replace('"tiny"', '"large"'))
  $script:NextPrefsReload = [DateTime]::MinValue
  Reload-PetPreferences
  Assert-Equal $script:ReadCount ($reads + 1) 'external changed ticks trigger a single read'
  Assert-Equal $script:RefreshCount 1 'size-only change does not refresh billing mode'
  Assert-Equal $script:Window.Width 340.0 'size-only reload invokes production Set-PetSize'
  Assert-Equal $script:Window.Left 123.25 'size-only change preserves exact left'
  Assert-Equal $script:Window.Top 234.75 'size-only change preserves exact top'

  foreach ($badJson in @('{broken', '', 'null', '[]', '[{}]', 'true', '"string"')) {
    Write-External $valid
    Reload-PetPreferences -Force
    Write-External $badJson
    Reload-PetPreferences -Force
    Assert-Equal $script:Prefs.skin 'test-skin' 'malformed JSON preserves last-known skin'
    Assert-Equal $script:Prefs.billingMode 'codex' 'malformed JSON preserves last-known mode'
    Assert-Equal $script:Prefs.size 'tiny' 'malformed JSON preserves last-known size'
    foreach ($key in @('codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup')) {
      Assert-Equal $script:Prefs[$key] $false "malformed JSON fails closed for $key"
    }
  }
  foreach ($time in @('7:05', '24:00', '09:60', "09:30`n", ' 09:30', '09:30 ', '０９:３０', '', $null, 930)) {
    Write-External (@{ codexWarmupDaily = $true; codexWarmupTime = $time } | ConvertTo-Json -Compress)
    Reload-PetPreferences -Force
    Assert-Equal $script:Prefs.codexWarmupDaily $false 'invalid exact HH:mm disables daily warmup'
    Assert-Equal $script:Prefs.codexWarmupTime '09:30' 'invalid exact HH:mm uses safe display default'
  }
  foreach ($time in @('00:00', '09:30', '23:59')) {
    Write-External (@{ codexWarmupDaily = $true; codexWarmupTime = $time } | ConvertTo-Json -Compress)
    Reload-PetPreferences -Force
    Assert-Equal $script:Prefs.codexWarmupDaily $true 'valid exact HH:mm accepts typed daily boolean'
    Assert-Equal $script:Prefs.codexWarmupTime $time 'valid HH:mm remains unchanged'
  }
  foreach ($bad in @('true', 1, 0, @($true), @{ value = $true })) {
    Write-External (@{ codexWarmupDaily = $bad; codexWarmupReset = $bad; codexWarmupStartup = $bad; codexWarmupTime = '09:30' } | ConvertTo-Json -Depth 4 -Compress)
    Reload-PetPreferences -Force
    foreach ($key in @('codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup')) {
      Assert-Equal $script:Prefs[$key] $false "non-boolean $key fails closed"
    }
  }
  Write-External '{"skin":["default"],"unit":true,"size":42,"billingMode":{},"codexUnit":"bad","sleepMinutes":"20","codexQuotaRefreshSeconds":"5"}'
  Reload-PetPreferences -Force
  foreach ($pair in @(@('skin', 'default'), @('unit', 'cny'), @('size', 'medium'), @('billingMode', 'deepseek'), @('codexUnit', 'token'), @('sleepMinutes', 10), @('codexQuotaRefreshSeconds', 5))) {
    Assert-Equal $script:Prefs[$pair[0]] $pair[1] 'invalid typed fields use defaults'
  }
  foreach ($seconds in @(0, 3601, 2.5, $null)) {
    Write-External (@{ codexQuotaRefreshSeconds = $seconds } | ConvertTo-Json -Compress)
    Reload-PetPreferences -Force
    Assert-Equal $script:Prefs.codexQuotaRefreshSeconds 5 'quota out-of-range or fractional value defaults'
  }
  foreach ($seconds in @(1, 3600)) {
    Write-External (@{ codexQuotaRefreshSeconds = $seconds } | ConvertTo-Json -Compress)
    Reload-PetPreferences -Force
    Assert-Equal $script:Prefs.codexQuotaRefreshSeconds $seconds 'quota boundary is accepted'
  }
  foreach ($pair in @(@(-1, 1), @(999, 240), @([long]::MaxValue, 240), @(2.5, 10))) {
    Write-External (@{ sleepMinutes = $pair[0] } | ConvertTo-Json -Compress)
    Reload-PetPreferences -Force
    Assert-Equal $script:Prefs.sleepMinutes $pair[1] 'sleep is integer-typed and safely clamped'
  }

  # Startup fallback is isolated from hot reload and does not source runtime code.
  Restore-PetPosition ([pscustomobject]@{ left = -12.5; top = 46 })
  Assert-Equal $script:Prefs.left -12.5 'legacy left restores without position file'
  Assert-Equal $script:Prefs.top 46.0 'legacy top restores without position file'
  [IO.File]::WriteAllText($script:PositionFile, '{"left":101.25,"top":202.5}')
  Restore-PetPosition ([pscustomobject]@{ left = 1; top = 2 })
  Assert-Equal $script:Prefs.left 101.25 'dedicated position wins on startup'
  Assert-Equal $script:Prefs.top 202.5 'dedicated top wins on startup'
  [IO.File]::WriteAllText($script:PositionFile, '{"left":"101","top":false}')
  Restore-PetPosition ([pscustomobject]@{ left = 1; top = 2 })
  Assert-Equal $script:Prefs.left 1.0 'non-numeric position falls back to legacy left'
  Assert-Equal $script:Prefs.top 2.0 'boolean position falls back to legacy top'
  [IO.File]::WriteAllText($script:PositionFile, '{broken')
  Restore-PetPosition ([pscustomobject]@{ left = '1'; top = [double]::NaN })
  Assert-Equal $script:Prefs.left $null 'invalid legacy coordinate remains unset'
  Assert-Equal $script:Prefs.top $null 'nonfinite legacy coordinate remains unset'
  foreach ($bad in @([double]::NaN, [double]::PositiveInfinity, [double]::NegativeInfinity, '5', $true, $null)) {
    Assert-True (-not (Test-FinitePetCoordinate $bad)) 'coordinate validator rejects nonfinite/non-numeric values'
  }
  foreach ($good in @(0, -5, [long]100, 2.25, [decimal]1.2)) {
    Assert-True (Test-FinitePetCoordinate $good) 'coordinate validator accepts finite numbers'
  }

  $script:LegacySettingsFile = Join-Path $temporaryDirectory 'legacy-settings.json'
  [IO.File]::WriteAllText($script:LegacySettingsFile, '{"left":81.25,"top":92.5,"skin":"ignored-legacy"}')
  Restore-PetPosition ([pscustomobject]@{})
  Assert-Equal $script:Prefs.left 81.25 'host-stripped left falls back to old settings file'
  Assert-Equal $script:Prefs.top 92.5 'host-stripped top falls back to old settings file'
  Assert-True ($script:Prefs.skin -ne 'ignored-legacy') 'legacy coordinate fallback does not import old preferences'
  [IO.File]::WriteAllText($script:PositionFile, '{"left":13,"top":14}')
  Restore-PetPosition ([pscustomobject]@{})
  Assert-Equal $script:Prefs.left 13.0 'position left wins over old settings fallback'
  Assert-Equal $script:Prefs.top 14.0 'position top wins over old settings fallback'

  Write-External $valid
  # Use a second test-owned path to exercise both creation and atomic replacement.
  $script:PositionFile = Join-Path $temporaryDirectory 'position-save.json'
  $globalBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:SettingsFile))
  $globalTicks = (Get-Item -LiteralPath $script:SettingsFile).LastWriteTimeUtc.Ticks
  $script:Window.Left = 321.2; $script:Window.Top = 432.8
  for ($i = 0; $i -lt 4; $i++) {
    Save-Prefs
    $position = [IO.File]::ReadAllText($script:PositionFile) | ConvertFrom-Json
    Assert-Equal @($position.PSObject.Properties).Count 2 'normal save contains only two coordinate keys'
    Assert-Equal $position.left 321 'normal left is rounded'
    Assert-Equal $position.top 433 'normal top is rounded'
    Assert-Equal ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:SettingsFile))) $globalBytes 'normal save never changes host preference bytes'
    Assert-Equal (Get-Item -LiteralPath $script:SettingsFile).LastWriteTimeUtc.Ticks $globalTicks 'normal save never changes host preference ticks'
    Assert-NoTemps 'successful atomic replace cleans unique temporary files'
  }
  # Failure after writing the temporary must also clean it and preserve destination.
  $lock = [IO.File]::Open($script:PositionFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  $failed = $false
  try { Save-Prefs } catch { $failed = $true } finally { $lock.Dispose() }
  Assert-True $failed 'locked destination exercises failed atomic replace'
  Assert-NoTemps 'failed atomic replace removes unique temporary file'
  Assert-Equal ([IO.File]::ReadAllText($script:PositionFile) | ConvertFrom-Json).left 321 'failed replace preserves old position'

  $script:SettingsFile = Join-Path $temporaryDirectory 'missing-globalsettings.json'
  $script:Prefs.skin = 'test-skin'
  $script:Prefs.codexWarmupDaily = $true; $script:Prefs.codexWarmupReset = $true; $script:Prefs.codexWarmupStartup = $true
  Reload-PetPreferences -Force
  Assert-Equal $script:Prefs.skin 'test-skin' 'missing settings preserve last-known visual preference'
  foreach ($key in @('codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup')) {
    Assert-Equal $script:Prefs[$key] $false "missing settings fail closed for $key"
  }
  Save-Prefs
  Assert-True (-not (Test-Path -LiteralPath $script:SettingsFile)) 'normal save never creates absent global preferences'
  Assert-NoTemps 'normal save with absent global file cleans atomic temporary'

  $Preview = $true
  $script:SettingsFile = Join-Path $temporaryDirectory 'settings-preview.json'
  $script:Prefs.skin = 'test-skin'; $script:Prefs.size = 'tiny'; $script:Prefs.codexWarmupTime = '08:15'
  $before = $script:ReadCount
  Reload-PetPreferences -Force
  Assert-Equal $script:ReadCount $before 'preview never reloads host preferences'
  for ($i = 0; $i -lt 2; $i++) {
    Save-Prefs
    $saved = [IO.File]::ReadAllText($script:SettingsFile) | ConvertFrom-Json
    Assert-Equal @($saved.PSObject.Properties).Count $script:Prefs.Count 'preview saves full preferences'
    Assert-Equal $saved.skin 'test-skin' 'preview saves skin'
    Assert-Equal $saved.size 'tiny' 'preview saves size'
    Assert-Equal $saved.codexWarmupTime '08:15' 'preview saves warmup preferences'
    Assert-Equal $saved.left 321 'preview saves coordinates too'
    Assert-NoTemps 'preview create-and-replace clean temporary files'
  }

  # Evaluate only the explicit developer-preview loader. No right-click interaction.
  $menuBranch = $petAst.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.Contains("'settings-window.ps1'") }, $true)
  Assert-True ($null -ne $menuBranch) 'legacy UI loader is explicitly guarded'
  Assert-Equal $menuBranch.Clauses[0].Item1.Extent.Text '$Preview -and $PreviewSettings' 'only explicit PreviewSettings loads legacy UI'
  Assert-True (-not ($petAst.Extent.Text -match '\.Add_(?:Preview)?MouseRightButton(?:Up|Down)\b')) 'no right-button popup handler is registered'
  Assert-True (-not ($petAst.Extent.Text -match 'Windows\.Controls\.(ContextMenu|MenuItem)\b|\.ContextMenu\s*=')) 'no context menu or exit menu is created'
  $PreviewSettings = $false
  foreach ($Preview in @($false, $true)) {
    Invoke-Expression $menuBranch.Extent.Text
    Assert-True ($null -eq $script:Window.ContextMenu) "window has no right-click menu (Preview=$Preview)"
    Assert-True ($null -eq $script:Card.ContextMenu) "card has no right-click menu (Preview=$Preview)"
    Assert-True ($null -eq $script:SpriteLayer.ContextMenu) "sprite has no right-click menu (Preview=$Preview)"
  }
  $timer = $petAst.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Extent.Text.StartsWith('$script:Timer.Add_Tick(') }, $true)
  Assert-True ($timer.Extent.Text -match 'Reload-PetPreferences\s+Read-PetState') 'normal timer reloads before reading state'
  $previewLaunch = $petAst.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($Preview -and $PreviewSettings)') }, $true)
  Assert-True ($null -ne $previewLaunch) 'PreviewSettings cannot open old settings in normal mode'
  Assert-True (-not $script:Window.IsVisible) 'test never displays the native pet'
  Write-Host "PASS: $($script:Assertions) isolated native pet-preferences assertions (external reload, typed defaults, warmup fail-closed, positions, atomic saves, Preview-only legacy UI)."
} finally {
  if ($null -ne $script:Window -and -not $script:ExitCalled) { $script:Window.Close() }
  $resolved = (Resolve-Path -LiteralPath $temporaryDirectory).Path
  if ($resolved -cne [IO.Path]::GetFullPath($temporaryDirectory) -or (Split-Path -Leaf $resolved) -notmatch '^DshPetPreferencesTest-[0-9a-f]{32}$') {
    throw 'Refusing cleanup outside the exact test-owned temporary directory.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
