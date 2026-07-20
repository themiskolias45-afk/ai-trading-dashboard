@echo off
cd /d C:\Users\User\ai-trading-dashboard

echo [%date% %time%] JARVIS morning agent starting... >> tasks\logs\agent_log.txt

claude --dangerously-skip-permissions -p "You are JARVIS, SmartEntry Pro trading system engineer. Run a full autonomous morning cycle — no permission needed, just act: 1) Fetch http://localhost:3001/api/checksystem and note any problems. 2) Fetch http://localhost:3001/api/signals — list any signals with confidence >= 65%. 3) Fetch http://localhost:3001/api/learning — find any setup with WR < 40% over 5+ trades. 4) If a clear low-risk improvement exists (tighten a weak setup's entry criteria, adjust confidence threshold), implement it in server/index.js, commit with git. 5) Write a summary to tasks/logs/morning_summary.txt: date, signals found, actions taken, system status. One paragraph, no fluff." >> tasks\logs\agent_log.txt 2>&1

echo [%date% %time%] JARVIS morning agent complete. >> tasks\logs\agent_log.txt
