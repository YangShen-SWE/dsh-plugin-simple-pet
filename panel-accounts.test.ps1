# Isolated PS5.1/STA contract tests: never run pet.ps1, read user files or make HTTP requests.
param([string]$CapturePath = '')
$requestedCapture = $CapturePath
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:Assertions = 0
function Assert($condition, [string]$label) {
  if (-not $condition) { throw ('FAIL: ' + $label) }
  $script:Assertions++
}
$paths = @('pet.ps1', 'panel-accounts.ps1', 'panel-accounts.test.ps1', 'preferences-applied.ps1')
foreach ($name in $paths) {
  $path = Join-Path $root $name
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) ($name + ' UTF-8 BOM')
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Assert ($errors.Count -eq 0) ($name + ' parses')
  if ($name -ceq 'pet.ps1') { $petAst = $ast }
  if ($name -ceq 'panel-accounts.ps1') { $panelAst = $ast }
}
$petSource = [IO.File]::ReadAllText((Join-Path $root 'pet.ps1'))
$xamlNode = $petAst.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$xaml' }, $true)
$xaml = $xamlNode.Right.Expression.Value
# Real production XAML, never Show/ShowDialog: hidden controls only.
$script:Window = [Windows.Markup.XamlReader]::Parse($xaml)
Assert (-not $script:Window.IsVisible) 'production XAML remains hidden'
foreach ($name in @('PanelAccountArea', 'PanelAccountEmail', 'PanelAccountSwitch')) { Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name) }
$card = $script:Window.FindName('Card'); $header = $script:Window.FindName('CardHeader')
Assert ($script:PanelAccountArea.Height -eq 28 -and [Windows.Controls.Canvas]::GetTop($script:PanelAccountArea) -eq 154) 'account area independent 28px footer'
Assert ($script:PanelAccountEmail.Width -eq 168 -and [Windows.Controls.Canvas]::GetLeft($script:PanelAccountEmail) -eq 13) 'email fixed bounds'
Assert ($script:PanelAccountEmail.TextTrimming -eq 'CharacterEllipsis' -and $script:PanelAccountEmail.TextWrapping -eq 'NoWrap') 'email ellipsis no wrapping'
Assert ($script:PanelAccountSwitch.Width -eq 60 -and $script:PanelAccountSwitch.Height -eq 22 -and [Windows.Controls.Canvas]::GetLeft($script:PanelAccountSwitch) -eq 187) 'switch fixed bounds'
Assert ($script:Window.FindName('FiveHourValue').FontSize -eq 23 -and [Windows.Controls.Canvas]::GetTop($script:Window.FindName('WeeklyReset')) -eq 137) 'quota layout preserved'
$header.Foreground = [Windows.Media.Brushes]::Gold
$card.BorderBrush = [Windows.Media.Brushes]::Crimson
$card.Background = [Windows.Media.Brushes]::Navy
$script:Window.Measure([Windows.Size]::new(272, 388)); $script:Window.Arrange([Windows.Rect]::new(0, 0, 272, 388)); $script:Window.UpdateLayout()
Assert ($script:PanelAccountSwitch.Foreground.ToString() -eq $header.Foreground.ToString()) 'switch inherits theme text'
Assert ($script:PanelAccountSwitch.BorderBrush.ToString() -eq $card.BorderBrush.ToString()) 'switch inherits theme border'
Assert ($script:PanelAccountSwitch.Background.ToString() -eq $card.Background.ToString()) 'switch has no system gray background'
Assert ($script:PanelAccountSwitch.Template -ne $null -and $xaml -notmatch 'Storyboard') 'simple template without animations'

