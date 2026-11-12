# Реєструє щоденні завдання збору цін у Планувальнику завдань Windows:
#   «ATB Price early» — scripts\daily.ps1 -Part early (друга половина міст АТБ);
#   «ATB Price»         — scripts\daily.ps1 -Part late  (перша половина міст АТБ + Сільпо, «Траш!»).
# Завдання будять комп'ютер зі сну; якщо о вказаний час він вимкнений — виконаються, щойно увімкнеться.
param([string]$Early = '03:00', [string]$Late = '05:30')

$script = Join-Path $PSScriptRoot 'daily.ps1'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3)

foreach ($t in @(
        @{ Name = 'ATB Price early'; At = $Early; Part = 'early' },
        @{ Name = 'ATB Price'; At = $Late; Part = 'late' }
    )) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Part $($t.Part)" `
        -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
    $trigger = New-ScheduledTaskTrigger -Daily -At $t.At
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings `
        -Description "Щоденний збір цін ($($t.Part)) і публікація на GitHub" -Force -ErrorAction Stop | Out-Null
    Write-Host "Завдання '$($t.Name)' зареєстровано: щодня о $($t.At), -Part $($t.Part)."
}
