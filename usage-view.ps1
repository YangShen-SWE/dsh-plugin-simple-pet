# Mode-specific presentation. This file has no network or credential access.
function Get-BillingMode {
  if ($script:Prefs.billingMode -eq 'codex') { return 'codex' }
  return 'deepseek'
}
function Format-QuotaPercent($window) {
  if ($null -eq $window -or $null -eq $window.remainingPercent) { return '—' }
  return ('{0:0.#}%' -f [double]$window.remainingPercent)
}
function Format-QuotaReset($window) {
  if ($null -eq $window -or $null -eq $window.resetAt) { return '重置时间未知' }
  try { return '重置 ' + [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$window.resetAt).LocalDateTime.ToString('MM-dd HH:mm') }
  catch { return '重置时间未知' }
}
function Test-QuotaFresh($quota) {
  if ($quota.status -ne 'ready' -or -not $quota.observedAt) { return $false }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ([int64]$quota.observedAt -gt $now + 5000 -or $now - [int64]$quota.observedAt -gt 120000) { return $false }
  foreach ($window in @($quota.fiveHour, $quota.weekly)) {
    if ($window.resetAt -and [int64]$window.resetAt -le $now) { return $false }
  }
  return $true
}
function Get-QuotaStatus($quota, $snapshot = $script:LastSnapshot) {
  if ($null -eq $quota) {
    # A pre-Codex backend snapshot is not a missing subscription account.
    if ($null -ne $snapshot -and $null -eq $snapshot.codex) { return '请重启 DSH 更新桌宠' }
    return '等待 DSH 数据'
  }
  if ($quota.status -eq 'ready' -and -not (Test-QuotaFresh $quota)) { return '上次额度 · 待更新' }
  if ($quota.status -eq 'reported') {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    foreach ($window in @($quota.fiveHour, $quota.weekly)) {
      if ($window.resetAt -and [int64]$window.resetAt -le $now) { return '上次额度 · 待更新' }
    }
  }
  switch ([string]$quota.status) {
    'ready' { return '当前账号 · 官方报告' }
    'reported' { return '默认账号 · 可能缓存' }
    'loading' { return '查询额度中…' }
    'signed-out' { return '请在订阅插件登录' }
    'unsupported' { return '未发现支持的订阅接口' }
    'switching' { return '账号切换中…' }
    'stale' { return '上次额度 · 待更新' }
    default { return '额度暂不可用' }
  }
}
function Update-PetUsageCard {
  if ($null -eq $script:Window) { return }
  $codexMode = (Get-BillingMode) -eq 'codex'
  $script:DeepSeekPanel.Visibility = if ($codexMode) { 'Collapsed' } else { 'Visible' }
  $script:CodexPanel.Visibility = if ($codexMode) { 'Visible' } else { 'Collapsed' }
  $script:Root.Height = if ($codexMode) { 360 } else { 296 }
  $script:Card.Height = if ($codexMode) { 156 } else { 92 }
  $snapshot = $script:LastSnapshot
  if ($codexMode) {
    $quota = $snapshot.codex
    $status = Get-QuotaStatus $quota
    $stale = $status -eq '上次额度 · 待更新'
    if ($stale) { $status = '上次额度 · 待更新' }
    $script:QuotaStatus.Text = $status
    $script:CodexPanel.Opacity = if ($stale) { 0.72 } else { 1 }
    foreach ($kind in @('fiveHour', 'weekly')) {
      $window = $quota.$kind
      $prefix = if ($kind -eq 'fiveHour') { 'FiveHour' } else { 'Weekly' }
      $script:Window.FindName("${prefix}Value").Text = Format-QuotaPercent $window
      $script:Window.FindName("${prefix}Reset").Text = Format-QuotaReset $window
      $bar = $script:Window.FindName("${prefix}Bar")
      $bar.Value = if ($null -ne $window -and $null -ne $window.remainingPercent) { [double]$window.remainingPercent } else { 0 }
      $bar.Opacity = if ($null -eq $window) { 0.35 } else { 1 }
    }
  } elseif ($null -ne $snapshot) {
    if ($null -ne $snapshot.balance) {
      $script:Balance.Text = '¥' + ([double]$snapshot.balance).ToString('N2')
      $script:Balance.FontSize = if ($script:Balance.Text.Length -gt 10) { 19 } elseif ($script:Balance.Text.Length -gt 8) { 22 } else { 26 }
    } elseif ($snapshot.balanceStatus -eq 'loading') { $script:Balance.Text = '查询中…' }
    else { $script:Balance.Text = '未连接' }
    $script:Rate.Text = if ($null -ne $snapshot.cacheHitRate) { '缓存命中 ' + ([math]::Round([double]$snapshot.cacheHitRate * 100)).ToString() + '%' } else { '缓存命中 —' }
  }
}
function Refresh-BillingMode {
  $script:Queue.Clear()
  foreach ($entry in $script:ActiveFloats) { $script:Root.Children.Remove($entry.control) }
  $script:ActiveFloats.Clear()
  $script:LastPeak = $null
  $script:Current = 'idle'
  $script:ActionEnd = [DateTime]::UtcNow
  $script:Stats = if ((Get-BillingMode) -eq 'codex') { $script:LastSnapshot.codexStats } else { $script:LastSnapshot.stats }
  $script:LastActivityAt = if ($script:Stats.activityAt -gt 0) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$script:Stats.activityAt).UtcDateTime } else { [DateTime]::UtcNow }
  Update-PetUsageCard
  Set-PetSize
}