. (Join-Path $root 'panel-accounts.ps1')
. (Join-Path $root 'preferences-applied.ps1')
# Extract only sanitization function: do not execute any top-level pet script.
$preferenceNode = $petAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Set-PetPreferenceValues' }, $true)
Invoke-Expression $preferenceNode.Extent.Text
$script:SkinCatalog = @(@{ id = 'default' }); $script:CardThemeCatalog = @(@{ id = 'default' })
$script:Prefs = [ordered]@{}
Set-PetPreferenceValues ([pscustomobject]@{})
Assert ($script:Prefs.multiAccountManagement -is [bool] -and -not $script:Prefs.multiAccountManagement) 'new preference defaults strictly false'
foreach ($bad in @('true', 'false', 1, 0, @($true), [pscustomobject]@{})) {
  Set-PetPreferenceValues ([pscustomobject]@{ multiAccountManagement = $bad })
  Assert ($script:Prefs.multiAccountManagement -is [bool] -and -not $script:Prefs.multiAccountManagement) 'non-bool preference rejected'
}
Set-PetPreferenceValues ([pscustomobject]@{ multiAccountManagement = $true })
Assert ($script:Prefs.multiAccountManagement -ceq $true) 'boolean true accepted'
Assert ((Get-PetAppliedPreferenceValues).Contains('multiAccountManagement')) 'receipt whitelist includes preference'

# Transport implementation is inspected, not started: no real HTTP or sockets.
$transport = $panelAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Start-PetPanelRequest' }, $true).Extent.Text
$receiver = $panelAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Receive-PetPanelRequest' }, $true).Extent.Text
Assert ($transport -match '\.Proxy = \$null' -and $transport -match '\.AllowAutoRedirect = \$false') 'transport disables proxies and redirects'
Assert ($transport -match 'CachePolicy.*NoCacheNoStore') 'account response cache is never persisted'
Assert ($transport -match "Headers\['Authorization'\] = 'Bearer '" -and $transport -match 'Timeout = 15000') 'Bearer authentication and bounded timeout'
Assert ($transport -match 'BeginGetResponse' -and $receiver -match 'EndGetResponse' -and $receiver -match 'BeginRead' -and $receiver -match 'IsCompleted') 'async header and body polling'
Assert ($transport -match 'BeginGetRequestStream' -and $receiver -match 'BeginWrite' -and $receiver -match 'EndWrite') 'POST body upload is asynchronous'
Assert ($receiver -match 'ContentLength -gt 16384' -and $receiver -match 'Bytes.Length \+ \$count -gt 16384') 'both declared and chunked payload capped at 16KB'
Assert ($transport -notmatch '\.GetResponse\(' -and $receiver -notmatch '\.ReadToEnd\(') 'no blocking response/body calls'

# Exercise the real asynchronous reader with memory-only response doubles.
function New-MemoryResponse([byte[]]$body, [long]$declaredLength = -1) {
  $stream = New-Object IO.MemoryStream(,$body)
  $response = [pscustomobject]@{ StatusCode = 200; ContentLength = $declaredLength; BodyStream = $stream }
  $response | Add-Member ScriptMethod GetResponseStream { return $this.BodyStream }
  $request = [pscustomobject]@{ Response = $response }
  $request | Add-Member ScriptMethod EndGetResponse { param($pending); return $this.Response }
  return [pscustomobject]@{ Request = $request; Response = $null; Stream = $null; Stage = 'response';
    Pending = [pscustomobject]@{ IsCompleted = $true }; Buffer = (New-Object byte[] 4096); Bytes = (New-Object IO.MemoryStream) }
}
$memory = New-MemoryResponse ([Text.Encoding]::UTF8.GetBytes('{"email":"memory@example.invalid"}'))
try {
  $result = Receive-PetPanelRequest $memory
  for ($i = 0; $i -lt 100 -and $result.Status -ceq 'pending'; $i++) { $result = Receive-PetPanelRequest $memory }
  Assert ($result.Status -ceq 'ready' -and $result.Value.email -ceq 'memory@example.invalid') 'real reader decodes memory-only async body'
} finally { $memory.Request.Response.BodyStream.Dispose(); $memory.Bytes.Dispose() }
foreach ($declared in @(16385, -1)) {
  $memory = New-MemoryResponse (New-Object byte[] 16385) $declared
  $rejected = $false
  try {
    $result = Receive-PetPanelRequest $memory
    for ($i = 0; $i -lt 100 -and $result.Status -ceq 'pending'; $i++) { $result = Receive-PetPanelRequest $memory }
  } catch { $rejected = $true }
  finally { $memory.Request.Response.BodyStream.Dispose(); $memory.Bytes.Dispose() }
  Assert $rejected 'real reader rejects declared or chunked over-16KB payload'
}
$memory = New-MemoryResponse ([byte[]]@(255))
$rejected = $false
try {
  $result = Receive-PetPanelRequest $memory
  for ($i = 0; $i -lt 100 -and $result.Status -ceq 'pending'; $i++) { $result = Receive-PetPanelRequest $memory }
} catch { $rejected = $true }
finally { $memory.Request.Response.BodyStream.Dispose(); $memory.Bytes.Dispose() }
Assert $rejected 'real reader rejects malformed UTF-8'
$memory = New-MemoryResponse ([byte[]]@(123, 125)); $memory.Pending.IsCompleted = $false
try { $result = Receive-PetPanelRequest $memory; Assert ($result.Status -ceq 'pending' -and $memory.Stage -ceq 'response') 'unfinished headers are never synchronously ended' }
finally { $memory.Request.Response.BodyStream.Dispose(); $memory.Bytes.Dispose() }

