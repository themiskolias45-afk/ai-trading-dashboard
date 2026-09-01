Get-ScheduledTask | Where-Object { $_.TaskName -match 'SmartEntry' } | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  $lr = if ($i.LastRunTime) { $i.LastRunTime.ToString('MM-dd HH:mm') } else { 'never' }
  $flag = if ($i.LastTaskResult -ne 0 -and $i.LastTaskResult -ne 267009 -and $i.LastTaskResult -ne 3) { '  <-- NONZERO' } else { '' }
  Write-Output ("{0,-30} {1,-9} last={2}  result={3}{4}" -f $_.TaskName, $_.State, $lr, $i.LastTaskResult, $flag)
}
