# Hackathon Runbook

## Goal

Ihanda ang lab, credentials, demo path, at fallback artifacts bago magsimula ang timed build. Ang runbook na ito ay operational; hindi nito pinapalitan ang system contracts sa `SYSTEM.md`.

## Readiness states

| State | Meaning |
| --- | --- |
| `LOCAL_READY` | Dependencies, build, tests, and local server pass without credentials |
| `CREDENTIAL_READY` | Required environment variable names are present; validity may remain unverified |
| `RTC_READY` | Two authenticated browser clients complete two-way media flow |
| `API_READY` | Chosen operation passes dry-run and authorized live smoke test |
| `KIT_READY` | Portable package starts independently and contains no `.env` |

## T-minus 1 day: local preparation

### 1. Reproduce the workspace

```powershell
npm ci
npm run build
npm run verify
```

Pass condition: all commands exit `0`. If Playwright browser binaries are missing, install the required browser before repeating `npm run test:e2e`; do not claim full verification from unit tests alone.

### 2. Create local configuration

```powershell
Copy-Item .env.example .env
npm run doctor
```

Populate only the credentials needed by the selected demo. Keep `AGORA_LIVE_ENABLED=false` until the team is ready for provider traffic.

### 3. Start offline

```powershell
npm start
```

Open `http://127.0.0.1:4317`. Confirm:

- Health and catalog load.
- Product and operation selection work.
- Generated input appears.
- Validation reports incomplete placeholders.
- Dry-run returns a request preview.
- No live provider call occurs.

### 4. Select one primary demo path

Write down:

- Product and exact operation ID.
- Required credentials and Console services.
- Required input fields and known IDs.
- Create/start → query → stop/delete lifecycle.
- Expected provider result and visible user outcome.
- Cleanup owner.

Choose one fallback path that uses fewer external dependencies.

## T-minus 2 hours: credential and account checks

1. Confirm required Agora services are enabled in the target project.
2. Confirm App ID and App Certificate belong to the same project.
3. Confirm REST Customer ID/Secret are not confused with App ID/Certificate.
4. Confirm channel name, UIDs, region, storage, LLM, and TTS configuration as applicable.
5. Run:

```powershell
npm run doctor
```

`doctor` checks presence and shape, not provider validity.

## T-minus 1 hour: RTC smoke test

1. Start the server.
2. Open two browser windows.
3. Use the same channel and different UIDs.
4. Join both clients.
5. Verify A publishes and B receives audio/video.
6. Verify B publishes and A receives audio/video.
7. Start and stop screen sharing.
8. Leave both clients and confirm local tracks stop.
9. Confirm no secret/token content appears in lifecycle logs.

Record `RTC_READY` only after the full two-client flow succeeds.

## T-minus 30 minutes: live API smoke test

Enable live mode only for an approved target account:

```powershell
# Edit .env: AGORA_LIVE_ENABLED=true
npm start
```

For the chosen operation:

1. Run validation.
2. Run `dry-run` and inspect method, host, path, query, and redacted headers.
3. Confirm the operation ID exactly in the UI.
4. Send one bounded live request.
5. Capture returned resource/agent/task identifiers outside committed files.
6. Query the created resource if the product supports it.
7. Run the documented stop/delete cleanup.

Never live-test a mutation without a cleanup path and owner.

## Event execution

### Standard start

```powershell
npm start
```

### Standard health check

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/health
```

Expected fields: `status=ok` and the intended `liveEnabled` value.

### Standard verification after a code change

```powershell
npm run check
npm test
npm run test:e2e
```

Do not alternate partial implementation and tests file-by-file. Complete the coherent change, then run the static pass, then the complete behavior pass.

### Packaging

```powershell
npm run verify
npm run package:event
```

Inspect the package before transfer:

- No `.env`.
- No credentials or generated tokens.
- No unreviewed result exports.
- No unrestricted lifecycle logs.
- `START.cmd`, runtime dependencies, and built assets are present.

## Demo choreography

Keep the main demo under five minutes:

1. Explain the user problem and chosen Agora capability.
2. Show the selected operation and generated input.
3. Validate and dry-run to show safety boundaries.
4. Execute one live path or RTC interaction.
5. Show the visible outcome, not merely an HTTP 2xx.
6. Clean up started resources.
7. State the fallback and next production hardening step.

## Failure matrix

| Symptom | First check | Safe action |
| --- | --- | --- |
| Catalog does not load | `/api/health`, build output | Rebuild and restart; do not refresh contracts during demo |
| `blocked` result | Live flag, confirmation, credential presence | Return to dry-run; fix only the missing gate |
| `invalid` result | Field-level schema errors and placeholders | Correct input; do not bypass validation |
| `provider-error` | Status, operation ID, account/service setup | Preserve bounded metadata; verify Console configuration |
| `network-error` | Internet, DNS, firewall, timeout | Switch to offline dry-run or RTC fallback |
| RTC join fails | App ID, token, channel, UID, clock | Reissue token and verify same project/channel |
| One-way media | Permissions, track publish state, device, firewall | Re-run device preview, then rejoin both clients |
| Screen share fails | Browser permission/support | Continue audio/video demo; do not block core flow |
| Cleanup fails | Stored task/resource ID and product lifecycle | Retry manually only after querying current state |

## Fallback ladder

Use the highest available level:

1. Live end-to-end provider result.
2. Live RTC between two clients.
3. Provider dry-run with validated request preview.
4. Offline catalog and schema validation.
5. Pre-captured, redacted screenshots or exported sample data prepared before the event.

Never represent a lower fallback as a live success.

## End-of-event cleanup

- Stop/delete all created agents, recordings, streams, transcriptions, and other tasks.
- Leave RTC channels and stop local tracks.
- Set `AGORA_LIVE_ENABLED=false`.
- Remove temporary exported provider results after review.
- Rotate credentials if they were exposed in screen sharing, terminal history, or chat.
- Preserve only bounded, redacted diagnostics needed for follow-up.

