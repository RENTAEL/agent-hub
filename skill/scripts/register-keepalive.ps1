$vbs = Join-Path $PSScriptRoot 'keepalive.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Agent Hub keep-alive' -Description 'Restarts the agent hub bridge, live view, OmniRoute and Ollama if any is down.' `
  -Action $action -Trigger $every5, $logon -Settings $settings -Principal $principal -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'Agent Hub keep-alive'
"$($t.TaskName): $($t.State); triggers: $($t.Triggers.Count); battery ok: $(-not $t.Settings.DisallowStartIfOnBatteries)"
