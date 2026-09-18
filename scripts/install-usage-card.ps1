# install-usage-card.ps1 —— 在**目标机**上安装 dsh-usage-card
#
# 为什么要单独一个脚本（而不是让人手敲命令）：
#   目标是三台机行为一致：装 → 校验 → 提示重启。手敲容易漏掉校验那步，
#   而"装完了但其实没生效"比装失败更难查。
#
# 两种用法：
#   A. 直接在目标机上跑：  pwsh -File install-usage-card.ps1
#   B. 从有 ssh 路由的机器批量推（本仓库的 run-on.ps1 就是干这个的）：
#        pwsh -File run-on.ps1 -Script .\install-usage-card.ps1 -Target b-server
#      （run-on.ps1 会处理 BOM/引号/解释器版本那三个坑）
#
# 参数：
#   -Restart  安装后尝试重启 dsh web（会中断该机正在进行的会话，默认不做）
param(
  [switch]$Restart
)
$ErrorActionPreference = 'Continue'
$pkg = 'dsh-usage-card'
$src = 'github:Icstick/dsh-usage-card'

function Say($m) { Write-Host "[usage-card] $m" }

Say "目标机: $env:COMPUTERNAME / 用户 $env:USERNAME"

# 1) dsh 可用？
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { Say "找不到 dsh 命令 —— 这台机器还没配好 DSH CLI，先解决这个再装"; exit 1 }
Say "dsh: $($dsh.Source)"

# 2) 安装（pnpm 由 dsh plugin 自己驱动）
Say "安装 $src ..."
& dsh plugin --profile web add $src
if ($LASTEXITCODE -ne 0) { Say "安装失败（exit $LASTEXITCODE）。常见原因：网络/代理、pnpm 被运行中的 DSH 占用"; exit 1 }

# 3) 校验：包真的落进 profile 了吗（装失败但退出码 0 的情况不是没有）
$profilePkg = Join-Path $env:USERPROFILE ".dsh\profiles\web\package.json"
$ok = $false
if (Test-Path $profilePkg) {
  $json = Get-Content $profilePkg -Raw | ConvertFrom-Json
  $hasDep = $null -ne $json.dependencies.$pkg
  $inBundles = @($json.dsh.profile.bundles) -contains $pkg
  Say ("校验: dependencies=" + $hasDep + " / bundles=" + $inBundles)
  $mod = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\$pkg\lib\client.js"
  $hasClient = Test-Path $mod
  Say ("校验: lib/client.js = " + $hasClient)
  $ok = $hasDep -and $inBundles -and $hasClient
}
if (-not $ok) { Say "校验未通过 —— 包没完整落进 web profile，别急着重启，先看上面的输出"; exit 1 }

Say "安装完成。**重启 dsh web 后生效**（宿主半改动必须重启）。"
Say "重启后自检： curl http://127.0.0.1:3080/usage-card/current.json   应返回 ok:true"

if ($Restart) {
  Say "-Restart 指定了，正在重启 dsh web ..."
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'bin\.ts"?\s+\"?web' -or $_.CommandLine -match 'dsh.*web' }
  foreach ($p in $procs) { Say ("结束进程 " + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Say "已停止；请手动重新启动 dsh web（脚本不替你起服务，避免带着错的参数把它拉起来）"
} else {
  Say "（未重启。需要的话加 -Restart，或手动重启）"
}
