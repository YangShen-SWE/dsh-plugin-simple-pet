# Pure WPF presentation controls. No timers, persistence, network, or model calls.
function Get-PetFeedbackPolicy($prefs = $script:Prefs) {
  $quiet = $prefs.quietMode -eq $true
  $static = $quiet -or ($prefs.reduceMotion -eq $true)
  $gentle = $prefs.feedbackStyle -ceq 'gentle'
  return [pscustomobject]@{
    Quiet = $quiet; Static = $static; Gentle = $gentle
    Flash = -not ($static -or $gentle -or ($prefs.disableFlashes -eq $true))
    Floats = -not ($static -or ($prefs.disableFloats -eq $true))
  }
}

function Get-PetVisualAction([string]$action) {
  $policy = Get-PetFeedbackPolicy
  if ($action -eq 'sleep') { return 'sleep' }
  if ($policy.Static) { return 'idle' }
  if ($policy.Gentle -and $action -notin @('idle', 'blink')) { return 'idle' }
  return $action
}

function Reset-PetFeedbackEffects([DateTime]$now) {
  # Remove clocks as well as resetting base values (infinite sleep loops included).
  foreach ($entry in @(
    @{ target = $script:Move; property = [Windows.Media.TranslateTransform]::XProperty; value = 0.0 },
    @{ target = $script:Move; property = [Windows.Media.TranslateTransform]::YProperty; value = 0.0 },
    @{ target = $script:Scale; property = [Windows.Media.ScaleTransform]::ScaleXProperty; value = 1.0 },
    @{ target = $script:Scale; property = [Windows.Media.ScaleTransform]::ScaleYProperty; value = 1.0 },
    @{ target = $script:Rotate; property = [Windows.Media.RotateTransform]::AngleProperty; value = 0.0 },
    @{ target = $script:BalanceScale; property = [Windows.Media.ScaleTransform]::ScaleXProperty; value = 1.0 },
    @{ target = $script:BalanceScale; property = [Windows.Media.ScaleTransform]::ScaleYProperty; value = 1.0 },
    @{ target = $script:OldSprite; property = [Windows.UIElement]::OpacityProperty; value = 0.0 },
    @{ target = $script:SleepMark; property = [Windows.UIElement]::OpacityProperty; value = 1.0 }
  )) {
    if ($null -ne $entry.target) {
      $entry.target.BeginAnimation($entry.property, $null)
      $entry.target.SetValue($entry.property, $entry.value)
    }
  }
  if ($script:OldSprite) { $script:OldSprite.Source = $null }
  if ($script:SleepMark) { $script:SleepMark.Visibility = 'Collapsed' }
  if ($script:CriticalMark) { $script:CriticalMark.Visibility = 'Collapsed' }
  if ($script:Card -and $script:CardBaseBorder) { $script:Card.BorderBrush = $script:CardBaseBorder }
  $script:FlashEnd = [DateTime]::MaxValue; $script:MarkEnd = [DateTime]::MaxValue
  if ($script:ActiveFloats) {
    foreach ($entry in $script:ActiveFloats) {
      $entry.control.BeginAnimation([Windows.Controls.Canvas]::TopProperty, $null)
      $entry.control.BeginAnimation([Windows.UIElement]::OpacityProperty, $null)
      if ($script:Root) { $script:Root.Children.Remove($entry.control) }
    }
    $script:ActiveFloats.Clear()
  }
  if ($null -ne $script:Queue) { $script:Queue.Clear() }
  $script:Current = if (($now - $script:LastActivityAt).TotalMinutes -ge [double]$script:Prefs.sleepMinutes) { 'sleep' } else { 'idle' }
  $script:ActionEnd = $now; $script:NextEventAt = $now; $script:NextIdlePulse = $now
  $script:LastFrameKey = ''; $script:IdleMotionActive = $false
}

function Update-PetSpriteFrame([bool]$peak) {
  if ($null -eq $script:Sprite -or $null -eq $script:OldSprite) { return }
  $policy = Get-PetFeedbackPolicy
  $mode = if ($peak) { 'peak' } else { 'valley' }
  $action = Get-PetVisualAction $script:Current
  $key = "$($script:Prefs.skin)-$mode-$action"
  if ($key -eq $script:LastFrameKey) { return }
  if (-not $policy.Static -and $null -ne $script:Sprite.Source) {
    $script:OldSprite.Source = $script:Sprite.Source
    $fade = New-Object Windows.Media.Animation.DoubleAnimation
    $fade.From = 1; $fade.To = 0
    $fade.Duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds($(if ($script:LastPeak -ne $peak) { 180 } else { 100 })))
    $script:OldSprite.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
  } else {
    $script:OldSprite.BeginAnimation([Windows.UIElement]::OpacityProperty, $null)
    $script:OldSprite.Opacity = 0; $script:OldSprite.Source = $null
  }
  $script:Sprite.Source = Get-Frame $script:Prefs.skin $mode $action
  $script:LastFrameKey = $key
}

function Sync-PetFeedbackPolicy {
  if ($null -eq $script:Window -or $null -eq $script:Sprite -or $null -eq $script:OldSprite) { return }
  $policy = Get-PetFeedbackPolicy
  $key = "$($policy.Quiet)|$($policy.Static)|$($policy.Gentle)|$($policy.Flash)|$($policy.Floats)"
  if ($key -ceq $script:AppliedFeedbackKey) { return }
  $previous = $script:AppliedFeedbackPolicy
  $script:AppliedFeedbackKey = $key; $script:AppliedFeedbackPolicy = $policy
  $now = [DateTime]::UtcNow
  # First active-mode tick keeps the legacy queue/animation startup untouched.
  if ($null -eq $previous -and -not $policy.Static) { return }
  Reset-PetFeedbackEffects $now
  # Consume the current snapshot at both static-mode boundaries; never replay it.
  if ($null -eq $previous -or $previous.Static -ne $policy.Static -or $previous.Quiet -ne $policy.Quiet) {
    $script:SkipPresentationSnapshot = $true
    $script:FileTicks = $null
  }
  $peak = if ((Get-BillingMode) -eq 'codex') { $false } elseif ($Preview) { [bool]$script:PreviewPeak } else { Get-Peak }
  if (-not $policy.Static) {
    if ($script:Current -eq 'sleep') { Start-SleepMotion $peak } else { Start-IdleMotion $peak }
  }
  Update-PetSpriteFrame $peak
}