function Start-PetPanelRequest([string]$method, [string]$grant) {
  $script:Requests.Add([pscustomobject]@{ Method = $method; Grant = $grant }) | Out-Null
  if ($script:StartFailure) { throw 'SECRET RAW ERROR' }
  return [pscustomobject]@{ Method = $method; Revision = $script:PetCandidateRevision; StartedAt = [DateTime]::UtcNow; Stopped = $false }
}
function Receive-PetPanelRequest($operation) {
  $script:Receives++
  if ($script:ReceiveFailure) { throw 'SECRET RAW ERROR' }
  return $script:MockResult
}
function Stop-PetPanelRequest($operation) { if ($operation) { $operation.Stopped = $true; $script:Stops++ } }
function New-PanelValue {
  return [pscustomobject]@{ enabled = $true; canSwitch = $true; email = 'person.with.a.long.email.address@example.invalid'; selection = 'active';
    accountKey = '1234567890abcdef'; reason = ''; validForMs = 5000; grant = ('b' * 64) }
}
function Reset-Fixture {
  # Only test-generated environment values; no original token is copied or logged.
  $env:DSH_PET_PANEL_URL = 'http://127.0.0.1:49152/panel'
  $env:DSH_PET_PANEL_TOKEN = 'a' * 64
  Initialize-PetPanelAccounts
  $script:Prefs.billingMode = 'codex'; $script:Prefs.multiAccountManagement = $true
  $script:PetCandidateRevision = 'test-config-revision-1'
  $script:Preview = $false
  $script:Requests = New-Object 'Collections.Generic.List[object]'
  $script:Receives = 0; $script:Stops = 0
  $script:StartFailure = $false; $script:ReceiveFailure = $false
  $script:MockResult = [pscustomobject]@{ Status = 'pending' }
  Clear-PetPanelAccounts
}
function Complete-MockGet {
  $script:MockResult = [pscustomobject]@{ Status = 'ready'; Value = (New-PanelValue) }
  Update-PetPanelAccounts
}
Reset-Fixture
Assert ($null -eq $env:DSH_PET_PANEL_URL -and $null -eq $env:DSH_PET_PANEL_TOKEN) 'IPC environment immediately cleared'
Assert ($script:PetPanelEndpoint -ceq 'http://127.0.0.1:49152/panel' -and $script:PetPanelToken.Length -eq 64) 'strict valid endpoint retained only in memory'
foreach ($bad in @('http://localhost:123/panel','http://127.0.0.2:123/panel','https://127.0.0.1:123/panel','http://127.0.0.1:65536/panel','http://127.0.0.1:0/panel','http://user@127.0.0.1:123/panel','http://127.0.0.1:123/panel?x=1','http://127.0.0.1:123/panel#x','http://127.0.0.1:123/%70anel','http://127.0.0.1:123/panel/')) {
  $env:DSH_PET_PANEL_URL = $bad; $env:DSH_PET_PANEL_TOKEN = 'a' * 64; Initialize-PetPanelAccounts
  Assert ($null -eq $script:PetPanelEndpoint -and $null -eq $env:DSH_PET_PANEL_TOKEN) 'nonliteral endpoint rejected and env cleared'
}
foreach ($bad in @(('a' * 63), ('z' * 64), (('a' * 64) + "`n"))) {
  $env:DSH_PET_PANEL_URL = 'http://127.0.0.1:123/panel'; $env:DSH_PET_PANEL_TOKEN = $bad; Initialize-PetPanelAccounts
  Assert ($null -eq $script:PetPanelEndpoint -and $null -eq $script:PetPanelToken) 'invalid bearer rejected'
}
Reset-Fixture
$script:Prefs.multiAccountManagement = $false; Update-PetPanelAccounts
Assert ($script:Requests.Count -eq 1 -and $script:PanelAccountArea.Visibility -eq 'Visible') 'read-only identity does not depend on retired switch grant'
$readonly = New-PanelValue; $readonly.canSwitch = $false; $readonly.grant = $null; $readonly.email = 'p***@e***.invalid'
$script:MockResult = [pscustomobject]@{ Status = 'ready'; Value = $readonly }; Update-PetPanelAccounts
Invoke-PetPanelAccountSwitch
Assert ($script:Requests.Count -eq 1 -and -not $script:PanelAccountSwitch.IsEnabled) 'read-only response can never authorize POST'
Reset-Fixture
$script:Prefs.billingMode = 'deepseek'; Update-PetPanelAccounts
Assert ($script:Requests.Count -eq 0) 'DeepSeek forbids GET'
$script:Prefs.billingMode = 'codex'; $script:Preview = $true; Update-PetPanelAccounts
Assert ($script:Requests.Count -eq 0) 'Preview forbids GET'
$script:Preview = $false; Update-PetPanelAccounts
Assert ($script:Requests.Count -eq 1 -and $script:PanelAccountArea.Visibility -eq 'Visible') 'enabled Codex starts GET'
1..5 | ForEach-Object { Update-PetPanelAccounts }
Assert ($script:Requests.Count -eq 1 -and $script:PetPanelOperation.Method -ceq 'GET') 'at most one HTTP in flight'
Complete-MockGet
Assert ($script:PanelAccountEmail.Text.StartsWith('激活 · ') -and $script:PanelAccountEmail.ToolTip -ceq $script:PanelAccountEmail.Text) 'active semantic and full email tooltip'
Assert ($script:PanelAccountSwitch.IsEnabled) 'fresh grant enables switch'
Update-PetPanelAccounts
Assert ($script:Requests.Count -eq 1) 'GET throttled to 2 seconds'
$script:PetPanelState.selection = 'default'; Set-PetPanelAccountResponse $script:PetPanelState ([DateTime]::UtcNow) ([DateTime]::UtcNow)
Assert ($script:PanelAccountEmail.Text.StartsWith('默认 · ')) 'default semantic label'
$script:PetPanelExpiresAt = [DateTime]::UtcNow.AddMilliseconds(-1); Update-PetPanelAccounts
Assert (-not $script:PanelAccountSwitch.IsEnabled -and $null -eq $script:PanelAccountEmail.ToolTip -and $null -eq $script:PetPanelState) 'expiry clears email and grant'

