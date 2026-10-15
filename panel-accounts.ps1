# Private, memory-only panel IPC. No account state, endpoint or credential is persisted.
function Initialize-PetPanelAccounts {
  $url = $env:DSH_PET_PANEL_URL
  $token = $env:DSH_PET_PANEL_TOKEN
  [Environment]::SetEnvironmentVariable('DSH_PET_PANEL_URL', $null, 'Process')
  [Environment]::SetEnvironmentVariable('DSH_PET_PANEL_TOKEN', $null, 'Process')
  $script:PetPanelEndpoint = $null
  $script:PetPanelToken = $null
  # Literal IPv4 loopback only: reject userinfo, escapes, DNS, query and fragments.
  if ($url -is [string] -and $url -cmatch '\Ahttp://127\.0\.0\.1:([1-9][0-9]{0,4})/panel\z' -and
      [int]$Matches[1] -le 65535 -and $token -is [string] -and $token -cmatch '\A[a-fA-F0-9]{64}\z') {
    $script:PetPanelEndpoint = $url
    $script:PetPanelToken = $token
  }
  $script:PetPanelClosed = $false
  $script:PetPanelOperation = $null
  $script:PetPanelState = $null
  $script:PetPanelExpiresAt = [DateTime]::MinValue
  $script:PetPanelNextGetAt = [DateTime]::MinValue
  $script:PetPanelRevision = $null
}

function Test-PetPanelAccountsEnabled {
  return (-not $Preview -and -not $script:PetPanelClosed -and $script:Prefs.billingMode -ceq 'codex' -and
    $script:Prefs.multiAccountManagement -is [bool] -and $script:Prefs.multiAccountManagement)
}

# These three transport functions are replaceable by isolated tests. Every stage is
# asynchronous, including POST upload and response body reads (headers alone are not enough).
function Start-PetPanelRequest([string]$method, [string]$grant) {
  $request = [Net.HttpWebRequest]::Create($script:PetPanelEndpoint)
  $request.Method = $method
  $request.Proxy = $null
  $request.AllowAutoRedirect = $false
  $request.CachePolicy = New-Object Net.Cache.RequestCachePolicy([Net.Cache.RequestCacheLevel]::NoCacheNoStore)
  $request.Timeout = 15000
  $request.ReadWriteTimeout = 15000
  $request.KeepAlive = $false
  $request.Credentials = $null
  $request.UseDefaultCredentials = $false
  $request.Headers['Authorization'] = 'Bearer ' + $script:PetPanelToken
  $request.Accept = 'application/json'
  $operation = [pscustomobject]@{ Request = $request; Method = $method; StartedAt = [DateTime]::UtcNow;
    Revision = $script:PetCandidateRevision; Stage = 'response'; Pending = $null; Upload = $null;
    Response = $null; Stream = $null; Buffer = (New-Object byte[] 4096); Bytes = (New-Object IO.MemoryStream); Body = $null }
  try {
    if ($method -ceq 'POST') {
      $operation.Body = [Text.Encoding]::UTF8.GetBytes((@{ action = 'cycle'; grant = $grant } | ConvertTo-Json -Compress))
      $request.ContentType = 'application/json; charset=utf-8'
      $request.ContentLength = $operation.Body.Length
      $request.AllowWriteStreamBuffering = $false
      $operation.Stage = 'upload-open'
      $operation.Pending = $request.BeginGetRequestStream($null, $null)
    } else { $operation.Pending = $request.BeginGetResponse($null, $null) }
    return $operation
  } catch { Stop-PetPanelRequest $operation; throw }
}

function Stop-PetPanelRequest($operation) {
  if ($null -eq $operation) { return }
  try { $operation.Request.Abort() } catch { }
  foreach ($resource in @($operation.Upload, $operation.Stream, $operation.Response, $operation.Bytes)) {
    if ($null -ne $resource) { try { $resource.Dispose() } catch { } }
  }
}

