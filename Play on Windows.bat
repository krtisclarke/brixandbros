@echo off
rem Brix and Bros launcher (Windows) - starts a tiny local server and opens the game.
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "node serve.js"
  timeout /t 1 /nobreak >nul
  start "" "http://localhost:8642"
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "python -m http.server 8642"
  timeout /t 1 /nobreak >nul
  start "" "http://localhost:8642"
  goto :eof
)
rem no server available - open the file directly (works in most browsers)
start "" "index.html"
