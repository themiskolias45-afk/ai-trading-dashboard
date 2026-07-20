@echo off
title Installing MCP Tools for JARVIS
echo.
echo  Installing MCP tools — gives JARVIS filesystem, web fetch, and memory access...
echo.

REM Check node is available
node --version >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js not found. Install from nodejs.org first.
  pause
  exit /b 1
)

echo  [1/3] Installing filesystem MCP server...
npx -y @modelcontextprotocol/server-filesystem --version >nul 2>&1
echo  Done.

echo  [2/3] Installing fetch MCP server...
npx -y @modelcontextprotocol/server-fetch --version >nul 2>&1
echo  Done.

echo  [3/3] Installing memory MCP server...
npx -y @modelcontextprotocol/server-memory --version >nul 2>&1
echo  Done.

echo.
echo  MCP tools installed. Restart JARVIS.bat to activate.
echo.
echo  New JARVIS powers:
echo   - Read/write ANY file on your PC (not just the project folder)
echo   - Fetch any URL or webpage directly
echo   - Persistent memory across sessions (knowledge graph)
echo.
pause
