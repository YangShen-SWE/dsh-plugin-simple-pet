# PS5.1 -STA; production AST + invisible native WPF, private Temp only.
# Never starts pet.ps1, a host, models, accounts, or reads real LocalAppData.
param([string]$ProjectRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Receipt tests require -STA.' }
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:Assertions = 0
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }; $script:Assertions++
}
function Assert-Equal($actual, $expected, [string]$message) { Assert-True ($actual -ceq $expected) "$message (expected '$expected', actual '$actual')" }
function Get-FunctionText($ast, [string]$name) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if ($null -eq $node) { throw "Missing production function: $name" }; return $node.Extent.Text
}
$asts = @{}
foreach ($name in @('pet.ps1', 'preferences-applied.ps1', 'preferences-applied.test.ps1')) {
  $path = Join-Path $ProjectRoot $name
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) "$name preserves PS5.1 BOM"
  $tokens = $null; $errors = $null
  $asts[$name] = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Assert-Equal $errors.Count 0 "$name parses in PS5.1"
}
$petAst = $asts['pet.ps1']; $helperAst = $asts['preferences-applied.ps1']
foreach ($node in $helperAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $node.Extent.Text }
. (Join-Path $ProjectRoot 'skin-catalog.ps1')
. (Join-Path $ProjectRoot 'card-themes.ps1')
. (Join-Path $ProjectRoot 'companion-view.ps1')
. (Join-Path $ProjectRoot 'usage-view.ps1')
foreach ($name in @('Prefs', 'Sizes', 'Cells')) {
  $node = $petAst.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq ('$script:' + $name) }, $true)
  Invoke-Expression $node.Extent.Text
}
foreach ($name in @('Set-PetPreferenceValues', 'Reload-PetPreferences', 'Get-Frame', 'Read-PetState', 'Set-PetSize', 'Set-ModeVisual', 'Format-Cost', 'Start-Event', 'Start-Track', 'Start-IdleMotion', 'Start-SleepLoop', 'Start-SleepMotion', 'Start-EventMotion', 'Clear-ExpiredFloats')) { Invoke-Expression (Get-FunctionText $petAst $name) }
function Get-Peak { return $false }
$script:Preview = $false; $script:PreviewSleep = $false; $script:DshProfile = 'desktop'
$script:PetRunId = [guid]::NewGuid().ToString()
$temp = Join-Path ([IO.Path]::GetTempPath()) ('DshPreferencesApplied-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
$script:DataDir = $temp
$script:SettingsFile = Join-Path $temp 'settings.json'; $script:StateFile = Join-Path $temp 'state-desktop.json'
$script:PositionFile = Join-Path $temp 'position.json'
$script:Window = $null; $script:NextPrefsReload = [DateTime]::MinValue
$script:ApplyingPetPreferences = $false
$script:SnapshotReadCount = 0
$script:ProductionReadSnapshot = ${function:Read-PetPreferenceSnapshot}
function Read-PetPreferenceSnapshot([string]$path) { $script:SnapshotReadCount++; & $script:ProductionReadSnapshot $path }
function Write-Settings([string]$text, [switch]$Bom) {
  [IO.File]::WriteAllText($script:SettingsFile, $text, [Text.UTF8Encoding]::new([bool]$Bom))
}
function Read-Receipt { return ([IO.File]::ReadAllText($script:PetReceiptFile, [Text.Encoding]::UTF8) | ConvertFrom-Json) }
function Hash-Bytes([byte[]]$bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Assert-Pending([string]$message) {
  $receipt = Read-Receipt
  Assert-Equal $receipt.status 'pending' $message
  foreach ($key in @('revision', 'values', 'appliedAt')) { Assert-True ($null -eq $receipt.PSObject.Properties[$key]) "pending omits $key" }
  Assert-Equal $receipt.runId $PetRunId 'pending carries current run identity'
  Assert-Equal $receipt.pid $PID 'pending carries actual child PID'
}
function Assert-NoTemps { Assert-Equal @(Get-ChildItem -LiteralPath $temp -Filter '*.tmp').Count 0 'atomic operation leaves no unique temporary' }
try {
  Initialize-PetPreferencesReceipt
  $base = '{"size":"tiny","cardTheme":"forest","skin":"night","feedbackStyle":"gentle","reduceMotion":true,"unknown":{"x":1},"left":999,"top":888}' + "`r`n"
  Write-Settings $base -Bom
  Reload-PetPreferences -Force
  $revision = Hash-Bytes ([IO.File]::ReadAllBytes($script:SettingsFile))
  Assert-Equal $script:PetCandidateRevision $revision 'BOM-inclusive full raw-byte hash is decoded snapshot revision'
  Assert-Equal $script:Prefs.skin 'night' 'BOM decoder loads actual native preferences'
  Assert-Equal $script:SnapshotReadCount 1 'startup snapshot uses one production read'
  Complete-PetPreferencesApplication
  Assert-True (-not [IO.File]::Exists($script:PetReceiptFile)) 'startup before WPF Loaded cannot publish success'
  $readText = Get-FunctionText $helperAst 'Read-PetPreferenceSnapshot'
  Assert-Equal ([regex]::Matches($readText, 'ReadAllBytes\(')).Count 1 'production snapshot contains exactly one raw-byte read'
  Assert-True ($readText -notmatch 'Get-Content|ReadAllText') 'hash and decode cannot read separate snapshots'

  # Real native controls, actual atlases and production timer. No full pet execution.
  $literal = $petAst.Find({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('<Window') }, $true)
  $script:Window = [Windows.Markup.XamlReader]::Parse($literal.Value)
  foreach ($name in @('Root', 'Card', 'Sprite', 'OldSprite', 'SpriteLayer', 'DeepSeekPanel', 'CodexPanel', 'Balance', 'Rate', 'QuotaStatus', 'CriticalMark', 'SleepMark')) { Set-Variable -Name $name -Scope Script -Value $script:Window.FindName($name) }
  $script:ModeLabel = $script:Window.FindName('Mode')
  $script:Move = [Windows.Media.TranslateTransform]::new(); $script:Rotate = [Windows.Media.RotateTransform]::new()
  $script:Scale = [Windows.Media.ScaleTransform]::new(); $script:BalanceScale = [Windows.Media.ScaleTransform]::new()
  $transforms = [Windows.Media.TransformGroup]::new()
  $transforms.Children.Add($script:Scale); $transforms.Children.Add($script:Rotate); $transforms.Children.Add($script:Move)
  $script:SpriteLayer.RenderTransform = $transforms; $script:Balance.RenderTransform = $script:BalanceScale
  $script:Queue = New-Object 'Collections.Generic.Queue[object]'; $script:ActiveFloats = New-Object Collections.ArrayList
  $script:Atlases = @{}; $script:Frames = @{}
  foreach ($skin in $script:SkinCatalog.id) { foreach ($mode in @('valley', 'peak')) {
    $bitmap = [Windows.Media.Imaging.BitmapImage]::new(); $bitmap.BeginInit()
    $bitmap.UriSource = [uri](Join-Path $ProjectRoot "assets/$skin-$mode.png")
    $bitmap.CacheOption = 'OnLoad'; $bitmap.EndInit(); $bitmap.Freeze(); $script:Atlases["$skin-$mode"] = $bitmap
  } }
  $script:LastActivityAt = [DateTime]::UtcNow; $activity = $script:LastActivityAt
  $script:LastUpdate = [DateTime]::MinValue; $script:LastBlink = [DateTime]::UtcNow
  $script:ActionEnd = [DateTime]::UtcNow; $script:NextEventAt = [DateTime]::UtcNow
  $script:NextIdlePulse = [DateTime]::UtcNow; $script:LastFrameKey = ''; $script:LastPeak = $null
  $script:FlashEnd = [DateTime]::MaxValue; $script:MarkEnd = [DateTime]::MaxValue
  $script:Current = 'idle'; $script:LastSnapshot = $null; $script:SettingsWindow = $null
  $script:LastWarmupAlert = $null; $script:AppliedFeedbackKey = $null; $script:AppliedFeedbackPolicy = $null
  $script:Timer = New-Object Windows.Threading.DispatcherTimer
  $timerAst = $petAst.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Extent.Text.StartsWith('$script:Timer.Add_Tick(') }, $true)
  $tick = $timerAst.Arguments[0].ScriptBlock.GetScriptBlock()
  $loadedAst = $petAst.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Extent.Text -eq '$script:Window.Add_Loaded({ Start-PetPreferencesReceipt })' }, $true)
  Assert-True ($null -ne $loadedAst) 'real production Loaded handler is present'
  Invoke-Expression $loadedAst.Extent.Text
  # Production startup size/layout functions, suppress fixture-only coordinate save.
  $script:ApplyingPetPreferences = $true
  try { Update-PetUsageCard; Set-PetSize } finally { $script:ApplyingPetPreferences = $false }
  # Actual Loaded lifecycle, fully invisible/off-screen and never activated.
  $script:Window.ShowActivated = $false; $script:Window.Opacity = 0
  $script:Window.Left = -32000; $script:Window.Top = -32000
  $script:Window.Show()
  [void]$script:Window.Dispatcher.Invoke([Action]{ }, [Windows.Threading.DispatcherPriority]::ApplicationIdle)
  $script:Window.Hide()
  # WPF snaps native coordinates to physical pixels. Choose representable DIPs
  # so this invariant is valid at 100%, 125%, 150% and mixed-DPI desktops.
  $nativeDpi = [Windows.Media.VisualTreeHelper]::GetDpi($script:Window)
  $nativeLeft = [Math]::Ceiling(123 * $nativeDpi.DpiScaleX) / $nativeDpi.DpiScaleX
  $nativeTop = [Math]::Ceiling(234 * $nativeDpi.DpiScaleY) / $nativeDpi.DpiScaleY
  $script:Window.Left = $nativeLeft; $script:Window.Top = $nativeTop
  Assert-True $script:Window.IsLoaded 'hidden real WPF Window reaches actual Loaded'
  Assert-Pending 'Loaded revokes predecessor state before full timer success'
  # Startup creation normally already sized the real window. Reapply via genuine reload fixture.
  Reload-PetPreferences -Force
  Assert-Pending 'successful reload alone is not full application success'
  & $tick
  $receipt = Read-Receipt
  Assert-Equal $receipt.status 'applied' 'only complete normal tick publishes applied'
  Assert-Equal $receipt.revision $revision 'receipt uses exact raw-byte revision'
  Assert-Equal $receipt.profile 'desktop' 'receipt profile matches backend launch'
  Assert-Equal $receipt.runId $PetRunId 'receipt runId matches launch token'
  Assert-Equal $receipt.pid $PID 'receipt PID is real native test child'
  Assert-True ($receipt.appliedAt -is [long] -and $receipt.heartbeatAt -is [long]) 'UTC timestamps are millisecond integers'
  $js = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'preferences.js'), [Text.Encoding]::UTF8)
  $defaults = [regex]::Match($js, '(?s)DEFAULT_PREFERENCES = Object\.freeze\(\{(.*?)\}\)').Groups[1].Value
  $keys = @([regex]::Matches($defaults, '([A-Za-z][A-Za-z0-9_]*)\s*:') | ForEach-Object { $_.Groups[1].Value } | Sort-Object)
  $receiptKeys = @($receipt.values.PSObject.Properties.Name | Sort-Object)
  Assert-Equal ($receiptKeys -join ',') ($keys -join ',') 'receipt whitelist exactly matches JS DEFAULT_PREFERENCES'
  Assert-Equal $receipt.values.size 'tiny' 'actual native size recorded'
  Assert-Equal $script:Window.Width 170 'real production resize applies'
  Assert-Equal $script:Window.Left $nativeLeft 'reload never moves native left'
  Assert-Equal $script:Window.Top $nativeTop 'reload never moves native top'
  Assert-Equal $script:LastActivityAt $activity 'receipt/retry never resets real activity'
  Assert-True ($script:Sprite.Source -eq (Get-Frame 'night' 'valley' 'idle')) 'actual atlas frame matches gentle/static normal path'
  Assert-True ($script:Card.Background -is [Windows.Media.LinearGradientBrush]) 'actual production theme creates native gradient'
  Assert-Equal $receipt.values.cardTheme 'forest' 'native theme value was actually loaded'
  Assert-Equal ($script:Card.Background.GradientStops[0].Color.ToString()) (Get-PetCardPalette 'forest' 'deepseek' $false).start 'real gradient uses chosen theme palette'
  Assert-True (-not [IO.File]::Exists($script:PositionFile)) 'reload does not create position file'

  $before = [IO.File]::ReadAllText($script:PetReceiptFile); $reads = $script:SnapshotReadCount
  # Pin the not-due boundaries: real WPF work or host scheduling can exceed 1s.
  # The next block explicitly expires the heartbeat deadline; later blocks
  # expire the reload deadline and verify an actual changed-byte reload.
  $script:NextPrefsReload = [DateTime]::MaxValue
  $script:PetReceiptNextWriteAt = [DateTime]::MaxValue
  & $tick; & $tick
  Assert-Equal ([IO.File]::ReadAllText($script:PetReceiptFile)) $before 'full ticks before heartbeat deadline cannot renew evidence'
  Assert-Equal $script:SnapshotReadCount $reads 'full ticks before reload deadline cannot reread preferences'
  $script:PetReceiptNextWriteAt = [DateTime]::UtcNow.AddSeconds(-1)
  & $tick
  Assert-Equal (Read-Receipt).appliedAt $receipt.appliedAt 'heartbeat preserves original appliedAt'
  Assert-True ((Read-Receipt).heartbeatAt -ge $receipt.heartbeatAt) 'due heartbeat remains UTC milliseconds'
  Assert-True ($script:PetReceiptNextWriteAt -gt [DateTime]::UtcNow.AddSeconds(4)) 'heartbeat schedules next write five seconds later'

  $mtime = [IO.File]::GetLastWriteTimeUtc($script:SettingsFile)
  Write-Settings ($base.Replace('"tiny"', '"large"')) -Bom
  [IO.File]::SetLastWriteTimeUtc($script:SettingsFile, $mtime)
  $script:NextPrefsReload = [DateTime]::MinValue
  & $tick
  Assert-Equal $script:Prefs.size 'large' 'unchanged mtime cannot hide changed settings bytes'
  Assert-Equal (Read-Receipt).revision (Hash-Bytes ([IO.File]::ReadAllBytes($script:SettingsFile))) 'same-mtime revision commits only after complete tick'
  Assert-Equal $script:Window.Width 340 'same-mtime new size reaches actual WPF'

  # Exceptions occur inside the real production tick/reload, not duplicate logic.
  $script:ProductionFrame = ${function:Get-Frame}; $script:FailFrame = $true
  function Get-Frame([string]$skin, [string]$mode, [string]$action) {
    if ($script:FailFrame) { throw 'Injected native frame failure.' }; & $script:ProductionFrame $skin $mode $action
  }
  $script:LastFrameKey = ''; & $tick
  Assert-Pending 'full tick frame exception revokes previous success conservatively'
  Assert-True $script:PetPreferencesDirty 'failed tick forces same-revision visual retry'
  Assert-Equal $script:PetCandidateRevision $null 'failed tick cannot renew old successful revision'
  $script:FailFrame = $false; $script:NextPrefsReload = [DateTime]::MinValue
  & $tick
  Assert-Equal (Read-Receipt).status 'applied' 'same revision recovers only after successful repair/full tick'
  Assert-Equal $script:LastActivityAt $activity 'same-revision repair does not reset activity'
  $script:ProductionTheme = ${function:Update-PetCardTheme}; $script:FailTheme = $true
  function Update-PetCardTheme([bool]$peak) {
    if ($script:FailTheme) { $script:AppliedCardThemeKey = 'premature'; throw 'Injected native theme failure.' }; & $script:ProductionTheme $peak
  }
  Write-Settings '{"cardTheme":"default","reduceMotion":true,"sleepMinutes":10}'
  Reload-PetPreferences -Force
  Assert-Pending 'visual reload failure cannot be mistaken for loaded preferences'
  Assert-Equal $script:AppliedCardThemeKey $null 'failed theme cache invalidated'
  $script:FailTheme = $false; $script:NextPrefsReload = [DateTime]::MinValue
  & $tick; Assert-Equal (Read-Receipt).status 'applied' 'same failed theme revision is retried'
  $script:ProductionSync = ${function:Sync-PetFeedbackPolicy}; $script:FailPolicy = $true
  function Sync-PetFeedbackPolicy {
    if ($script:FailPolicy) { $script:AppliedFeedbackKey = 'premature'; throw 'Injected native policy failure.' }; & $script:ProductionSync
  }
  $oldKey = $script:AppliedFeedbackKey; & $tick
  Assert-Pending 'full tick policy exception becomes pending'
  Assert-Equal $script:AppliedFeedbackKey $oldKey 'optimistic feedback policy cache rolls back on failure'
  $script:FailPolicy = $false; $script:NextPrefsReload = [DateTime]::MinValue
  & $tick; Assert-Equal (Read-Receipt).status 'applied' 'policy failure repair retries same settings revision'
  [IO.File]::WriteAllText($script:StateFile, '{broken')
  & $tick; Assert-Pending 'state read/parse failure also forbids successful heartbeat'
  [IO.File]::WriteAllText($script:StateFile, '{"instance":"fixture","seq":0,"events":[]}')
  $script:NextPrefsReload = [DateTime]::MinValue; & $tick
  Assert-Equal (Read-Receipt).status 'applied' 'state read repair permits same preference revision after full tick'

  foreach ($text in @('{broken', '', 'null', '[]', '[{}]', 'true', '"string"')) {
    Write-Settings $text; Reload-PetPreferences -Force; & $tick
    Assert-Pending 'invalid object JSON cannot produce success or success heartbeat'
    foreach ($key in @('codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup')) { Assert-Equal $script:Prefs[$key] $false 'bad preferences disable automatic warmup' }
  }
  [IO.File]::WriteAllBytes($script:SettingsFile, [byte[]]@(123,34,120,34,58,34,255,34,125))
  Reload-PetPreferences -Force; & $tick; Assert-Pending 'strict UTF8 rejects illegal input bytes'
  $originalSettings = $script:SettingsFile; $script:SettingsFile = Join-Path $temp 'missing.json'
  Reload-PetPreferences -Force; & $tick; Assert-Pending 'missing JSON cannot acknowledge defaults as applied'
  $script:SettingsFile = $originalSettings
  Write-Settings '{"skin":"NIGHT","sleepMinutes":241,"quietMode":[true],"size":{},"codexWarmupTime":"09:30","codexWarmupDaily":[true]}'
  Reload-PetPreferences -Force; & $tick; $actual = Read-Receipt
  Assert-Equal $actual.values.skin 'NIGHT' 'receipt exposes PS case-sensitive value difference for backend fail-closed'
  Assert-Equal $actual.values.sleepMinutes 240 'receipt exposes native clamp versus JS fallback difference'
  Assert-Equal $actual.values.quietMode $false 'array native boolean rejected'
  Assert-Equal $actual.values.size 'medium' 'object enum type rejected'
  Assert-Equal $actual.values.codexWarmupDaily $false 'array warmup rejected'
  Write-Settings '{}'; Reload-PetPreferences -Force; & $tick

  # Actual mode/theme/size and sleep path, using only a synthetic local snapshot.
  $activityMs = ([DateTimeOffset]$activity).ToUnixTimeMilliseconds()
  $script:LastSnapshot = [pscustomobject]@{ stats = [pscustomobject]@{ activityAt = $activityMs }; codexStats = [pscustomobject]@{ activityAt = $activityMs } }
  Write-Settings '{"billingMode":"codex","cardTheme":"amber","size":"small","skin":"snow","reduceMotion":true,"feedbackStyle":"gentle"}'
  Reload-PetPreferences -Force; & $tick
  $modeReceipt = Read-Receipt
  Assert-Equal $modeReceipt.status 'applied' 'real Codex mode transition reaches full success'
  Assert-Equal $modeReceipt.values.billingMode 'codex' 'receipt reports actual transitioned billing mode'
  Assert-Equal $script:CodexPanel.Visibility 'Visible' 'actual Codex panel displayed'
  Assert-Equal $script:DeepSeekPanel.Visibility 'Collapsed' 'actual DeepSeek panel hidden'
  Assert-Equal $script:Window.Height 330 'actual small Codex height includes the account row'
  Assert-Equal ($script:Card.Background.GradientStops[0].Color.ToString()) (Get-PetCardPalette 'amber' 'codex' $false).start 'actual Codex palette applies before receipt'
  $script:LastActivityAt = [DateTime]::UtcNow.AddMinutes(-30); $sleepActivity = $script:LastActivityAt
  & $tick
  Assert-Equal $script:Current 'sleep' 'real timer enters genuine static sleep'
  Assert-Equal $script:LastActivityAt $sleepActivity 'sleep/heartbeat never invents new activity'
  Assert-True ($script:Sprite.Source -eq (Get-Frame 'snow' 'valley' 'sleep')) 'real sleep pose is retained with reduceMotion'
  Assert-Equal (Read-Receipt).status 'applied' 'normal genuine sleep remains confirmed'
  Write-Settings '{}'; Reload-PetPreferences -Force; $script:LastActivityAt = $activity; & $tick
  Assert-Equal $script:DeepSeekPanel.Visibility 'Visible' 'return to native DeepSeek panel completes normally'
  Assert-Equal $script:Window.Left $nativeLeft 'real mode transitions preserve left'
  Assert-Equal $script:Window.Top $nativeTop 'real mode transitions preserve top'
  $script:LastSnapshot = $null

  # IO failures are harmless, atomic, cleaned and never mutate settings/coordinates.
  $settingsBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:SettingsFile))
  $destination = $script:PetReceiptFile; $oldReceipt = [IO.File]::ReadAllText($destination)
  $payload = [ordered]@{version=1;status='pending';profile=$DshProfile;runId=$PetRunId;pid=$PID;heartbeatAt=1}
  $lock = [IO.File]::Open($destination, 'Open', 'Read', 'None')
  try { Assert-True (-not (Write-PetPreferencesReceipt $payload)) 'locked existing destination does not crash publisher' } finally { $lock.Dispose() }
  Assert-NoTemps; Assert-Equal ([IO.File]::ReadAllText($destination)) $oldReceipt 'failed destination access preserves prior receipt'
  # Hold Delete-sharing read: ownership reads succeed, File.Replace fails at atomic commit.
  $lock = [IO.File]::Open($destination, 'Open', 'Read', 'ReadWrite')
  try { Assert-True (-not (Write-PetPreferencesReceipt $payload)) 'atomic replace failure after temp write is contained' } finally { $lock.Dispose() }
  Assert-NoTemps; Assert-Equal ([IO.File]::ReadAllText($destination)) $oldReceipt 'failed atomic replace preserves destination'
  $directoryDestination = Join-Path $temp 'receipt-directory.json'; [void][IO.Directory]::CreateDirectory($directoryDestination)
  $script:PetReceiptFile = $directoryDestination
  Assert-True (-not (Write-PetPreferencesReceipt $payload)) 'atomic create/move failure after temp write is contained'
  Assert-NoTemps; $script:PetReceiptFile = $destination
  Assert-Equal ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:SettingsFile))) $settingsBytes 'receipt IO never overwrites preference bytes'

  # A live foreign run/profile is never overwritten; stale dead predecessor can be retired.
  $foreign = [ordered]@{version=1;status='applied';profile='desktop';runId='foreign-run';pid=$PID;revision='foreign';values=@{};heartbeatAt=1}
  [IO.File]::WriteAllText($destination, ($foreign | ConvertTo-Json -Compress)); $foreignBytes = [IO.File]::ReadAllText($destination)
  $script:PetReceiptNextWriteAt = [DateTime]::MinValue; Complete-PetPreferencesApplication
  Assert-Equal ([IO.File]::ReadAllText($destination)) $foreignBytes 'heartbeat cannot overwrite another run'
  Stop-PetPreferencesReceipt
  Assert-Equal ([IO.File]::ReadAllText($destination)) $foreignBytes 'normal close cannot revoke another run'
  Initialize-PetPreferencesReceipt; Start-PetPreferencesReceipt
  Assert-Equal ([IO.File]::ReadAllText($destination)) $foreignBytes 'new Loaded cannot steal live foreign run'
  $foreign.profile = 'web'; $foreign.pid = 0
  [IO.File]::WriteAllText($destination, ($foreign | ConvertTo-Json -Compress)); $foreignBytes = [IO.File]::ReadAllText($destination)
  Initialize-PetPreferencesReceipt; Start-PetPreferencesReceipt
  Assert-Equal ([IO.File]::ReadAllText($destination)) $foreignBytes 'mismatched profile cannot be claimed even with dead identity'
  $foreign.profile = 'desktop'; $foreign.pid = 2147483647
  [IO.File]::WriteAllText($destination, ($foreign | ConvertTo-Json -Compress))
  Initialize-PetPreferencesReceipt; Start-PetPreferencesReceipt
  Assert-Pending 'Loaded retires dead old-run successful receipt'
  Reload-PetPreferences -Force; & $tick; Assert-Equal (Read-Receipt).status 'applied' 'retired predecessor replaced by own full success'

  $desktopBytes = [IO.File]::ReadAllText($destination)
  $script:DshProfile = 'web'; $script:PetRunId = [guid]::NewGuid().ToString()
  Initialize-PetPreferencesReceipt; Start-PetPreferencesReceipt; Reload-PetPreferences -Force; & $tick
  Assert-Equal (Read-Receipt).profile 'web' 'web has independent profile receipt'
  Assert-Equal ([IO.File]::ReadAllText($destination)) $desktopBytes 'web cannot contaminate desktop receipt'
  $closedAst = $petAst.Find({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Extent.Text.StartsWith('$script:Window.Add_Closed(') }, $true)
  Assert-True ($null -ne $closedAst) 'normal close test uses actual production Closed handler'
  # Test-owned mutex only, never the real pet single-instance name.
  $script:SingleInstance = [Threading.Mutex]::new($true, ('Local\DshReceiptFixture-' + [guid]::NewGuid().ToString('N')))
  Invoke-Expression $closedAst.Extent.Text
  $script:Window.Close()
  Assert-Pending 'actual native Closed handler revokes only owned success'
  Assert-True (-not $script:Timer.IsEnabled) 'actual Closed handler stops the existing timer'
  $webBytes = [IO.File]::ReadAllText($script:PetReceiptFile)
  $script:Preview = $true
  Initialize-PetPreferencesReceipt; Start-PetPreferencesReceipt; Reload-PetPreferences -Force
  Complete-PetPreferencesApplication; Stop-PetPreferencesReceipt
  Assert-Equal $script:PetReceiptFile $null 'preview receipt disabled regardless launch identity'
  Assert-Equal ([IO.File]::ReadAllText((Join-Path $temp 'settings-applied-web.json'))) $webBytes 'preview never writes normal receipt'
  Assert-Equal ([IO.File]::ReadAllText($destination)) $desktopBytes 'preview never contaminates other profile'
  $script:Preview = $false; $script:DshProfile = 'desktop'; $script:PetRunId = ''
  Initialize-PetPreferencesReceipt; Start-PetPreferencesReceipt; Reload-PetPreferences -Force; & $tick
  Assert-Equal ([IO.File]::ReadAllText($destination)) $desktopBytes 'old manual launch without runId cannot claim/acknowledge'
  Assert-NoTemps
  Assert-Equal $script:LastActivityAt $activity 'receipt matrix preserves genuine activity'
  Assert-True (-not $script:Window.IsVisible) 'fixture ends with native window hidden'
  Write-Host "PASS: $script:Assertions native preferences-applied assertions; real hidden WPF AST reload/timer/helper; no live user data, full pet, host, accounts or requests."
} finally {
  if ($script:Window) { $script:Window.Close() }
  $resolved = [IO.Path]::GetFullPath($temp)
  if ($resolved -cne $temp -or -not $resolved.StartsWith([IO.Path]::GetTempPath()) -or [IO.Path]::GetFileName($resolved) -notmatch '^DshPreferencesApplied-[0-9a-f]{32}$') { throw 'Unsafe receipt fixture cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
