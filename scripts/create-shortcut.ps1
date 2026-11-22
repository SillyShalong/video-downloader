# 创建桌面快捷方式：Video Downloader
$desktop = [Environment]::GetFolderPath('Desktop')
$project = 'C:\Users\lijialun\opt\video-downloader'
$electron = Join-Path $project 'node_modules\electron\dist\electron.exe'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Video Downloader.lnk'))
$lnk.TargetPath = $electron
$lnk.Arguments = '.'
$lnk.WorkingDirectory = $project
$lnk.IconLocation = (Join-Path $project 'build\icon.ico')
$lnk.Description = '视频下载器 (YouTube / 抖音 / B站 / 小红书)'
$lnk.Save()
Write-Output "已创建: $(Join-Path $desktop 'Video Downloader.lnk')"
