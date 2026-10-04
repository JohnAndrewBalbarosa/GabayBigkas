# GabayBigkas — AVP Script

## Production brief

- **Project name:** **GabayBigkas**
- **AVP title:** *Boses Mo, Gabay Mo*
- **Runtime:** 2:30–2:45
- **Format:** 16:9, 1080p, Taglish voice-over, burned-in subtitles
- **Tone:** Human, hopeful, credible; mabilis ang opening, mas kalmado ang solution demo
- **Audience:** Hackathon judges, educators, at potential school partners
- **Truth boundary:** Concept/prototype ang Pronunciation Coach. Ang Agora Event Lab at local RTC/API tooling ang kasalukuyang working foundation. Huwag magpakita ng simulated feedback bilang live production result.

## Scene-by-scene script

| Oras | Visual at edit direction | Voice-over | On-screen text |
| --- | --- | --- | --- |
| `0:00–0:10` | Close-up ng learner na nagpa-practice sa laptop. Nagre-record, humihinto, at inuulit ang isang English sentence. Minimal piano; maririnig sandali ang room tone. | “Alam mo ang gusto mong sabihin. Pero kapag hindi ka sigurado sa bigkas, minsan nauuna ang hiya bago ang boses.” | **Kapag may duda sa bigkas, saan magsisimula?** |
| `0:10–0:24` | Quick cuts: malaking online class, teacher na maraming learners, generic transcript na walang coaching context. Iwasan ang identifiable student data. | “Sa isang classroom, hindi laging kayang pakinggan ng guro ang bawat salita ng bawat learner. At ang ordinaryong transcript, ipinapakita lang kung ano ang narinig—hindi kung saan kailangan ng mas maingat na practice.” | **Limited feedback. Delayed practice. Lost confidence.** |
| `0:24–0:34` | Title reveal. Mula sa audio waveform, mabubuo ang project mark at simplified architecture line. | “Kaya binuo namin ang konsepto ng GabayBigkas—isang real-time, reviewable na gabay para mas makapag-practice ang learner nang may direksiyon.” | **GabayBigkas**<br>Boses Mo, Gabay Mo |
| `0:34–0:52` | Screen capture ng dalawang browser na magka-channel sa Agora Event Lab. Ipakita ang local at remote participant tiles; huwag ipakita ang tokens o `.env`. | “Gamit ang Agora, nagkakaroon ng live audio session ang learner at coach. Dito nagsisimula ang natural na conversation—hindi sa hiwalay at paulit-ulit na recording workflow.” | **Live conversation powered by Agora** |
| `0:52–1:12` | Animated flow: `Full session audio → preprocess → BuzzASR windows → Agora/Buzz alignment → sentence clips`. Gumamit ng fictional data. | “Pagkatapos ng session, nililinis at bina-batch transcribe ang independent recording. Kinukumpara ang timestamped Agora at BuzzASR transcripts, saka lamang pinuputol ang processed sentence clips na kailangang i-review.” | **Post-session dual-ASR review**<br>Sentence context · Reviewable · Privacy-bounded |
| `1:12–1:28` | UI mockup: dalawang transcript, isang highlighted mismatch, replay button, at confidence/evidence indicator. Labelan itong `PROTOTYPE`. | “Mahalaga: ang disagreement ng dalawang speech model ay signal lamang—hindi awtomatikong hatol na mali ang pronunciation. Noise, accent, code-switching, at context ay maaari ring makaapekto sa resulta.” | **Candidate signal ≠ diagnosis** |
| `1:28–1:45` | Learner feedback card: `Practice candidate`, replay clip, at curated resource. Sunod na shot: learner na muling bumibigkas. | “Sa halip na sabihing ‘mali,’ nagmumungkahi ang system ng practice candidate. Maaaring pakinggan muli ng learner ang consented clip at gumamit ng curated pronunciation resource para subukan ulit.” | **Pakinggan. Unawain. Mag-practice ulit.** |
| `1:45–2:00` | Split screen: learner view at teacher/reviewer queue na may bounded metadata lamang. Walang full transcript o raw private payload sa logs. | “Para sa guro, nagiging mas focused ang review. Para sa learner, mas mabilis ang feedback. At sa bawat hakbang, bounded ang data at malinaw kung alin ang automated suggestion at alin ang nangangailangan ng human judgment.” | **Learner agency + Teacher review** |
| `2:00–2:17` | Ipakita ang working Agora Event Lab: API explorer, local validation, dry-run result, token tools, at RTC tab. | “May working local foundation na kami para sa Agora API exploration, guarded dry-runs, short-lived token generation, at two-browser RTC validation. Ang susunod na hakbang ay ikonekta rito ang coaching workflow at patunayan ito kasama ang tunay na learners at educators.” | **Working foundation**<br>Local-first · Safe-by-default · Testable |
| `2:17–2:32` | Bumalik sa learner. Mas confident na inuulit ang sentence; soft rise ng music. Mag-end sa title card. | “Dahil ang pronunciation practice ay hindi dapat nakakatakot. Dapat itong malinaw, makatao, at nagbibigay ng lakas para magsalita. GabayBigkas—boses mo, gabay mo.” | **GabayBigkas**<br>Mas malinaw na practice. Mas confident na boses. |
| `2:32–2:38` | End card: team name, members, event, optional QR code. Music resolves. | “Built for real-time learning with Agora.” | **[TEAM NAME]** · **[EVENT NAME]**<br>`[QR / demo link]` |

