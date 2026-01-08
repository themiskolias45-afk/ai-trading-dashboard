// =======================================
// TKAI BACKEND — RENDER SAFE (FINAL)
// Node 18 / Express / Port Binding OK
// =======================================

const express = require("express");
const app = express();

/* ---------- BASIC MIDDLEWARE ---------- */
app.use(express.json());

/* ---------- ROOT (REQUIRED) ---------- */
app.get("/", (req, res) => {
  res.status(200).send("TKAI Backend is running");
});

/* ---------- HEALTH CHECK ---------- */
app.get("/api/status", (req, res) => {
  res.json({
    service: "TKAI Backend",
    status: "running",
    time: new Date().toISOString(),
  });
});

/* ---------- PORT (CRITICAL) ---------- */
const PORT = process.env.PORT;

/* ---------- START SERVER (CRITICAL) ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TKAI Backend listening on port ${PORT}`);
});