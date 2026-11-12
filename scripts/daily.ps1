# Щоденний збір цін з цього комп'ютера і публікація на GitHub.
# Запускається Планувальником завдань Windows (див. scripts\install-task.ps1) двічі на ніч:
#   -Part early (03:00) — друга половина міст АТБ;
#   -Part late  (05:30) — перша половина міст АТБ + Сільпо, «Траш!» і недільні знімки.
#   Без -Part — усе за один запуск.
param([ValidateSet('all', 'early', 'late')][string]$Part = 'all')
$ErrorActionPreference = 'Stop'
# Node пише в UTF-8; без цього PowerShell 5.1 читає його вивід як OEM-кодування й псує кирилицю.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Start-Transcript -Path (Join-Path $root 'daily.log') -Append | Out-Null

function Invoke-Step($name, [scriptblock]$cmd) {
    Write-Host "== $name"
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$name завершився з кодом $LASTEXITCODE" }
}

# Збирачі інших мереж (тестова копія) — паралельно з АТБ, вивід у файли .scratch\<назва>-daily.log;
# збій не зриває публікацію цін АТБ. Start-Bg запускає, Wait-Bg чекає й повертає рядок для звіту.
$bg = @{}
function Start-Bg($name, $script) {
    $log = Join-Path $root ".scratch\$name-daily.log"
    New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
    try {
        $p = Start-Process node -ArgumentList $script -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
        $null = $p.Handle
        $bg[$name] = @{ proc = $p; log = $log }
    } catch { $bg[$name] = @{ error = "$_" } }
}
function Wait-Bg($name, $title) {
    $b = $bg[$name]
    if (-not $b) { return $null }
    if ($b.error) { return "${title}: ПОМИЛКА запуску ($($b.error))" }
    Write-Host "== $title (йшло паралельно)"
    $b.proc.WaitForExit()
    $out = @(Get-Content $b.log -Encoding UTF8 -ErrorAction SilentlyContinue)
    $out + @(Get-Content "$($b.log).err" -Encoding UTF8 -ErrorAction SilentlyContinue) | ForEach-Object { Write-Host $_ }
    $n = @($out | Where-Object { $_ -match '\] \d+ товарів' }).Count
    if ($b.proc.ExitCode -eq 0) { "${title}: зібрано магазинів $n" } else { "${title}: ЧАСТКОВО (код $($b.proc.ExitCode)), зібрано магазинів $n" }
}
function Invoke-Quiet($title, $script) {
    Write-Host "== $title"
    try {
        $out = @(node $script | ForEach-Object { Write-Host $_; $_ })
        if ($LASTEXITCODE -eq 0) { $out | Select-Object -Last 1 } else { "${title}: ПОМИЛКА (код $LASTEXITCODE)" }
    } catch { "${title}: ПОМИЛКА ($_)" }
}

# Завдання будить комп'ютер зі сну: не даємо Windows приспати його знову, поки йде збір.
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED = [uint32]1

$started = Get-Date
$ok = $false
$result = ''
$scrapeOut = @()
$snapNote = ''
$silpoNote = ''
$silpoProc = $null
$thrashNote = ''
$full = $Part -ne 'early' # Сільпо, «Траш!» і недільні знімки — лише в пізньому (або повному) запуску
$scrapeArgs = @{ early = @('--', '--half', '2'); late = @('--', '--half', '1'); all = @() }[$Part]
$label = @{ early = ' (03:00)'; late = ' (05:30)'; all = '' }[$Part]
# Обидва запуски пишуть у ті самі файли (cities.json, порівняння, git) — якщо ранній затягнувся
# (комп'ютер прокинувся пізно), пізній чекає його завершення.
$lock = New-Object Threading.Mutex($false, 'Local\PriceTrailDaily')
$locked = $false