## Pronunciation-improvement showcase

Optional itong `50–60` second insert pagkatapos ng dual-ASR flow. Ang target ay isang
specific sound, hindi ang learner’s accent o identity. Huwag gamitin ang linyang
**“bad accent fixed.”** Gamitin ang **“unclear first take → reviewed guidance → clearer
retry.”**

**Practice sentence:** “Three thoughtful students reviewed the weather forecast.”

| Oras | Visual at performance direction | Dialogue / voice-over | On-screen text |
| --- | --- | --- | --- |
| `0:00–0:08` | Learner presses **Start session** and reads the practice sentence naturally. Huwag mag-caricature ng Filipino accent; ang actor ay gagawa lamang ng bahagyang unclear na initial `/θ/` sa **three**. | **Learner:** “Three thoughtful students reviewed the weather forecast.” | **BASELINE TAKE**<br>Consented demo audio |
| `0:08–0:18` | Ipakita ang real session capture, pagkatapos ay ang flow na `finalize → preprocess → Agora/Buzz comparison`. Sa review screen, i-focus ang **three**. Gumamit ng fictional transcript kung hindi ito live run. | **Narrator:** “Pagkatapos ng session, ikinukumpara ng sarili naming workflow ang expected phrase at dalawang transcript path. Nagkaiba ang mga transcript sa salitang *three*, kaya naging candidate ito for review.” | **Expected:** three<br>**Agora:** tree<br>**BuzzASR:** three<br>**Candidate only ≠ verdict** |
| `0:18–0:30` | Reviewer replays the whole sentence clip, then the highlighted range. Piliin ang appropriate annotation decision bago lumabas ang feedback card. | **Reviewer:** “May sapat na context. Practice natin ang `/θ/`: dila nang bahagya sa pagitan ng ngipin, then steady airflow—*θree*.” | **HUMAN-REVIEWED GUIDANCE**<br>Listen · Observe · Try again |
| `0:30–0:42` | Learner listens once, activates **Retry**, at binibigkas muli ang parehong sentence. Panatilihing magkatabi ang baseline at retry waveforms; huwag magpakita ng invented accuracy score. | **Learner:** “Three thoughtful students reviewed the weather forecast.” | **RETRY TAKE**<br>Same phrase · Same learner |
| `0:42–0:52` | Reviewer compares both consented clips and confirms only the target sound. Learner smiles; understated lang ang reaction. | **Reviewer:** “Mas clear na ang *three*. Keep your natural voice—target sound lang ang pinapractice natin.” | **Clearer target sound**<br>Accent preserved |
| `0:52–1:00` | Ipakita ang compact pipeline at GabayBigkas mark. | **Narrator:** “Hindi binubura ng GabayBigkas ang accent. Ginagawa nitong reviewable ang evidence para may konkretong marinig, maituro, at masubukan ulit.” | **Evidence → human guidance → retry** |

