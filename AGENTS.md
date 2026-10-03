# Agora Event Lab Agent Guide

## Mission

Ihanda at panatilihin ang local-first Agora event lab. Basahin muna ang `SYSTEM.md`; iyon ang canonical system scope at contract.

## Change workflow

1. I-classify ang request at inspeksyunin ang current repository state.
2. Tukuyin ang affected module mula sa `docs/MODULE_MAP.md`.
3. Isulat muna ang kumpletong production change at required tests.
4. Patakbuhin ang static pass: `npm run check`.
5. Patakbuhin ang full behavior pass: `npm test` at `npm run test:e2e`, o `npm run verify`.
6. I-update ang system/runbook docs kapag nagbago ang command, contract, environment variable, o event procedure.

## Todo semantics

- Kapag tinawag ng user na `todo` ang isang item, ituring iyon bilang post-MVP backlog work.
- Itala at panatilihin ang todo, pero huwag itong ipatupad habang hindi pa kumpleto at verified na gumagana ang MVP.
- Unahin ang smallest working product, required integration, at MVP verification bago ang todos o dagdag na features.
- Huwag kusang i-promote ang todo sa current MVP scope. Kung requirement pala ito para gumana ang MVP, i-report ang conflict at humingi muna ng explicit reclassification sa user.
- Simulan lamang ang todo kapag verified na ang MVP at tahasang pinagawa na ng user ang post-MVP work.

## Module rules

- Panatilihin ang dependency direction na `entrypoint → interface → application → domain`.
- Gumamit ng adapters para sa filesystem, Agora HTTP, token library, browser SDK, at event sinks.
- Huwag maglagay ng provider calls sa route handlers o DOM modules.
- Huwag mag-expose ng credentials, generated tokens, request bodies, o response bodies sa logs.
- Dry-run ang default; live execution requires explicit confirmation.
- Gumamit ng isang state owner bawat browser feature.
- Pangalanan ang function ayon sa domain step, hindi generic mechanics.
- Ayusin ang non-trivial source caller-first; panatilihing visible ang orchestration flow.

## Commands

```powershell
npm ci
npm run check
npm test
npm run test:e2e
npm run verify
npm run doctor
npm run package:event
```

Ang planned commands sa `SYSTEM.md` ay hindi pa executable. Huwag gamitin o i-document bilang implemented hanggang maidagdag at ma-verify sa `package.json`.

## Safety boundaries

- Huwag i-commit ang `.env`, credentials, tokens, exported provider payloads, o unrestricted logs.
- Huwag gawing public server template ang loopback-only lab nang walang hiwalay na auth, authorization, deployment, and threat-model work.
- Huwag mag-auto-retry ng create/start/update/stop/delete provider calls.
- Huwag baguhin ang imported contract data manually; gamitin ang import scripts at i-review ang source diff.
