@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 22+ is required. Install Node.js and reopen the terminal. 1>&2
    exit /b 127
)
if not exist "%~dp0dist\cli.js" (
    echo Run npm ci and npm run build in the AutoGit source directory first. 1>&2
    exit /b 1
)
rem Keep the caller's working directory; data lives beside this portable launcher.
node "%~dp0dist\cli.js" --app-dir "%~dp0." %*
exit /b %errorlevel%
