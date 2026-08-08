@echo off
chcp 65001 >nul
title ClipHistory 打包辅助 - 开启开发者模式
echo ==========================================
echo   ClipHistory 打包辅助
echo   本脚本将开启 Windows「开发者模式」，
echo   以便打包时能把自定义图标嵌入 exe。
echo ==========================================
echo.
echo 正在请求管理员权限...
echo 请在弹出的 Windows 安全确认框中点击「是」。
echo.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','New-Item -Path HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock -Force | Out-Null; Set-ItemProperty -Path HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock -Name AllowDevelopmentWithoutDevLicense -Type DWord -Value 1; Write-Host 开发者模式已开启'"
echo.
echo 操作完成。如果刚才点了「是」，开发者模式已开启。
echo 现在可以回到 Claude 那边，告诉它「已开启」继续打包。
echo.
pause