function Receive-PetPanelRequest($operation) {
  if (-not $operation.Pending.IsCompleted) { return [pscustomobject]@{ Status = 'pending' } }
  switch ($operation.Stage) {
    'upload-open' {
      $operation.Upload = $operation.Request.EndGetRequestStream($operation.Pending)
      $operation.Pending = $operation.Upload.BeginWrite($operation.Body, 0, $operation.Body.Length, $null, $null)
      $operation.Stage = 'upload-write'
    }
    'upload-write' {
      $operation.Upload.EndWrite($operation.Pending)
      $operation.Upload.Dispose(); $operation.Upload = $null; $operation.Body = $null
      $operation.Pending = $operation.Request.BeginGetResponse($null, $null)
      $operation.Stage = 'response'
    }
    'response' {
      $operation.Response = $operation.Request.EndGetResponse($operation.Pending)
      if ([int]$operation.Response.StatusCode -ne 200 -or $operation.Response.ContentLength -gt 16384) { throw 'Panel response rejected.' }
      $operation.Stream = $operation.Response.GetResponseStream()
      $operation.Pending = $operation.Stream.BeginRead($operation.Buffer, 0, $operation.Buffer.Length, $null, $null)
      $operation.Stage = 'read'
    }
    'read' {
      $count = $operation.Stream.EndRead($operation.Pending)
      if ($operation.Bytes.Length + $count -gt 16384) { throw 'Panel response too large.' }
      if ($count -eq 0) {
        $decoder = New-Object Text.UTF8Encoding($false, $true)
        $value = $decoder.GetString($operation.Bytes.ToArray()) | ConvertFrom-Json -ErrorAction Stop
        return [pscustomobject]@{ Status = 'ready'; Value = $value }
      }
      $operation.Bytes.Write($operation.Buffer, 0, $count)
      $operation.Pending = $operation.Stream.BeginRead($operation.Buffer, 0, $operation.Buffer.Length, $null, $null)
    }
    default { throw 'Panel response rejected.' }
  }
  return [pscustomobject]@{ Status = 'pending' }
}

function Clear-PetPanelAccounts([string]$message = '') {
  $script:PetPanelState = $null
  $script:PetPanelExpiresAt = [DateTime]::MinValue
  $script:PetPanelRevision = $null
  if ($script:PanelAccountEmail) { $script:PanelAccountEmail.Text = $message; $script:PanelAccountEmail.ToolTip = $null }
  if ($script:PanelAccountSwitch) { $script:PanelAccountSwitch.IsEnabled = $false }
}

function Reset-PetPanelAccounts {
  # Detach first: a cancelled/late completion can never repopulate the UI.
  $operation = $script:PetPanelOperation
  $script:PetPanelOperation = $null
  Stop-PetPanelRequest $operation
  Clear-PetPanelAccounts
  $script:PetPanelNextGetAt = [DateTime]::MinValue
}

function Set-PetPanelAccountResponse($value, [DateTime]$now, [DateTime]$startedAt) {
  if ($value -isnot [pscustomobject] -or $value.enabled -isnot [bool] -or $value.canSwitch -isnot [bool] -or
      ($value.validForMs -isnot [int] -and $value.validForMs -isnot [long]) -or
      $value.validForMs -le 0 -or $value.validForMs -gt 120000) { throw 'Panel response rejected.' }
  # Subtract request/transfer time rather than extending an already stale response.
  $expiresAt = $startedAt.AddMilliseconds([double]$value.validForMs)
  if (-not $value.enabled -or $now -ge $expiresAt) { Clear-PetPanelAccounts '账号信息待更新'; return }
  if ($value.email -isnot [string] -or $value.email.Length -gt 512 -or $value.email -match '[\x00-\x1f\x7f]' -or
      $value.selection -cnotin @('active', 'default', 'none') -or
      ($value.canSwitch -and ($value.grant -isnot [string] -or $value.grant -cnotmatch '\A[a-fA-F0-9]{64}\z'))) { throw 'Panel response rejected.' }
  if ($value.email -and $value.selection -cnotin @('active', 'default')) { throw 'Panel response rejected.' }
  $script:PetPanelState = $value
  $script:PetPanelExpiresAt = $expiresAt
  $script:PetPanelRevision = $script:PetCandidateRevision
  $prefix = if ($value.selection -ceq 'active') { '激活 · ' } elseif ($value.selection -ceq 'default') { '默认 · ' } else { '' }
  if ($script:PanelAccountEmail) {
    $script:PanelAccountEmail.Text = if ($value.email) { $prefix + $value.email } else { '暂无可用账号' }
    $script:PanelAccountEmail.ToolTip = if ($value.email) { $prefix + $value.email } else { $null }
  }
  if ($script:PanelAccountSwitch) { $script:PanelAccountSwitch.IsEnabled = $value.canSwitch }
}