# Короткий звіт на робочому столі після кожного запуску (перезаписується).
function Write-StatusFile {
    $today = $started.ToString('yyyy-MM-dd')
    $sum = @{ down = 0; up = 0; sale = 0; saleEnd = 0; saleKept = 0; saleUp = 0; added = 0; cities = 0 }
    foreach ($f in Get-ChildItem (Join-Path $root 'site\data\cities') -Recurse -Filter 'changes.json' -ErrorAction SilentlyContinue) {
        try { $c = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
        if ($c.date -ne $today) { continue }
        $sum.cities++
        # Ті самі правила, що й у вкладках «Що змінилося» на сайті.
        $plain = @($c.prices | Where-Object { -not $_.fromOld -and -not $_.toOld })
        $sum.down += @($plain | Where-Object { $_.to -lt $_.from }).Count
        $sum.up += @($plain | Where-Object { $_.to -gt $_.from }).Count
        $sum.sale += @($c.prices | Where-Object { $_.toOld }).Count
        $sum.saleEnd += @($c.prices | Where-Object { $_.fromOld -and -not $_.toOld -and $_.to -ne $_.from -and $_.to -le $_.fromOld }).Count
        $sum.saleUp += @($c.prices | Where-Object { $_.fromOld -and -not $_.toOld -and $_.to -gt $_.fromOld }).Count
        $sum.saleKept += @($c.prices | Where-Object { $_.fromOld -and -not $_.toOld -and $_.to -eq $_.from }).Count
        $sum.added += @($c.added).Count
    }
    $finished = Get-Date
    $done = $scrapeOut | Where-Object { $_ -match '^Готово' } | Select-Object -Last 1
    $status = if (-not $ok) { 'ПОМИЛКА' } elseif ($done -match 'з помилками [1-9]') { 'ЧАСТКОВО (деякі міста не зібрано)' } else { 'УСПІШНО' }
    $lines = @(
        "PriceTrail — щоденний збір цін$label",
        '',
        "Статус: $status",
        "Початок:    $($started.ToString('dd.MM.yyyy HH:mm:ss'))",
        "Завершення: $($finished.ToString('dd.MM.yyyy HH:mm:ss'))",
        "Тривалість: $([math]::Round(($finished - $started).TotalMinutes)) хв",
        '',
        $result
    )
    if ($done) { $lines += $done }
    if ($silpoNote) { $lines += $silpoNote }
    if ($snapNote) { $lines += $snapNote }
    if ($sum.cities) {
        $lines += "Зміни за сьогодні (міст: $($sum.cities)): подешевшало $($sum.down), подорожчало $($sum.up), нових акцій $($sum.sale), акцій закінчилось $($sum.saleEnd), після акції дорожче, ніж до неї, $($sum.saleUp), після акції ціна та сама $($sum.saleKept), нових товарів $($sum.added)"
    }
    $lines += '', "Сайт: https://fima02.github.io/pricetrail/", "Повний журнал: $(Join-Path $root 'daily.log')"
    $file = Join-Path ([Environment]::GetFolderPath('Desktop')) "PriceTrail — статус збору$label.txt"
    $lines | Out-File -FilePath $file -Encoding utf8
}

try {
    [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
    Write-Host "Старт: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), частина: $Part"
    try { $locked = $lock.WaitOne([TimeSpan]::FromHours(2)) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'попередній запуск збору досі не завершився (чекали 2 год)' }
    # Після пробудження мережа піднімається не одразу — чекаємо до 3 хвилин.
    for ($i = 0; $i -lt 36; $i++) {
        try { Invoke-WebRequest -Uri 'https://github.com' -Method Head -UseBasicParsing -TimeoutSec 5 | Out-Null; break }
        catch { Start-Sleep -Seconds 5 }
    }
    # --autostash: якщо щось лишилось незакоміченим (напр. ручний збір удень) — не зупиняємось, а відкладаємо й повертаємо.
    Invoke-Step 'git pull' { git pull --rebase --autostash --quiet }
    Invoke-Step 'npm ci' { npm ci --silent }
    # Сільпо (для тестової копії сайту, /test/) збираємо паралельно з АТБ: різні сайти й різні теки даних.
    # Його вивід — у файли, у журнал дописуємо після АТБ. Збій Сільпо не зриває публікацію цін АТБ.
    $silpoLog = Join-Path $root '.scratch\silpo-daily.log'
    New-Item -ItemType Directory -Force (Split-Path $silpoLog) | Out-Null
    if ($full) { try {
        $silpoProc = Start-Process node -ArgumentList 'scraper/silpo.js' -WorkingDirectory $root -NoNewWindow -PassThru `
            -RedirectStandardOutput $silpoLog -RedirectStandardError "$silpoLog.err"
        $null = $silpoProc.Handle # без цього в PowerShell 5.1 ExitCode після завершення буває порожнім
    } catch {
        $silpoNote = "Сільпо: ПОМИЛКА запуску ($_)"
    } }
    # Інші мережі: zakaz.ua (Метро, Ашан, Новус, Таврія В, МегаМаркет, ЕкоМаркет; ≈2–3 год) — у ранньому запуску,
    # Фора — у пізньому, разом із Сільпо.
    if ($Part -ne 'late') { Start-Bg 'zakaz' 'scraper/zakaz.js' }
    if ($full) { Start-Bg 'fora' 'scraper/fora.js' }
    Write-Host '== Збір цін'
    # Виводимо в журнал і водночас запам'ятовуємо — для звіту на робочому столі.
    $scrapeOut = @(npm run scrape @scrapeArgs | ForEach-Object { Write-Host $_; $_ })
    if ($LASTEXITCODE -ne 0) { throw "Збір цін завершився з кодом $LASTEXITCODE" }
    if ($silpoProc) {
        Write-Host '== Збір цін Сільпо (йшов паралельно)'
        $silpoProc.WaitForExit()
        $silpoOut = @(Get-Content $silpoLog -Encoding UTF8 -ErrorAction SilentlyContinue)
        $silpoOut + @(Get-Content "$silpoLog.err" -Encoding UTF8 -ErrorAction SilentlyContinue) | ForEach-Object { Write-Host $_ }
        $n = @($silpoOut | Where-Object { $_ -match '^\[.+\] \d+ товарів' }).Count
        $silpoNote = if ($silpoProc.ExitCode -eq 0) { "Сільпо: зібрано міст $n" } else { "Сільпо: ЧАСТКОВО (код $($silpoProc.ExitCode)), зібрано міст $n" }
    }
    if ($silpoNote) { Write-Host $silpoNote }
    # Акції «Траш!» (тестова копія) — після Сільпо: розділи товарів беруться з його каталогу. Кілька секунд; збій не зриває публікацію.
    if ($full) { Write-Host '== Акції «Траш!»' }
    if ($full) { try {
        $thrashOut = @(node scraper/thrash.js | ForEach-Object { Write-Host $_; $_ })
        $thrashNote = if ($LASTEXITCODE -eq 0) { $thrashOut | Where-Object { $_ -match '^Траш!:' } | Select-Object -Last 1 } else { "Траш!: ПОМИЛКА (код $LASTEXITCODE)" }
    } catch {
        $thrashNote = "Траш!: ПОМИЛКА ($_)"
    } }
    if ($thrashNote) { $silpoNote = "$silpoNote`r`n$thrashNote" }
    $other = @()
    $other += Wait-Bg 'zakaz' 'Мережі zakaz.ua'
    $other += Wait-Bg 'fora' 'Фора'
    if ($full) {
        $other += Invoke-Quiet 'Грош' 'scraper/grosh.js'
        # Штрихкоди: нові товари Сільпо (кілька хвилин) і покажчик для пошуку на сайті.
        $other += Invoke-Quiet 'Штрихкоди Сільпо' 'scraper/silpo-barcodes.js'
        $other += Invoke-Quiet 'Покажчик штрихкодів' 'scraper/barcodes.js'
    }
    $other = @($other | Where-Object { $_ })
    if ($other.Count) { $silpoNote = (@($silpoNote) + $other | Where-Object { $_ }) -join "`r`n" }
    # Раз на тиждень (у неділю) — знімок рівня цін у всіх містах АТБ для мапи на головній (≈45 хв).
    # Його збій не зриває щоденну публікацію: на мапі лишається знімок минулого тижня.
    if ($full -and $started.DayOfWeek -eq [DayOfWeek]::Sunday) {
        Write-Host '== Знімок рівня цін (щотижня)'
        try {
            $snapOut = @(node scraper/snapshot.js --fresh | ForEach-Object { Write-Host $_; $_ })
            $snapNote = if ($LASTEXITCODE -eq 0) { "Мапа рівня цін оновлена: $($snapOut | Where-Object { $_ -match '^levels.json' } | Select-Object -Last 1)" } else { "Мапа рівня цін: ПОМИЛКА (код $LASTEXITCODE), лишився знімок минулого тижня" }
        } catch {
            $snapNote = "Мапа рівня цін: ПОМИЛКА ($_), лишився знімок минулого тижня"
        }
        Write-Host $snapNote
        Write-Host '== Знімок рівня цін Сільпо (щотижня)'
        try {
            $snapOut = @(node scraper/silpo-snapshot.js --fresh | ForEach-Object { Write-Host $_; $_ })
            $note = if ($LASTEXITCODE -eq 0) { "Мапа рівня цін Сільпо оновлена: $($snapOut | Where-Object { $_ -match '^levels.json' } | Select-Object -Last 1)" } else { "Мапа рівня цін Сільпо: ПОМИЛКА (код $LASTEXITCODE), лишився знімок минулого тижня" }
        } catch {
            $note = "Мапа рівня цін Сільпо: ПОМИЛКА ($_), лишився знімок минулого тижня"
        }
        Write-Host $note
        $snapNote = "$snapNote`r`n$note"
    }
    # silpo-stores.json — запам'ятовані магазини Сільпо (новий з'являється, коли в місті вперше знайшовся магазин).
    # stores.json — запам'ятовані магазини АТБ (новий з'являється для щойно доданого міста).
    # zakaz-ids.json — номери товарів zakaz.ua (з них id на сайті: губити не можна); *-stores.json — вибрані магазини мереж;
    # silpo-barcodes.json — уже зібрані штрихкоди Сільпо (щоб не перезапитувати).
    Invoke-Step 'git add' { git add site/data scraper/silpo-stores.json scraper/stores.json scraper/zakaz-ids.json scraper/zakaz-stores.json scraper/fora-stores.json scraper/silpo-barcodes.json }
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        Invoke-Step 'git commit' { git commit --quiet -m "Ціни за $(Get-Date -Format 'yyyy-MM-dd')$label" }
        Invoke-Step 'git push' { git push --quiet }
        $result = 'Дані опубліковано на сайті (оновиться за кілька хвилин).'
    } else {
        $result = 'Змін у даних немає — публікувати нічого.'
    }
    Write-Host $result
    $ok = $true
} catch {
    $result = "Що сталося: $_"
    Write-Host "ПОМИЛКА: $_"
    exit 1
} finally {
    # Збір АТБ упав, а Сільпо ще йде — зупиняємо, щоб не лишився висіти після завершення завдання.
    if ($silpoProc -and -not $silpoProc.HasExited) { $silpoProc.Kill() }
    foreach ($b in $bg.Values) { if ($b.proc -and -not $b.proc.HasExited) { $b.proc.Kill() } }
    if ($locked) { $lock.ReleaseMutex() }
    [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    try { Write-StatusFile } catch { Write-Host "Не вдалося записати звіт: $_" }
    Stop-Transcript | Out-Null
}
