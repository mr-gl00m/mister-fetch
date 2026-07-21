@echo off
setlocal
cd /d "%~dp0"

if not exist "packages\fetch-core\dist\index.js" goto build
if not exist "packages\fetch-cli\dist\main.js" goto build
goto run

:build
echo [mister-fetch] building...
call npm run -w @mister-fetch/core build || goto fail
call npm run -w @mister-fetch/cli build || goto fail

:run
if "%MISTER_FETCH_MODEL%"=="" set MISTER_FETCH_MODEL=hermes3:latest
if "%MISTER_FETCH_OLLAMA_URL%"=="" set MISTER_FETCH_OLLAMA_URL=http://localhost:11434
node packages\fetch-cli\dist\main.js %*
goto end

:fail
echo [mister-fetch] build failed
exit /b 1

:end
endlocal
