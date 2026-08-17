#!/bin/bash
# Brix and Bros launcher (Mac) — starts a tiny local server and opens the game.
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  (node serve.js >/dev/null 2>&1 &)
  sleep 1
  open "http://localhost:8642"
elif command -v python3 >/dev/null 2>&1; then
  (python3 -m http.server 8642 >/dev/null 2>&1 &)
  sleep 1
  open "http://localhost:8642"
else
  # no server available — open the file directly (works in most browsers)
  open "index.html"
fi
