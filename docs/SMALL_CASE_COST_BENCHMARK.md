# Small-use cost and performance worksheet

## Claim boundary

The current MVP model path is private Modal T4. An **AWS EC2 Spot GPU for the model is a hypothetical post-MVP option**, not a deployed or benchmarked part of GabayBigkas. The priority `BinaryHeap`, application-controlled SSD spill, and measured RAM tiers are also planned, not implemented. Do not attribute current throughput or cost efficiency to them. OS swap is a last-resort host safety net, not the queue strategy.

## Comparable small-case workload

Use the same month, region, learner-session duration, completed-session count, request mix, and quality/latency threshold for each row. Record both `100 completed learner sessions/month` and `1,000 completed learner sessions/month` if the measured workload supports them. API reads alone are a separate metric; do not count them as completed sessions.

| Scenario | API host | Model runtime | Status |
| --- | --- | --- | --- |
| Current design | User-confirmed 512 MB Lightsail host | Modal T4 billed execution | Read capacity measured; total cost needs a bill and completed-session run |
| Proposed Spot design | Same Lightsail bundle | EC2 GPU Spot, started only for jobs | Hypothetical; requires interruption-safe implementation and live Spot quotes |
| Larger API baseline | 4 GB or 8 GB Lightsail | Same model runtime and workload | Price comparison only until measured on that host |
| Always-on GPU baseline | Same API host | EC2 GPU On-Demand running 730 h/month | Cost counterfactual, not a measured performance comparison |

The user confirmed **512 MB RAM** for the actual benchmark VPS. As of 2026-10-04, AWS lists the public-IPv4 Linux **512 MB, 2 vCPU, 20 GB SSD bundle at $5/month**. Larger comparison bundles are **$12/month for 2 vCPU, 2 GB RAM, 60 GB SSD**, **$24/month for 2 vCPU, 4 GB**, and **$44/month for 2 vCPU, 8 GB**. These are list prices; confirm region, tax, overages, and account credits against the actual bill. Modal lists **T4 GPU at $0.000164 per second** plus CPU and memory charges. Spot price is variable by Availability Zone and time; capture the exact `g4dn.xlarge` (or chosen compatible GPU) Linux/UNIX quote using AWS `DescribeSpotPriceHistory` at each benchmark, then record the paid bill. No fixed Spot price is asserted here.

## Calculation

Let `N` be **successful completed sessions/month**, `H_spot` be billed EC2 Spot hours including start/warm/idle time, and `P_spot` the captured USD/hour rate. Record `H_modal` as actual billed T4 seconds; include Modal CPU/memory, EC2 EBS/storage/snapshot, data transfer, Agora RTC/ConvoAI, YouTube or other provider, and tax as separate line items.

```text
monthly_total_spot = Lightsail + H_spot × P_spot + EBS + transfer + Agora + other
monthly_total_modal = Lightsail + H_modal × 0.000164 + Modal_CPU_RAM + transfer + Agora + other
cost_per_completed_session = monthly_total / N
cost_per_1000_successful_reads = 1000 × allocated_monthly_API_cost / monthly_successful_reads
```

For a **price-only illustration**, use the $5 Lightsail bundle, 100 completed sessions/month, and 60 billed T4 seconds per session. The T4 GPU line is `100 × 60 × $0.000164 = $0.984`; API host plus T4 GPU is **$5.984/month or $0.05984/session** before CPU/RAM, Agora, network, storage overages, taxes, and credits. This is not an observed bill or completed-session performance result. For Spot, insert the captured quote: if each session requires `G` billed GPU hours, the monthly Spot line is `100 × G × P_spot` plus startup/idle, EBS, and interruption overhead. A Spot interruption may increase cost per successful session even when its hourly quote is lower.

To show the Spot sensitivity on a slide, **assume** a $0.20/hour Spot quote and 10 billed GPU hours/month for those 100 sessions. The GPU line would be `$2`, giving **$7/month or $0.07/session** for the $5 API host plus Spot compute. At only 2 billed GPU hours, that partial total would be **$5.40/month or $0.054/session**. The $0.20 rate and billed hours are illustrative inputs, not a current AWS quote or measured runtime. EBS, warm-up, interrupted/repeated jobs, and the other line items above still need to be added. The $12, $24, and $44 Lightsail rows cost $7, $19, and $39 more per month than the $5 host before any measured performance benefit.

## Slide evidence table

| Field | 512 MB + Modal T4 | 512 MB + Spot GPU | 4 GB baseline | 8 GB baseline |
| --- | --- | --- | --- | --- |
| Status | Price estimate / measured | Hypothetical / measured | Price estimate / measured | Price estimate / measured |
| API host USD/month | 5 list / actual bill | Same | 24 list / actual bill | 44 list / actual bill |
| Model USD/month | Actual billed T4 + CPU/RAM | Actual Spot + EBS + idle | Same model as first column | Same model as first column |
| Completed sessions/month | Measure | Measure | Measure | Measure |
| p95/p99 end-to-end session latency | Measure | Measure | Measure | Measure |
| Peak RSS, swap in/out, disk latency | Measure | Measure | Measure | Measure |
| Rejection/failure rate; recovery time | Measure | Measure, including interruption | Measure | Measure |
| USD/completed session | Calculate from bill and N | Calculate from bill and N | Calculate from bill and N | Calculate from bill and N |

Use the same workload and an acceptable p95/p99, error rate, and recovery limit before calling one row better value. The slide should say **"small-case cost per completed session at measured quality"**, with date, host shape, concurrency, sample size, and the billing period. Do not claim a queue or swap advantage without before/after results on the same VPS and workload.

For the two-transcript and human-review story, use [the one-slide architecture](DUAL_ASR_SLIDE.md).

Sources: [AWS Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html), [Modal pricing](https://modal.com/pricing), [AWS Spot price history API](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeSpotPriceHistory.html), [AWS Spot interruption behavior](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html).
