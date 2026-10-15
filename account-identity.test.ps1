# Only the isolated WPF bootstrap, not the companion policy matrix or live startup.
param([string]$ProjectRoot = $PSScriptRoot, [string]$CapturePath = '')
$requestedCapture = $CapturePath
$fixture = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'companion.test.ps1'))
$start = $fixture.IndexOf('`$ErrorActionPreference ='.Replace('`', ''))
$end = $fixture.IndexOf('$baseActivity =')
if ($start -lt 0 -or $end -lt $start) { throw 'Missing isolated WPF bootstrap boundary' }
Invoke-Expression $fixture.Substring($start, $end - $start)
$before = $script:Assertions
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:ApplyingPetPreferences = $true
try {
  foreach ($provider in @('openai-codex', 'codex')) { foreach ($compact in @($false, $true)) { foreach ($size in @('tiny','small','medium','large')) { foreach ($theme in $script:CardThemeCatalog.id) {
    $selection = if ($provider -eq 'codex') { 'default' } else { 'active' }
    $script:Prefs.billingMode = 'codex'; $script:Prefs.compactMode = $compact; $script:Prefs.size = $size; $script:Prefs.cardTheme = $theme
    $script:LastSnapshot = [pscustomobject]@{ codex = [pscustomobject]@{ status = if ($provider -eq 'codex') { 'reported' } else { 'ready' }; provider = $provider; selection = $selection; accountKey = 'abcdef0123456789'; observedAt = $now;
      fiveHour = [pscustomobject]@{ remainingPercent = 82; resetAt = $now + 3600000 }; weekly = [pscustomobject]@{ remainingPercent = 64; resetAt = $now + 86400000 } } }
    Update-PetUsageCard; Set-PetSize; Update-PetCardTheme $false
    $header = $script:Window.FindName('CodexHeader')
    Assert-Equal $header.Text 'CODEX · 订阅额度' 'panel title stays stable across sources and layouts'
    Assert-Equal $header.Width 106 'identity cannot overlap status'
    Assert-Equal $script:Window.FindName('FiveHourValue').Text '82%' 'five hour value preserved'
    Assert-Equal $script:Window.FindName('WeeklyValue').Text '64%' 'weekly value preserved'
    Assert-Equal $script:Root.Height $(if ($compact) { 166 } else { 360 }) 'no added card height or character blank space'
    Assert-Equal $script:Card.Height 156 'existing geometry retained'
    Assert-Equal $script:Window.Left 123 'left coordinate unchanged'
    Assert-Equal $script:Window.Top 234 'top coordinate unchanged'
    Assert-True ($header.Text -notmatch '@') 'no email in native panel'
    $script:LastSnapshot.codex.status = 'switching'; Update-PetUsageCard
    Assert-Equal $header.Text 'CODEX · 订阅额度' 'switch clears old identity'
    $script:LastSnapshot.codex.status = 'stale'; Update-PetUsageCard
    Assert-Equal $header.Text 'CODEX · 订阅额度' 'stale clears identity'
  } } } }
  foreach ($key in @('alice@example.com', 'ABCDEF0123456789', 'a', "abcdef0123456789`n", $null)) {
    Assert-Equal (Get-QuotaIdentityLabel ([pscustomobject]@{ status = 'reported'; provider = 'codex'; selection = 'default'; accountKey = $key })) 'CODEX · 订阅额度' 'invalid hash never displayed'
  }
  Assert-Equal (Get-QuotaIdentityLabel ([pscustomobject]@{ status = 'ready'; provider = 'codex'; selection = 'active'; accountKey = 'abcdef0123456789'; observedAt = $now })) 'CODEX · 订阅额度' 'mismatched source never labeled active'
  Assert-Equal (Get-QuotaIdentityLabel ([pscustomobject]@{ status = 'ready'; provider = 'openai-codex'; selection = 'active'; accountKey = 'abcdef0123456789'; observedAt = $now - 121000 })) 'CODEX · 订阅额度' 'expired observed report clears identity'
  if ($requestedCapture) {
    $sheet = [Windows.Media.DrawingVisual]::new(); $dc = $sheet.RenderOpen()
    $dc.DrawRectangle([Windows.Media.Brushes]::White, $null, [Windows.Rect]::new(0,0,600,210)); $x = 20
    foreach ($source in @('openai-codex','codex')) {
      $script:Prefs.compactMode = $true; $script:Prefs.size = 'medium'; $script:Prefs.cardTheme = 'default'
      $script:LastSnapshot.codex.provider = $source
      $script:LastSnapshot.codex.selection = if ($source -eq 'codex') { 'default' } else { 'active' }
      $script:LastSnapshot.codex.status = if ($source -eq 'codex') { 'reported' } else { 'ready' }
      Update-PetUsageCard; Set-PetSize; Update-PetCardTheme $false
      $script:Root.Measure([Windows.Size]::new(272,166)); $script:Root.Arrange([Windows.Rect]::new(0,0,272,166)); $script:Root.UpdateLayout()
      $image = [Windows.Media.Imaging.RenderTargetBitmap]::new(272,166,96,96,[Windows.Media.PixelFormats]::Pbgra32); $image.Render($script:Root)
      $dc.DrawImage($image,[Windows.Rect]::new($x,20,272,166)); $x += 288
    }
    $dc.Close(); $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(600,210,96,96,[Windows.Media.PixelFormats]::Pbgra32); $bitmap.Render($sheet)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new(); $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create($requestedCapture); try { $encoder.Save($stream) } finally { $stream.Dispose() }
  }
  Write-Host "PASS: $($script:Assertions - $before) native account identity assertions; 80 source/layout/theme/size cases."
} finally { $script:Window.Close() }