function Test-PetEventVisible($item) {
  $mode = if ($item.billingMode) { [string]$item.billingMode } else { 'deepseek' }
  if ($mode -ne (Get-BillingMode)) { return $false }
  if ($mode -ne 'codex') { return $true }
  if ($item.kind -eq 'quota') {
    return $script:Prefs.codexUnit -eq 'percent' -and (Test-QuotaFresh $script:LastSnapshot.codex) -and $item.accountKey -eq $script:LastSnapshot.codex.accountKey
  }
  return $script:Prefs.codexUnit -ne 'percent' -or -not (Test-QuotaFresh $script:LastSnapshot.codex)
}
# Pure presentation: backend alone owns scheduling and model calls.
function Get-CodexWarmupStatusText($snapshot = $script:LastSnapshot, $prefs = $script:Prefs) {
  $enabled = ($prefs.codexWarmupDaily -is [bool] -and $prefs.codexWarmupDaily) -or ($prefs.codexWarmupReset -is [bool] -and $prefs.codexWarmupReset) -or ($prefs.codexWarmupStartup -is [bool] -and $prefs.codexWarmupStartup)
  $warmup = $snapshot.codexWarmup
  if ($null -eq $warmup) {
    if ($enabled) { return '自动预热已启用；当前后端尚未提供状态，请完全退出并重启 DSH 以加载新版插件。' }
    return '自动预热已关闭（三个开关默认关闭）。'
  }
  $label = switch ([string]$warmup.status) {
    'disabled' { '已关闭' }
    'idle' { '等待计划' }
    'running' { '正在预热' }
    'retrying' { '等待安全重试' }
    'succeeded' { '预热成功' }
    'failed' { '预热失败' }
    'skipped' { '已跳过' }
    default { '等待状态更新' }
  }
  $lines = New-Object Collections.Generic.List[string]
  $lines.Add('自动预热：' + $label)
  # detail is the backend's short, safe Chinese summary, never a raw error field.
  if ($warmup.detail -is [string] -and $warmup.detail.Length -gt 0) { $lines.Add($warmup.detail) }
  foreach ($field in @('lastAttemptAt', 'lastSuccessAt', 'nextDailyAt')) {
    $value = $warmup.$field
    if ($null -eq $value) { continue }
    try {
      $time = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$value).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
      $prefix = switch ($field) { 'lastAttemptAt' { '上次尝试' }; 'lastSuccessAt' { '上次成功' }; 'nextDailyAt' { '下次每日预热' } }
      $lines.Add($prefix + '（本地）：' + $time)
    } catch { }
  }
  if ($warmup.lastReason -in @('daily', 'reset', 'startup')) { $lines.Add('上次触发：' + $(switch ($warmup.lastReason) { 'daily' { '每日定时' }; 'reset' { '5h 额度窗口重置' }; 'startup' { '启动时满额度' } })) }
  if ($warmup.model -is [string] -and $warmup.model.Length -gt 0) { $lines.Add('模型：' + $warmup.model) }
  return $lines -join "`n"
}
function Update-SettingsCodexWarmup {
  if ($null -eq $script:SettingsWindow -or -not $script:SettingsWindow.IsVisible) { return }
  $control = $script:SettingsWindow.FindName('CodexWarmupStatus')
  if ($null -eq $control) { return }
  $control.Text = Get-CodexWarmupStatusText
}
function Update-SettingsCodexQuota {
  if ($null -eq $script:SettingsWindow -or -not $script:SettingsWindow.IsVisible -or (Get-BillingMode) -ne 'codex') { return }
  $quota = $script:LastSnapshot.codex
  $script:SettingsCost.Text = Format-QuotaPercent $quota.fiveHour
  $script:SettingsHitRate.Text = Format-QuotaPercent $quota.weekly
  $script:SettingsNote.Text = (Get-QuotaStatus $quota) + '；5h ' + (Format-QuotaReset $quota.fiveHour) + '；周 ' + (Format-QuotaReset $quota.weekly) + '。额度由订阅插件报告，不按 Token 折算；Token 图表仅统计 DSH 调用。'
}
function Update-SettingsBillingMode {
  $codexMode = (Get-BillingMode) -eq 'codex'
  $script:SettingsWindow.FindName('DeepSeekUnitPanel').Visibility = if ($codexMode) { 'Collapsed' } else { 'Visible' }
  $script:SettingsWindow.FindName('CodexUnitPanel').Visibility = if ($codexMode) { 'Visible' } else { 'Collapsed' }
  $script:SettingsWindow.FindName('TodaySecondaryTitle').Text = if ($codexMode) { '周额度剩余' } else { '今日缓存命中率' }
  $script:SettingsWindow.FindName('TodayCostTitle').Text = if ($codexMode) { '5 小时额度剩余' } else { '今日人民币消耗' }
  $script:SettingsWindow.FindName('GalleryHint').Text = if ($codexMode) { '本地形象预览 · Codex 不随峰谷变换' } else { '峰时 / 谷时双预览 · 点击切换，即时保存' }
  $script:ChartUnit.IsEnabled = -not $codexMode
  foreach ($id in $script:SkinButtons.Keys) {
    $button = $script:SkinButtons[$id]
    $button.FindName("SkinPreview_${id}_peak").Visibility = if ($codexMode) { 'Collapsed' } else { 'Visible' }
    $button.FindName("SkinLabelPeak_$id").Visibility = if ($codexMode) { 'Collapsed' } else { 'Visible' }
    $image = $button.FindName("SkinPreview_${id}_valley")
    [Windows.Controls.Grid]::SetColumn($image, $(if ($codexMode) { 0 } else { 1 }))
    [Windows.Controls.Grid]::SetColumnSpan($image, $(if ($codexMode) { 2 } else { 1 }))
    $label = $button.FindName("SkinLabelValley_$id")
    $label.Text = if ($codexMode) { '形象预览' } else { '谷时' }
    [Windows.Controls.Grid]::SetColumn($label, $(if ($codexMode) { 0 } else { 1 }))
    [Windows.Controls.Grid]::SetColumnSpan($label, $(if ($codexMode) { 2 } else { 1 }))
    $skinName = ($script:SkinCatalog | Where-Object { $_.id -eq $id }).name
    [Windows.Automation.AutomationProperties]::SetName($button, $skinName + $(if ($codexMode) { '，本地形象预览' } else { '，峰时与谷时本地预览' }))
  }
}
