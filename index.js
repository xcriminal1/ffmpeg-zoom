const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// health check
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// STATUS
app.get("/status", (req, res) => {
  res.json({ ok: true });
});

// JOIN (TEST FIRST)
app.get("/join", (req, res) => {
  console.log("JOIN HIT:", req.query);
  res.send("JOIN endpoint hit successfully");
});

app.post("/stop", (req, res) => {
  res.send("STOP endpoint hit");
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
