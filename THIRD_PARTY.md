# Agora Lab dependencies and reuse

Gumagamit ang lab ng official Agora packages at endpoint contracts. Node HTTP, fetch, test runner, crypto, at filesystem ang standard-platform foundation. Plain browser UI ang ginamit para portable at hindi nakatali ang buong lab sa isang voice-agent app framework.

| Dependency | Pinned version | License | Gamit |
| --- | --- | --- | --- |
| agora-token | 2.0.6 | ISC | Official token generation |
| agora-rtc-sdk-ng | 4.24.8 | MIT | Official browser RTC |
| ajv | 8.20.0 | MIT | JSON Schema validation |
| ajv-formats | 3.0.1 | MIT | Standard schema-format registration |
| yaml | 2.9.1 | ISC | OpenAPI import only |
| esbuild | 0.28.2 | MIT | Browser bundle |
| eslint | 10.11.0 | MIT | Static checks |
| @eslint/js | 10.0.1 | MIT | JavaScript lint rules |
| globals | 17.13.0 | MIT | Environment declarations |
| @playwright/test | 1.63.0 | Apache-2.0 | Browser verification |

Package versions at integrity hashes ay nasa `package-lock.json`. Original dependency licenses remain in their package directories. The RTC bundle retains legal comments supplied by the bundler.

Official reference candidates reviewed:

- [Agora Web examples](https://github.com/AgoraIO/API-Examples-Web): RTC feature reference; browser/App Certificate sample flow was not copied into this lab.
- [Agora Next.js agent quickstart](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs): closest full AI UI; useful for later specialized agent integration, but unnecessary framework weight for a multi-product request explorer.
- [Agora token tools](https://github.com/AgoraIO/Tools): official token implementations; released npm package used directly.
- [Agora Chat UIKit](https://github.com/AgoraIO-Usecase/AgoraChat-UIKit-web), [Signaling samples](https://github.com/AgoraIO/signaling-sdk-samples-web), [Fastboard](https://github.com/netless-io/fastboard): linked specialized clients; not vendored or claimed locally verified.
- [Community ConvoAI microservices](https://github.com/AgoraIO-Community/convo-ai-node-servers): narrower older AI-only example; not selected as the foundation.

Official [Agora API reference](https://docs.agora.io/en/api-reference/api-ref) supplied endpoint and request-validation facts. Generated snapshots preserve source URLs and content hashes; descriptive documentation was not copied wholesale. Request schemas are subject to provider changes and enabled-service restrictions.

Technology-memory lookup could not run because the installed observability CLI has no `tech` command. No previous tested status was assumed. Local verification and live verification remain separate in `verification.json`.
