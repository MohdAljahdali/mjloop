---
description: Open the loop dashboard — a queue of runs, each in a live terminal
---

Start the web dashboard for this project and hand the user its url.

1. Check that `.mjloop/` exists here. If it does not, say so and offer `/mjloop:init`
   instead of starting anything.
2. Run the server **in the background**:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/engine/dist/web/cli.js --dir "$PWD" --no-open
   ```

   It prints its url on the first two lines and then stays running. Read those lines
   and give the url to the user verbatim.
3. Tell them three things, and no more:
   - the url opens a page that queues loop commands and shows each one in a real
     terminal they can type into
   - **the url contains an access token — anyone who has it can run commands in this
     project**, so it is not something to paste into a chat or an issue
   - the server stops when they kill it, and a new one issues a new token

If the port is already in use, the server exits with an `EADDRINUSE` error. Retry once
with `--port 0` and report the url it lands on rather than guessing which other process
holds 4177.

Do not attempt to drive the page yourself. It is the user's surface, not a tool call —
your part ends when they have the url.
