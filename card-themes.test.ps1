# Run only this new feature test: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\card-themes.test.ps1
# Production AST + hidden real WPF XAML; never source pet startup or use real preferences.
param([string]$ProjectRoot = $PSScriptRoot, [string]$CapturePath = '')
$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) { throw 'Card theme tests require Windows PowerShell with -STA.' }
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:Assertions = 0
$script:MatrixCases = 0
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
function Get-Assignment($ast, [string]$name) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq ('$script:' + $name) }, $true)
  if ($null -eq $node) { throw "Missing production assignment: $name" }
  return $node.Extent.Text
}
$asts = @{}
foreach ($name in @('pet.ps1', 'usage-view.ps1', 'card-themes.ps1', 'card-themes.test.ps1')) {
  $path = Join-Path $ProjectRoot $name
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) "$name retains UTF-8 BOM for PS 5.1"
  $tokens = $null; $errors = $null
  $asts[$name] = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Assert-Equal $errors.Count 0 "$name parses in Windows PowerShell 5.1"
}
$petAst = $asts['pet.ps1']
$script:Window = $null
. (Join-Path $ProjectRoot 'skin-catalog.ps1')
. (Join-Path $ProjectRoot 'card-themes.ps1')
Assert-Equal ($script:CardThemeCatalog.id -join ',') 'default,forest,amber,violet,paper' 'five canonical ids'
Assert-Equal $script:CardThemeCatalog[1].name '苔庭墨绿' 'BOM-less canonical Chinese names decode as UTF-8'
Update-PetCardTheme $true
Assert-Equal $script:AppliedCardThemeKey $null 'theme update is safe before window creation'
$loadNode = $petAst.Find({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text -match "ProjectRoot 'card-themes.ps1'" }, $true)
$prefNode = $petAst.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Set-PetPreferenceValues' }, $true)
Assert-True ($null -ne $loadNode -and $loadNode.Extent.StartOffset -lt $prefNode.Extent.StartOffset) 'catalogue loads before startup preference validation'
foreach ($name in @('Prefs', 'Sizes', 'Cells')) { Invoke-Expression (Get-Assignment $petAst $name) }
foreach ($name in @('Set-PetPreferenceValues', 'Reload-PetPreferences', 'Save-Prefs', 'Set-PetSize', 'Set-ModeVisual', 'Start-Track', 'Start-EventMotion', 'Get-Frame')) {
  Invoke-Expression (Get-FunctionText $petAst $name)
}
foreach ($name in @('Get-BillingMode', 'Format-QuotaPercent', 'Format-QuotaReset', 'Test-QuotaFresh', 'Get-QuotaStatus', 'Update-PetUsageCard', 'Refresh-BillingMode')) {
  Invoke-Expression (Get-FunctionText $asts['usage-view.ps1'] $name)
}
# Freeze only the clock choice, not production preference/visual functions.
$script:TestPeak = $false
function Get-Peak { return $script:TestPeak }
$script:ProductionTheme = ${function:Update-PetCardTheme}
$script:ThemeCalls = 0
function Update-PetCardTheme([bool]$peak) { $script:ThemeCalls++; & $script:ProductionTheme $peak }
$literal = $petAst.Find({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('<Window') }, $true)
if ($null -eq $literal) { throw 'Missing production XAML.' }
$script:Window = [Windows.Markup.XamlReader]::Parse($literal.Value)
$script:Window.ShowActivated = $false
$script:Window.ShowInTaskbar = $false
$script:Window.Left = 123.25; $script:Window.Top = 234.75
foreach ($name in @('Root', 'Card', 'CardHeader', 'Sprite', 'SpriteLayer', 'DeepSeekPanel', 'CodexPanel', 'QuotaStatus', 'Balance', 'Rate', 'PriceBadge', 'CriticalMark', 'SleepMark')) {
  Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name)
}
$script:ModeLabel = $script:Window.FindName('Mode')
$script:Scale = [Windows.Media.ScaleTransform]::new()
$script:Rotate = [Windows.Media.RotateTransform]::new()
$script:Move = [Windows.Media.TranslateTransform]::new()
$script:BalanceScale = [Windows.Media.ScaleTransform]::new()
$script:Queue = New-Object 'Collections.Generic.Queue[object]'
$script:ActiveFloats = New-Object Collections.ArrayList
$script:Frames = @{}; $script:Atlases = @{}
foreach ($skin in $script:SkinCatalog.id) {
  foreach ($mode in @('valley', 'peak')) {
    $bitmap = New-Object Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit()
    $bitmap.UriSource = [uri](Join-Path $ProjectRoot "assets/$skin-$mode.png")
    $bitmap.CacheOption = 'OnLoad'; $bitmap.EndInit(); $bitmap.Freeze()
    $script:Atlases["$skin-$mode"] = $bitmap
  }
}
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:LastSnapshot = [pscustomobject]@{
  balance = 12.34; balanceStatus = 'ready'; cacheHitRate = 0.84
  stats = [pscustomobject]@{ activityAt = 0 }; codexStats = [pscustomobject]@{ activityAt = 0 }
  codex = [pscustomobject]@{
    status = 'ready'; observedAt = $nowMs; accountKey = 'test-fixture'
    fiveHour = [pscustomobject]@{ remainingPercent = 68; resetAt = $nowMs + 18000000 }
    weekly = [pscustomobject]@{ remainingPercent = 91; resetAt = $nowMs + 604800000 }
  }
}
$script:ApplyingPetPreferences = $true
$script:FlashEnd = [DateTime]::MaxValue
$Preview = $false
$script:NextPrefsReload = [DateTime]::MinValue
$script:PreferencesFileTicks = $null
$script:LastPeak = $false
# Geometry signature deliberately excludes only Card/Root's documented mode height.
[xml]$xml = $literal.Value
$geometry = @()
foreach ($node in $xml.SelectNodes('//*[@Name]')) {
  $properties = @()
  foreach ($property in @('Width', 'Height', 'Canvas.Left', 'Canvas.Top', 'FontSize')) {
    if (($node.Name -in @('Card', 'Root')) -and $property -eq 'Height') { continue }
    if ($node.HasAttribute($property)) { $properties += [pscustomobject]@{ key = $property; value = [double]$node.GetAttribute($property) } }
  }
  $geometry += [pscustomobject]@{ name = $node.GetAttribute('Name'); properties = $properties }
}
function Assert-Geometry([string]$mode, [string]$size) {
  foreach ($entry in $geometry) {
    $control = $script:Window.FindName($entry.name)
    foreach ($property in $entry.properties) {
      $actual = switch ($property.key) {
        'Canvas.Left' { [Windows.Controls.Canvas]::GetLeft($control) }
        'Canvas.Top' { [Windows.Controls.Canvas]::GetTop($control) }
        default { $control.($property.key) }
      }
      Assert-Equal $actual $property.value "$($entry.name) $($property.key) unchanged"
    }
  }
  $height = if ($mode -eq 'codex') { 360 } else { 296 }
  Assert-Equal $script:Root.Height $height 'native root mode height preserved'
  Assert-Equal $script:Card.Height $(if ($mode -eq 'codex') { 156 } else { 92 }) 'native card mode height preserved'
  Assert-Equal $script:Window.Width (272 * $script:Sizes[$size]) 'four-size window width preserved'
  Assert-Equal $script:Window.Height ($height * $script:Sizes[$size]) 'four-size window height preserved'
  Assert-Equal $script:Window.Left 123.25 'theme and suppressed size application preserve left'
  Assert-Equal $script:Window.Top 234.75 'theme and suppressed size application preserve top'
}
function Color-String([string]$value) { return [Windows.Media.ColorConverter]::ConvertFromString($value).ToString() }
function Assert-Brush($brush, [string]$value, [string]$message) { Assert-Equal $brush.Color.ToString() (Color-String $value) $message }
function Assert-Palette($theme, [string]$mode, [bool]$peak) {
  # Expected values come straight from canonical data, not from the production resolver.
  $palette = @{}
  foreach ($property in $theme.$mode.PSObject.Properties) { $palette[$property.Name] = $property.Value }
  if ($mode -eq 'deepseek' -and $peak) {
    foreach ($property in $theme.peak.PSObject.Properties) { $palette[$property.Name] = $property.Value }
  }
  Assert-Equal $script:Card.Background.GradientStops[0].Color.ToString() (Color-String $palette.start) 'actual gradient start'
  Assert-Equal $script:Card.Background.GradientStops[1].Color.ToString() (Color-String $palette.end) 'actual gradient end'
  Assert-Brush $script:Card.BorderBrush $palette.border 'actual border'
  Assert-Brush $script:CardBaseBorder $palette.border 'flash restoration base follows theme'
  Assert-Equal $script:Card.CornerRadius.TopLeft ([double]$palette.radius) 'theme radius'
  Assert-Equal $script:Card.Effect.Color.ToString() (Color-String $palette.shadow) 'theme shadow'
  foreach ($name in @('CardHeader', 'CodexHeader', 'FiveHourLabel', 'WeeklyLabel', 'QuotaStatus', 'FiveHourReset', 'WeeklyReset')) {
    Assert-Brush $script:Window.FindName($name).Foreground $palette.muted "$name muted text"
  }
  Assert-Brush $script:Balance.Foreground $palette.text 'balance main text'
  Assert-Brush $script:Rate.Foreground $palette.accent 'rate accent'
  Assert-Brush $script:ModeLabel.Foreground $palette.badgeText 'badge text'
  Assert-Brush $script:PriceBadge.Background $palette.badge 'badge background'
  Assert-Brush $script:Window.FindName('BalanceDivider').Background $palette.divider 'balance divider'
  foreach ($prefix in @('FiveHour', 'Weekly')) {
    $expected = if ($prefix -eq 'FiveHour') { $palette.accent } else { $palette.secondary }
    Assert-Brush $script:Window.FindName("${prefix}Value").Foreground $expected "$prefix value accent"
    Assert-Brush $script:Window.FindName("${prefix}Bar").Foreground $expected "$prefix progress accent"
    Assert-Brush $script:Window.FindName("${prefix}Bar").Background $palette.track "$prefix progress track"
  }
  if ($theme.id -in @('forest', 'paper')) {
    $originalBlue = @('#FFFFFFFF', '#FFC8EFFF', '#FFA8EEFF', '#FF95E8FF', '#FFD8F7FF', '#FFABD2E3', '#FF7DE9FF', '#FFA9CEE2', '#FFB7ABFF')
    foreach ($panel in @($script:DeepSeekPanel, $script:CodexPanel)) {
      foreach ($control in $panel.Children) {
        if ($control -is [Windows.Controls.TextBlock]) { Assert-True ($control.Foreground.Color.ToString() -cnotin $originalBlue) 'forest/paper contains no original blue/white card text' }
      }
    }
    Assert-True ($script:ModeLabel.Foreground.Color.ToString() -cnotin $originalBlue) 'forest/paper nested badge contains no original text'
  }
}
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('DshPetCardThemesTest-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporaryDirectory)
$script:SettingsFile = Join-Path $temporaryDirectory 'settings.json'
$script:PositionFile = Join-Path $temporaryDirectory 'position.json'
$script:WriteCount = 0
function Write-External($saved) {
  $content = $saved | ConvertTo-Json -Depth 8 -Compress
  [IO.File]::WriteAllText($script:SettingsFile, $content, [Text.UTF8Encoding]::new($false))
  $script:WriteCount++
  [IO.File]::SetLastWriteTimeUtc($script:SettingsFile, [DateTime]::UtcNow.AddSeconds($script:WriteCount))
  return $content
}
function Invoke-ProductionFlashEnd {
  $node = $petAst.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq '$now -ge $script:FlashEnd' }, $true)
  if ($null -eq $node) { throw 'Missing production flash restoration.' }
  $now = $script:FlashEnd.AddMilliseconds(1)
  Invoke-Expression $node.Extent.Text
}
function Save-ContactSheet([string]$path) {
  $drawing = [Windows.Media.DrawingVisual]::new()
  $context = $drawing.RenderOpen()
  try {
    $context.DrawRectangle([Windows.Media.Brushes]::WhiteSmoke, $null, [Windows.Rect]::new(0, 0, 1440, 792))
    $column = 0
    foreach ($theme in $script:CardThemeCatalog) {
      $row = 0
      foreach ($mode in @('deepseek', 'codex')) {
        Set-PetPreferenceValues ([pscustomobject]@{ skin = 'default'; cardTheme = $theme.id; billingMode = $mode; size = 'medium' })
        $script:ApplyingPetPreferences = $true
        Update-PetUsageCard; Set-PetSize; Set-ModeVisual $false
        $script:Sprite.Source = Get-Frame 'default' 'valley' 'idle'
        $script:Root.Measure([Windows.Size]::new(272, $script:Root.Height))
        $script:Root.Arrange([Windows.Rect]::new(0, 0, 272, $script:Root.Height))
        $script:Root.UpdateLayout()
        $image = [Windows.Media.Imaging.RenderTargetBitmap]::new(272, [int]$script:Root.Height, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
        $image.Render($script:Root)
        $label = [Windows.Media.FormattedText]::new(($theme.name + ' / ' + $mode), [Globalization.CultureInfo]::InvariantCulture, [Windows.FlowDirection]::LeftToRight, [Windows.Media.Typeface]::new('Microsoft YaHei'), 12, [Windows.Media.Brushes]::Black)
        $context.DrawText($label, [Windows.Point]::new($column * 288 + 8, $row * 396 + 5))
        $context.DrawImage($image, [Windows.Rect]::new($column * 288 + 8, $row * 396 + 28, 272, $script:Root.Height))
        $row++
      }
      $column++
    }
  } finally { $context.Close() }
  $sheet = [Windows.Media.Imaging.RenderTargetBitmap]::new(1440, 792, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $sheet.Render($drawing)
  $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($sheet))
  $stream = [IO.File]::Create($path)
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
}
try {
  $catalogueBefore = $script:CardThemeCatalog | ConvertTo-Json -Depth 8 -Compress
  foreach ($theme in $script:CardThemeCatalog) {
    foreach ($mode in @('deepseek', 'codex')) {
      foreach ($skin in $script:SkinCatalog.id) {
        foreach ($size in @('tiny', 'small', 'medium', 'large')) {
          foreach ($peak in @($false, $true)) {
            Set-PetPreferenceValues ([pscustomobject]@{ skin = $skin; cardTheme = $theme.id; billingMode = $mode; size = $size })
            $script:Sprite.Source = Get-Frame $skin $(if ($mode -eq 'deepseek' -and $peak) { 'peak' } else { 'valley' }) 'idle'
            $spriteBefore = $script:Sprite.Source
            $script:ApplyingPetPreferences = $true
            Update-PetUsageCard; Set-PetSize; Set-ModeVisual $peak
            Assert-Equal $script:Prefs.skin $skin 'theme never changes chosen character'
            Assert-True ([object]::ReferenceEquals($spriteBefore, $script:Sprite.Source)) 'theme never swaps sprite image'
            Assert-Equal $script:ModeLabel.Text $(if ($peak) { '☀ 峰值价' } else { '☾ 谷时价' }) 'DeepSeek peak/valley label remains unchanged'
            Assert-Equal ([string]$script:CodexPanel.Visibility) $(if ($mode -eq 'codex') { 'Visible' } else { 'Collapsed' }) 'mode-specific layout remains unchanged'
            Assert-Palette $theme $mode $peak
            Assert-Geometry $mode $size
            $script:MatrixCases++
          }
        }
      }
    }
  }
  Assert-Equal $script:MatrixCases 480 'five themes x two modes x six skins x four sizes x two peak choices'
  Assert-Equal ($script:CardThemeCatalog | ConvertTo-Json -Depth 8 -Compress) $catalogueBefore 'peak resolver never mutates canonical palettes'
  # Default must retain the exact pre-theme blue/peak colour behavior.
  Set-PetPreferenceValues ([pscustomobject]@{ cardTheme = 'default'; billingMode = 'deepseek' })
  Set-ModeVisual $false
  Assert-Brush $script:Card.BorderBrush '#91DFFA' 'original valley border retained'
  Assert-Brush $script:Rate.Foreground '#95E8FF' 'original valley rate retained'
  Set-ModeVisual $true
  Assert-Brush $script:Card.BorderBrush '#FFD184' 'original peak border retained'
  Assert-Brush $script:Rate.Foreground '#FFE1A8' 'original peak rate retained'
  # Ill-typed/missing/unknown values fallback independently of skin.
  $badValues = @($null, '', 'unknown', 'Forest', 1, $true, @('forest'), @{ value = 'forest' })
  foreach ($bad in $badValues) {
    Set-PetPreferenceValues ([pscustomobject]@{ skin = 'mint'; cardTheme = $bad })
    Assert-Equal $script:Prefs.cardTheme 'default' 'typed theme validation falls back to default'
    Assert-Equal $script:Prefs.skin 'mint' 'invalid theme does not reset valid skin'
    Set-ModeVisual $false
    Assert-Brush $script:Card.BorderBrush '#91DFFA' 'invalid theme really renders default'
  }
  Set-PetPreferenceValues ([pscustomobject]@{ skin = 'snow' })
  Assert-Equal $script:Prefs.cardTheme 'default' 'omitted theme uses default'
  $script:Prefs.cardTheme = 'no-such-theme'
  Update-PetCardTheme $false
  Assert-Brush $script:Card.BorderBrush '#91DFFA' 'renderer itself safely resolves unknown theme'
  # Real event border survives a theme update; production timer restores the new base.
  Set-PetPreferenceValues ([pscustomobject]@{ skin = 'cherry'; cardTheme = 'forest' })
  Set-ModeVisual $false
  $script:Current = 'hit'
  Start-EventMotion 580 $false
  $script:FlashEnd = [DateTime]::UtcNow.AddMinutes(1)
  $flash = $script:Card.BorderBrush
  $script:Prefs.cardTheme = 'paper'
  Set-ModeVisual $false
  Assert-True ([object]::ReferenceEquals($flash, $script:Card.BorderBrush)) 'theme change preserves active event flash'
  Assert-Brush $script:CardBaseBorder '#8C9E96' 'theme change updates flash restoration base'
  Invoke-ProductionFlashEnd
  Assert-Brush $script:Card.BorderBrush '#8C9E96' 'production timer restores newly selected border'
  Assert-Equal $script:FlashEnd ([DateTime]::MaxValue) 'flash completion sentinel unchanged'
  $background = $script:Card.Background
  Update-PetCardTheme $false
  Assert-True ([object]::ReferenceEquals($background, $script:Card.Background)) 'same palette reuses background without reallocating'
  $script:Card.BorderBrush = [Windows.Media.Brushes]::Salmon
  Update-PetCardTheme $false
  Assert-Brush $script:Card.BorderBrush 'Salmon' 'same palette does not overwrite an event border'
  $script:Card.BorderBrush = $script:CardBaseBorder
  # Actual disk hot reload into WPF, not a mocked update function; temp files only.
  $script:Prefs.skin = 'star'; $script:Prefs.billingMode = 'deepseek'; $script:LastPeak = $false
  $script:TestPeak = $false
  $content = Write-External ([ordered]@{ skin = 'star'; cardTheme = 'forest'; billingMode = 'deepseek'; size = 'medium'; left = 999; top = 888 })
  $calls = $script:ThemeCalls
  Reload-PetPreferences -Force
  Assert-True ($script:ThemeCalls -gt $calls) 'theme-only reload really invokes renderer without peak transition'
  Assert-Equal $script:LastPeak $false 'theme-only reload does not require changing LastPeak'
  Assert-Equal $script:Prefs.cardTheme 'forest' 'external theme preference applies'
  Assert-Equal $script:Prefs.skin 'star' 'external theme preserves chosen skin'
  Assert-Brush $script:Card.BorderBrush '#91BFA2' 'hot reload actual forest border'
  Assert-Equal ([IO.File]::ReadAllText($script:SettingsFile, [Text.Encoding]::UTF8)) $content 'hot reload never rewrites host preferences'
  Assert-True (-not (Test-Path -LiteralPath $script:PositionFile)) 'hot reload does not save position'
  $calls = $script:ThemeCalls
  for ($i = 0; $i -lt 15; $i++) { Reload-PetPreferences }
  Assert-Equal $script:ThemeCalls $calls 'one-second reload throttle prevents repeated theme calls'
  Assert-True (($script:NextPrefsReload - [DateTime]::UtcNow).TotalSeconds -le 1) 'reload cadence stays one second'
  $script:NextPrefsReload = [DateTime]::MinValue
  Reload-PetPreferences
  Assert-Equal $script:ThemeCalls $calls 'unchanged preference timestamp skips theme apply'
  $script:TestPeak = $true
  [void](Write-External ([ordered]@{ skin = 'star'; cardTheme = 'paper'; billingMode = 'deepseek'; size = 'medium' }))
  $script:NextPrefsReload = [DateTime]::MinValue
  Reload-PetPreferences
  Assert-Brush $script:Card.BorderBrush '#AB9271' 'theme hot reload respects current DeepSeek peak'
  [void](Write-External ([ordered]@{ skin = 'star'; cardTheme = 'paper'; billingMode = 'codex'; size = 'medium' }))
  $calls = $script:ThemeCalls
  Reload-PetPreferences -Force
  Assert-True ($script:ThemeCalls -gt $calls) 'billing mode refresh invokes theme immediately'
  Assert-Brush $script:Card.BorderBrush '#8D9EAA' 'Codex switch uses its palette, never DeepSeek peak override'
  Assert-Equal $script:Window.Height 360 'mode refresh preserves Codex geometry'
  Assert-Equal $script:Window.Left 123.25 'mode/theme hot reload preserves left'
  Assert-Equal $script:Window.Top 234.75 'mode/theme hot reload preserves top'
  [void](Write-External ([ordered]@{ skin = 'star'; cardTheme = @('forest'); billingMode = 'codex'; size = 'medium' }))
  Reload-PetPreferences -Force
  Assert-Equal $script:Prefs.cardTheme 'default' 'disk singleton array is rejected, not string-coerced'
  Assert-Brush $script:Card.BorderBrush '#91DFFA' 'disk ill-typed theme actually resets to default palette'
  # Local developer Preview save carries cardTheme; normal writer stays position-only.
  $Preview = $true
  $script:Prefs.cardTheme = 'violet'
  Save-Prefs
  $saved = [IO.File]::ReadAllText($script:SettingsFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
  Assert-Equal $saved.cardTheme 'violet' 'Preview save includes selected theme'
  Assert-Equal $saved.skin 'star' 'Preview save includes independent selected skin'
  Set-PetPreferenceValues $saved
  Set-ModeVisual $false
  Assert-Brush $script:Card.BorderBrush '#B1BDD7' 'saved theme restores actual Codex colors'
  $Preview = $false
  $settingsBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:SettingsFile))
  $settingsTicks = (Get-Item -LiteralPath $script:SettingsFile).LastWriteTimeUtc.Ticks
  Save-Prefs; Save-Prefs
  $position = [IO.File]::ReadAllText($script:PositionFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
  Assert-Equal @($position.PSObject.Properties).Count 2 'normal writer remains coordinate-only'
  Assert-Equal $position.left 123 'normal writer rounds left'
  Assert-Equal $position.top 235 'normal writer rounds top'
  Assert-Equal ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:SettingsFile))) $settingsBytes 'normal save preserves host theme/settings bytes'
  Assert-Equal (Get-Item -LiteralPath $script:SettingsFile).LastWriteTimeUtc.Ticks $settingsTicks 'normal save preserves host settings timestamp'
  Assert-Equal @(Get-ChildItem -LiteralPath $temporaryDirectory -Filter '*.tmp').Count 0 'theme save leaves no atomic-write temporary files'
  Assert-True (-not $script:Window.IsVisible) 'real WPF test window never displayed'
  if ($CapturePath) {
    Save-ContactSheet ([IO.Path]::GetFullPath($CapturePath))
    Assert-True (Test-Path -LiteralPath $CapturePath) 'real XAML contact sheet saved'
    Write-Host "CAPTURE: $CapturePath"
  }
  Write-Host "PASS: $($script:Assertions) card theme assertions; $($script:MatrixCases) matrix cases (5 themes x 2 modes x 6 skins x 4 sizes x 2 peak choices). No real pet/preferences/models/host used."
} finally {
  $script:Window.Close()
  # Delete only the exact unique directory created above, never a derived user-data path.
  $expected = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetFileName($temporaryDirectory))
  if ([IO.Path]::GetFullPath($temporaryDirectory) -cne [IO.Path]::GetFullPath($expected) -or [IO.Path]::GetFileName($temporaryDirectory) -notmatch '^DshPetCardThemesTest-[0-9a-f]{32}$') { throw 'Refusing unsafe theme test cleanup.' }
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
}
