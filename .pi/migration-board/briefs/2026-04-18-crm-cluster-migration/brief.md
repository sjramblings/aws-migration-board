# Brief: Migrate CRM cluster (22 VMs) to AWS ap-southeast-2

## Inventory Summary
Extracted from RVTools export — 22 VMs across 2 ESXi hosts in a single cluster.

| Category | Count | Total vCPU | Total RAM | Total Storage |
|----------|-------|-----------|-----------|---------------|
| Application Servers | 8 | 48 vCPU | 128 GB | 640 GB |
| Database Servers | 4 | 32 vCPU | 256 GB | 2.4 TB |
| Web/API Servers | 6 | 24 vCPU | 48 GB | 180 GB |
| Utility/Batch | 4 | 16 vCPU | 32 GB | 320 GB |
| **Total** | **22** | **120 vCPU** | **464 GB** | **3.54 TB** |

OS Distribution: Windows Server 2019 (14), RHEL 8 (6), Ubuntu 22.04 (2)
Average CPU utilisation across cluster: 18% (peak: 62% during month-end batch)

## Workload Description
This is the CRM platform for a mid-market financial services company with 850 internal users. The system handles customer onboarding, portfolio management, compliance reporting, and client communications. It processes ~15,000 transactions/day during normal operations, spiking to ~45,000 during quarter-end reporting.

Key components:
- **CRM Application** (8 VMs): Custom .NET application with IIS, running the core CRM logic
- **SQL Server cluster** (4 VMs): 2-node Always On AG for CRM database (~1.8TB), plus 2 reporting replicas
- **API Gateway** (6 VMs): REST APIs serving mobile app and 3rd party integrations, nginx + Node.js
- **Batch Processing** (4 VMs): Month-end regulatory reports, data reconciliation, ETL jobs. The large batch job runs for 6-8 hours on the last business day of each month and pegs all 4 VMs at 90%+ CPU.

## Current Pain Points
- Hardware is 5 years old, approaching end of warranty in 8 months
- Data centre lease expires in 14 months — must exit or renegotiate at 30% higher rates
- SQL Server licensing on-prem is expensive ($180K/year) and renewal is in 6 months
- No DR capability — single site, single cluster, RPO is "last night's backup"
- Compliance team flagged lack of encryption at rest as a finding in last audit
- Performance complaints during month-end batch — users report slowness in the CRM UI while batch jobs run

## Interview Highlights
From IT team interviews:
- "The batch job is the thing that scares everyone. It runs for 6-8 hours and if it fails halfway, we have to restart from scratch. It's touched maybe 3 times in 5 years."
- "The SQL AG works fine but failover has never been tested in production. We'd have no idea if it actually works."
- "The API servers are way over-provisioned. We allocated 4 vCPU each but they barely use 1 core except during quarter-end."
- "We have a hard compliance requirement: all customer data must stay in Australia. No exceptions."
- "The CRM app has a session affinity requirement — sticky sessions on the load balancer. It can't be round-robin."
- "We'd love to get rid of the Windows licensing cost but the .NET app targets .NET Framework 4.8, not .NET Core. Migration would be a project."

## Requirements
- Target region: ap-southeast-2 (Sydney) — mandatory for data sovereignty
- Availability target: 99.95% for CRM application, 99.99% for database
- RTO: 4 hours, RPO: 1 hour
- Compliance: APRA CPS 234 (information security), data must remain in Australia
- Timeline: 6 months to complete migration, 8-month hard deadline (hardware warranty)
- Budget ceiling: Migration cost capped at $150K. Ongoing monthly target: less than current $45K/month all-in (hardware amortization + licensing + power/cooling + DC lease portion)
- Existing AWS footprint: None. This is their first AWS workload. No existing commitments.
- Partner relationship: AWS Select tier partner managing the engagement.

## Key Question
What is the optimal architecture, migration wave plan, and 3-year TCO for moving this 22-VM CRM cluster to AWS ap-southeast-2, and what funding programs can offset the migration and first-year costs?
