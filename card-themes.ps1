# Canonical local palettes only: independent of skin, settings persistence and network.
# Explicit UTF-8 also decodes a BOM-less Chinese catalogue correctly in PS 5.1.
$script:CardThemeCatalog = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'card-themes.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$script:AppliedCardThemeKey = $null
$script:AppliedCardThemeWindow = $null

function Get-PetCardPalette([string]$themeId, [string]$billingMode, [bool]$peak) {
  $theme = $script:CardThemeCatalog | Where-Object { $_.id -ceq $themeId } | Select-Object -First 1
  if ($null -eq $theme) { $theme = $script:CardThemeCatalog | Where-Object { $_.id -ceq 'default' } | Select-Object -First 1 }
  if ($null -eq $theme) { throw 'Card theme catalogue must contain default.' }
  $mode = if ($billingMode -eq 'codex') { 'codex' } else { 'deepseek' }
  # Copy rather than mutate canonical objects; peak overrides never enter Codex.
  $palette = [ordered]@{}
  foreach ($property in $theme.$mode.PSObject.Properties) { $palette[$property.Name] = $property.Value }
  if ($mode -eq 'deepseek' -and $peak) {
    foreach ($property in $theme.peak.PSObject.Properties) { $palette[$property.Name] = $property.Value }
  }
  return [pscustomobject]$palette
}

function Update-PetCardTheme([bool]$peak) {
  # Preference loading happens before the real XAML window exists.
  if ($null -eq $script:Window) { return }
  $themeId = 'default'
  if ($script:Prefs.cardTheme -is [string] -and $script:Prefs.cardTheme -cin @($script:CardThemeCatalog | ForEach-Object { $_.id })) { $themeId = $script:Prefs.cardTheme }
  $mode = if ($script:Prefs.billingMode -eq 'codex') { 'codex' } else { 'deepseek' }
  $effectivePeak = $mode -eq 'deepseek' -and $peak
  $key = "$themeId|$mode|$effectivePeak"
  # Repeated data/animation updates must neither allocate brushes nor erase a flash.
  if ($script:AppliedCardThemeKey -ceq $key -and [object]::ReferenceEquals($script:AppliedCardThemeWindow, $script:Window)) { return }
  $palette = Get-PetCardPalette $themeId $mode $effectivePeak
  $brushes = @{}
  $converter = [Windows.Media.BrushConverter]::new()
  foreach ($name in @('border', 'text', 'muted', 'accent', 'secondary', 'track', 'badge', 'badgeText', 'divider')) {
    $brushes[$name] = $converter.ConvertFromString([string]$palette.$name)
    $brushes[$name].Freeze()
  }
  $card = $script:Window.FindName('Card')
  $start = [Windows.Media.ColorConverter]::ConvertFromString([string]$palette.start)
  $end = [Windows.Media.ColorConverter]::ConvertFromString([string]$palette.end)
  $background = [Windows.Media.LinearGradientBrush]::new($start, $end, 18)
  $background.Freeze()
  $card.Background = $background
  $card.CornerRadius = [Windows.CornerRadius]::new([double]$palette.radius)
  $script:CardBaseBorder = $brushes.border
  # FlashEnd == MaxValue means inactive; an active event retains its own border.
  $flashActive = $null -ne $script:FlashEnd -and $script:FlashEnd -ne [DateTime]::MaxValue -and [DateTime]::UtcNow -lt $script:FlashEnd
  if (-not $flashActive) { $card.BorderBrush = $script:CardBaseBorder }
  $card.Effect.Color = [Windows.Media.ColorConverter]::ConvertFromString([string]$palette.shadow)
  foreach ($name in @('CardHeader', 'CodexHeader', 'FiveHourLabel', 'WeeklyLabel', 'QuotaStatus', 'FiveHourReset', 'WeeklyReset')) {
    $script:Window.FindName($name).Foreground = $brushes.muted
  }
  $script:Window.FindName('Balance').Foreground = $brushes.text
  $script:Window.FindName('Rate').Foreground = $brushes.accent
  $script:Window.FindName('Mode').Foreground = $brushes.badgeText
  $script:Window.FindName('PriceBadge').Background = $brushes.badge
  $script:Window.FindName('BalanceDivider').Background = $brushes.divider
  foreach ($prefix in @('FiveHour', 'Weekly')) {
    $brush = if ($prefix -eq 'FiveHour') { $brushes.accent } else { $brushes.secondary }
    $script:Window.FindName("${prefix}Value").Foreground = $brush
    $bar = $script:Window.FindName("${prefix}Bar")
    $bar.Foreground = $brush
    $bar.Background = $brushes.track
  }
  $script:AppliedCardThemeKey = $key
  $script:AppliedCardThemeWindow = $script:Window
}