Reset-Fixture; Update-PetPanelAccounts; $late = $script:PetPanelOperation
$script:Prefs.billingMode = 'deepseek'; Update-PetPanelAccounts
Assert ($late.Stopped -and $null -eq $script:PetPanelOperation -and $null -eq $script:PetPanelState) 'switch off aborts and detaches'
$script:MockResult = [pscustomobject]@{ Status = 'ready'; Value = (New-PanelValue) }; Update-PetPanelAccounts
Assert ($script:Receives -eq 0 -and $script:PanelAccountEmail.Text -ceq '') 'late response cannot restore off UI'
$script:Prefs.billingMode = 'codex'; Update-PetPanelAccounts; Complete-MockGet
Assert ($script:Requests.Count -eq 2 -and $script:PanelAccountSwitch.IsEnabled) 'reopen requires fresh GET'
$script:Prefs.billingMode = 'deepseek'; Update-PetPanelAccounts
Assert ($null -eq $script:PetPanelState -and $script:PanelAccountArea.Visibility -eq 'Collapsed') 'billing transition clears identity'

Reset-Fixture; Update-PetPanelAccounts; Complete-MockGet
Invoke-PetPanelAccountSwitch; Invoke-PetPanelAccountSwitch
Assert ($script:Requests.Count -eq 2 -and $script:Requests[1].Method -ceq 'POST' -and $script:Requests[1].Grant -ceq ('b' * 64)) 'double click sends exactly one cycle POST with grant'
Assert (-not $script:PanelAccountSwitch.IsEnabled -and $null -eq $script:PetPanelState) 'POST consumes local authorization before outcome'
$script:ReceiveFailure = $true; Update-PetPanelAccounts; $script:ReceiveFailure = $false
Invoke-PetPanelAccountSwitch
Assert ($script:Requests.Count -eq 2 -and $script:PanelAccountEmail.Text -ceq '切换结果待确认') 'failed POST never retries or claims success'
Assert ($script:PanelAccountEmail.Text -notmatch 'SECRET') 'raw errors never shown'
$script:PetPanelNextGetAt = [DateTime]::MinValue; Update-PetPanelAccounts
Assert ($script:Requests.Count -eq 3 -and $script:Requests[2].Method -ceq 'GET') 'reconciliation after unknown outcome uses GET only'

