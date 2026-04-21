# modules/networking

VPC, three subnets, Cloud NAT, Serverless VPC Access Connector, Private Service Access, and a minimal firewall baseline.

One VPC per environment project. See ADR-INFRA-003 for the full topology rationale.

## Inputs

| Name          | Type     | Default         | Description                                  |
| ------------- | -------- | --------------- | -------------------------------------------- |
| `project_id`  | `string` | —               | GCP project.                                 |
| `environment` | `string` | —               | `dev` \| `staging` \| `prod`.                |
| `region`      | `string` | `"asia-south1"` | Primary region.                              |
| `vpc_name`    | `string` | `"cortex-vpc"`  | VPC name.                                    |
| `cidr_octet`  | `number` | —               | `10` (dev) \| `20` (staging) \| `30` (prod). |

## Outputs

| Name                                                | Description                             |
| --------------------------------------------------- | --------------------------------------- |
| `vpc_id`, `vpc_self_link`                           | VPC refs.                               |
| `subnet_compute_id`, `subnet_compute_self_link`     | Compute subnet (10.X.0.0/20).           |
| `subnet_data_id`, `subnet_data_self_link`           | Data subnet (10.X.16.0/20).             |
| `subnet_connector_id`, `subnet_connector_self_link` | Connector subnet (10.X.32.0/28).        |
| `psa_range_name`                                    | PSA range name — for Cloud SQL in P0.4. |
| `vpc_connector_id`                                  | Connector ID — for Cloud Run egress.    |

## CIDR plan

```
10.X.0.0/16 — environment summary (where X = 10|20|30)
├── 10.X.0.0/20         compute   (4 094 usable)
├── 10.X.16.0/20        data      (4 094 usable)
├── 10.X.32.0/28        connector (14 usable — must be /28)
├── 10.X.240.0/20       psa       (Cloud SQL private IP)
└── 10.X.64.0/20 …      RESERVED for asia-south2 DR (P11.x)
```

## Firewall

4 rules:

| #   | Priority | Direction | Action | Protocol / port | Source / dest                    |
| --- | -------: | --------- | ------ | --------------- | -------------------------------- |
| 1   |    65534 | EGRESS    | DENY   | all             | 0.0.0.0/0                        |
| 2   |     1100 | EGRESS    | ALLOW  | TCP:443         | 0.0.0.0/0                        |
| 3   |     1000 | EGRESS    | ALLOW  | TCP:443         | 199.36.153.4/30, 199.36.153.8/30 |
| 4   |     1000 | INGRESS   | ALLOW  | all             | 10.X.0.0/16                      |

GCP's implicit deny-all-ingress at 65535 handles all other ingress. Rule #1 overrides GCP's implicit allow-all-egress at 65535.

## Not included

IAP-SSH allow, GCLB health-check allow, per-service egress pinning. Added when consuming workloads land (Cloud Run, VMs, bastions, load balancers). See the firewall-section comment in `main.tf`.
