# Local WPF application receipts only. Never writes preferences, position or ledger.
function Initialize-PetPreferencesReceipt {
  $script:PetPreferencesLoaded = $false
  $script:PetReceiptClaimed = $false
  $script:PetReceiptState = $null
  $script:PetReceiptNextWriteAt = [DateTime]::MinValue
  $script:PetAppliedAt = $null
  $script:PetAppliedRevision = $null
  $script:PetCandidateRevision = $null
  $script:PetPreferencesDirty = $true
  $script:PetPreferencesSaved = $null
  $script:PetReceiptFile = $null
  if (-not $Preview -and $DshProfile -cin @('desktop', 'web') -and -not [string]::IsNullOrWhiteSpace($PetRunId)) {
    $script:PetReceiptFile = Join-Path $script:DataDir "settings-applied-$DshProfile.json"
  }
}

function Read-PetPreferenceSnapshot([string]$path) {
  # Decode and hash the SAME single read, including BOM/newlines/unknown keys.
  $bytes = [IO.File]::ReadAllBytes($path)
  $decoder = [Text.UTF8Encoding]::new($false, $true)
  $content = $decoder.GetString($bytes)
  if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) { $content = $content.Substring(1) }
  if (-not $content.TrimStart().StartsWith('{')) { throw 'Pet preferences must be a JSON object.' }
  $saved = $content | ConvertFrom-Json -ErrorAction Stop
  if ($saved -isnot [pscustomobject]) { throw 'Pet preferences must be a JSON object.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $revision = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return [pscustomobject]@{ Saved = $saved; Revision = $revision }
}

function Get-PetAppliedPreferenceValues {
  # EXACT DEFAULT_PREFERENCES key set; report actual native values, not JS sanitization.
  $values = [ordered]@{}
  foreach ($key in @('skin', 'cardTheme', 'unit', 'size', 'billingMode', 'codexUnit', 'codexAccountBackend',
    'codexQuotaRefreshSeconds', 'codexWarmupDaily', 'codexWarmupTime', 'codexWarmupReset',
    'codexWarmupStartup', 'multiAccountManagement', 'sleepMinutes', 'compactMode', 'quietMode', 'feedbackStyle', 'reduceMotion', 'disableFlashes', 'disableFloats')) {
    $values[$key] = $script:Prefs[$key]
  }
  return $values
}

function Test-PetReceiptIdentity($receipt) {
  return ($null -ne $receipt -and $receipt.version -eq 1 -and $receipt.profile -ceq $DshProfile -and
    $receipt.runId -ceq $PetRunId -and $receipt.pid -eq $PID)
}

function Test-PetReceiptWriteOwnership([switch]$Claim) {
  if (-not [IO.File]::Exists($script:PetReceiptFile)) { return $true }
  try { $existing = [IO.File]::ReadAllText($script:PetReceiptFile, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop }
  catch { return [bool]$Claim }
  if (Test-PetReceiptIdentity $existing) { return $true }
  if ($existing.profile -and $existing.profile -cne $DshProfile) { return $false }
  if (-not $Claim) { return $false }
  # Single-instance owner may retire a dead predecessor at Loaded, never a live peer.
  if ($existing.pid -isnot [int] -and $existing.pid -isnot [long]) { return $true }
  if ($existing.pid -le 0) { return $true }
  try { $process = [Diagnostics.Process]::GetProcessById([int]$existing.pid) }
  catch [ArgumentException] { return $true }
  catch { return $false }
  try { return $process.HasExited } finally { $process.Dispose() }
}

function Write-PetPreferencesReceipt($payload, [switch]$Claim) {
  if ($Preview -or -not $script:PetPreferencesLoaded -or -not $script:PetReceiptFile) { return $false }
  $temporary = $script:PetReceiptFile + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $created = $false
  try {
    if (-not (Test-PetReceiptWriteOwnership -Claim:$Claim)) { return $false }
    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
    if (-not (Test-PetReceiptWriteOwnership -Claim:$Claim)) { return $false }
    if ([IO.File]::Exists($script:PetReceiptFile)) {
      [IO.File]::Replace($temporary, $script:PetReceiptFile, [Management.Automation.Language.NullString]::Value)
    } else { [IO.File]::Move($temporary, $script:PetReceiptFile) }
    return $true
  } catch { return $false } finally {
    if ($created -and [IO.File]::Exists($temporary)) {
      try { [IO.File]::Delete($temporary) } catch { }
    }
  }
}

function Publish-PetPreferencesPending([switch]$Claim, [switch]$Force) {
  if ($Preview -or -not $script:PetPreferencesLoaded -or -not $script:PetReceiptFile) { return }
  $now = [DateTime]::UtcNow
  if (-not $Force -and $script:PetReceiptState -ceq 'pending' -and $now -lt $script:PetReceiptNextWriteAt) { return }
  $script:PetReceiptNextWriteAt = $now.AddSeconds(5)
  $payload = [ordered]@{ version = 1; status = 'pending'; profile = $DshProfile; runId = $PetRunId; pid = $PID; heartbeatAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $script:PetReceiptState = 'pending'
  if (Write-PetPreferencesReceipt $payload -Claim:$Claim) { $script:PetReceiptClaimed = $true }
}

function Invalidate-PetPreferencesApplication {
  $script:PetCandidateRevision = $null
  $script:PetAppliedRevision = $null
  $script:PetAppliedAt = $null
  $script:PetPreferencesDirty = $true
  # Failed theme/frame/peak work must not be mistaken for repaired presentation.
  $script:AppliedCardThemeKey = $null
  $script:LastFrameKey = ''
  $script:LastPeak = $null
  Publish-PetPreferencesPending
}

function Start-PetPreferencesReceipt {
  if ($Preview -or $script:PetPreferencesLoaded) { return }
  $script:PetPreferencesLoaded = $true
  # No successful receipt before actual Window.Loaded and a subsequent full tick.
  Publish-PetPreferencesPending -Claim -Force
}

function Complete-PetPreferencesApplication {
  if ($Preview -or -not $script:PetPreferencesLoaded -or -not $script:PetCandidateRevision -or $script:PetPreferencesDirty) { return }
  if (-not $script:PetReceiptClaimed) { Publish-PetPreferencesPending -Claim; if (-not $script:PetReceiptClaimed) { return } }
  $now = [DateTime]::UtcNow
  if ($script:PetAppliedRevision -cne $script:PetCandidateRevision) {
    $script:PetAppliedRevision = $script:PetCandidateRevision
    $script:PetAppliedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } elseif ($now -lt $script:PetReceiptNextWriteAt) { return }
  $script:PetReceiptNextWriteAt = $now.AddSeconds(5)
  $payload = [ordered]@{ version = 1; status = 'applied'; profile = $DshProfile; runId = $PetRunId; pid = $PID;
    revision = $script:PetAppliedRevision; values = Get-PetAppliedPreferenceValues;
    appliedAt = $script:PetAppliedAt; heartbeatAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  if (Write-PetPreferencesReceipt $payload) { $script:PetReceiptState = 'applied' }
}

function Stop-PetPreferencesReceipt {
  if ($Preview -or -not $script:PetReceiptClaimed) { return }
  # Identity-checked atomic pending replaces success, but never a newer run's file.
  $script:PetCandidateRevision = $null; $script:PetAppliedRevision = $null; $script:PetAppliedAt = $null
  Publish-PetPreferencesPending -Force
  $script:PetPreferencesLoaded = $false
}
