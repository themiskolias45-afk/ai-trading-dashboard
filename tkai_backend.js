/**************************************************
 * TKAI – BACKEND SERVER (RENDER SAFE)
 * Telegram + Dashboard API
 * Assets: BTC, GOLD (PAXG), SP500, MSFT, AMZN
 * Scans: Hourly
 * Daily Report: 23:00 London
 **************************************************/

const express = require("express");
const cron = require("node-cron");

// Node 18+ has fetch built-in
const fetch = global.fetch;

const app = express();
const PORT = process.env.PORT || 3000;

/* ===================== TELEGRAM ===================== */
const TELEGRAM_TOKEN = "8246792368:AAG8bxkAIEulUddX5PnQjnC6BubqM3p-NeA";
const TELEGRAM_CHAT_ID = "7063659034";

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

/* ===================== STATE ===================== */
let lastScan = new Date().toISOString();

const ASSETS = ["BTC", "GOLD (PAXG)", "SP500", "MSFT", "AMZN"];

/* ===================== API ===================== */
app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    lastScan,
    assets: AS