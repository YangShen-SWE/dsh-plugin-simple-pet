. (Join-Path $PSScriptRoot 'usage-view.ps1')
if (-not $script:CardThemeCatalog) { . (Join-Path $PSScriptRoot 'card-themes.ps1') }

function Get-StatDay([string]$key) {
  if ($null -eq $script:Stats -or $null -eq $script:Stats.days) { return $null }
  $property = $script:Stats.days.PSObject.Properties[$key]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Format-StatCny([double]$value) {
  if ($value -eq 0) { return '¥0.00' }
  if ($value -lt 1) { return '¥' + $value.ToString('0.########') }
  return '¥' + $value.ToString('N2')
}

function Add-ChartText($canvas, [string]$value, [double]$x, [double]$y, [double]$width = 56) {
  $label = New-Object Windows.Controls.TextBlock
  $label.Text = $value
  $label.Width = $width
  $label.TextAlignment = 'Center'
  $label.FontFamily = New-Object Windows.Media.FontFamily('Microsoft YaHei')
  $label.FontSize = 10
  $label.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#A9CEE2')
  [Windows.Controls.Canvas]::SetLeft($label, $x - $width / 2)
  [Windows.Controls.Canvas]::SetTop($label, $y)
  [void]$canvas.Children.Add($label)
}

function Update-SettingsStats {
  if ($null -eq $script:SettingsWindow -or -not $script:SettingsWindow.IsVisible) { return }
  $statsReady = $null -ne $script:Stats -and $null -ne $script:Stats.days
  $today = [DateTime]::Today
  $entry = Get-StatDay ($today.ToString('yyyy-MM-dd'))
  $tokens = if ($entry) { [int64]$entry.tokens } else { 0 }
  $script:SettingsTokens.Text = if ($statsReady) { $tokens.ToString('N0') } else { '—' }
  $script:SettingsCost.Text = if ($statsReady) { Format-StatCny $(if ($entry) { [double]$entry.cny } else { 0 }) } else { '—' }
  $inputTotal = if ($entry) { [double]$entry.inputTokens + [double]$entry.cacheReadTokens } else { 0 }
  $script:SettingsHitRate.Text = if ($inputTotal -gt 0) { '{0:N1}%' -f (100 * [double]$entry.cacheReadTokens / $inputTotal) } else { '—' }
  $script:SettingsNote.Text = if (-not $statsReady) {
    '等待 DSH 加载新版统计；重启 DSH 后，今日用量将从可用的记录开始显示。'
  } elseif ($entry -and [double]$entry.unpricedTokens -gt 0) {
    '部分 Token 的模型价格未知，人民币仅包含已计价部分。'
  } elseif ($script:Stats -and $script:Stats.partialSince) {
    '已补录升级时保存的最近事件；更早的历史可能缺失。人民币为用量估算。'
  } else { '人民币为用量估算；统计从本版本首次启用后开始。' }

  Update-SettingsCodexQuota
  $unit = if ((Get-BillingMode) -eq 'codex' -or $script:ChartUnit.SelectedIndex -eq 1) { 'tokens' } else { 'cny' }
  $range = $script:ChartRange.SelectedIndex
  $buckets = New-Object System.Collections.ArrayList
  if ($range -eq 0) {
    $offset = (([int]$today.DayOfWeek + 6) % 7)
    $first = $today.AddDays(-$offset)
    for ($i = 0; $i -lt 7; $i++) {
      $date = $first.AddDays($i)
      $value = Get-StatDay ($date.ToString('yyyy-MM-dd'))
      [void]$buckets.Add([pscustomobject]@{ label = @('一','二','三','四','五','六','日')[$i]; value = if ($value) { [double]$value.$unit } else { 0 } })
    }
  } elseif ($range -eq 1) {
    $count = [DateTime]::DaysInMonth($today.Year, $today.Month)
    for ($i = 1; $i -le $count; $i++) {
      $date = [DateTime]::new($today.Year, $today.Month, $i)
      $value = Get-StatDay ($date.ToString('yyyy-MM-dd'))
      [void]$buckets.Add([pscustomobject]@{ label = [string]$i; value = if ($value) { [double]$value.$unit } else { 0 } })
    }
  } else {
    for ($month = 1; $month -le 12; $month++) {
      $sum = 0.0
      $days = [DateTime]::DaysInMonth($today.Year, $month)
      for ($i = 1; $i -le $days; $i++) {
        $key = [DateTime]::new($today.Year, $month, $i).ToString('yyyy-MM-dd')
        $value = Get-StatDay $key
        if ($value) { $sum += [double]$value.$unit }
      }
      [void]$buckets.Add([pscustomobject]@{ label = [string]$month; value = $sum })
    }
  }

  $canvas = $script:ChartCanvas
  $canvas.Children.Clear()
  $canvasWidth = $canvas.ActualWidth
  if ($canvasWidth -le 0) { return } # Wait for layout, never invent a fixed-width canvas.
  $top = 18.0; $height = 158.0
  $max = 0.0
  foreach ($bucket in $buckets) { $max = [math]::Max($max, [double]$bucket.value) }
  $axisMax = if ($max -gt 0) { $max * 1.18 } else { 1.0 }
  $ticks = @()
  $axisLabelWidth = 36.0
  for ($line = 0; $line -le 3; $line++) {
    $tick = $axisMax * (1 - $line / 3)
    $tickText = if ($unit -eq 'tokens') { [math]::Round($tick).ToString('N0') } else { if ($tick -lt .01) { $tick.ToString('0.####') } else { $tick.ToString('0.##') } }
    $ticks += $tickText
    $measure = New-Object Windows.Controls.TextBlock
    $measure.Text = $tickText; $measure.FontSize = 10
    $measure.FontFamily = New-Object Windows.Media.FontFamily('Microsoft YaHei')
    $measure.Measure([Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity))
    $axisLabelWidth = [math]::Max($axisLabelWidth, [math]::Ceiling($measure.DesiredSize.Width))
  }
  $left = $axisLabelWidth + 14
  $width = [math]::Max(1, $canvasWidth - $left - 16)
  for ($line = 0; $line -le 3; $line++) {
    $y = $top + $height * $line / 3
    $grid = New-Object Windows.Shapes.Line
    $grid.X1 = $left; $grid.X2 = $left + $width; $grid.Y1 = $y; $grid.Y2 = $y
    $grid.Stroke = [Windows.Media.BrushConverter]::new().ConvertFromString('#345F78')
    $grid.StrokeThickness = 1
    [void]$canvas.Children.Add($grid)
    Add-ChartText $canvas $ticks[$line] ($axisLabelWidth / 2) ($y - 7) $axisLabelWidth
  }
  $path = New-Object Windows.Shapes.Polyline
  $path.Stroke = [Windows.Media.BrushConverter]::new().ConvertFromString('#6BE3FF')
  $path.StrokeThickness = 2.5
  $path.StrokeLineJoin = [Windows.Media.PenLineJoin]::Round
  for ($i = 0; $i -lt $buckets.Count; $i++) {
    $x = $left + $width * $i / [math]::Max(1, $buckets.Count - 1)
    $y = $top + $height * (1 - [double]$buckets[$i].value / $axisMax)
    [void]$path.Points.Add([Windows.Point]::new($x, $y))
    if ($buckets[$i].value -gt 0) {
      $dot = New-Object Windows.Shapes.Ellipse
      $dot.Width = 7; $dot.Height = 7
      $dot.Fill = [Windows.Media.Brushes]::LightCyan
      [Windows.Controls.Canvas]::SetLeft($dot, $x - 3.5)
      [Windows.Controls.Canvas]::SetTop($dot, $y - 3.5)
      [void]$canvas.Children.Add($dot)
    }
    $labelStep = [math]::Max(1, [math]::Ceiling(($buckets.Count - 1) * 30 / $width))
    if ($range -eq 1) { $labelStep = [math]::Max(7, $labelStep) }
    $showLabel = $i -eq 0 -or $i -eq ($buckets.Count - 1) -or $i % $labelStep -eq 0
    # Reserve room for the final tick rather than letting adjacent labels collide.
    if ($showLabel -and ($i -eq ($buckets.Count - 1) -or ($buckets.Count - 1 - $i) * $width / [math]::Max(1, $buckets.Count - 1) -ge 28)) {
      Add-ChartText $canvas $buckets[$i].label $x 184 28
    }
  }
  [void]$canvas.Children.Insert(4, $path)
  if ($max -eq 0) { Add-ChartText $canvas $(if ($statsReady) { '当前周期暂无记录' } else { '等待 DSH 加载统计' }) ($left + $width / 2) 95 ([math]::Min(160, $width)) }
}

function Update-SettingsLayout {
  if ($null -eq $script:SettingsWindow) { return }
  $settingsScroll = $script:SettingsWindow.FindName('SettingsScroll')
  $available = $settingsScroll.ViewportWidth
  if ($available -le 0) { $available = $settingsScroll.ActualWidth - 22 }
  $gallery = $script:SettingsWindow.FindName('SkinGallery')
  $gallery.Rows = 0
  $gallery.Columns = [math]::Max(1, [math]::Min(3, [math]::Floor(($available - 28) / 160)))
  # Grid star sizing supplies flex-shrink; narrow rows stack label and input.
  foreach ($name in @('BillingModeChoice', 'CardThemeChoice', 'SizeChoice', 'UnitChoice', 'CodexUnitChoice', 'SleepInput')) {
    $control = $script:SettingsWindow.FindName($name)
    $form = $control.Parent
    while ($form -and -not ($form -is [Windows.Controls.Grid])) { $form = $form.Parent }
    if ($null -eq $form -or $form.ColumnDefinitions.Count -ne 2) { continue }
    if ($form.RowDefinitions.Count -eq 0) {
      for ($i = 0; $i -lt 2; $i++) {
        $row = New-Object Windows.Controls.RowDefinition
        $row.Height = [Windows.GridLength]::Auto
        [void]$form.RowDefinitions.Add($row)
      }
    }
    $input = $form.Children[1]
    $narrow = $available -lt 460
    $form.ColumnDefinitions[1].Width = if ($narrow) { [Windows.GridLength]::new(0) } else { [Windows.GridLength]::Auto }
    [Windows.Controls.Grid]::SetColumn($input, $(if ($narrow) { 0 } else { 1 }))
    [Windows.Controls.Grid]::SetRow($input, $(if ($narrow) { 1 } else { 0 }))
    $input.Margin = [Windows.Thickness]::new(0, $(if ($narrow) { 10 } else { 0 }), 0, 0)
    $input.HorizontalAlignment = if ($narrow) { 'Left' } else { 'Stretch' }
  }
  $statsScroll = $script:SettingsWindow.FindName('StatsScroll')
  $statsWidth = $statsScroll.ViewportWidth
  if ($statsWidth -le 0) { $statsWidth = $statsScroll.ActualWidth - 22 }
  $script:SettingsWindow.FindName('StatsCards').Columns = if ($statsWidth -ge 540) { 3 } else { 1 }
}

function Get-SettingsSkinPreview([string]$skin, [string]$mode) {
  # Reuse frozen local frames across settings reopen; never decode in an event handler.
  if ($null -eq $script:SettingsSkinPreviewCache) { $script:SettingsSkinPreviewCache = @{} }
  $key = "$skin/$mode"
  if (-not $script:SettingsSkinPreviewCache.ContainsKey($key)) {
    $script:SettingsSkinPreviewCache[$key] = Get-Frame $skin $mode 'idle'
  }
  return $script:SettingsSkinPreviewCache[$key]
}

function Update-SettingsSkinSelection {
  foreach ($id in $script:SkinButtons.Keys) {
    $button = $script:SkinButtons[$id]
    $selected = [string]$script:Prefs.skin -eq [string]$id
    $button.Background = [Windows.Media.BrushConverter]::new().ConvertFromString($(if ($selected) { '#245F79' } else { '#153B57' }))
    $button.BorderBrush = [Windows.Media.BrushConverter]::new().ConvertFromString($(if ($selected) { '#80E6FF' } else { '#40738E' }))
    $button.BorderThickness = [Windows.Thickness]::new($(if ($selected) { 2 } else { 1 }))
    $script:SkinSelectionLabels[$id].Visibility = if ($selected) { 'Visible' } else { 'Hidden' }
    [Windows.Automation.AutomationProperties]::SetItemStatus($button, $(if ($selected) { '已选择' } else { '未选择' }))
  }
}

function Initialize-SettingsSkinGallery {
  $gallery = $script:SettingsWindow.FindName('SkinGallery')
  $script:SkinButtons = @{}
  $script:SkinSelectionLabels = @{}
  foreach ($skin in $script:SkinCatalog) {
    $id = [string]$skin.id
    $name = [Security.SecurityElement]::Escape([string]$skin.name)
    $cardXaml = @"
<Button xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Name="SkinCard_$id" Tag="$id" Height="153" Margin="4" Padding="9,8" Cursor="Hand"
        Focusable="True" IsTabStop="True" Foreground="White" FontFamily="Microsoft YaHei"
        AutomationProperties.Name="$name，峰时与谷时本地预览" ToolTip="选择$name">
  <Grid>
    <Grid.RowDefinitions><RowDefinition Height="25"/><RowDefinition Height="*"/></Grid.RowDefinitions>
    <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <TextBlock Text="$name" FontSize="12" FontWeight="SemiBold" VerticalAlignment="Center"/>
      <TextBlock Name="SkinSelection_$id" Grid.Column="1" Text="✓" FontSize="15" FontWeight="Bold" Foreground="#9BF2D2" VerticalAlignment="Center" Margin="3,0,0,0"/>
    </Grid>
    <Grid Grid.Row="1">
      <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
      <Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="19"/></Grid.RowDefinitions>
      <Image Name="SkinPreview_${id}_peak" Margin="1,2" Stretch="Uniform" SnapsToDevicePixels="True" AutomationProperties.Name="$name 峰时预览"/>
      <Image Name="SkinPreview_${id}_valley" Grid.Column="1" Margin="1,2" Stretch="Uniform" SnapsToDevicePixels="True" AutomationProperties.Name="$name 谷时预览"/>
      <TextBlock Name="SkinLabelPeak_$id" Grid.Row="1" Text="峰时" FontSize="10" Foreground="#D9F5FF" HorizontalAlignment="Center" VerticalAlignment="Bottom"/>
      <TextBlock Name="SkinLabelValley_$id" Grid.Row="1" Grid.Column="1" Text="谷时" FontSize="10" Foreground="#ADCDE8" HorizontalAlignment="Center" VerticalAlignment="Bottom"/>
    </Grid>
  </Grid>
</Button>
"@
    $button = [Windows.Markup.XamlReader]::Parse($cardXaml)
    $button.Style = $script:SettingsWindow.FindResource('SkinCardStyle')
    $script:SettingsWindow.RegisterName($button.Name, $button)
    $script:SkinButtons[$id] = $button
    $label = $button.FindName("SkinSelection_$id")
    $script:SkinSelectionLabels[$id] = $label
    foreach ($mode in @('peak', 'valley')) {
      $image = $button.FindName("SkinPreview_${id}_$mode")
      $image.Source = Get-SettingsSkinPreview $id $mode
      $script:SettingsWindow.RegisterName($image.Name, $image)
    }
    $button.Add_Click({
      param($sender, $eventArgs)
      # Use the sender's stable id: loop variables are not captured by PowerShell events.
      $id = [string]$sender.Tag
      if ([string]$script:Prefs.skin -eq $id) { return }
      $script:Prefs.skin = $id
      Save-Prefs
      Update-SettingsSkinSelection
    })
    $button.Add_PreviewKeyDown([Windows.Input.KeyEventHandler]{
      param($sender, $eventArgs)
      if ($eventArgs.Key -in @([Windows.Input.Key]::Enter, [Windows.Input.Key]::Space)) {
        $eventArgs.Handled = $true
        $sender.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
      }
    })
    [void]$gallery.Children.Add($button)
  }
  Update-SettingsSkinSelection
}

function Show-PetSettings {
  if ($script:SettingsWindow -and $script:SettingsWindow.IsVisible) {
    $script:SettingsWindow.FindName('SettingsTabs').SelectedIndex = 0
    [void]$script:SettingsWindow.Activate()
    Update-SettingsCodexWarmup
    return
  }
  $settingsXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="dsh-plugin-simple-pet 设置" Width="680" Height="625"
        WindowStyle="None" ResizeMode="CanResizeWithGrip" MinWidth="380" MinHeight="300" AllowsTransparency="True"
        Background="Transparent" ShowInTaskbar="False" Topmost="True">
  <Window.Resources>
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="14"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="ScrollBar">
          <Grid Background="Transparent" Margin="2,4">
            <Border Width="8" HorizontalAlignment="Center" Background="#102F49" CornerRadius="4"/>
            <Track Name="PART_Track" Orientation="Vertical" IsDirectionReversed="True" Width="10"
                   Minimum="{TemplateBinding Minimum}" Maximum="{TemplateBinding Maximum}"
                   Value="{TemplateBinding Value}" ViewportSize="{TemplateBinding ViewportSize}">
              <Track.DecreaseRepeatButton><RepeatButton Command="ScrollBar.PageUpCommand" Focusable="False">
                <RepeatButton.Template><ControlTemplate TargetType="RepeatButton"><Border Background="Transparent"/></ControlTemplate></RepeatButton.Template>
              </RepeatButton></Track.DecreaseRepeatButton>
              <Track.Thumb><Thumb MinHeight="30" Cursor="Hand" AutomationProperties.Name="滚动内容">
                <Thumb.Style><Style TargetType="Thumb">
                  <Setter Property="Background" Value="#46819B"/>
                  <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Thumb">
                    <Border Background="{TemplateBinding Background}" CornerRadius="4" Margin="1,0"/>
                  </ControlTemplate></Setter.Value></Setter>
                  <Style.Triggers>
                    <Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="#71DDF1"/></Trigger>
                    <Trigger Property="IsDragging" Value="True"><Setter Property="Background" Value="#B0F6FF"/></Trigger>
                  </Style.Triggers>
                </Style></Thumb.Style>
              </Thumb></Track.Thumb>
              <Track.IncreaseRepeatButton><RepeatButton Command="ScrollBar.PageDownCommand" Focusable="False">
                <RepeatButton.Template><ControlTemplate TargetType="RepeatButton"><Border Background="Transparent"/></ControlTemplate></RepeatButton.Template>
              </RepeatButton></Track.IncreaseRepeatButton>
            </Track>
          </Grid>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style TargetType="TextBlock"><Setter Property="TextWrapping" Value="Wrap"/></Style>
    <Style x:Key="SkinCardStyle" TargetType="Button">
      <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
      <Setter Property="VerticalContentAlignment" Value="Stretch"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="Button">
          <Border Name="CardBorder" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="11" Padding="{TemplateBinding Padding}">
            <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="{TemplateBinding VerticalContentAlignment}"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="CardBorder" Property="BorderBrush" Value="#B6F0FF"/></Trigger>
            <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="CardBorder" Property="BorderBrush" Value="#FFE2A7"/><Setter TargetName="CardBorder" Property="BorderThickness" Value="2"/></Trigger>
            <Trigger Property="IsPressed" Value="True"><Setter TargetName="CardBorder" Property="Opacity" Value="0.8"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style TargetType="TabItem">
      <Setter Property="Foreground" Value="#B9DEEE"/>
      <Setter Property="FontFamily" Value="Microsoft YaHei"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="TabItem">
          <Border Name="TabBorder" Background="#203F5D" BorderThickness="1" BorderBrush="Transparent" CornerRadius="9" Padding="25,9" Margin="0,0,10,0" Cursor="Hand">
            <ContentPresenter ContentSource="Header"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsSelected" Value="True"><Setter TargetName="TabBorder" Property="Background" Value="#23789B"/><Setter Property="Foreground" Value="White"/></Trigger>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="TabBorder" Property="BorderBrush" Value="#77CCEA"/><Setter TargetName="TabBorder" Property="BorderThickness" Value="1"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
  </Window.Resources>
  <Border CornerRadius="22" BorderThickness="1" BorderBrush="#82CEEC">
    <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
      <GradientStop Color="#102F51" Offset="0"/><GradientStop Color="#1B4964" Offset="1"/>
    </LinearGradientBrush></Border.Background>
    <Border.Effect><DropShadowEffect Color="#0A2039" BlurRadius="24" ShadowDepth="8" Opacity="0.55"/></Border.Effect>
    <Grid Margin="25,20,25,23">
      <Grid.RowDefinitions><RowDefinition Height="68"/><RowDefinition Height="*"/></Grid.RowDefinitions>
      <Grid Grid.Row="0">
        <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="42"/></Grid.ColumnDefinitions>
        <Grid Name="SettingsDragHandle" Background="Transparent" Cursor="SizeAll" Margin="0,0,10,0" ToolTip="按住标题栏拖动窗口">
          <StackPanel><TextBlock Text="设置与统计" FontFamily="Microsoft YaHei" FontSize="23" FontWeight="Bold" Foreground="White"/>
            <TextBlock Text="SIMPLE DESKTOP PET · 拖动标题栏移动" FontFamily="Microsoft YaHei" FontSize="10" Foreground="#9BCFE2"/></StackPanel>
        </Grid>
        <Button Name="CloseSettings" Grid.Column="1" Content="×" Width="32" Height="32" HorizontalAlignment="Right" VerticalAlignment="Top"
                FontSize="21" Foreground="White" Background="#315E7A" BorderBrush="#6599B6" Cursor="Hand" ToolTip="关闭设置，桌宠继续运行"/>
      </Grid>
      <TabControl Name="SettingsTabs" Grid.Row="1" SelectedIndex="0" Background="Transparent" BorderThickness="0">
        <TabControl.Template><ControlTemplate TargetType="TabControl">
          <Grid><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/></Grid.RowDefinitions>
            <TabPanel IsItemsHost="True"/>
            <ContentPresenter Grid.Row="1" ContentSource="SelectedContent" Margin="0,13,0,0"/>
          </Grid>
        </ControlTemplate></TabControl.Template>
        <TabItem Header="设置">
          <Grid><Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="56"/></Grid.RowDefinitions>
            <ScrollViewer Name="SettingsScroll" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Padding="0,0,8,0">
            <StackPanel>
              <Border Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12">
                <Grid Margin="16,14"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                  <StackPanel><TextBlock Text="计费模式" FontFamily="Microsoft YaHei" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
                    <TextBlock Text="仅切换桌宠显示，不改变 DSH 模型或登录账号" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#ABD2E3" Margin="0,5,0,0"/></StackPanel>
                  <ComboBox Name="BillingModeChoice" Grid.Column="1" Width="160" Height="31" VerticalAlignment="Center" Foreground="#17384F" Background="White">
                    <ComboBoxItem Content="DeepSeek 计费模式" Tag="deepseek"/><ComboBoxItem Content="Codex 订阅模式" Tag="codex"/>
                  </ComboBox>
                </Grid>
              </Border>
              <Border Name="CodexQuotaRefreshPanel" Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12">
                <StackPanel Margin="16,14" TextBlock.FontFamily="Microsoft YaHei">
                  <TextBlock Text="Codex 额度检测" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
                  <WrapPanel Margin="0,9,0,0">
                    <TextBlock Text="额度检测间隔（秒）" Foreground="#C5E6F3" VerticalAlignment="Center" Margin="0,0,10,6"/>
                    <TextBox Name="CodexQuotaRefreshSeconds" Width="75" Height="31" Margin="0,0,10,6" TextAlignment="Center" FontSize="14" Foreground="White" Background="#113451" BorderBrush="#78B9D3" VerticalContentAlignment="Center" AutomationProperties.Name="Codex 额度检测间隔（秒）"/>
                    <Button Name="SaveCodexQuotaRefreshSeconds" Content="保存间隔" Width="85" Height="31" Margin="0,0,0,6" Foreground="White" Background="#23789B" BorderBrush="#77CCEA" Cursor="Hand"/>
                  </WrapPanel>
                  <TextBlock Text="默认 5 秒，可设为 1–3600 秒整数；保存后直接生效。用于刷新额度及检查已启用的预热条件，不会自动打开预热开关。更短间隔会增加上游查询频率，实际报告仍受订阅接口限制。" Foreground="#ABD2E3" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,0"/>
                  <TextBlock Name="CodexQuotaRefreshValidation" Foreground="#FFE2A7" FontSize="11" TextWrapping="Wrap" Margin="0,5,0,0"/>
                </StackPanel>
              </Border>
              <Border Name="CodexWarmupPanel" Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12">
                <StackPanel Margin="16,14" TextBlock.FontFamily="Microsoft YaHei">
                  <TextBlock Text="Codex 自动预热" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
                  <TextBlock Name="CodexWarmupExplanation" Text="适用于 dsh-codex-subscription 当前活动账号与可用 Codex 模型（优先 Codex 默认项，否则目录首项）；预热会消耗订阅额度。三个开关默认关闭，互相独立。100% 是报告显示值，不保证此前完全没有调用。" FontSize="11" Foreground="#ABD2E3" TextWrapping="Wrap" Margin="0,5,0,9"/>
                  <CheckBox Name="CodexWarmupDaily" Content="每天按电脑本地时间自动预热" Foreground="White" FontSize="12" Margin="0,0,0,8"/>
                  <WrapPanel>
                    <TextBlock Text="每日时间" Foreground="#C5E6F3" VerticalAlignment="Center" Margin="0,0,10,6"/>
                    <TextBox Name="CodexWarmupTime" Width="75" Height="31" Margin="0,0,10,6" TextAlignment="Center" FontSize="14" Foreground="White" Background="#113451" BorderBrush="#78B9D3" VerticalContentAlignment="Center" AutomationProperties.Name="每日预热时间 HH:mm"/>
                    <Button Name="SaveCodexWarmupTime" Content="保存时间" Width="85" Height="31" Margin="0,0,10,6" Foreground="White" Background="#23789B" BorderBrush="#77CCEA" Cursor="Hand"/>
                    <TextBlock Text="HH:mm（24 小时制）" Foreground="#ABD2E3" VerticalAlignment="Center" Margin="0,0,0,6" FontSize="11"/>
                  </WrapPanel>
                  <TextBlock Name="CodexWarmupTimeValidation" Foreground="#FFE2A7" TextWrapping="Wrap" FontSize="11" Margin="0,5,0,7"/>
                  <CheckBox Name="CodexWarmupReset" Foreground="White" FontSize="12" Margin="0,0,0,8"><TextBlock Text="5h 重置 / 按检测间隔检查满额新窗口并自动预热" TextWrapping="Wrap"/></CheckBox>
                  <CheckBox Name="CodexWarmupStartup" Foreground="White" FontSize="12" Margin="0,0,0,8"><TextBlock Text="启动 DSH 时，5h 额度为 100% 则预热一次" TextWrapping="Wrap"/></CheckBox>
                  <TextBlock Text="适合非 24 小时开机；开启后也会检查一次当前额度。同一已知窗口不会重复预热。" Foreground="#ABD2E3" FontSize="11" TextWrapping="Wrap" Margin="0,0,0,8"/>
                  <TextBlock Name="CodexWarmupTimezone" Foreground="#ABD2E3" FontSize="11" TextWrapping="Wrap"/>
                  <TextBlock Name="CodexWarmupScheduleNote" Text="保存后数秒内由后端读取，无需重启。切换显示模式不会停止已启用任务；关闭或退出桌宠窗口也不会停止后端计划。DSH 或插件停止时不会唤醒电脑，也不会补执行错过的每日任务。" Foreground="#ABD2E3" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,0"/>
                  <TextBlock Name="CodexWarmupSafetyNote" Text="按上方检测间隔刷新检查满额新窗口（含提前恢复），同一已知窗口只尝试一次；100% 可能是四舍五入。重置预热仅依据新鲜 5h 报告；每次只发极短提示，不带会话或工具。仅确认请求未发送时重试，最多尝试 3 次、间隔 5 秒；发送后结果不明则停止并提示。连续失败停止本次预热；底层传输仍可能重试；不保证固定 Token 或窗口起点。接口无法锁定调用期间账号。" Foreground="#ABD2E3" FontSize="11" TextWrapping="Wrap" Margin="0,6,0,0"/>
                  <TextBlock Name="CodexWarmupStatus" Foreground="#D9F5FF" FontSize="11" TextWrapping="Wrap" Margin="0,9,0,0"/>
                </StackPanel>
              </Border>
              <Border Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12">
                <StackPanel Margin="10,10,10,8">
                  <TextBlock Text="形象图库" FontFamily="Microsoft YaHei" FontSize="14" FontWeight="SemiBold" Foreground="White" Margin="4,0,0,0"/>
                  <TextBlock Name="GalleryHint" Text="峰时 / 谷时双预览 · 点击切换，即时保存" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#ABD2E3" Margin="4,4,0,5"/>
                  <UniformGrid Name="SkinGallery" Columns="3"/>
                </StackPanel>
              </Border>
              <Border Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12">
                <Grid Margin="16,14"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                  <StackPanel><TextBlock Text="尺寸" FontFamily="Microsoft YaHei" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
                    <TextBlock Text="调整角色与余额卡的整体大小" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#ABD2E3" Margin="0,5,0,0"/></StackPanel>
                  <ComboBox Name="SizeChoice" Grid.Column="1" Width="160" Height="31" VerticalAlignment="Center" Foreground="#17384F" Background="White">
                    <ComboBoxItem Content="超小" Tag="tiny"/><ComboBoxItem Content="小" Tag="small"/><ComboBoxItem Content="中" Tag="medium"/><ComboBoxItem Content="大" Tag="large"/>
                  </ComboBox>
                </Grid>
              </Border>
              <Border Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12">
                <Grid Margin="16,14"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                  <StackPanel><TextBlock Text="信息框主题" FontFamily="Microsoft YaHei" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
                    <TextBlock Text="与人物独立搭配，每版含 DeepSeek / Codex 两种样式" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#ABD2E3" Margin="0,5,0,0"/></StackPanel>
                  <ComboBox Name="CardThemeChoice" Grid.Column="1" Width="160" Height="31" VerticalAlignment="Center" Foreground="#17384F" Background="White"/>
                </Grid>
              </Border>
              <Border Name="DeepSeekUnitPanel" Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12">
                <Grid Margin="16,14"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                  <StackPanel><TextBlock Text="扣费飘字" FontFamily="Microsoft YaHei" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
                    <TextBlock Text="选择扣费动画的单位，不影响统计图表" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#ABD2E3" Margin="0,5,0,0"/></StackPanel>
                  <ComboBox Name="UnitChoice" Grid.Column="1" Width="160" Height="31" VerticalAlignment="Center" Foreground="#17384F" Background="White">
                    <ComboBoxItem Content="人民币" Tag="cny"/><ComboBoxItem Content="Token" Tag="token"/>
                  </ComboBox>
                </Grid>
              </Border>              <Border Name="CodexUnitPanel" Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,12" Visibility="Collapsed">
                <Grid Margin="16,14"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                  <StackPanel><TextBlock Text="Codex 用量飘字" FontFamily="Microsoft YaHei" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
                    <TextBlock Text="百分比为两次报告的实测变化；未取得时回退 Token" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#ABD2E3" Margin="0,5,0,0"/></StackPanel>
                  <ComboBox Name="CodexUnitChoice" Grid.Column="1" Width="160" Height="31" VerticalAlignment="Center" Foreground="#17384F" Background="White">
                    <ComboBoxItem Content="Token" Tag="token"/><ComboBoxItem Content="额度百分比" Tag="percent"/>
                  </ComboBox>
                </Grid>
              </Border>
       <Border Background="#203F5D" BorderBrush="#40738E" BorderThickness="1" CornerRadius="13" Margin="0,0,0,10">
        <Grid Margin="16,10"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <StackPanel VerticalAlignment="Center"><TextBlock Text="打瞌睡等待时间" FontFamily="Microsoft YaHei" FontSize="14" FontWeight="SemiBold" Foreground="White"/>
            <TextBlock Text="当前计费模式无调用后开始打瞌睡" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#ABD2E3"/></StackPanel>
          <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
            <TextBox Name="SleepInput" Width="55" Height="31" TextAlignment="Center" FontSize="14" Foreground="White" Background="#113451" BorderBrush="#78B9D3" BorderThickness="1" VerticalContentAlignment="Center"/>
            <TextBlock Text="分钟" Foreground="#C5E6F3" FontFamily="Microsoft YaHei" VerticalAlignment="Center" Margin="7,0,12,0"/>
            <Button Name="SaveSleep" Content="保存" Width="61" Height="31" Foreground="White" Background="#23789B" BorderBrush="#77CCEA" FontFamily="Microsoft YaHei" Cursor="Hand"/>
          </StackPanel>
        </Grid>
      </Border>
            </StackPanel>
            </ScrollViewer>
            <Grid Grid.Row="1"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <TextBlock Text="关闭设置窗口不会退出桌宠" FontFamily="Microsoft YaHei" FontSize="11" Foreground="#A5C9DA" VerticalAlignment="Center" Margin="0,0,12,0"/>
              <Button Name="ExitPet" Grid.Column="1" Content="退出桌宠" Width="110" Height="34" HorizontalAlignment="Right" VerticalAlignment="Center"
                      Foreground="White" Background="#804653" BorderBrush="#CB8897" FontFamily="Microsoft YaHei" Cursor="Hand"/>
            </Grid>
          </Grid>
        </TabItem>
        <TabItem Header="统计">
          <ScrollViewer Name="StatsScroll" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Padding="0,0,8,0">
            <StackPanel>
              <UniformGrid Name="StatsCards" Columns="3" Margin="-4,0,-4,8">
                <Border Name="TokenStatCard" Margin="4" MinHeight="106" Background="#153D5C" CornerRadius="13" BorderBrush="#447A99" BorderThickness="1"><StackPanel Margin="15,14">
                  <TextBlock Text="今日 Token 消耗" Foreground="#A9D7E8" FontFamily="Microsoft YaHei" FontSize="12"/>
                  <Viewbox Stretch="Uniform" StretchDirection="DownOnly" HorizontalAlignment="Left" Margin="0,7,0,0"><TextBlock Name="TodayTokens" Text="0" Foreground="White" FontFamily="Segoe UI" FontSize="27" FontWeight="Bold" TextWrapping="NoWrap"/></Viewbox>
                </StackPanel></Border>
                <Border Name="SecondaryStatCard" Margin="4" MinHeight="106" Background="#153D5C" CornerRadius="13" BorderBrush="#447A99" BorderThickness="1"><StackPanel Margin="15,14">
                  <TextBlock Name="TodaySecondaryTitle" Text="今日缓存命中率" Foreground="#A9D7E8" FontFamily="Microsoft YaHei" FontSize="12"/>
                  <Viewbox Stretch="Uniform" StretchDirection="DownOnly" HorizontalAlignment="Left" Margin="0,7,0,0"><TextBlock Name="TodayHitRate" Text="—" Foreground="#7DE9FF" FontFamily="Segoe UI" FontSize="27" FontWeight="Bold" TextWrapping="NoWrap"/></Viewbox>
                </StackPanel></Border>
                <Border Name="CostStatCard" Margin="4" MinHeight="106" Background="#153D5C" CornerRadius="13" BorderBrush="#447A99" BorderThickness="1"><StackPanel Margin="15,14">
                  <TextBlock Name="TodayCostTitle" Text="今日人民币消耗" Foreground="#A9D7E8" FontFamily="Microsoft YaHei" FontSize="12"/>
                  <Viewbox Stretch="Uniform" StretchDirection="DownOnly" HorizontalAlignment="Left" Margin="0,7,0,0"><TextBlock Name="TodayCost" Text="¥0.00" Foreground="#FFE2A7" FontFamily="Segoe UI" FontSize="22" FontWeight="Bold" TextWrapping="NoWrap"/></Viewbox>
                </StackPanel></Border>
              </UniformGrid>
              <Border Background="#123653" CornerRadius="15" BorderBrush="#457A98" BorderThickness="1">
                <Grid Margin="15,12"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="210"/></Grid.RowDefinitions>
                  <WrapPanel Grid.Row="0" Margin="0,0,0,8">
                    <TextBlock Text="周期消耗趋势" FontFamily="Microsoft YaHei" FontSize="15" FontWeight="SemiBold" Foreground="White" VerticalAlignment="Center" Margin="0,0,22,8"/>
                    <StackPanel Orientation="Horizontal" Margin="0,0,0,8">
                      <ComboBox Name="ChartUnit" Width="89" Height="27" SelectedIndex="0" Margin="0,0,8,0" Foreground="#17384F" Background="White"><ComboBoxItem Content="人民币"/><ComboBoxItem Content="Token"/></ComboBox>
                      <ComboBox Name="ChartRange" Width="74" Height="27" SelectedIndex="0" Foreground="#17384F" Background="White"><ComboBoxItem Content="本周"/><ComboBoxItem Content="本月"/><ComboBoxItem Content="本年"/></ComboBox>
                    </StackPanel>
                  </WrapPanel>
                  <Canvas Name="ChartCanvas" Grid.Row="1" Height="210" HorizontalAlignment="Stretch" ClipToBounds="True"/>
                </Grid>
              </Border>
              <TextBlock Name="StatsNote" Text="人民币为用量估算；统计从本版本首次启用后开始。" Margin="0,14,0,4"
                         FontFamily="Microsoft YaHei" FontSize="11" Foreground="#A5C9DA" TextWrapping="Wrap"/>
            </StackPanel>
          </ScrollViewer>
        </TabItem>
      </TabControl>
    </Grid>
  </Border>
</Window>
'@
  $script:SettingsWindow = [Windows.Markup.XamlReader]::Parse($settingsXaml)
  $script:SettingsWindow.Owner = $script:Window
  $workArea = [Windows.SystemParameters]::WorkArea
  $script:SettingsWindow.Width = [math]::Min(680, $workArea.Width - 20)
  $script:SettingsWindow.Height = [math]::Min(625, $workArea.Height - 20)
  $script:SettingsWindow.Left = [math]::Max($workArea.Left + 10, [math]::Min($workArea.Right - $script:SettingsWindow.Width - 10, $script:Window.Left - 390))
  $script:SettingsWindow.Top = [math]::Max($workArea.Top + 10, [math]::Min($workArea.Bottom - $script:SettingsWindow.Height - 10, $script:Window.Top - 270))
  $script:SettingsTokens = $script:SettingsWindow.FindName('TodayTokens')
  $script:SettingsHitRate = $script:SettingsWindow.FindName('TodayHitRate')
  $script:SettingsCost = $script:SettingsWindow.FindName('TodayCost')
  $script:SettingsNote = $script:SettingsWindow.FindName('StatsNote')
  $script:ChartCanvas = $script:SettingsWindow.FindName('ChartCanvas')
  $script:ChartUnit = $script:SettingsWindow.FindName('ChartUnit')
  $script:ChartRange = $script:SettingsWindow.FindName('ChartRange')
  $script:SleepInput = $script:SettingsWindow.FindName('SleepInput')
  $script:SleepInput.Text = [string]$script:Prefs.sleepMinutes
  Initialize-SettingsSkinGallery
  $refreshInput = $script:SettingsWindow.FindName('CodexQuotaRefreshSeconds')
  $refreshInput.Text = [string]$(if (($script:Prefs.codexQuotaRefreshSeconds -is [int] -or $script:Prefs.codexQuotaRefreshSeconds -is [long]) -and $script:Prefs.codexQuotaRefreshSeconds -ge 1 -and $script:Prefs.codexQuotaRefreshSeconds -le 3600) { $script:Prefs.codexQuotaRefreshSeconds } else { 5 })
  $script:SettingsWindow.FindName('SaveCodexQuotaRefreshSeconds').Add_Click({
    $inputControl = $script:SettingsWindow.FindName('CodexQuotaRefreshSeconds')
    $validation = $script:SettingsWindow.FindName('CodexQuotaRefreshValidation')
    $seconds = 0
    if ($inputControl.Text -cnotmatch '\A[0-9]{1,4}\z' -or -not [int]::TryParse($inputControl.Text, [ref]$seconds) -or $seconds -lt 1 -or $seconds -gt 3600) {
      $validation.Text = '请输入 1–3600 秒的整数，例如 5。'
      $inputControl.BorderBrush = [Windows.Media.Brushes]::Salmon
      return
    }
    if ($script:Prefs.codexQuotaRefreshSeconds -ne $seconds) {
      $script:Prefs.codexQuotaRefreshSeconds = $seconds
      Save-Prefs
    }
    $inputControl.Text = [string]$seconds
    $inputControl.BorderBrush = [Windows.Media.Brushes]::PaleGreen
    $validation.Text = '检测间隔已保存；新版后端将直接采用。首次升级仍需完整重启 DSH。'
  })
  $script:SettingsWindow.FindName('CodexWarmupTimezone').Text = '电脑本地时区：' + [TimeZoneInfo]::Local.DisplayName
  $script:SettingsWindow.FindName('CodexWarmupTime').Text = [string]$script:Prefs.codexWarmupTime
  # Restore before subscribing: opening settings must never enable or persist a task.
  foreach ($key in @('codexWarmupDaily', 'codexWarmupReset', 'codexWarmupStartup')) {
    $name = switch ($key) { 'codexWarmupDaily' { 'CodexWarmupDaily' }; 'codexWarmupReset' { 'CodexWarmupReset' }; 'codexWarmupStartup' { 'CodexWarmupStartup' } }
    $check = $script:SettingsWindow.FindName($name)
    $check.Tag = $key
    $check.IsChecked = $script:Prefs[$key] -is [bool] -and $script:Prefs[$key]
    $check.Add_Click({
      param($sender, $eventArgs)
      $key = [string]$sender.Tag
      $value = $sender.IsChecked -eq $true
      if ($script:Prefs[$key] -is [bool] -and $script:Prefs[$key] -eq $value) { return }
      $script:Prefs[$key] = $value
      Save-Prefs
      Update-SettingsCodexWarmup
    })
  }
  $script:SettingsWindow.FindName('SaveCodexWarmupTime').Add_Click({
    $timeInput = $script:SettingsWindow.FindName('CodexWarmupTime')
    $validation = $script:SettingsWindow.FindName('CodexWarmupTimeValidation')
    if ($timeInput.Text -cnotmatch '\A(?:[01][0-9]|2[0-3]):[0-5][0-9]\z') {
      $validation.Text = '请输入有效时间 HH:mm，例如 09:30（00:00–23:59）。'
      $timeInput.BorderBrush = [Windows.Media.Brushes]::Salmon
      return
    }
    if ($script:Prefs.codexWarmupTime -cne $timeInput.Text) {
      $script:Prefs.codexWarmupTime = $timeInput.Text
      Save-Prefs
    }
    $validation.Text = '时间已保存；后端将在数秒内读取。'
    $timeInput.BorderBrush = [Windows.Media.Brushes]::PaleGreen
    Update-SettingsCodexWarmup
  })
  $themeChoice = $script:SettingsWindow.FindName('CardThemeChoice')
  foreach ($theme in $script:CardThemeCatalog) {
    $item = New-Object Windows.Controls.ComboBoxItem
    $item.Content = [string]$theme.name; $item.Tag = [string]$theme.id
    [void]$themeChoice.Items.Add($item)
  }
  # Restore saved choices before subscribing so opening settings does not write preferences.
  foreach ($choice in @(@{ name = 'CardThemeChoice'; group = 'cardTheme' }, @{ name = 'SizeChoice'; group = 'size' }, @{ name = 'UnitChoice'; group = 'unit' }, @{ name = 'BillingModeChoice'; group = 'billingMode' }, @{ name = 'CodexUnitChoice'; group = 'codexUnit' })) {
    $control = $script:SettingsWindow.FindName($choice.name)
    $control.Tag = $choice.group
    foreach ($item in $control.Items) {
      if ([string]$item.Tag -eq $script:Prefs[$choice.group]) { $control.SelectedItem = $item; break }
    }
    $control.Add_SelectionChanged({
      param($sender, $eventArgs)
      if ($null -eq $sender.SelectedItem) { return }
      $group = [string]$sender.Tag
      $value = [string]$sender.SelectedItem.Tag
      if ($script:Prefs[$group] -eq $value) { return }
      $script:Prefs[$group] = $value
      if ($group -eq 'size') { Set-PetSize }
      elseif ($group -eq 'cardTheme') { Update-PetCardTheme ([bool]$script:LastPeak); Save-Prefs }
      elseif ($group -eq 'billingMode') {
        if (Get-Command Refresh-BillingMode -ErrorAction SilentlyContinue) { Refresh-BillingMode } else { Save-Prefs }
        Update-SettingsBillingMode
        Update-SettingsStats
      } else { Save-Prefs }
    })
  }
  ($script:SettingsWindow.FindName('SettingsDragHandle')).Add_MouseLeftButtonDown([Windows.Input.MouseButtonEventHandler]{
    param($sender, $eventArgs)
    if ($eventArgs.LeftButton -ne [Windows.Input.MouseButtonState]::Pressed) { return }
    $eventArgs.Handled = $true
    try { $script:SettingsWindow.DragMove() } catch [InvalidOperationException] { }
  })
  ($script:SettingsWindow.FindName('CloseSettings')).Add_Click({ $script:SettingsWindow.Close() })
  ($script:SettingsWindow.FindName('ExitPet')).Add_Click({ $script:Window.Close() })
  ($script:SettingsWindow.FindName('SettingsTabs')).Add_SelectionChanged({
    param($sender, $eventArgs)
    if ($eventArgs.OriginalSource -eq $sender -and $sender.SelectedIndex -eq 1) { Update-SettingsStats }
  })
  ($script:SettingsWindow.FindName('SaveSleep')).Add_Click({
    $number = 0
    if ([int]::TryParse($script:SleepInput.Text, [ref]$number) -and $number -ge 1 -and $number -le 240) {
      $script:Prefs.sleepMinutes = $number
      Save-Prefs
      $script:SleepInput.BorderBrush = [Windows.Media.Brushes]::PaleGreen
    } else { $script:SleepInput.BorderBrush = [Windows.Media.Brushes]::Salmon }
  })
  $script:ChartUnit.Add_SelectionChanged({ Update-SettingsStats })
  $script:ChartRange.Add_SelectionChanged({ Update-SettingsStats })
  $script:ChartCanvas.Add_SizeChanged({ Update-SettingsStats })
  foreach ($name in @('SettingsScroll', 'StatsScroll')) {
    $scroll = $script:SettingsWindow.FindName($name)
    $scroll.Add_SizeChanged({ Update-SettingsLayout })
    # SizeChanged can arrive before the ScrollViewer has measured its new viewport.
    $scroll.Add_ScrollChanged([Windows.Controls.ScrollChangedEventHandler]{
      param($sender, $eventArgs)
      if ($eventArgs.OriginalSource -eq $sender -and $eventArgs.ViewportWidthChange -ne 0) { Update-SettingsLayout }
    })
  }
  $script:SettingsWindow.Add_SizeChanged({ Update-SettingsLayout })
  $script:SettingsWindow.Add_Closed({ $script:SettingsWindow = $null })
  Update-SettingsBillingMode
  $script:SettingsWindow.Show()
  Update-SettingsLayout
  Update-SettingsCodexWarmup
  Update-SettingsStats
}