### Presenter bridge

> “Ang improvement na nakita ninyo ay hindi galing sa automatic accent score.
> Galing ito sa implemented session capture, private audio processing, dual-ASR
> comparison, sentence-level review, at guided retry. Ang system ang nagpapabilis
> ng paghahanap ng practice candidate; tao pa rin ang nagbibigay ng final judgment.”

### Demo-state labels

- **LIVE** — gamitin lamang kapag ang exact learner → inference → import → review run ay
  nakumpleto sa demo environment.
- **PRE-RECORDED REAL RUN** — gamitin kapag totoong system output ang footage pero
  ginawa bago ang presentation.
- **PROTOTYPE / FICTIONAL DATA** — gamitin kapag staged ang transcript, highlight,
  feedback, o retry comparison.
- Huwag gumamit ng percentage improvement, accent score, o “fixed” claim nang walang
  measured benchmark at documented review protocol.

## Recording copy

Ito ang clean voice-over text para sa narrator:

> Alam mo ang gusto mong sabihin. Pero kapag hindi ka sigurado sa bigkas, minsan nauuna ang hiya bago ang boses.
>
> Sa isang classroom, hindi laging kayang pakinggan ng guro ang bawat salita ng bawat learner. At ang ordinaryong transcript, ipinapakita lang kung ano ang narinig—hindi kung saan kailangan ng mas maingat na practice.
>
> Kaya binuo namin ang konsepto ng GabayBigkas—isang real-time, reviewable na gabay para mas makapag-practice ang learner nang may direksiyon.
>
> Gamit ang Agora, nagkakaroon ng live audio session ang learner at coach. Dito nagsisimula ang natural na conversation—hindi sa hiwalay at paulit-ulit na recording workflow.
>
> Sa backend, hinahati ang audio sa maiikling sentence-level segments. Kinukumpara ang Agora transcript sa independent BuzzASR Filipino pass, saka ina-align ang dalawang resulta para makita ang mga salitang kailangang i-review.
>
> Mahalaga: ang disagreement ng dalawang speech model ay signal lamang—hindi awtomatikong hatol na mali ang pronunciation. Noise, accent, code-switching, at context ay maaari ring makaapekto sa resulta.
>
> Sa halip na sabihing “mali,” nagmumungkahi ang system ng practice candidate. Maaaring pakinggan muli ng learner ang consented clip at gumamit ng curated pronunciation resource para subukan ulit.
>
> Para sa guro, nagiging mas focused ang review. Para sa learner, mas mabilis ang feedback. At sa bawat hakbang, bounded ang data at malinaw kung alin ang automated suggestion at alin ang nangangailangan ng human judgment.
>
> May working local foundation na kami para sa Agora API exploration, guarded dry-runs, short-lived token generation, at two-browser RTC validation. Ang susunod na hakbang ay ikonekta rito ang coaching workflow at patunayan ito kasama ang tunay na learners at educators.
>
> Dahil ang pronunciation practice ay hindi dapat nakakatakot. Dapat itong malinaw, makatao, at nagbibigay ng lakas para magsalita. GabayBigkas—boses mo, gabay mo.
>
> Built for real-time learning with Agora.

## Asset checklist

- Learner and teacher B-roll with consent
- Clean screen recording ng Agora Event Lab RTC flow
- Screen recording ng API dry-run at token tools na walang secrets
- Simplified dual-ASR flow animation
- Clearly labeled prototype feedback mockup
- Team logo, member names, event name, at final QR/demo link
- Licensed background music at sound effects
- Tagalog/English subtitles checked against the final narration take

## Edit safeguards

- I-blur ang channel IDs, UIDs, account names, notifications, at personal data.
- Huwag i-record ang `.env`, credentials, generated tokens, request bodies, o provider response bodies.
- Gumamit lamang ng fictional transcript at learner data sa mockups.
- Lagyan ng **PROTOTYPE** ang coaching screens hanggang may working end-to-end implementation.
- Kung dry-run lang ang footage, tawagin itong local validation; huwag itong ilarawan bilang successful live Agora operation.
