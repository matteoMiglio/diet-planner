# iOS Shortcuts

Two Shortcuts get weigh-ins into the app with a couple of taps, without opening it. Both call the server over Tailscale, so the iPhone needs Tailscale connected.

You need:

- **The server address**: `https://<vm-name>.<tailnet>.ts.net`. Settings → iOS Shortcuts in the app shows both full URLs, with copy buttons.
- **The ingest token**: `INGEST_TOKEN` from the server's `.env`. Generate one with `openssl rand -hex 32` and restart the app (`docker compose up -d`).

Every request sends the header `Authorization: Bearer <INGEST_TOKEN>`. A wrong or missing token gets `401`; if the server has no token set, the endpoints answer `503`.

## 1. "Log weight" (about 5 seconds)

For mornings when you weigh yourself without needing the full Tanita reading, or on a scale that isn't the Tanita.

In the Shortcuts app, create a new Shortcut with these actions:

1. **Ask for Input**: Input Type _Number_, Prompt `Weight (kg)`. Allow decimal numbers.
2. **Get Contents of URL**:
   - URL: `https://<vm-name>.<tailnet>.ts.net/api/ingest/weight`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer <INGEST_TOKEN>`
   - Request Body: _JSON_, one field `weightKg` (Number) = _Provided Input_
3. **Get Dictionary Value**: Key `message` from _Contents of URL_.
4. **Show Notification**: _Dictionary Value_.

Name it "Log weight" and add it to the Home Screen or the Lock Screen. You can also run it with Siri.

What happens on the server:

- Your weight is stored with the current time.
- Logging again within 10 minutes corrects the earlier entry instead of adding a second one.
- If a Tanita reading from the same weigh-in arrives later in the CSV, it replaces this entry with the full composition reading.
- A typed number never overwrites a scale reading.

## 2. "Send to Diet Planner" (Tanita CSV)

This one sends the My Tanita export straight from the share sheet.

1. Create a new Shortcut and open its settings (the ⓘ button).
2. Turn on **Show in Share Sheet** and set the accepted input to **Files**.
3. Add **Get Contents of URL**:
   - URL: `https://<vm-name>.<tailnet>.ts.net/api/ingest/tanita`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer <INGEST_TOKEN>`
   - Request Body: _File_, set to _Shortcut Input_
4. Add **Get Dictionary Value**: Key `message`.
5. Add **Show Notification**: _Dictionary Value_.

To use it: in My Tanita, export the CSV, then pick **Send to Diet Planner** from the share sheet. The notification says what happened, e.g. `Tanita import: 1 new, 37 already imported.` Re-sending the whole history every time is fine, because readings that are already in are skipped.

If you'd rather check the rows before importing, use Progress → Import in the app instead; it shows a preview first.

## Testing from a computer

```sh
TOKEN=...  HOST=https://<vm-name>.<tailnet>.ts.net
curl -s -H "Authorization: Bearer $TOKEN" -d '86.4' "$HOST/api/ingest/weight"
curl -s -H "Authorization: Bearer $TOKEN" --data-binary @report.csv "$HOST/api/ingest/tanita"
```
