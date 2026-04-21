variable "project_id" {
  type        = string
  description = "GCP project to baseline. The module enables the list of APIs in this project."
}

variable "activate_apis" {
  type        = list(string)
  description = "List of API service names to enable (e.g., compute.googleapis.com). The caller owns this list; each environment root specifies its own composition of APIs."
}
