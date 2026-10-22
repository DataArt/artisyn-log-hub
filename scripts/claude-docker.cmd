@echo off
rem Thin wrapper: runs the claude-docker launcher with the given arguments (see --help).
rem When the interactive menu picks a session, shell or new sandbox, it writes that command to
rem CLAUDE_DOCKER_NEXT_FILE (one argument per line) and exits; the command then runs here as a
rem fresh process (see handNext in claude-docker.mjs). Its arguments are sandbox names, branch
rem names and flags, which never contain spaces.
setlocal EnableDelayedExpansion
set "NEXT_FILE=%TEMP%\claude-docker-next-%RANDOM%%RANDOM%.txt"
set "CLAUDE_DOCKER_NEXT_FILE=%NEXT_FILE%"
node "%~dp0claude-docker.mjs" %*
set "RC=%ERRORLEVEL%"
set "CLAUDE_DOCKER_NEXT_FILE="
if exist "%NEXT_FILE%" (
  set "NEXT_ARGS="
  for /f "usebackq delims=" %%a in ("%NEXT_FILE%") do set "NEXT_ARGS=!NEXT_ARGS! %%a"
  del "%NEXT_FILE%"
  node "%~dp0claude-docker.mjs" !NEXT_ARGS!
  set "RC=!ERRORLEVEL!"
)
exit /b %RC%
