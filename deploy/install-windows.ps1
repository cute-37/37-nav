# 在 Windows 上把网址导航注册成计划任务：登录后自动在后台启动，异常退出后自动重启。
# 用法：在项目目录里执行  powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1
# 卸载：powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'NavServer'
$Dir = Split-Path -Parent $PSScriptRoot

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已卸载。数据还在 $Dir\data，需要的话请自行删除。"
    exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
    Write-Error '没有找到 Node.js。请先安装 22.13 或更高版本：https://nodejs.org/'
}
$Version = [version]((& $Node -v).TrimStart('v'))
if ($Version -lt [version]'22.13.0') {
    Write-Error "Node.js 版本太低（当前 $Version），需要 22.13 或更高。"
}

Write-Host '安装依赖…'
Push-Location $Dir
try { npm ci --omit=dev } finally { Pop-Location }

# 用 conhost --headless 启动，这样不会弹出一个黑色的命令行窗口
$Action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$Node`" server/index.js" -WorkingDirectory $Dir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description '网址导航' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host '安装完成。浏览器打开 http://localhost:3080 设置管理密码。'
Write-Host "停止：Stop-ScheduledTask -TaskName $TaskName    启动：Start-ScheduledTask -TaskName $TaskName"
Write-Host '注意：这是「登录后启动」。如果希望不登录也运行（服务器常见需求），请改用 Docker 或 pm2，见 DEPLOY.md。'
