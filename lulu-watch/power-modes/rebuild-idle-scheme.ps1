# 重建挂件用的自定义「挂机」电源方案。
# 用法： powershell -ExecutionPolicy Bypass -File .\rebuild-idle-scheme.ps1
# 可重复运行：方案已存在时只重新应用参数，不改名、不重复创建。
# 新机器上执行后，若生成的新 GUID 与下面不同，脚本会自动回填 widget.py（并留 widget.py.bak）。

$ErrorActionPreference = "Stop"

$IdleGuid = "22f98355-2f49-49ce-8a7f-c138149382ce"
$BaseGuid = "381b4222-f694-41f0-9685-ff5bb260df2e"   # 平衡
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Widget   = Join-Path (Split-Path -Parent $Here) "widget.py"

function Test-Scheme([string]$g) {
    foreach ($line in (powercfg /list)) {
        if ($line -match [regex]::Escape($g)) { return $true }
    }
    return $false
}

$guid    = $IdleGuid
$isNew   = $false

if (Test-Scheme $IdleGuid) {
    Write-Host "[ok] 挂机方案已存在：$IdleGuid"
} else {
    Write-Host "[..] 复制「平衡」方案以创建挂机方案"
    $out = powercfg /duplicatescheme $BaseGuid
    $m = [regex]::Match(($out -join " "), "[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")
    if (-not $m.Success) {
        Write-Host "[!!] 创建失败，原始输出："
        $out | ForEach-Object { Write-Host "     $_" }
        exit 1
    }
    $guid  = $m.Value.ToLower()
    $isNew = $true
    Write-Host "[ok] 新建方案 GUID：$guid"

    if (Test-Path $Widget) {
        $text = Get-Content -Raw -Encoding UTF8 $Widget
        if ($text.Contains($IdleGuid)) {
            Copy-Item $Widget "$Widget.bak" -Force
            $text = $text.Replace($IdleGuid, $guid)
            [System.IO.File]::WriteAllText($Widget, $text, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "[ok] 已回填 widget.py（备份：widget.py.bak）"
        }
    } else {
        Write-Host "[!!] 同目录下没找到 widget.py"
        Write-Host "     请手动把 $IdleGuid 替换为 $guid"
    }
}

if ($isNew) {
    powercfg /changename $guid "挂机模式（服务常驻·低功耗）" "CPU 5-60%、显示器 10 分钟关、不睡眠、硬盘 20 分钟停转"
}

# CPU 5%~60%（交流 + 电池）
powercfg /setacvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMIN 5
powercfg /setacvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMAX 60
powercfg /setdcvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMIN 5
powercfg /setdcvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMAX 60
# 显示器 10 分钟后关闭
powercfg /setacvalueindex $guid SUB_VIDEO VIDEOIDLE 600
# 永不睡眠 / 永不休眠
powercfg /setacvalueindex $guid SUB_SLEEP STANDBYIDLE 0
powercfg /setacvalueindex $guid SUB_SLEEP HIBERNATEIDLE 0
# 硬盘 20 分钟后停转（原来是「永不」，两块机械盘会一直转着）
powercfg /setacvalueindex $guid SUB_DISK DISKIDLE 1200
# PCIe 链接状态电源管理：最大省电（原来是「中等省电」）
powercfg /setacvalueindex $guid SUB_PCIEXPRESS ee12f906-d277-404b-b6da-e5fa1a576df5 2
# JavaScript 计时器频率：最大省电（原来是「最高性能」，会让浏览器后台每秒唤醒多次）
# 注意子组是「Internet Explorer」02f815b5-…，不是 SUB_PROCESSOR，写错子组会报「设置不存在」
powercfg /setacvalueindex $guid 02f815b5-a5cf-4c84-bf20-649d1f75d3d8 4c793e7d-a264-42e1-87d3-7a0d2f523ccd 0
# 可切换动态显卡「全局设置」：优化省电（原来是「最佳性能」）
# 台式机双显卡影响有限，笔记本上差别明显
powercfg /setacvalueindex $guid e276e160-7cb0-43c6-b20b-73f5dce39954 a1662ab2-9d34-4e53-ba8b-2639b9e20857 1

powercfg /setactive $guid
Write-Host "[ok] 已应用：CPU 5-60%、显示器 10 分钟关、不睡眠、硬盘 20 分钟停转、PCIe 最大省电、JS 计时器省电、显卡优化省电"
Write-Host "[ok] 当前方案 -> $guid"
