@echo off
rem ===========================================================================
rem  FreedomCard - run the app in "public" (production-like) mode.
rem
rem  What it does:
rem    1. builds the client bundle into packages/client/dist
rem    2. starts the Fastify server which serves that bundle AND /socket.io
rem       on ONE port, so a single tunnel is enough.
rem
rem  Usage:
rem    serve-public.cmd            (default port 3100)
rem    serve-public.cmd 3200       (custom port)
rem
rem  IMPORTANT for tunnelling:
rem    Point the tunnel at 127.0.0.1, NOT "localhost".
rem    On Windows "localhost" resolves to IPv6 ::1 first, while this server
rem    binds IPv4 0.0.0.0 - the tunnel then reports 502 / "no tunnel".
rem ===========================================================================
setlocal
set "NODE_DIR=C:\Users\jack-\.workbuddy\binaries\node\versions\22.22.2-2"
set "PATH=%NODE_DIR%;%PATH%"

cd /d "%~dp0.."

if not "%~1"=="" set "PORT=%~1"
if "%PORT%"=="" set "PORT=3100"
set "SERVE_STATIC=1"
set "HOST=0.0.0.0"

echo [1/2] Building client bundle...
call pnpm.cmd --filter @app/client run build
if errorlevel 1 (
  echo [FAIL] client build failed, aborting.
  exit /b 1
)

echo [2/2] Starting server on 0.0.0.0:%PORT%  (SERVE_STATIC=1)
echo       local: http://127.0.0.1:%PORT%
echo       tunnel target: 127.0.0.1:%PORT%   <-- not localhost
call pnpm.cmd --filter @app/server run start
