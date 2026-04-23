locals {
  # Derive every CIDR from cidr_octet. Primary-region subnets use 0–47.
  # The DR region (asia-south2) block is RESERVED at 64–96 but not provisioned.
  #
  #   compute      10.X.0.0/20     4 094 usable  — GKE/VM/Cloud Run egress
  #   data         10.X.16.0/20    4 094 usable  — data-plane workloads
  #   connector    10.X.32.0/28         14 usable — Serverless VPC Access Connector (must be /28, exclusive)
  #   psa          10.X.240.0/20    4 094 usable  — Cloud SQL private IP (PSA peering)
  #   cloudbuild   10.X.224.0/24       254 usable — Cloud Build private worker pool (PSA peering, ADR-CI-001)
  #
  #   asia-south2 DR (NOT created in Phase 1 — placeholders for P11.x):
  #     compute    10.X.64.0/20
  #     data       10.X.80.0/20
  #     connector  10.X.96.0/28

  octet               = var.cidr_octet
  cidr_compute        = "10.${local.octet}.0.0/20"
  cidr_data           = "10.${local.octet}.16.0/20"
  cidr_connector      = "10.${local.octet}.32.0/28"
  cidr_psa            = "10.${local.octet}.240.0/20"
  cidr_cloudbuild_psa = "10.${local.octet}.224.0/24"
  cidr_vpc_summary    = "10.${local.octet}.0.0/16"
}
