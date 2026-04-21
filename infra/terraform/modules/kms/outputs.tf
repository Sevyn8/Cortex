output "keyring_id" {
  description = "Fully-qualified KMS keyring ID (projects/.../keyRings/...)."
  value       = google_kms_key_ring.this.id
}

output "key_ids" {
  description = "Map of key name to fully-qualified key resource ID. Callers reference specific keys by name."
  value = {
    for name, key in google_kms_crypto_key.this : name => key.id
  }
}
