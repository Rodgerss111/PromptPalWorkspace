@echo off
setlocal

pushd "%~dp0promptpal"
if errorlevel 1 (
    echo Unable to find the PromptPal application directory.
    exit /b 1
)

call npm run tauri -- dev %*
set "exitCode=%errorlevel%"
popd
exit /b %exitCode%