function Update-PetPanelAccounts {
  $enabled = Test-PetPanelAccountsEnabled
  if ($script:PanelAccountArea) { $script:PanelAccountArea.Visibility = if ($enabled) { 'Visible' } else { 'Collapsed' } }
  if (-not $enabled) { Reset-PetPanelAccounts; return }
  $now = [DateTime]::UtcNow
  if ($script:PetPanelState -and ($now -ge $script:PetPanelExpiresAt -or $script:PetPanelRevision -cne $script:PetCandidateRevision)) {
    Clear-PetPanelAccounts '账号信息待更新'
  }
  $operation = $script:PetPanelOperation
  if ($null -ne $operation) {
    if ($operation.Revision -cne $script:PetCandidateRevision) { Reset-PetPanelAccounts; return }
    try {
      if (($now - $operation.StartedAt).TotalMilliseconds -ge 15000) { throw 'Panel request timed out.' }
      $result = Receive-PetPanelRequest $operation
      if ($result.Status -ceq 'pending') { return }
      $script:PetPanelOperation = $null
      Stop-PetPanelRequest $operation
      Set-PetPanelAccountResponse $result.Value $now $operation.StartedAt
      if ($operation.Method -ceq 'POST') { $script:PetPanelNextGetAt = $now.AddSeconds(2) }
    } catch {
      $script:PetPanelOperation = $null
      Stop-PetPanelRequest $operation
      Clear-PetPanelAccounts $(if ($operation.Method -ceq 'POST') { '切换结果待确认' } else { '账号信息暂不可用' })
      $script:PetPanelNextGetAt = $now.AddSeconds(2)
    }
    return
  }
  if (-not $script:PetPanelEndpoint -or -not $script:PetPanelToken) { Clear-PetPanelAccounts '账号连接不可用'; return }
  if ($now -lt $script:PetPanelNextGetAt) { return }
  $script:PetPanelNextGetAt = $now.AddSeconds(2)
  try {
    $script:PetPanelOperation = Start-PetPanelRequest 'GET' ''
    if ($script:PanelAccountSwitch) { $script:PanelAccountSwitch.IsEnabled = $false }
  } catch { Clear-PetPanelAccounts '账号信息暂不可用' }
}

function Invoke-PetPanelAccountSwitch {
  # Refresh the local setting at click time: old WPF handlers must not keep consent.
  if (Get-Command Reload-PetPreferences -ErrorAction SilentlyContinue) { Reload-PetPreferences -Force }
  if (-not (Test-PetPanelAccountsEnabled)) { Reset-PetPanelAccounts; return }
  if ($script:PetPanelOperation -or -not $script:PetPanelEndpoint -or -not $script:PetPanelToken) { return }
  $now = [DateTime]::UtcNow
  $state = $script:PetPanelState
  if ($null -eq $state) { return }
  if (-not $state.canSwitch -or $script:PetPanelRevision -cne $script:PetCandidateRevision -or
      $now -ge $script:PetPanelExpiresAt -or $state.grant -cnotmatch '\A[a-fA-F0-9]{64}\z') { Clear-PetPanelAccounts '账号信息待更新'; return }
  $grant = $state.grant
  # Consume this UI authorization BEFORE starting, even if startup fails; never retry POST.
  Clear-PetPanelAccounts '正在切换账号…'
  $script:PetPanelNextGetAt = $now.AddSeconds(2)
  try { $script:PetPanelOperation = Start-PetPanelRequest 'POST' $grant }
  catch { Clear-PetPanelAccounts '切换结果待确认' }
}

function Connect-PetPanelAccounts {
  if ($script:PanelAccountSwitch) {
    $script:PanelAccountSwitch.Add_Click({ param($sender, $eventArgs); $eventArgs.Handled = $true; Invoke-PetPanelAccountSwitch })
    # Button consumes down events itself; explicitly fence its bubbling mouse event, too.
    $script:PanelAccountSwitch.Add_MouseLeftButtonDown({ param($sender, $eventArgs); $eventArgs.Handled = $true })
  }
  Update-PetPanelAccounts
}

function Close-PetPanelAccounts {
  $script:PetPanelClosed = $true
  Reset-PetPanelAccounts
  $script:PetPanelToken = $null
  $script:PetPanelEndpoint = $null
  if ($script:PanelAccountArea) { $script:PanelAccountArea.Visibility = 'Collapsed' }
}