Reset-Fixture; Update-PetPanelAccounts; Complete-MockGet
$script:StartFailure = $true; Invoke-PetPanelAccountSwitch; Invoke-PetPanelAccountSwitch
Assert ($script:Requests.Count -eq 2 -and $null -eq $script:PetPanelState) 'POST startup failure is not repeated'
Reset-Fixture; Update-PetPanelAccounts; Complete-MockGet
function Reload-PetPreferences { param([switch]$Force); $script:PetCandidateRevision = 'consent-revoked' }
Invoke-PetPanelAccountSwitch
Assert ($script:Requests.Count -eq 1 -and $null -eq $script:PetPanelState) 'click rechecks current local setting, blocks stale handler'
Remove-Item Function:\Reload-PetPreferences
Reset-Fixture; Update-PetPanelAccounts; Complete-MockGet
$script:PetCandidateRevision = 'test-config-revision-2'; Invoke-PetPanelAccountSwitch
Assert ($script:Requests.Count -eq 1 -and $null -eq $script:PetPanelState) 'changed consent revision invalidates prior grant'
Reset-Fixture; Update-PetPanelAccounts; $old = $script:PetPanelOperation
$script:PetCandidateRevision = 'test-config-revision-2'; Complete-MockGet
Assert ($old.Stopped -and $null -eq $script:PetPanelState -and $script:Receives -eq 0) 'old request revision cannot populate reopened config'
Reset-Fixture; Update-PetPanelAccounts; $timeout = $script:PetPanelOperation
$timeout.StartedAt = [DateTime]::UtcNow.AddSeconds(-16); Update-PetPanelAccounts
Assert ($timeout.Stopped -and $null -eq $script:PetPanelOperation -and $script:PanelAccountEmail.Text -ceq '账号信息暂不可用') '15 second timeout aborts without raw exception'
Reset-Fixture; Update-PetPanelAccounts
$script:PetPanelOperation.StartedAt = [DateTime]::UtcNow.AddSeconds(-6); Complete-MockGet
Assert ($null -eq $script:PetPanelState -and -not $script:PanelAccountSwitch.IsEnabled) 'slow transfer does not extend freshness'
Reset-Fixture; Update-PetPanelAccounts
$bad = New-PanelValue; $bad.email = "private`nINJECT"; $script:MockResult = [pscustomobject]@{ Status = 'ready'; Value = $bad }; Update-PetPanelAccounts
Assert ($null -eq $script:PetPanelState -and $null -eq $script:PanelAccountEmail.ToolTip) 'invalid payload clears identity'
Reset-Fixture; Update-PetPanelAccounts; Complete-MockGet
Connect-PetPanelAccounts
$script:PanelAccountSwitch.IsEnabled = $true
$click = New-Object Windows.RoutedEventArgs([Windows.Controls.Button]::ClickEvent)
$script:PanelAccountSwitch.RaiseEvent($click)
Assert ($click.Handled -and $script:Requests.Count -eq 2) 'real hidden button consumes routed click and sends once'
$closing = $script:PetPanelOperation; Close-PetPanelAccounts; Update-PetPanelAccounts; Invoke-PetPanelAccountSwitch
Assert ($closing.Stopped -and $script:PetPanelClosed -and $null -eq $script:PetPanelToken -and $null -eq $script:PetPanelEndpoint -and $script:Requests.Count -eq 2) 'Closed cancels clears secret and blocks all future work'
$script:Window.Close()
# Real layout/theme/size integration; bootstrap contains no live top-level startup or IO.
$protocolAssertions = $script:Assertions
$ProjectRoot = $root
$fixture = [IO.File]::ReadAllText((Join-Path $root 'companion.test.ps1'))
$start = $fixture.IndexOf('`$ErrorActionPreference ='.Replace('`', ''))
$end = $fixture.IndexOf('$baseActivity =')
if ($start -lt 0 -or $end -lt $start) { throw 'Missing isolated WPF bootstrap boundary' }
Invoke-Expression $fixture.Substring($start, $end - $start)
$script:Assertions += $protocolAssertions
foreach ($name in @('PanelAccountArea', 'PanelAccountEmail', 'PanelAccountSwitch')) { Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name) }
$script:ApplyingPetPreferences = $true
try {
  foreach ($compact in @($false, $true)) { foreach ($size in @('tiny','small','medium','large')) { foreach ($theme in $script:CardThemeCatalog.id) {
    $script:Prefs.billingMode = 'codex'; $script:Prefs.compactMode = $compact; $script:Prefs.size = $size; $script:Prefs.cardTheme = $theme
    $script:Prefs.multiAccountManagement = $true
    Update-PetUsageCard; Update-PetCardTheme $false; Set-PetSize
    Assert-Equal $script:Card.Height 184 'email footer adds only 28 logical pixels'
    Assert-Equal $script:Root.Height $(if ($compact) { 194 } else { 388 }) 'classic and compact contain footer without clipping'
    Assert-Equal $script:Window.Height ($script:Root.Height * $script:Sizes[$size]) 'native host size matches footer'
    Assert-Equal $script:PanelAccountArea.Visibility 'Visible' 'enabled Codex account area visible'
    Assert-Equal $script:Window.Left 123 'does not save or move left coordinate'
    Assert-Equal $script:Window.Top 234 'does not save or move top coordinate'
    $script:Prefs.multiAccountManagement = $false; Update-PetUsageCard; Set-PetSize
    Assert-Equal $script:Card.Height 184 'read-only identity preserves footer without old grant'
    Assert-Equal $script:PanelAccountArea.Visibility 'Visible' 'read-only Codex identity remains visible'
  } } }
  if ($requestedCapture) {
    $script:Prefs.multiAccountManagement = $true; $script:Prefs.compactMode = $true; $script:Prefs.size = 'medium'; $script:Prefs.cardTheme = 'default'
    Update-PetUsageCard; Update-PetCardTheme $false; Set-PetSize
    $script:PanelAccountEmail.Text = 'demo.account@example.com'; $script:PanelAccountSwitch.IsEnabled = $true
    $script:Root.Measure([Windows.Size]::new(272,194)); $script:Root.Arrange([Windows.Rect]::new(0,0,272,194)); $script:Root.UpdateLayout()
    $image = [Windows.Media.Imaging.RenderTargetBitmap]::new(544,388,192,192,[Windows.Media.PixelFormats]::Pbgra32)
    $image.Render($script:Root)
    $png = [Windows.Media.Imaging.PngBitmapEncoder]::new(); $png.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($image))
    $stream = [IO.File]::Create($requestedCapture); try { $png.Save($stream) } finally { $stream.Dispose() }
  }
} finally { $script:ApplyingPetPreferences = $false; $script:Window.Close() }
Write-Output ('PASS panel-accounts.test.ps1: ' + $script:Assertions + ' assertions; real hidden XAML, mock transport, no user files or real requests.')
