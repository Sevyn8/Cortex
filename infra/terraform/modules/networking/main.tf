# ─────────────────────────────────────────────────────────────────────────────
# networking — VPC + subnets + Cloud NAT + VPC connector + PSA + firewall.
#
# One VPC per environment project (dev/staging/prod). No Shared VPC.
# See ADR-INFRA-003 for topology rationale.
# ─────────────────────────────────────────────────────────────────────────────

# ─── VPC ────────────────────────────────────────────────────────────────────
resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.vpc_name
  auto_create_subnetworks = false

  # routing_mode = "REGIONAL" for Phase 1 (single-region asia-south1).
  # Flip to GLOBAL in P11.x when asia-south2 DR region activates.
  # Change is in-place, no resource recreation required.
  routing_mode = "REGIONAL"
}

# ─── Subnets ────────────────────────────────────────────────────────────────
# Private Google Access on every subnet — required so resources with only
# private IPs can reach GCP APIs without a public route.
resource "google_compute_subnetwork" "compute" {
  project                  = var.project_id
  name                     = "cortex-subnet-compute"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = local.cidr_compute
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_subnetwork" "data" {
  project                  = var.project_id
  name                     = "cortex-subnet-data"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = local.cidr_data
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_subnetwork" "connector" {
  project                  = var.project_id
  name                     = "cortex-subnet-connector"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = local.cidr_connector
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# ─── Cloud Router + Cloud NAT ───────────────────────────────────────────────
# NAT provides egress for private-IP workloads that need to reach the public
# internet (via the allow-https-egress rule below). Logging is enabled so we
# have an audit trail of outbound destinations.
resource "google_compute_router" "nat_router" {
  project = var.project_id
  name    = "cortex-nat-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  project = var.project_id
  name    = "cortex-nat"
  router  = google_compute_router.nat_router.name
  region  = var.region

  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  # Static port allocation. 64 is GCP's documented default; set explicitly
  # so any future bump (e.g., to accommodate many concurrent outbound TLS
  # connections from a single Cloud Run instance) is a deliberate code change.
  min_ports_per_vm = 64

  log_config {
    enable = true
    filter = "ALL"
  }
}

# ─── Private Service Access (for Cloud SQL private IP in P0.4) ──────────────
# Route export/import intentionally not configured.
# Default behavior: Cloud SQL and other PSA-consuming services can reach
# this VPC; this VPC doesn't need to reach into GCP's service network.
# Revisit if Cloud Interconnect or VPN gateway is added in Phase 2+.
resource "google_compute_global_address" "psa" {
  project       = var.project_id
  name          = "cortex-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  address       = "10.${local.octet}.240.0"
  network       = google_compute_network.vpc.id
}

# Cloud Build private worker pool PSA range. Separate reservation from the
# Cloud SQL range above; both are members of the same service-networking
# connection. See ADR-CI-001 Impl Notes "Private pool PSA range allocation".
resource "google_compute_global_address" "cloudbuild_psa" {
  project       = var.project_id
  name          = "cortex-cloudbuild-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 24
  address       = "10.${local.octet}.224.0"
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network = google_compute_network.vpc.id
  service = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [
    google_compute_global_address.psa.name,
    google_compute_global_address.cloudbuild_psa.name,
  ]
}

# ─── Serverless VPC Access Connector ────────────────────────────────────────
# Sized at the minimum: 2 × e2-micro. Cloud Run uses this to reach private
# resources (Cloud SQL via PSA, Memorystore, internal services).
# Resize when S12 observability shows saturation.
resource "google_vpc_access_connector" "connector" {
  project       = var.project_id
  name          = "cortex-connector"
  region        = var.region
  machine_type  = "e2-micro"
  min_instances = 2
  max_instances = 3

  subnet {
    name = google_compute_subnetwork.connector.name
  }
}

# ─── Firewall ───────────────────────────────────────────────────────────────
# Firewall rules are intentionally minimal for P0.3.
# Add when the consuming workload lands:
# - IAP-SSH allow: when first VM/bastion is provisioned
# - GCLB health-check allow: when first load-balanced service deploys
#   (35.191.0.0/16, 130.211.0.0/22)
# - Cloud Run implicit internal: none needed (Cloud Run traffic flows through
#   VPC Connector already permitted by internal-ingress rule)

# (1) Default-deny egress. Overrides GCP's implicit allow-all-egress at 65535.
resource "google_compute_firewall" "deny_all_egress" {
  project   = var.project_id
  name      = "cortex-deny-all-egress"
  network   = google_compute_network.vpc.name
  direction = "EGRESS"
  priority  = 65534

  deny {
    protocol = "all"
  }

  destination_ranges = ["0.0.0.0/0"]
}

# (2) Allow HTTPS egress to the public internet on TCP:443.
# TODO(P11.x): Harden egress.
# Current rule allows all TCP:443 outbound to accommodate dynamic IPs of
# upstream services (Anthropic, Resend, WorkOS, Google APIs).
# Future hardening options:
#   1. Egress proxy (e.g., Squid) with per-domain allowlisting
#   2. Cloud NAT per-VPC-IP allocation + per-destination routing
#   3. Service Connect for Google APIs + explicit allows for third parties
# Revisit trigger: first compliance audit OR when per-service egress
# observability (S12) shows untrusted destinations.
resource "google_compute_firewall" "allow_https_egress" {
  project   = var.project_id
  name      = "cortex-allow-https-egress"
  network   = google_compute_network.vpc.name
  direction = "EGRESS"
  priority  = 1100

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }

  destination_ranges = ["0.0.0.0/0"]
}

# (3) Allow egress to Google APIs via private/restricted.googleapis.com.
# Higher priority (lower number) than the blanket TCP:443 rule so these
# packets take the Private Google Access path (no NAT, no egress cost).
resource "google_compute_firewall" "allow_google_apis_egress" {
  project   = var.project_id
  name      = "cortex-allow-google-apis-egress"
  network   = google_compute_network.vpc.name
  direction = "EGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }

  destination_ranges = [
    "199.36.153.4/30", # private.googleapis.com
    "199.36.153.8/30", # restricted.googleapis.com
  ]
}

# (4) Allow internal VPC ingress. GCP's implicit deny-all-ingress (65535)
# handles everything else — no explicit deny-ingress rule needed.
resource "google_compute_firewall" "allow_internal_ingress" {
  project   = var.project_id
  name      = "cortex-allow-internal-ingress"
  network   = google_compute_network.vpc.name
  direction = "INGRESS"
  priority  = 1000

  allow {
    protocol = "all"
  }

  source_ranges = [local.cidr_vpc_summary]
}
