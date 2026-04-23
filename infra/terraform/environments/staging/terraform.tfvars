project_id = "sevyn8-cortex-staging"
region     = "asia-south1"
cidr_octet = 20

common_labels = {
  managed_by  = "terraform"
  project     = "cortex"
  prompt      = "p0-3"
  environment = "staging"
}

wif_pool_resource_name      = "projects/242079866727/locations/global/workloadIdentityPools/cortex-github-pool"
wif_pool_principal_set_base = "principalSet://iam.googleapis.com/projects/242079866727/locations/global/workloadIdentityPools/cortex-github-pool"
wif_provider_resource_name  = "projects/242079866727/locations/global/workloadIdentityPools/cortex-github-pool/providers/cortex-github-provider"
wif_project_number          = "242079866727"
