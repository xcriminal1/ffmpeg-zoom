const express = require("express");

const app = express();

// IMPORTANT: Railway injects PORT
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.get("/join", (req, res) => {
  console.log("JOIN HIT", req.query);
  res.send("JOIN OK");
});

app.get("/status", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});
