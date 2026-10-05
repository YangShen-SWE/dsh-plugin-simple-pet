param([string]$ProjectRoot = $PSScriptRoot, [string]$CaptureDir = '', [string]$DeltaJson = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:Assertions = 0
function Assert-Equal($actual, $expected, [string]$message) {
  $script:Assertions++
  if ($actual -ne $expected) { throw "FAIL: $message; actual=$actual expected=$expected" }
}
# Extract only literal XAML and pure functions; do not execute pet startup or read real state.
$source = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'pet.ps1'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
Assert-Equal $errors.Count 0 'pet source parses in Windows PowerShell'
$literal = $ast.Find({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.StartsWith('<Window') }, $true)
if ($null -eq $literal) { throw 'Missing pet XAML literal' }
$script:Window = [Windows.Markup.XamlReader]::Parse($literal.Value)
$script:Window.Left = -10000; $script:Window.Top = -10000
$script:Window.ShowActivated = $false; $script:Window.ShowInTaskbar = $false
$bitmap = New-Object Windows.Media.Imaging.BitmapImage
$bitmap.BeginInit(); $bitmap.UriSource = [uri](Join-Path $ProjectRoot 'assets/default-valley.png'); $bitmap.CacheOption = 'OnLoad'; $bitmap.EndInit(); $bitmap.Freeze()
$script:Window.FindName('Sprite').Source = [Windows.Media.Imaging.CroppedBitmap]::new($bitmap, [Windows.Int32Rect]::new(0,0,320,320))
$script:Window.FindName('Mode').Text = '☾ 谷时价'
foreach ($name in @('Root', 'Card', 'DeepSeekPanel', 'CodexPanel', 'QuotaStatus', 'Balance', 'Rate')) {
  Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name)
}
$script:Prefs = @{ billingMode = 'deepseek'; codexUnit = 'token'; unit = 'cny' }
. (Join-Path $ProjectRoot 'usage-view.ps1')
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Format-Cost' }, $true)
Invoke-Expression $function.Extent.Text
function Capture([string]$name) {
  if (-not $CaptureDir) { return }
  [void][IO.Directory]::CreateDirectory($CaptureDir)
  $script:Window.Width = 272; $script:Window.Height = $script:Root.Height
  $script:Window.Show()
  $script:Window.Measure([Windows.Size]::new($script:Root.Width, $script:Root.Height))
  $script:Window.Arrange([Windows.Rect]::new(0,0,$script:Root.Width,$script:Root.Height))
  $script:Window.UpdateLayout()
  $image = [Windows.Media.Imaging.RenderTargetBitmap]::new(272, [int]$script:Root.Height, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $image.Render($script:Root)
  $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($image))
  $stream = [IO.File]::Create((Join-Path $CaptureDir $name))
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
}
try {
  $script:LastSnapshot = [pscustomobject]@{ balance = 12.34; balanceStatus = 'ready'; cacheHitRate = 0.5 }
  Update-PetUsageCard
  Assert-Equal ([string]$script:DeepSeekPanel.Visibility) 'Visible' 'DeepSeek panel shown by default'
  Assert-Equal ([string]$script:CodexPanel.Visibility) 'Collapsed' 'Codex panel hidden by default'
  Assert-Equal $script:Root.Height 296 'DeepSeek dimensions preserved'
  Assert-Equal $script:Balance.Text '¥12.34' 'DeepSeek balance preserved'
  Capture 'deepseek-card.png'
  $script:Prefs.billingMode = 'codex'
  Update-PetUsageCard
  Assert-Equal $script:QuotaStatus.Text '请重启 DSH 更新桌宠' 'old backend without codex DTO is not misdiagnosed as missing subscription plugin'
  Assert-Equal $script:Window.FindName('FiveHourValue').Text '—' 'old backend never invents quota'
  Assert-Equal (Get-QuotaStatus $null) '请重启 DSH 更新桌宠' 'statistics also directs old backend to restart DSH'
  $script:LastSnapshot = $null
  Update-PetUsageCard
  Assert-Equal $script:QuotaStatus.Text '等待 DSH 数据' 'no initial snapshot is distinct from old backend'
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $script:LastSnapshot = [pscustomobject]@{ codex = [pscustomobject]@{ status = 'ready'; accountKey = 'fixture-a'; observedAt = $now; fiveHour = [pscustomobject]@{ remainingPercent = 0; resetAt = $now + 18000000 }; weekly = [pscustomobject]@{ remainingPercent = 100; resetAt = $now + 604800000 } } }
  Update-PetUsageCard
  Assert-Equal ([string]$script:DeepSeekPanel.Visibility) 'Collapsed' 'price and wallet panel hidden in Codex'
  Assert-Equal ([string]$script:CodexPanel.Visibility) 'Visible' 'Codex panel shown'
  Assert-Equal $script:Root.Height 360 'Codex dimensions fit both quota windows'
  Assert-Equal $script:Card.Height 156 'Codex information card expanded'
  Assert-Equal $script:Window.FindName('FiveHourValue').Text '0%' 'exhausted quota remains 0%'
  Assert-Equal $script:Window.FindName('WeeklyValue').Text '100%' 'unused quota remains 100%'
  Assert-Equal $script:Window.FindName('WeeklyBar').Value 100 'bar agrees with actual quota'
  Capture 'codex-card.png'
  Assert-Equal (Format-Cost ([pscustomobject]@{ billingMode = 'codex'; kind = 'output'; tokens = 250; cny = 99 })) '−250 token' 'Codex never floats invented currency'
  Assert-Equal (Format-Cost ([pscustomobject]@{ billingMode = 'codex'; kind = 'quota'; window = 'fiveHour'; percent = 0.123 })) '5h 实测 −0.123%' 'quota float displays measured percentage points'
  Assert-Equal (Test-PetEventVisible ([pscustomobject]@{ billingMode = 'deepseek'; kind = 'output' })) $false 'DeepSeek events do not leak into Codex mode'
  Assert-Equal (Test-PetEventVisible ([pscustomobject]@{ billingMode = 'codex'; kind = 'output' })) $true 'Token animation enabled in Codex Token mode'
  $script:Prefs.codexUnit = 'percent'
  Assert-Equal (Test-PetEventVisible ([pscustomobject]@{ billingMode = 'codex'; kind = 'output' })) $false 'Token animation suppressed when fresh quota percentage requested'
  Assert-Equal (Test-PetEventVisible ([pscustomobject]@{ billingMode = 'codex'; kind = 'quota'; accountKey = 'fixture-a' })) $true 'measured percentage animation enabled'
  if ($DeltaJson) { Assert-Equal (Test-PetEventVisible ($DeltaJson | ConvertFrom-Json)) $true 'actual backend-emitted quota DTO passes native visibility filter' }
  Assert-Equal (Test-PetEventVisible ([pscustomobject]@{ billingMode = 'codex'; kind = 'quota'; accountKey = 'fixture-b' })) $false 'queued quota delta from another account rejected'
  $script:LastSnapshot.codex.fiveHour.resetAt = $now - 1
  Update-PetUsageCard
  Assert-Equal $script:QuotaStatus.Text '上次额度 · 待更新' 'expired window immediately marked stale without waiting for next backend poll'
  Assert-Equal (Get-QuotaStatus $script:LastSnapshot.codex) '上次额度 · 待更新' 'statistics and card agree about expiry'
  $script:LastSnapshot.codex.fiveHour.resetAt = $now + 18000000
  $script:LastSnapshot.codex.status = 'stale'
  Assert-Equal (Test-PetEventVisible ([pscustomobject]@{ billingMode = 'codex'; kind = 'output' })) $true 'Token fallback when quota stale'
  Update-PetUsageCard
  Assert-Equal $script:QuotaStatus.Text '上次额度 · 待更新' 'stale quota explicitly labeled'
  $script:LastSnapshot.codex = [pscustomobject]@{ status = 'unsupported'; fiveHour = $null; weekly = $null }
  Update-PetUsageCard
  Assert-Equal $script:Window.FindName('FiveHourValue').Text '—' 'unknown quota is not zero or full'
  Assert-Equal $script:Window.FindName('WeeklyValue').Text '—' 'unknown weekly quota is not zero or full'
  Assert-Equal $script:Window.FindName('FiveHourReset').Text '重置时间未知' 'unknown reset explicit'
  Assert-Equal (Get-QuotaStatus ([pscustomobject]@{ status = 'reported' })) '默认账号 · 可能缓存' 'pooled/default account freshness not invented'
  $script:Prefs.billingMode = 'deepseek'
  Update-PetUsageCard
  Assert-Equal (Test-PetEventVisible ([pscustomobject]@{ kind = 'output' })) $true 'legacy events remain DeepSeek-compatible'
  Write-Host "PASS: $($script:Assertions) native dual-mode quota presentation assertions."
} finally { $script:Window.Close() }
